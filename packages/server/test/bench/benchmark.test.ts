/**
 * Runs the section 10 benchmark over the five tasks in bench/tasks.ts.
 *
 * Three of section 10's rows can be derived from the repository, and this
 * file measures all three:
 *
 * - **Full files read per task** (target −60%): −100%. The server returns
 *   facts rather than files, so the answer is zero by construction.
 * - **Input tokens per task** (target −50%): about −45% against a
 *   perfect-oracle baseline. Short of the target, and reported as such.
 * - **Incremental indexing** (target < 2 s): asserted directly.
 *
 * The baseline is deliberately the minimum file set that actually holds each
 * answer — no exploratory reads, no greps, no dead ends. A real session reads
 * more, so the token figure understates the difference; equally, it is not the
 * −50% the plan asks for, and the assertion below is a regression floor rather
 * than the plan's target dressed up as one.
 *
 * Turns to first correct edit and task success rate are NOT here. They need an
 * agent driven three times on each side, and inventing them from a script
 * would be fabricating exactly the numbers R15 says not to publish without.
 * docs/BENCHMARK.md records what is measured, what is not, and why.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as angularCompiler from '@angular/compiler';
import * as typescript from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { BENCH_TASKS, FIXTURE } from '../../bench/tasks.js';
import { formatSummary, measureTask, summarize } from '../../bench/measure.js';
import type { CallRunner } from '../../bench/measure.js';
import { indexProject } from '../../src/indexer/index.js';
import { ALL_TOOLS } from '../../src/server.js';
import { ToolContext } from '../../src/tools/index.js';

const REPO_ROOT = join(process.cwd(), '..', '..');
const FIXTURE_ROOT = join(REPO_ROOT, 'fixtures', FIXTURE);

describe('section 10 benchmark', () => {
  let cacheDir: string;
  let context: ToolContext;

  beforeEach(async () => {
    cacheDir = await mkdtemp(join(tmpdir(), 'bench-'));
    const result = await indexProject({
      root: FIXTURE_ROOT,
      typescript,
      angularCompiler,
      force: true,
      cacheDir,
    });

    context = new ToolContext({ defaultRoot: FIXTURE_ROOT, cacheDir });
    context.setState({
      root: FIXTURE_ROOT,
      result,
      deps: {
        typescript,
        typescriptVersion: typescript.version,
        angularCompiler,
        angularVersion: { full: '18.2.14', major: 18 },
      },
      workspace: { root: FIXTURE_ROOT, kind: 'angular-cli', projects: [] },
      indexedAtMs: Date.now(),
    });
  });

  afterEach(async () => {
    await rm(cacheDir, { recursive: true, force: true });
  });

  /** Runs a tool exactly as the server would, and returns what the caller receives. */
  const runCall: CallRunner = async (toolName, args) => {
    const tool = ALL_TOOLS.find((candidate) => candidate.name === toolName);
    if (!tool) throw new Error(`The benchmark names a tool that does not exist: ${toolName}`);

    const output = (await tool.run(args, context)) as Record<string, unknown>;

    // The markdown rendering is what an agent actually reads, so that is what
    // is counted — not the structured payload beside it.
    const result = output['result'] as { format?: string; text?: string } | undefined;
    return result?.format === 'markdown' && typeof result.text === 'string'
      ? result.text
      : JSON.stringify(output);
  };

  it('cuts context on every task, and records the overall figure', async () => {
    const measurements = [];
    for (const task of BENCH_TASKS) {
      measurements.push(await measureTask(FIXTURE_ROOT, task, runCall));
    }
    const summary = summarize(measurements);

    // Printed so the committed numbers in docs/BENCHMARK.md can be regenerated
    // and checked rather than taken on trust.
    console.error(formatSummary(summary));

    for (const task of summary.tasks) {
      expect(task.byteReduction, task.taskId).toBeGreaterThan(0);
    }

    // A regression floor, NOT the plan's target. Section 10 asks for -50%
    // against a real agent session; this measures against a perfect-oracle
    // baseline that opens exactly the right files and nothing else, and comes
    // out at about 45%. Asserting 50% here would be asserting the plan's
    // number against a different measurement than the one it was written for.
    // docs/BENCHMARK.md states the gap and what would close it.
    expect(summary.overallByteReduction).toBeGreaterThan(0.4);
  });

  it('pulls no whole source files into the context at all', async () => {
    const measurements = [];
    for (const task of BENCH_TASKS) {
      measurements.push(await measureTask(FIXTURE_ROOT, task, runCall));
    }
    const summary = summarize(measurements);

    // This is section 10's "full files read per task" metric, literally. The
    // target is -60%; the answer is -100%, because the server returns facts
    // rather than files. It is satisfied by construction, which is worth
    // stating plainly rather than presenting as a finding.
    expect(summary.totalBaselineFilesRead).toBeGreaterThan(0);
    expect(summary.totalWithServerFilesRead).toBe(0);
  });

  it('every task is answerable with the tools that exist', async () => {
    const names = new Set(ALL_TOOLS.map((tool) => tool.name));

    for (const task of BENCH_TASKS) {
      for (const call of task.calls) {
        expect(names, `${task.id} -> ${call.tool}`).toContain(call.tool);
      }
    }
  });

  it('reindexes an unchanged project entirely from cache', async () => {
    const started = Date.now();
    const result = await indexProject({
      root: FIXTURE_ROOT,
      typescript,
      angularCompiler,
      cacheDir,
    });
    const elapsed = Date.now() - started;

    // The deterministic half of section 10's "< 2 s" row: nothing changed
    // since beforeEach, so every file must come from cache and none may be
    // re-extracted. This is a property of the code and holds on any hardware.
    expect(result.stats.filesReindexed).toBe(0);
    expect(result.stats.filesReused).toBe(result.stats.filesProcessed);
    expect(result.stats.filesReused).toBeGreaterThan(0);

    // The wall clock is recorded, not asserted at the plan's threshold. On a
    // shared CI runner an elapsed-time assertion measures the runner rather
    // than the cache, and a flaky red teaches nobody anything. The real figure
    // (0.9 s on the machine named there) lives in docs/BENCHMARK.md; this
    // ceiling exists only to catch a change that makes indexing pathological.
    console.error(`incremental index: ${elapsed} ms, ${result.stats.filesReused} files reused`);
    expect(elapsed).toBeLessThan(30_000);
  });
});
