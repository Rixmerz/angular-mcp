/**
 * Workspace loading for the analyzed project. See docs/PLAN.md, section 4.2.
 *
 * Detects the project root, reads `angular.json` when present and exposes every
 * workspace project with its `sourceRoot` and its `tsconfig`. When there is no
 * `angular.json` (an Angular project without the CLI, or a non-Angular one), it
 * falls back to looking for a `tsconfig.json` at the root and reports that in
 * `kind`.
 */

import { access, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';

import { normalizeRelativePath } from '../graph/model.js';

export type WorkspaceKind = 'angular-cli' | 'tsconfig-only';

export interface WorkspaceProject {
  readonly name: string;
  readonly projectType: string;
  /** Path relative to the workspace root. */
  readonly root: string;
  /** Path relative to the workspace root, when angular.json declares it. */
  readonly sourceRoot?: string;
  /** Absolute path to the project's tsconfig, when it could be determined. */
  readonly tsConfigPath?: string;
  /**
   * Every tsconfig this project declares (build, test, lint, ...), the
   * primary one first. A standard Angular app splits its sources across
   * `tsconfig.app.json` ("files": ["src/main.ts"]) and
   * `tsconfig.spec.json`, so indexing only the primary one would leave
   * every `.spec.ts` out of the graph.
   */
  readonly tsConfigPaths?: readonly string[];
}

export interface Workspace {
  readonly root: string;
  readonly kind: WorkspaceKind;
  /** Absolute path to angular.json or tsconfig.json, depending on `kind`. `undefined` when neither was found. */
  readonly configPath?: string;
  readonly projects: readonly WorkspaceProject[];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Walks up from `startDir` looking for `angular.json` or, failing that,
 * `package.json`. Throws if it reaches the filesystem root without finding
 * either.
 */
export async function findWorkspaceRoot(startDir: string): Promise<string> {
  let dir = resolvePath(startDir);

  while (true) {
    if (await pathExists(join(dir, 'angular.json'))) return dir;
    if (await pathExists(join(dir, 'package.json'))) return dir;

    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `Could not find "angular.json" or "package.json" walking up from "${startDir}". ` +
          'Run the indexer inside an Angular workspace or a valid Node project.',
      );
    }
    dir = parent;
  }
}

interface RawArchitectTarget {
  readonly options?: { readonly tsConfig?: string };
}

interface RawAngularProject {
  readonly projectType?: string;
  readonly root?: string;
  readonly sourceRoot?: string;
  readonly architect?: Record<string, RawArchitectTarget>;
  readonly targets?: Record<string, RawArchitectTarget>;
}

interface RawAngularJson {
  readonly projects?: Record<string, RawAngularProject>;
}

/** Preference order when looking for a project's "main" tsconfig. */
const TSCONFIG_TARGET_PRIORITY = ['build', 'test', 'lint'];

/**
 * Every tsconfig the project's targets declare, deduplicated, in
 * `TSCONFIG_TARGET_PRIORITY` order first and then whatever else is left. The
 * first entry is the project's "main" tsconfig.
 */
function findTsConfigOptions(project: RawAngularProject): readonly string[] {
  const targets = project.architect ?? project.targets;
  if (!targets) return [];

  const found: string[] = [];
  const add = (tsConfig: string | undefined): void => {
    if (tsConfig && !found.includes(tsConfig)) found.push(tsConfig);
  };

  for (const targetName of TSCONFIG_TARGET_PRIORITY) {
    add(targets[targetName]?.options?.tsConfig);
  }
  for (const target of Object.values(targets)) {
    add(target.options?.tsConfig);
  }

  return found;
}

async function loadAngularCliWorkspace(root: string, angularJsonPath: string): Promise<Workspace> {
  const raw = JSON.parse(await readFile(angularJsonPath, 'utf8')) as RawAngularJson;
  const rawProjects = raw.projects ?? {};

  const projects: WorkspaceProject[] = [];
  for (const [name, project] of Object.entries(rawProjects)) {
    const projectRoot = normalizeRelativePath(project.root ?? '');
    const tsConfigPaths = findTsConfigOptions(project).map((option) => join(root, option));

    if (tsConfigPaths.length === 0) {
      const fallback = join(root, projectRoot, 'tsconfig.json');
      if (await pathExists(fallback)) tsConfigPaths.push(fallback);
    }

    projects.push({
      name,
      projectType: project.projectType ?? 'unknown',
      root: projectRoot,
      sourceRoot: project.sourceRoot !== undefined ? normalizeRelativePath(project.sourceRoot) : undefined,
      tsConfigPath: tsConfigPaths[0],
      tsConfigPaths,
    });
  }

  return { root, kind: 'angular-cli', configPath: angularJsonPath, projects };
}

async function loadTsConfigOnlyWorkspace(root: string): Promise<Workspace> {
  const tsConfigPath = join(root, 'tsconfig.json');
  const exists = await pathExists(tsConfigPath);

  return {
    root,
    kind: 'tsconfig-only',
    configPath: exists ? tsConfigPath : undefined,
    projects: exists
      ? [{ name: basename(root), projectType: 'unknown', root: '.', tsConfigPath, tsConfigPaths: [tsConfigPath] }]
      : [],
  };
}

/**
 * Loads the workspace at `root`: when `angular.json` exists, exposes its
 * projects (several are supported). Otherwise it falls back to looking for a
 * `tsconfig.json` at the root.
 */
export async function loadWorkspace(root: string): Promise<Workspace> {
  const absoluteRoot = resolvePath(root);
  const angularJsonPath = join(absoluteRoot, 'angular.json');

  if (await pathExists(angularJsonPath)) {
    return loadAngularCliWorkspace(absoluteRoot, angularJsonPath);
  }

  return loadTsConfigOnlyWorkspace(absoluteRoot);
}
