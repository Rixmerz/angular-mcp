/**
 * The two MCP resources from docs/PLAN.md, section 6, Phase 4.
 *
 * Both are derived on read from the same state the tools use — nothing is
 * remembered that could not be re-derived from the code (P1), and neither
 * resource interprets anything (P2): `angular://project/summary` is counts
 * and versions, `angular://rules` is the rules file exactly as it was
 * loaded, including which parts were imported from sheriff or Nx.
 */

import type { NodeKind } from '../graph/model.js';
import { loadEffectiveRules } from '../rules/load.js';
import type { ToolContext } from '../tools/index.js';

export const PROJECT_SUMMARY_URI = 'angular://project/summary';
export const RULES_URI = 'angular://rules';

export interface ResourceContents {
  readonly uri: string;
  readonly mimeType: string;
  readonly text: string;
}

/**
 * Counts, versions and coverage for the indexed project, or an explicit
 * "not indexed yet" document. Reporting a not-yet-derived project as empty
 * would be indistinguishable from a project with nothing in it, so the two
 * are kept apart (P4).
 */
export function readProjectSummary(context: ToolContext): ResourceContents {
  const root = context.resolveRoot();
  const state = context.getStateFor(root);

  if (!state) {
    return {
      uri: PROJECT_SUMMARY_URI,
      mimeType: 'application/json',
      text: JSON.stringify(
        {
          root,
          indexed: false,
          reason: 'This project has not been indexed in this session. Call angular_index_project first.',
        },
        null,
        2,
      ),
    };
  }

  const nodeCountByKind: Partial<Record<NodeKind, number>> = {};
  for (const node of state.result.graph.allNodes()) {
    nodeCountByKind[node.kind] = (nodeCountByKind[node.kind] ?? 0) + 1;
  }

  return {
    uri: PROJECT_SUMMARY_URI,
    mimeType: 'application/json',
    text: JSON.stringify(
      {
        root,
        indexed: true,
        indexedAt: new Date(state.indexedAtMs).toISOString(),
        angularVersion: state.deps.angularVersion,
        typescriptVersion: state.deps.typescriptVersion,
        workspaceKind: state.workspace.kind,
        projects: state.workspace.projects.map((project) => ({
          name: project.name,
          projectType: project.projectType,
          root: project.root,
        })),
        filesProcessed: state.result.stats.filesProcessed,
        nodeCount: state.result.graph.nodeCount,
        nodeCountByKind,
        // Coverage, stated rather than implied: a file the indexer could not
        // read, and a template it could not parse, are both reported here
        // instead of quietly shrinking the graph (P4, R14).
        brokenFileCount: state.result.stats.brokenFiles.length,
        templateParseErrorCount: state.result.stats.parseErrors.length,
      },
      null,
      2,
    ),
  };
}

/**
 * The effective rules for the project: the loaded file plus, for each layer,
 * where it came from. Reads from disk on every call so that editing the
 * rules file is picked up without restarting the server (P1).
 */
export async function readRules(context: ToolContext): Promise<ResourceContents> {
  const root = context.resolveRoot();
  const state = context.getStateFor(root);

  if (!state) {
    return {
      uri: RULES_URI,
      mimeType: 'application/json',
      text: JSON.stringify(
        {
          root,
          loaded: false,
          reason:
            'Rules are read using the project\'s own TypeScript, which is resolved while indexing. ' +
            'Call angular_index_project first.',
        },
        null,
        2,
      ),
    };
  }

  const effective = await loadEffectiveRules(root, { typescript: state.deps.typescript });

  return {
    uri: RULES_URI,
    mimeType: 'application/json',
    text: JSON.stringify(
      {
        root,
        loaded: true,
        layerOrigin: effective.layerOrigin,
        warnings: effective.warnings,
        rules: effective.rules,
      },
      null,
      2,
    ),
  };
}
