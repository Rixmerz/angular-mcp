/**
 * Path validation for every path that reaches the server from a client
 * (docs/PLAN.md, risk R11: "Validate that every path resolves inside the
 * root").
 *
 * The server analyzes exactly one workspace, fixed when it starts. A tool
 * input can name a `root`, a `file` or a list of `files`, and none of them
 * may point outside that workspace: not through `..`, not through an
 * absolute path, and not through a symlink that leaves it. Escapes are
 * rejected with an actionable message rather than clamped, because silently
 * reading a different file than the caller asked for is worse than failing.
 */

import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve as resolvePath, sep } from 'node:path';

import { InvalidInputError } from './errors.js';

/**
 * Resolves symlinks when the path exists, and returns it unchanged when it
 * does not. A path that does not exist yet cannot be traversing anywhere
 * through a link, and the tools report "not indexed"/"not found" for it on
 * their own terms.
 */
function realPathOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/** True when `candidate` is `root` itself or sits underneath it. */
export function isInsideRoot(root: string, candidate: string): boolean {
  const relativePath = relative(realPathOrSelf(root), realPathOrSelf(candidate));
  if (relativePath === '') return true;
  return !relativePath.startsWith(`..${sep}`) && relativePath !== '..' && !isAbsolute(relativePath);
}

/**
 * Validates that `candidate` (absolute, or relative to `root`) stays inside
 * `root`, and returns its absolute form. `label` names the offending input
 * field so the caller knows which one to fix.
 */
export function assertInsideRoot(root: string, candidate: string, label: string): string {
  const absoluteRoot = resolvePath(root);
  const absoluteCandidate = isAbsolute(candidate) ? resolvePath(candidate) : resolvePath(absoluteRoot, candidate);

  if (!isInsideRoot(absoluteRoot, absoluteCandidate)) {
    throw new InvalidInputError(
      `"${candidate}" (in "${label}") resolves outside the analyzed project at "${absoluteRoot}". ` +
        'This server only reads the workspace it was started against; pass a path relative to that root.',
    );
  }

  return absoluteCandidate;
}

/**
 * Validates a tool's `root` input against the workspace the server was
 * started with. A client may omit it, repeat it, or name a project inside
 * the workspace; it may never point somewhere else entirely.
 */
export function assertProjectRoot(configuredRoot: string, inputRoot: string | undefined): string {
  if (inputRoot === undefined || inputRoot.length === 0) return resolvePath(configuredRoot);
  return assertInsideRoot(configuredRoot, inputRoot, 'root');
}

/** Every input field that carries a path, so the guard has one list to walk. */
export const PATH_INPUT_FIELDS = ['file', 'files'] as const;

/**
 * Validates every path-bearing field of a tool input in one place, so a new
 * tool cannot quietly skip the check: the server applies this to every call
 * before the tool's own handler runs.
 */
export function validatePathInputs(configuredRoot: string, rawInput: unknown): void {
  if (typeof rawInput !== 'object' || rawInput === null) return;
  const input = rawInput as Record<string, unknown>;

  const root = assertProjectRoot(configuredRoot, typeof input['root'] === 'string' ? input['root'] : undefined);

  for (const field of PATH_INPUT_FIELDS) {
    const value = input[field];
    if (typeof value === 'string') {
      assertInsideRoot(root, value, field);
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === 'string') assertInsideRoot(root, entry, field);
      }
    }
  }
}
