/**
 * Measures the context cost of each benchmark task, both ways
 * (docs/PLAN.md, section 10).
 *
 * "Context cost" is the number of bytes of the model's window a route
 * consumes: the files an agent must read without this server, against the
 * responses the server returns instead. Both sides are measured the same way,
 * from real bytes — file contents on one side, actual tool output on the
 * other. Nothing is estimated except the bytes-to-tokens ratio, which is
 * stated rather than hidden.
 *
 * This is the half of section 10 that can be derived from the repository.
 * Turns-to-first-edit and task success rate need an agent driven three times
 * on each side; see docs/BENCHMARK.md.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { BenchTask } from './tasks.js';

/**
 * Bytes per token, for converting a byte count into an approximate token
 * count. Four is the usual rule of thumb for English prose and source code in
 * a BPE tokenizer; it is an approximation, and the byte counts beside it are
 * exact, so a reader can redo the arithmetic with their own ratio.
 */
export const BYTES_PER_TOKEN = 4;

export interface SideMeasurement {
  readonly bytes: number;
  readonly approxTokens: number;
  /** Whole source files pulled into the context window. Zero with the server. */
  readonly filesRead: number;
  /** Tool calls made. Zero without the server. */
  readonly calls: number;
}

export interface TaskMeasurement {
  readonly taskId: string;
  readonly baseline: SideMeasurement;
  readonly withServer: SideMeasurement;
  /** Fraction of baseline bytes saved. Negative when the server costs more. */
  readonly byteReduction: number;
}

function side(bytes: number, filesRead: number, calls: number): SideMeasurement {
  return { bytes, approxTokens: Math.round(bytes / BYTES_PER_TOKEN), filesRead, calls };
}

/** Total bytes of the files an agent would have to read for this task. */
export async function measureBaseline(fixtureRoot: string, task: BenchTask): Promise<SideMeasurement> {
  let bytes = 0;

  for (const file of task.baselineFiles) {
    // A file that cannot be read is a defect in the task definition, not
    // something to quietly score as zero.
    const text = await readFile(join(fixtureRoot, file), 'utf8');
    bytes += Buffer.byteLength(text, 'utf8');
  }

  return side(bytes, task.baselineFiles.length, 0);
}

/** What one tool call returned, as the caller would receive it. */
export type CallRunner = (tool: string, args: Record<string, unknown>) => Promise<string>;

/** Total bytes the server returns for this task's calls. */
export async function measureWithServer(task: BenchTask, run: CallRunner): Promise<SideMeasurement> {
  let bytes = 0;

  for (const call of task.calls) {
    const text = await run(call.tool, call.args);
    bytes += Buffer.byteLength(text, 'utf8');
  }

  return side(bytes, 0, task.calls.length);
}

export async function measureTask(
  fixtureRoot: string,
  task: BenchTask,
  run: CallRunner,
): Promise<TaskMeasurement> {
  const baseline = await measureBaseline(fixtureRoot, task);
  const withServer = await measureWithServer(task, run);

  return {
    taskId: task.id,
    baseline,
    withServer,
    byteReduction: baseline.bytes === 0 ? 0 : 1 - withServer.bytes / baseline.bytes,
  };
}

export interface BenchSummary {
  readonly tasks: readonly TaskMeasurement[];
  readonly totalBaselineBytes: number;
  readonly totalWithServerBytes: number;
  /** Across all tasks, not the mean of the per-task fractions. */
  readonly overallByteReduction: number;
  readonly totalBaselineFilesRead: number;
  readonly totalWithServerFilesRead: number;
}

export function summarize(tasks: readonly TaskMeasurement[]): BenchSummary {
  const totalBaselineBytes = tasks.reduce((sum, task) => sum + task.baseline.bytes, 0);
  const totalWithServerBytes = tasks.reduce((sum, task) => sum + task.withServer.bytes, 0);

  return {
    tasks,
    totalBaselineBytes,
    totalWithServerBytes,
    overallByteReduction: totalBaselineBytes === 0 ? 0 : 1 - totalWithServerBytes / totalBaselineBytes,
    totalBaselineFilesRead: tasks.reduce((sum, task) => sum + task.baseline.filesRead, 0),
    totalWithServerFilesRead: tasks.reduce((sum, task) => sum + task.withServer.filesRead, 0),
  };
}

/** A markdown table of the measurement, for docs/BENCHMARK.md. */
export function formatSummary(summary: BenchSummary): string {
  const percent = (value: number): string => `${(value * 100).toFixed(0)}%`;

  const rows = summary.tasks.map((task) =>
    [
      task.taskId,
      `${task.baseline.filesRead} files / ${task.baseline.approxTokens} tok`,
      `${task.withServer.calls} calls / ${task.withServer.approxTokens} tok`,
      percent(task.byteReduction),
    ].join(' | '),
  );

  return [
    '| Task | Without the server | With it | Context saved |',
    '|---|---|---|---|',
    ...rows.map((row) => `| ${row} |`),
    `| **Total** | **${Math.round(summary.totalBaselineBytes / BYTES_PER_TOKEN)} tok** | ` +
      `**${Math.round(summary.totalWithServerBytes / BYTES_PER_TOKEN)} tok** | ` +
      `**${percent(summary.overallByteReduction)}** |`,
  ].join('\n');
}
