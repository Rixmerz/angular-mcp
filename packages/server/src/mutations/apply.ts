/**
 * The write path shared by every Phase 5 mutation (docs/PLAN.md, section 6).
 *
 * One rule governs all of it: `dry_run` defaults to true, and a mutation
 * returns a diff rather than writing unless the caller explicitly opted in.
 * That default lives here, not in each tool, so a tool added later cannot
 * quietly ship with the opposite one.
 *
 * Writes also go through the same containment check as every read (R11): a
 * mutation may only touch files inside the analyzed workspace.
 */

import { readFile, writeFile } from 'node:fs/promises';

import { assertInsideRoot } from '../tools/internal/paths.js';

import { diffStat, unifiedDiff } from './diff.js';

export interface FileEdit {
  /** Path relative to the analyzed project root. */
  readonly path: string;
  readonly before: string;
  readonly after: string;
}

export interface AppliedEdit {
  readonly path: string;
  readonly diff: string;
  readonly added: number;
  readonly removed: number;
  /** False when `before` and `after` were identical — the edit was a no-op. */
  readonly changed: boolean;
}

export interface ApplyResult {
  readonly dryRun: boolean;
  readonly edits: readonly AppliedEdit[];
  /** Every edit's diff, concatenated, ready to hand to angular_check_rules. */
  readonly diff: string;
  readonly filesChanged: number;
}

/**
 * Turns edits into diffs and, only when `dryRun` is false, writes them.
 *
 * Every path is validated before anything is read or written, and all writes
 * happen after all validation: a mutation touching three files either has
 * three writable paths or writes none of them, instead of leaving two files
 * changed and failing on the third.
 */
export async function applyEdits(
  root: string,
  edits: readonly FileEdit[],
  dryRun: boolean,
): Promise<ApplyResult> {
  const absolutePaths = edits.map((edit) => assertInsideRoot(root, edit.path, 'path'));

  const applied: AppliedEdit[] = edits.map((edit) => {
    const diff = unifiedDiff(edit.path, edit.before, edit.after);
    const { added, removed } = diffStat(diff);
    return { path: edit.path, diff, added, removed, changed: diff.length > 0 };
  });

  if (!dryRun) {
    for (const [index, edit] of edits.entries()) {
      if (!applied[index]?.changed) continue;
      await writeFile(absolutePaths[index]!, edit.after, 'utf8');
    }
  }

  return {
    dryRun,
    edits: applied,
    diff: applied
      .filter((edit) => edit.changed)
      .map((edit) => edit.diff)
      .join(''),
    filesChanged: applied.filter((edit) => edit.changed).length,
  };
}

/** Reads a file inside the project, after validating its path (R11). */
export async function readProjectFile(root: string, relativePath: string): Promise<string> {
  return readFile(assertInsideRoot(root, relativePath, 'path'), 'utf8');
}
