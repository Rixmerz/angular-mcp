/**
 * The three Phase 5 tools (docs/PLAN.md, section 6): `angular_generate`,
 * `angular_add_route` and `angular_add_dependency`.
 *
 * These are the only tools in the server that can write, which is why they
 * share one rule, stated in the plan and enforced here: `dry_run` defaults to
 * **true**, and every one of them returns a unified diff whether or not it
 * writes. An agent is expected to read the diff, run `angular_check_rules`
 * over it, and only then call again with `dry_run: false`.
 *
 * Their annotations say so honestly: `readOnlyHint: false`, because the tool
 * *can* write, even though its default does not.
 */

import type * as TS from 'typescript';
import { z } from 'zod';

import { addDependency } from '../mutations/add_dependency.js';
import type { AddDependencyRequest, AddDependencyResult } from '../mutations/add_dependency.js';
import { addRoute } from '../mutations/add_route.js';
import { applyEdits, readProjectFile } from '../mutations/apply.js';
import { ALLOWED_SCHEMATICS, parseGeneratedFiles, runGenerate } from '../mutations/generate.js';
import { countInjectionStyles } from '../mutations/style.js';
import type { InjectionStyleCounts } from '../mutations/style.js';

import { defineTool } from './internal/define.js';
import type { ToolAnnotations } from './internal/define.js';
import { InvalidInputError } from './internal/errors.js';
import { rootInputField } from './internal/schemas.js';

/**
 * A mutation adds code; it does not delete or overwrite other people's work,
 * and it never reaches outside the workspace. It is not idempotent: calling
 * `angular_generate` twice is not the same as calling it once.
 */
const MUTATION_ANNOTATIONS: ToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

const dryRunField = z
  .boolean()
  .optional()
  .describe(
    'Defaults to true: the change is computed and returned as a diff, and nothing is written. Pass false only ' +
      'after reviewing that diff — ideally after running angular_check_rules over it (docs/PLAN.md, Phase 5).',
  );

const diffOutputFields = {
  dryRun: z.boolean().describe('True when nothing was written.'),
  filesChanged: z.number().int(),
  diff: z.string().describe('Unified diff of the change, empty when there was nothing to do.'),
};

/** Counts both injection styles across the whole indexed project, for a class that injects nothing yet. */
async function projectInjectionCounts(
  typescript: typeof TS,
  root: string,
  paths: readonly string[],
): Promise<InjectionStyleCounts> {
  let injectCalls = 0;
  let constructorParameters = 0;

  for (const path of paths) {
    let text: string;
    try {
      text = await readProjectFile(root, path);
    } catch {
      continue;
    }

    const sourceFile = typescript.createSourceFile(path, text, typescript.ScriptTarget.ES2022, true);
    const visit = (node: TS.Node): void => {
      if (typescript.isClassDeclaration(node)) {
        const counts = countInjectionStyles(typescript, node);
        injectCalls += counts.injectCalls;
        constructorParameters += counts.constructorParameters;
      }
      typescript.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  return { injectCalls, constructorParameters };
}

// ---------------------------------------------------------------------------
// angular_generate
// ---------------------------------------------------------------------------

export const generateTool = defineTool({
  name: 'angular_generate',
  description:
    "Runs the analyzed project's own Angular CLI to scaffold a component, service, guard, pipe or similar, so the " +
    "generated code follows that project's schematics, custom ones included, and its angular.json defaults. " +
    'Defaults to a dry run that reports the files it would create without writing them. The CLI is spawned with ' +
    'its arguments as an array, never through a shell, and every run is bounded by a timeout.',
  inputSchema: {
    root: rootInputField,
    schematic: z
      .enum(ALLOWED_SCHEMATICS)
      .describe('What to generate. Run any other schematic with the CLI directly.'),
    name: z
      .string()
      .min(1)
      .describe('Name, optionally with a path, e.g. "features/users/user-card". Resolved inside the project.'),
    options: z
      .array(
        z.object({
          flag: z.string().describe('A CLI flag, e.g. "--standalone".'),
          value: z.string().optional().describe('Its value, when the flag takes one. Passed as its own argument.'),
        }),
      )
      .optional()
      .describe('Extra CLI options, each already split into flag and value so neither can smuggle the other.'),
    dry_run: dryRunField,
    timeout_ms: z.number().int().min(1000).max(600_000).optional(),
  },
  outputSchema: {
    dryRun: z.boolean(),
    command: z.array(z.string()).describe('The exact argv that was run, for the caller to see.'),
    exitCode: z.number().int(),
    files: z
      .array(z.object({ action: z.enum(['create', 'update', 'delete']), path: z.string() }))
      .describe('Files the schematic reported. In a dry run these are the files it would have written.'),
    output: z.string().describe("The CLI's own output, trimmed."),
  },
  annotations: { ...MUTATION_ANNOTATIONS, title: 'Generate' },
  async handler(input, context) {
    const root = context.resolveRoot(input.root);
    const dryRun = input.dry_run ?? true;

    const result = await runGenerate({
      root,
      schematic: input.schematic,
      name: input.name,
      options: input.options,
      dryRun,
      timeoutMs: input.timeout_ms,
    });

    const output = `${result.stdout}\n${result.stderr}`.trim();

    return {
      dryRun,
      command: [...result.command],
      exitCode: result.exitCode,
      files: parseGeneratedFiles(output),
      output,
    };
  },
});

// ---------------------------------------------------------------------------
// angular_add_route
// ---------------------------------------------------------------------------

export const addRouteTool = defineTool({
  name: 'angular_add_route',
  description:
    'Adds a route to a routing array, written the way that array already writes its routes — lazy with ' +
    'loadComponent, or eager with component — so the entry does not have to be reformatted by hand. Use ' +
    'angular_get_route_tree first to find the file and array you mean. Defaults to a dry run returning a diff.',
  inputSchema: {
    root: rootInputField,
    file: z.string().min(1).describe('File holding the routes array, relative to root.'),
    array_name: z
      .string()
      .min(1)
      .describe('The const that holds the routes, e.g. "routes" or "ORDERS_ROUTES".'),
    path: z.string().describe('The new route\'s path. Use "" for the array\'s index route.'),
    component: z.string().min(1).describe('Component class the route targets.'),
    component_path: z
      .string()
      .min(1)
      .describe('Module specifier to reach the component from this file, e.g. "./user-list/user-list.component".'),
    loading: z
      .enum(['loadComponent', 'component'])
      .optional()
      .describe("Override the array's dominant loading style. Omit it to follow what the neighbours do."),
    dry_run: dryRunField,
  },
  outputSchema: {
    ...diffOutputFields,
    loading: z.enum(['loadComponent', 'component']),
    loadingConfidence: z
      .enum(['certain', 'unknown'])
      .describe('"unknown" when the array was empty or evenly split, so a default was used rather than detected (P4).'),
    loadingReason: z.string(),
    alreadyPresent: z.boolean().describe('True when the array already declares this path; nothing was changed.'),
  },
  annotations: { ...MUTATION_ANNOTATIONS, title: 'Add route' },
  async handler(input, context) {
    const root = context.resolveRoot(input.root);
    const state = context.requireIndexedState(root);

    const before = await readProjectFile(root, input.file);
    const result = addRoute({
      typescript: state.deps.typescript,
      sourceText: before,
      filePath: input.file,
      arrayName: input.array_name,
      path: input.path,
      component: input.component,
      componentPath: input.component_path,
      loading: input.loading,
    });

    const applied = await applyEdits(root, [{ path: input.file, before, after: result.after }], input.dry_run ?? true);

    return {
      dryRun: applied.dryRun,
      filesChanged: applied.filesChanged,
      diff: applied.diff,
      loading: result.loading,
      loadingConfidence: result.loadingConfidence,
      loadingReason: result.loadingReason,
      alreadyPresent: result.alreadyPresent,
    };
  },
});

// ---------------------------------------------------------------------------
// angular_add_dependency
// ---------------------------------------------------------------------------

export const addDependencyTool = defineTool({
  name: 'angular_add_dependency',
  description:
    'Injects a dependency into a class, in whichever style that file already uses — an inject() property or a ' +
    'constructor parameter — and adds the import when one is needed. The style is read from the class itself, ' +
    'falling back to the project and then to inject(), and which of those happened is reported. Defaults to a dry ' +
    'run returning a diff.',
  inputSchema: {
    root: rootInputField,
    ref: z
      .string()
      .min(1)
      .describe('Full ref ("path#Name") of the class to inject into, or a bare name that resolves to exactly one.'),
    dependency: z.string().min(1).describe('Type to inject, e.g. "UserService".'),
    property_name: z
      .string()
      .optional()
      .describe('Property to hold it. Defaults to the type name, lower-camel-cased.'),
    import_from: z
      .string()
      .optional()
      .describe('Module specifier to import the type from, when this file does not import it yet.'),
    dry_run: dryRunField,
  },
  outputSchema: {
    ...diffOutputFields,
    style: z.enum(['inject', 'constructor']),
    styleConfidence: z
      .enum(['certain', 'inferred', 'unknown'])
      .describe('"certain" from the class itself, "inferred" from the project, "unknown" when a default was used (P4).'),
    styleReason: z.string(),
    propertyName: z.string(),
    alreadyPresent: z.boolean().describe('True when the class already injects this type; nothing was changed.'),
  },
  annotations: { ...MUTATION_ANNOTATIONS, title: 'Add dependency' },
  async handler(input, context) {
    const root = context.resolveRoot(input.root);
    const state = context.requireIndexedState(root);
    const graph = state.result.graph;

    const [filePath, className] = input.ref.includes('#')
      ? (input.ref.split('#') as [string, string])
      : (() => {
          const matches = graph.nodesByName(input.ref);
          if (matches.length === 0) {
            throw new InvalidInputError(
              `No indexed symbol named "${input.ref}". Call angular_find_symbol to see what is there.`,
            );
          }
          if (matches.length > 1) {
            throw new InvalidInputError(
              `"${input.ref}" matches ${matches.length} symbols, so none was picked: ` +
                `${matches.map((node) => node.id).join(', ')}. Pass the full ref (R13).`,
            );
          }
          return [matches[0]!.path, matches[0]!.name] as [string, string];
        })();

    const before = await readProjectFile(root, filePath);

    // Reading every other component and service is only worth doing when the
    // class itself shows no style, so the counts are resolved lazily rather
    // than computed on every call.
    const loadProjectCounts = async (): Promise<InjectionStyleCounts> => {
      const otherPaths = graph
        .allNodes()
        .filter((node) => (node.kind === 'Component' || node.kind === 'Service') && node.path !== filePath)
        .map((node) => node.path);
      return projectInjectionCounts(state.deps.typescript, root, [...new Set(otherPaths)]);
    };

    const result = await addDependencyWithLazyProjectCounts(
      {
        typescript: state.deps.typescript,
        sourceText: before,
        filePath,
        className,
        dependencyType: input.dependency,
        propertyName: input.property_name,
        importFrom: input.import_from,
      },
      loadProjectCounts,
    );

    const applied = await applyEdits(root, [{ path: filePath, before, after: result.after }], input.dry_run ?? true);

    return {
      dryRun: applied.dryRun,
      filesChanged: applied.filesChanged,
      diff: applied.diff,
      style: result.style.value,
      styleConfidence: result.style.confidence,
      styleReason: result.style.reason,
      propertyName: result.propertyName,
      alreadyPresent: result.alreadyPresent,
    };
  },
});

/**
 * Runs `addDependency`, consulting the project's counts only if the class's
 * own code did not settle the style.
 *
 * The edit is computed twice in that case, which is cheap — it is a string
 * splice over one file — and far cheaper than reading every component and
 * service in the project on every call, which is what computing the counts
 * eagerly would cost.
 */
export async function addDependencyWithLazyProjectCounts(
  request: Omit<AddDependencyRequest, 'projectCounts'>,
  loadProjectCounts: () => Promise<InjectionStyleCounts>,
): Promise<AddDependencyResult> {
  const first = addDependency(request);
  if (first.style.confidence !== 'unknown') return first;

  return addDependency({ ...request, projectCounts: await loadProjectCounts() });
}

/** The three Phase 5 mutation tools (docs/PLAN.md section 6). */
export const PHASE_5_TOOLS = [generateTool, addRouteTool, addDependencyTool] as const;
