/**
 * Recomputes the current per-file content hashes of a workspace, without
 * running the full indexer. Used by `angular_get_index_status` (docs/PLAN.md
 * risk R2) to tell whether the last indexed graph is still fresh, mirroring
 * the file discovery `indexProject` itself does (src/indexer/index.ts) but
 * stopping short of extracting anything.
 */

import { relative } from 'node:path';

import type * as TS from 'typescript';

import { hashFile } from '../../graph/cache.js';
import { normalizeRelativePath } from '../../graph/model.js';
import { loadProgramForProject } from '../../indexer/program.js';
import type { Workspace } from '../../indexer/workspace.js';

export interface BrokenProject {
  readonly project: string;
  readonly message: string;
}

export interface CurrentFileHashes {
  readonly hashes: ReadonlyMap<string, string>;
  readonly brokenProjects: readonly BrokenProject[];
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function collectCurrentFileHashes(typescript: typeof TS, workspace: Workspace): Promise<CurrentFileHashes> {
  const hashes = new Map<string, string>();
  const brokenProjects: BrokenProject[] = [];

  for (const project of workspace.projects) {
    let rootFileNames: readonly string[];
    try {
      rootFileNames = loadProgramForProject(typescript, project).rootFileNames;
    } catch (error) {
      brokenProjects.push({ project: project.name, message: messageOf(error) });
      continue;
    }

    for (const absolutePath of rootFileNames) {
      const relativePath = normalizeRelativePath(relative(workspace.root, absolutePath));
      if (hashes.has(relativePath)) continue;
      try {
        hashes.set(relativePath, await hashFile(absolutePath));
      } catch (error) {
        brokenProjects.push({ project: project.name, message: `${relativePath}: ${messageOf(error)}` });
      }
    }
  }

  return { hashes, brokenProjects };
}
