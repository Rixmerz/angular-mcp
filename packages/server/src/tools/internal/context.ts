/**
 * Per-session state shared by every Phase 1 tool. See docs/PLAN.md, section 4.1.
 *
 * A single `ToolContext` holds, at most, the result of the last successful
 * `angular_index_project` run: the graph, the resolved project dependencies
 * (typescript/@angular/compiler, R1), and the workspace layout. Every other
 * tool reads from it instead of touching disk or re-deriving anything
 * (P1: derive, don't remember — the context is only a cache of the last
 * derivation, never a second source of truth).
 *
 * It is intentionally single-project: an MCP server instance analyzes one
 * Angular workspace at a time (docs/PLAN.md, section 4). Calling a tool with
 * a `root` that does not match the last indexed one is treated as "not
 * indexed" (R2: never serve facts about a project that was never derived).
 */

import { resolve as resolvePath } from 'node:path';

import type { ProjectGraph } from '../../graph/index.js';
import type { IndexResult } from '../../indexer/index.js';
import type { ResolvedProjectDependencies } from '../../indexer/resolve.js';
import type { Workspace } from '../../indexer/workspace.js';

import { NotIndexedError } from './errors.js';

export interface IndexedState {
  readonly root: string;
  readonly result: IndexResult;
  readonly deps: ResolvedProjectDependencies;
  readonly workspace: Workspace;
  readonly indexedAtMs: number;
}

export interface ToolContextOptions {
  /** Root of the analyzed project used when a tool call omits `root`. */
  readonly defaultRoot: string;
  /** Cache directory passed through to `indexProject`. Defaults to `.angular-mcp/cache`. */
  readonly cacheDir?: string;
}

export class ToolContext {
  private state: IndexedState | undefined;

  constructor(private readonly options: ToolContextOptions) {}

  get defaultRoot(): string {
    return this.options.defaultRoot;
  }

  get cacheDir(): string | undefined {
    return this.options.cacheDir;
  }

  /** Resolves a tool's optional `root` input against the configured default, both as absolute paths. */
  resolveRoot(inputRoot?: string): string {
    return resolvePath(inputRoot && inputRoot.length > 0 ? inputRoot : this.options.defaultRoot);
  }

  getState(): IndexedState | undefined {
    return this.state;
  }

  setState(state: IndexedState): void {
    this.state = { ...state, root: resolvePath(state.root) };
  }

  /** State for `root`, or `undefined` when that root was never (successfully) indexed in this session. */
  getStateFor(root: string): IndexedState | undefined {
    if (!this.state || this.state.root !== resolvePath(root)) return undefined;
    return this.state;
  }

  /** Graph for `root`. Throws `NotIndexedError` (actionable) instead of returning `undefined`. */
  requireGraph(root: string): ProjectGraph {
    const state = this.getStateFor(root);
    if (!state) throw new NotIndexedError(root);
    return state.result.graph;
  }
}
