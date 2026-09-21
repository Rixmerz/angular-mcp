/**
 * Unified diffs for the Phase 5 mutation tools (docs/PLAN.md, section 6).
 *
 * Every mutation returns a diff before it returns anything else: the plan's
 * rule is `dry_run: true` by default, "returning a diff, never writing
 * directly without confirmation". A diff the caller can read is what makes
 * that confirmation meaningful, so it is generated the same way whether the
 * change is then written or not.
 *
 * Implemented here rather than pulled in: the only operation needed is a
 * line-level longest-common-subsequence over two small files, and a
 * dependency that has to be resolved from the analyzed project (4.2) or
 * bundled is a worse trade than thirty lines of table.
 */

export interface DiffOptions {
  /** Lines of unchanged context around each hunk. */
  readonly context?: number;
}

const DEFAULT_CONTEXT = 3;

type Op = { readonly kind: 'equal' | 'delete' | 'insert'; readonly line: string };

/**
 * Line-level LCS. Quadratic in the number of lines, which is the right trade
 * for single source files; a mutation that rewrote something large enough for
 * that to matter would be out of this phase's scope anyway.
 */
function diffLines(before: readonly string[], after: readonly string[]): Op[] {
  const rows = before.length;
  const columns = after.length;

  // lengths[i][j] = LCS length of before[i..] and after[j..]
  const lengths: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(columns + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = columns - 1; j >= 0; j -= 1) {
      lengths[i]![j] =
        before[i] === after[j]
          ? (lengths[i + 1]![j + 1] ?? 0) + 1
          : Math.max(lengths[i + 1]![j] ?? 0, lengths[i]![j + 1] ?? 0);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < columns) {
    if (before[i] === after[j]) {
      ops.push({ kind: 'equal', line: before[i]! });
      i += 1;
      j += 1;
    } else if ((lengths[i + 1]![j] ?? 0) >= (lengths[i]![j + 1] ?? 0)) {
      ops.push({ kind: 'delete', line: before[i]! });
      i += 1;
    } else {
      ops.push({ kind: 'insert', line: after[j]! });
      j += 1;
    }
  }
  while (i < rows) {
    ops.push({ kind: 'delete', line: before[i]! });
    i += 1;
  }
  while (j < columns) {
    ops.push({ kind: 'insert', line: after[j]! });
    j += 1;
  }

  return ops;
}

interface Hunk {
  beforeStart: number;
  beforeCount: number;
  afterStart: number;
  afterCount: number;
  lines: string[];
}

/**
 * A unified diff of `before` against `after`, labelled with `path` on both
 * sides. Returns an empty string when the two are identical, which is how
 * callers tell "nothing to do" from "here is the change".
 */
export function unifiedDiff(
  path: string,
  before: string,
  after: string,
  options: DiffOptions = {},
): string {
  if (before === after) return '';

  const context = options.context ?? DEFAULT_CONTEXT;
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const ops = diffLines(beforeLines, afterLines);

  const hunks: Hunk[] = [];
  let current: Hunk | undefined;
  let beforeLine = 1;
  let afterLine = 1;
  let trailingEqual = 0;

  const flush = (): void => {
    if (!current) return;
    // Drop context beyond the limit that accumulated after the last change.
    const excess = Math.max(0, trailingEqual - context);
    if (excess > 0) {
      current.lines.splice(current.lines.length - excess, excess);
      current.beforeCount -= excess;
      current.afterCount -= excess;
    }
    hunks.push(current);
    current = undefined;
    trailingEqual = 0;
  };

  // Equal lines waiting to become leading context for the next hunk.
  const pending: { line: string; beforeLine: number; afterLine: number }[] = [];

  for (const op of ops) {
    if (op.kind === 'equal') {
      if (current) {
        current.lines.push(` ${op.line}`);
        current.beforeCount += 1;
        current.afterCount += 1;
        trailingEqual += 1;
        if (trailingEqual > context * 2) flush();
      } else {
        pending.push({ line: op.line, beforeLine, afterLine });
        if (pending.length > context) pending.shift();
      }
      beforeLine += 1;
      afterLine += 1;
      continue;
    }

    if (!current) {
      const first = pending[0];
      current = {
        beforeStart: first?.beforeLine ?? beforeLine,
        afterStart: first?.afterLine ?? afterLine,
        beforeCount: pending.length,
        afterCount: pending.length,
        lines: pending.map((entry) => ` ${entry.line}`),
      };
      pending.length = 0;
    }
    trailingEqual = 0;

    if (op.kind === 'delete') {
      current.lines.push(`-${op.line}`);
      current.beforeCount += 1;
      beforeLine += 1;
    } else {
      current.lines.push(`+${op.line}`);
      current.afterCount += 1;
      afterLine += 1;
    }
  }
  flush();

  const header = [`--- a/${path}`, `+++ b/${path}`];
  const body = hunks.map(
    (hunk) =>
      `@@ -${hunk.beforeStart},${hunk.beforeCount} +${hunk.afterStart},${hunk.afterCount} @@\n${hunk.lines.join('\n')}`,
  );

  return `${header.join('\n')}\n${body.join('\n')}\n`;
}

/** Counts added and removed lines in a unified diff, for a one-line summary. */
export function diffStat(diff: string): { readonly added: number; readonly removed: number } {
  let added = 0;
  let removed = 0;

  for (const line of diff.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1;
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1;
  }

  return { added, removed };
}
