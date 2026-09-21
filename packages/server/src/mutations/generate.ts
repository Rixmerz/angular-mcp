/**
 * Runs the analyzed project's own Angular CLI, behind `angular_generate`
 * (docs/PLAN.md, section 6, Phase 5): "Wraps `ng generate` (the project's own
 * schematics, custom ones included). It adds value because it resolves the
 * path and the options from the detected conventions."
 *
 * Delegating to the project's schematics is deliberate (R8): they already
 * know that project's conventions, its custom schematics and its
 * `angular.json` defaults, and code they emit is code its own team would have
 * emitted.
 *
 * R11 in full: the CLI is located inside the project and spawned with its
 * arguments as an array — never a shell string, so a component name can never
 * become a command. Every run is bounded by a timeout, and a dry run passes
 * the CLI's own `--dry-run`, so nothing reaches disk unless the caller asked.
 */

import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { assertInsideRoot } from '../tools/internal/paths.js';

/** Long enough for a cold schematic run, short enough that a hung CLI is not forever. */
export const DEFAULT_GENERATE_TIMEOUT_MS = 120_000;

export class GenerateError extends Error {}

/**
 * Schematics this tool will run. `ng generate` can also run arbitrary
 * schematics from any installed package, which is a wide surface to expose
 * to a tool an agent drives; the list covers what the plan's use cases need
 * and an unknown name is refused by name rather than passed through.
 */
export const ALLOWED_SCHEMATICS = [
  'component',
  'directive',
  'pipe',
  'service',
  'guard',
  'interceptor',
  'resolver',
  'module',
  'class',
  'interface',
  'enum',
] as const;

export type AllowedSchematic = (typeof ALLOWED_SCHEMATICS)[number];

/**
 * A CLI option, already split into flag and value so neither can smuggle the
 * other. Values are passed as their own argv entries.
 */
export interface GenerateOption {
  readonly flag: string;
  readonly value?: string;
}

export interface GenerateRequest {
  readonly root: string;
  readonly schematic: string;
  readonly name: string;
  readonly options?: readonly GenerateOption[];
  readonly dryRun: boolean;
  readonly timeoutMs?: number;
}

export interface GenerateResult {
  readonly command: readonly string[];
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly dryRun: boolean;
}

/** `ng` as installed in the analyzed project. Never a globally installed one. */
export async function resolveProjectCli(root: string): Promise<string> {
  const candidates = [
    join(root, 'node_modules', '@angular', 'cli', 'bin', 'ng.js'),
    join(root, 'node_modules', '.bin', 'ng'),
  ];

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      continue;
    }
  }

  throw new GenerateError(
    `The Angular CLI is not installed in "${root}". Run "npm install" (or your package manager's equivalent) ` +
      'in that project first: this tool deliberately uses the project\'s own CLI and schematics, never a global one.',
  );
}

/** A schematic name must be one this tool knows, and a target name must look like one. */
export function validateGenerateInput(schematic: string, name: string): void {
  if (!(ALLOWED_SCHEMATICS as readonly string[]).includes(schematic)) {
    throw new GenerateError(
      `Unsupported schematic "${schematic}". Supported: ${ALLOWED_SCHEMATICS.join(', ')}. ` +
        'Run another schematic with the CLI directly.',
    );
  }

  // A name is a path plus an identifier — never a flag, and never anything
  // that would be meaningful to a shell if one were ever introduced.
  if (!/^[A-Za-z0-9._\-/]+$/.test(name) || name.startsWith('-')) {
    throw new GenerateError(
      `Invalid name "${name}". Use letters, digits, dots, dashes, underscores and slashes, e.g. "features/users/user-card".`,
    );
  }
}

function runCli(
  cliPath: string,
  args: readonly string[],
  cwd: string,
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    // execFile, not exec: arguments stay an array and are never parsed by a
    // shell (R11). `shell` defaults to false and is left that way.
    execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: { ...process.env } },
      (error, stdout, stderr) => {
        if (error && (error as NodeJS.ErrnoException & { killed?: boolean }).killed) {
          reject(new GenerateError(`The Angular CLI did not finish within ${timeoutMs} ms and was stopped.`));
          return;
        }
        const exitCode = typeof (error as { code?: unknown })?.code === 'number' ? ((error as { code: number }).code) : 0;
        resolve({ stdout, stderr, exitCode });
      },
    );
  });
}

/**
 * Runs `ng generate <schematic> <name>` in the analyzed project.
 *
 * A dry run adds the CLI's own `--dry-run`, so the schematic reports what it
 * would create without writing it — the plan's default, enforced by the CLI
 * itself rather than by this wrapper pretending to.
 */
export async function runGenerate(request: GenerateRequest): Promise<GenerateResult> {
  const { root, schematic, name, dryRun } = request;

  validateGenerateInput(schematic, name);
  // Belt and braces: a name is a path fragment, so it must land inside the project.
  assertInsideRoot(root, name, 'name');

  const cliPath = await resolveProjectCli(root);

  const args = ['generate', schematic, name];
  for (const option of request.options ?? []) {
    if (!/^--[a-z0-9-]+$/i.test(option.flag)) {
      throw new GenerateError(`Invalid option flag "${option.flag}". Flags look like "--standalone" or "--skip-tests".`);
    }
    args.push(option.flag);
    if (option.value !== undefined) args.push(option.value);
  }
  if (dryRun) args.push('--dry-run');

  const { stdout, stderr, exitCode } = await runCli(
    cliPath,
    args,
    root,
    request.timeoutMs ?? DEFAULT_GENERATE_TIMEOUT_MS,
  );

  return { command: ['ng', ...args], stdout, stderr, exitCode, dryRun };
}

export interface ParsedGenerateFile {
  readonly action: 'create' | 'update' | 'delete';
  readonly path: string;
}

/**
 * Parses the file list out of the CLI's output.
 *
 * The CLI prints lines like `CREATE src/app/foo/foo.component.ts (123 bytes)`,
 * and in a dry run it prints the same lines plus a note that nothing was
 * written. Parsing them gives the caller the same file list either way.
 */
export function parseGeneratedFiles(output: string): ParsedGenerateFile[] {
  const files: ParsedGenerateFile[] = [];

  for (const line of output.split('\n')) {
    const match = /^\s*(CREATE|UPDATE|DELETE)\s+(\S+)/.exec(line);
    if (!match) continue;
    files.push({
      action: match[1]!.toLowerCase() as ParsedGenerateFile['action'],
      path: match[2]!,
    });
  }

  return files;
}
