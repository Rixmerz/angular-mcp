/**
 * Index orchestrator. See docs/PLAN.md, sections 4.1 and 7 ("Phase 1 —
 * Indexer and queries").
 *
 * Ties together the workspace loader, one `ts.Program` per workspace project,
 * and every extractor (`decorators`, `di`, `signals`, `templates`, `routes`,
 * `http`, `specs`, `modules`) into a single `ProjectGraph`, incrementally by
 * file hash (see incremental.ts). A broken file is recorded and skipped, it
 * never aborts the rest of the index (R14, "the index aborts because of a
 * single file" is the warning sign to avoid).
 *
 * Every extractor is AST-only (no type checker, see program.ts's header), so
 * files are re-parsed here with their `fileName` set to the project-relative
 * path: several extractors (`routes.ts` in particular) derive a node's path
 * straight from `sourceFile.fileName`, and `NodeId`s must always be relative
 * (graph/model.ts).
 */

import { readFile } from 'node:fs/promises';
import { isAbsolute, join, relative } from 'node:path';

import type * as TS from 'typescript';

import { GraphCache, hashContent } from '../graph/cache.js';
import { ProjectGraph } from '../graph/index.js';
import type { ComponentNode, GraphEdge, GraphNode, NgModuleNode, NodeKind, TemplateNode } from '../graph/model.js';
import { normalizeRelativePath } from '../graph/model.js';

import { extractDecorators } from './extractors/decorators.js';
import { extractInjections } from './extractors/di.js';
import { extractHttpCalls } from './extractors/http.js';
import { extractModules } from './extractors/modules.js';
import { extractRoutes } from './extractors/routes.js';
import type { ComponentScope, SelectorTargetNode } from './extractors/selectors.js';
import { resolveComponentScope } from './extractors/selectors.js';
import { extractSignals } from './extractors/signals.js';
import { extractSpec } from './extractors/specs.js';
import { extractTemplate } from './extractors/templates.js';
import { loadProgramsForProject } from './program.js';
import { loadWorkspace } from './workspace.js';
import { hydrateReusedFiles, planIncrementalIndex } from './incremental.js';

export interface IndexProjectOptions {
  /** Root of the analyzed project (an Angular workspace, or a plain tsconfig project). */
  readonly root: string;
  /** The analyzed project's own `typescript`, resolved with resolve.ts. */
  readonly typescript: typeof TS;
  /** The analyzed project's own `@angular/compiler`, resolved with resolve.ts. */
  readonly angularCompiler: unknown;
  /** Cache directory, relative to `root`. Defaults to `.angular-mcp/cache`. */
  readonly cacheDir?: string;
  /** Ignores any existing cache and reindexes every file from scratch. */
  readonly force?: boolean;
}

export interface FileError {
  readonly file: string;
  readonly message: string;
}

export interface TemplateParseError extends FileError {
  readonly line?: number;
  readonly column?: number;
}

export interface IndexStats {
  /** Node count per kind, across the whole graph after this run. */
  readonly nodesByType: Readonly<Partial<Record<NodeKind, number>>>;
  /** Total number of files known to the project after this run (reindexed + reused). */
  readonly filesProcessed: number;
  /** Files actually (re)extracted in this run: hash was missing or had changed. */
  readonly filesReindexed: number;
  /** Files whose cached facts were reused as-is because their hash was unchanged. */
  readonly filesReused: number;
  /** Files that were cached but no longer exist. */
  readonly filesRemoved: number;
  readonly elapsedMs: number;
  /** Template parse errors found in this run (R14: recorded, never fatal). */
  readonly parseErrors: readonly TemplateParseError[];
  /** Files that threw while being extracted. Every other file was still processed. */
  readonly brokenFiles: readonly FileError[];
}

export interface IndexResult {
  readonly graph: ProjectGraph;
  readonly stats: IndexStats;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function countNodesByType(graph: ProjectGraph): Partial<Record<NodeKind, number>> {
  const counts: Partial<Record<NodeKind, number>> = {};
  for (const node of graph.allNodes()) {
    counts[node.kind] = (counts[node.kind] ?? 0) + 1;
  }
  return counts;
}

function isSelectorTarget(node: GraphNode): node is SelectorTargetNode {
  return node.kind === 'Component' || node.kind === 'Directive' || node.kind === 'Pipe';
}

/** Runs every per-file, AST-only extractor over a single source file. */
function extractFile(
  typescript: typeof TS,
  sourceFile: TS.SourceFile,
  relativePath: string,
  graph: ProjectGraph,
): void {
  // Drop whatever this file produced on a previous run before re-deriving it,
  // so a removed class/route/etc. does not linger (R2).
  graph.removeFile(relativePath);

  graph.addNodes(extractDecorators(typescript, sourceFile, relativePath).nodes);
  graph.addNodes(extractSignals(typescript, sourceFile, relativePath));
  graph.addEdges(extractInjections(typescript, sourceFile, relativePath));

  const modules = extractModules(typescript, sourceFile, relativePath);
  graph.addNodes(modules.nodes);
  graph.addEdges(modules.edges);

  const routes = extractRoutes(typescript, sourceFile);
  graph.addNodes(routes.nodes);
  graph.addEdges(routes.edges);

  const http = extractHttpCalls(typescript, sourceFile, relativePath);
  graph.addNodes(http.nodes);
  graph.addEdges(http.edges);

  if (relativePath.endsWith('.spec.ts')) {
    const spec = extractSpec(typescript, sourceFile, relativePath);
    graph.addNode(spec.node);
    graph.addEdges(spec.edges);
  }
}

/**
 * Finds, inside `sourceFile`, the inline `template: '...'` (or template
 * literal) of the `@Component`-decorated class named `className`. Resolving
 * which component a template tag belongs to is templates.ts's job; this only
 * recovers the raw source text extractTemplate() needs, since decorators.ts
 * does not retain it (only `inlineTemplate: boolean`, see graph/model.ts).
 */
function findInlineTemplateSource(
  typescript: typeof TS,
  sourceFile: TS.SourceFile,
  className: string,
): string | undefined {
  let templateSource: string | undefined;

  function visit(node: TS.Node): void {
    if (
      typescript.isClassDeclaration(node) &&
      node.name?.text === className &&
      typescript.canHaveDecorators(node)
    ) {
      for (const decorator of typescript.getDecorators(node) ?? []) {
        const expr = decorator.expression;
        if (!typescript.isCallExpression(expr) || !typescript.isIdentifier(expr.expression)) continue;
        if (expr.expression.text !== 'Component') continue;

        const metadata = expr.arguments[0];
        if (!metadata || !typescript.isObjectLiteralExpression(metadata)) continue;

        for (const prop of metadata.properties) {
          if (!typescript.isPropertyAssignment(prop)) continue;
          const key = typescript.isIdentifier(prop.name) ? prop.name.text : undefined;
          if (key === 'template' && typescript.isStringLiteralLike(prop.initializer)) {
            templateSource = prop.initializer.text;
          }
        }
      }
    }
    typescript.forEachChild(node, visit);
  }

  visit(sourceFile);
  return templateSource;
}

function memberKindsOf(graph: ProjectGraph, component: ComponentNode): ReadonlyMap<string, 'signal' | 'observable'> {
  const memberKinds = new Map<string, 'signal' | 'observable'>();

  for (const node of graph.nodesByFile(component.path)) {
    if ((node.kind !== 'Signal' && node.kind !== 'Observable') || node.ownerRef !== component.id) continue;
    memberKinds.set(node.name, node.kind === 'Signal' ? 'signal' : 'observable');
  }

  return memberKinds;
}

/** Reads (or recovers) a component's template source and extracts it, never throwing (R14). */
async function resolveComponentTemplate(
  root: string,
  typescript: typeof TS,
  angularCompiler: unknown,
  component: ComponentNode,
  sourceFile: TS.SourceFile,
  scope: ComponentScope | undefined,
  memberKinds: ReadonlyMap<string, 'signal' | 'observable'>,
): Promise<{ templateNode: TemplateNode; edges: readonly GraphEdge[] } | undefined> {
  let templateSource: string | undefined;
  let templatePath: string;
  const inline = component.inlineTemplate;

  if (inline) {
    templateSource = findInlineTemplateSource(typescript, sourceFile, component.name);
    templatePath = component.path;
  } else if (component.templatePath) {
    templatePath = component.templatePath;
    try {
      templateSource = await readFile(join(root, templatePath), 'utf8');
    } catch {
      templateSource = undefined;
    }
  } else {
    return undefined;
  }

  if (templateSource === undefined) return undefined;

  const result = extractTemplate({
    angularCompiler,
    templateSource,
    templatePath,
    inline,
    ownerRef: component.id,
    ownerFilePath: component.path,
    scope,
    memberKinds,
  });

  return { templateNode: result.templateNode, edges: result.edges };
}

/**
 * Indexes a whole project: loads its workspace, builds one `ts.Program` per
 * declared project, runs every extractor over every source file (only the
 * ones whose hash changed since the last run, see incremental.ts), and
 * returns the resulting graph together with a summary (nodes per type, files
 * processed, elapsed time, parse errors) as required by the
 * `angular_index_project` tool (docs/PLAN.md, section 6).
 */
/**
 * True when `absolutePath` belongs to the analyzed project rather than to a
 * dependency. A program's source files include every `.ts` it had to read,
 * which on a real workspace means the whole of `node_modules`; indexing that
 * would be both wrong and enormous.
 */
function isInsideProject(root: string, absolutePath: string): boolean {
  const relativePath = normalizeRelativePath(relative(root, absolutePath));
  if (relativePath === '' || relativePath.startsWith('../') || isAbsolute(relativePath)) return false;
  return !relativePath.split('/').includes('node_modules');
}

export async function indexProject(options: IndexProjectOptions): Promise<IndexResult> {
  const start = Date.now();
  const { typescript, angularCompiler } = options;

  const brokenFiles: FileError[] = [];
  const parseErrors: TemplateParseError[] = [];

  const workspace = await loadWorkspace(options.root);
  const root = workspace.root;

  const graph = new ProjectGraph();
  const cache = new GraphCache(root, options.cacheDir);
  const cached = options.force ? undefined : await cache.read();

  const sourceFileByPath = new Map<string, TS.SourceFile>();
  const currentHashes = new Map<string, string>();

  for (const project of workspace.projects) {
    const { programs, errors } = loadProgramsForProject(typescript, project);
    for (const { file, error } of errors) {
      brokenFiles.push({ file, message: messageOf(error) });
    }

    for (const loaded of programs) {
      // Every source file the program pulled in, not just `rootFileNames`: a
      // standard Angular `tsconfig.app.json` lists a single root file
      // ("files": ["src/main.ts"]), so the root names alone would index one
      // file and miss the entire application. `getSourceFiles()` is the whole
      // transitive closure, which is what the compiler itself type-checks.
      //
      // Known limit, declared rather than papered over (P4): a file that
      // nothing imports and that no tsconfig lists is not part of any program
      // and therefore is not indexed.
      for (const originalSourceFile of loaded.program.getSourceFiles()) {
        const absolutePath = originalSourceFile.fileName;
        if (originalSourceFile.isDeclarationFile) continue;
        if (!isInsideProject(root, absolutePath)) continue;

        const relativePath = normalizeRelativePath(relative(root, absolutePath));
        if (sourceFileByPath.has(relativePath)) continue;

        // Re-parsed with a project-relative fileName: NodeIds must be relative
        // (graph/model.ts), and extractRoutes derives its path straight from
        // `sourceFile.fileName`.
        const relativeSourceFile = typescript.createSourceFile(
          relativePath,
          originalSourceFile.text,
          originalSourceFile.languageVersion,
          true,
        );

        sourceFileByPath.set(relativePath, relativeSourceFile);
        currentHashes.set(relativePath, hashContent(originalSourceFile.text));
      }
    }
  }

  const plan = planIncrementalIndex(cached, currentHashes);

  if (cached) {
    hydrateReusedFiles(graph, cached, plan.toReuse);
  }

  let filesReindexed = 0;
  for (const relativePath of plan.toIndex) {
    const sourceFile = sourceFileByPath.get(relativePath);
    if (!sourceFile) continue;

    try {
      extractFile(typescript, sourceFile, relativePath, graph);
      filesReindexed += 1;
    } catch (error) {
      brokenFiles.push({ file: relativePath, message: messageOf(error) });
    }
  }

  // Templates and selector scopes need every node in the graph to be known
  // first (a standalone component can import a sibling reindexed in this same
  // run), so this only runs once every file in `toIndex` has been processed.
  const knownNodes = graph.allNodes().filter(isSelectorTarget);
  const ngModules = graph.nodesByKind('NgModule') as NgModuleNode[];
  const ngModuleSourceFiles = new Map<string, TS.SourceFile>();
  for (const ngModule of ngModules) {
    const sourceFile = sourceFileByPath.get(ngModule.path);
    if (sourceFile) ngModuleSourceFiles.set(ngModule.path, sourceFile);
  }

  for (const relativePath of plan.toIndex) {
    const sourceFile = sourceFileByPath.get(relativePath);
    if (!sourceFile) continue;

    const components = graph
      .nodesByFile(relativePath)
      .filter((node): node is ComponentNode => node.kind === 'Component');

    for (const component of components) {
      try {
        const scope = resolveComponentScope({
          typescript,
          component,
          componentSourceFile: sourceFile,
          ngModules,
          ngModuleSourceFiles,
          knownNodes,
        });

        const memberKinds = memberKindsOf(graph, component);
        const templateResult = await resolveComponentTemplate(
          root,
          typescript,
          angularCompiler,
          component,
          sourceFile,
          scope,
          memberKinds,
        );

        if (templateResult) {
          graph.addNode(templateResult.templateNode);
          graph.addEdges(templateResult.edges);

          for (const parseError of templateResult.templateNode.parseErrors) {
            parseErrors.push({
              file: templateResult.templateNode.path,
              message: parseError.message,
              line: parseError.line,
              column: parseError.column,
            });
          }
        }
      } catch (error) {
        brokenFiles.push({ file: relativePath, message: messageOf(error) });
      }
    }
  }

  await cache.write(graph, currentHashes);

  return {
    graph,
    stats: {
      nodesByType: countNodesByType(graph),
      filesProcessed: currentHashes.size,
      filesReindexed,
      filesReused: plan.toReuse.length,
      filesRemoved: plan.toRemove.length,
      elapsedMs: Date.now() - start,
      parseErrors,
      brokenFiles,
    },
  };
}
