/**
 * Parses a unified diff and scopes rule evaluation to what it actually
 * touches. See docs/PLAN.md, section 6: `angular_check_rules` is the
 * gatekeeper an agent calls with a diff before or after writing a change, and
 * it must report only violations the diff introduces — not every
 * pre-existing violation in the rest of the project.
 */

import type { ProjectGraph } from '../graph/index.js';
import type { GraphNode, NodeId } from '../graph/model.js';
import { normalizeRelativePath } from '../graph/model.js';
import { evaluateRules } from './evaluate.js';
import type { Violation } from './evaluate.js';
import type { RulesFile } from './schema.js';

export type DiffFileStatus = 'added' | 'modified' | 'deleted';

export interface DiffFileChange {
  /** Normalized relative path: the new path, or the old path for a deleted file. */
  readonly path: string;
  readonly status: DiffFileStatus;
  /** 1-based line numbers, in the NEW version of the file, that this diff adds. */
  readonly addedLines: readonly number[];
}

interface WorkingFile {
  oldPath?: string;
  newPath?: string;
  oldIsDevNull: boolean;
  newIsDevNull: boolean;
  addedLines: number[];
  newLineNumber: number;
}

const GIT_HEADER_RE = /^diff --git a\/(.+) b\/(.+)$/;
const OLD_HEADER_RE = /^--- (?:a\/(.+)|\/dev\/null)/;
const NEW_HEADER_RE = /^\+\+\+ (?:b\/(.+)|\/dev\/null)/;
const HUNK_HEADER_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

function toChange(file: WorkingFile): DiffFileChange | undefined {
  if (file.newIsDevNull) {
    if (!file.oldPath) return undefined;
    return { path: normalizeRelativePath(file.oldPath), status: 'deleted', addedLines: [] };
  }
  if (!file.newPath) return undefined;
  return {
    path: normalizeRelativePath(file.newPath),
    status: file.oldIsDevNull ? 'added' : 'modified',
    addedLines: file.addedLines,
  };
}

/**
 * Parses a unified diff (as produced by `git diff`, with or without the
 * `diff --git` header) into the files it touches, each with the 1-based new
 * file line numbers it adds. A rename with no content change (no hunks)
 * is reported with an empty `addedLines`, since there is nothing to check.
 */
export function parseUnifiedDiff(diffText: string): DiffFileChange[] {
  const files: WorkingFile[] = [];
  let active: WorkingFile | undefined;
  let pendingFromGitHeader = false;

  for (const rawLine of diffText.split('\n')) {
    const gitHeader = GIT_HEADER_RE.exec(rawLine);
    if (gitHeader) {
      active = {
        oldPath: gitHeader[1],
        newPath: gitHeader[2],
        oldIsDevNull: false,
        newIsDevNull: false,
        addedLines: [],
        newLineNumber: 0,
      };
      files.push(active);
      pendingFromGitHeader = true;
      continue;
    }

    const oldHeader = OLD_HEADER_RE.exec(rawLine);
    if (oldHeader) {
      if (!pendingFromGitHeader || !active) {
        active = { oldIsDevNull: false, newIsDevNull: false, addedLines: [], newLineNumber: 0 };
        files.push(active);
      }
      pendingFromGitHeader = false;
      if (oldHeader[1] !== undefined) active.oldPath = oldHeader[1];
      else active.oldIsDevNull = true;
      continue;
    }

    const newHeader = NEW_HEADER_RE.exec(rawLine);
    if (newHeader && active) {
      if (newHeader[1] !== undefined) active.newPath = newHeader[1];
      else active.newIsDevNull = true;
      continue;
    }

    const hunkHeader = HUNK_HEADER_RE.exec(rawLine);
    if (hunkHeader && active) {
      active.newLineNumber = Number.parseInt(hunkHeader[1]!, 10);
      continue;
    }

    if (!active || active.newLineNumber === 0) continue;

    if (rawLine.startsWith('+') && !rawLine.startsWith('+++')) {
      active.addedLines.push(active.newLineNumber);
      active.newLineNumber += 1;
    } else if (rawLine.startsWith('-') && !rawLine.startsWith('---')) {
      // Old-only line: absent from the new file, no new line number to advance.
    } else if (rawLine.startsWith('\\')) {
      // "\ No newline at end of file" — not a content line.
    } else {
      active.newLineNumber += 1;
    }
  }

  return files.map(toChange).filter((file): file is DiffFileChange => file !== undefined);
}

/**
 * Evaluates `rules` against `graph`, restricted to the files `diffText`
 * touches: only edges with an endpoint in a touched file's nodes are
 * checked, and `require` constraints only apply to nodes in touched files.
 * The graph is assumed to already reflect the diff's content (the project
 * was (re)indexed after the change was made or written to disk — P1, derive
 * from the code, never from the diff text itself).
 */
export function evaluateDiff(graph: ProjectGraph, rules: RulesFile, diffText: string): Violation[] {
  const changes = parseUnifiedDiff(diffText);
  const touchedPaths = new Set(
    changes.filter((change) => change.status !== 'deleted').map((change) => normalizeRelativePath(change.path)),
  );

  const touchedNodeIds = new Set<NodeId>();
  for (const path of touchedPaths) {
    for (const node of graph.nodesByFile(path)) touchedNodeIds.add(node.id);
  }

  const edges = graph.allEdges().filter((edge) => touchedNodeIds.has(edge.from) || touchedNodeIds.has(edge.to));

  return evaluateRules(graph, rules, {
    edges,
    nodeFilter: (node: GraphNode) => touchedNodeIds.has(node.id),
  });
}
