/**
 * Carga del workspace del proyecto analizado. Ver docs/PLAN.md, seccion 4.2.
 *
 * Detecta la raiz del proyecto, lee `angular.json` cuando existe y expone
 * cada proyecto del workspace con su `sourceRoot` y su `tsconfig`. Si no hay
 * `angular.json` (proyecto Angular sin CLI, o no-Angular), degrada a buscar
 * un `tsconfig.json` en la raiz y lo reporta como tal en `kind`.
 */

import { access, readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve as resolvePath } from 'node:path';

import { normalizeRelativePath } from '../graph/model.js';

export type WorkspaceKind = 'angular-cli' | 'tsconfig-only';

export interface WorkspaceProject {
  readonly name: string;
  readonly projectType: string;
  /** Ruta relativa a la raiz del workspace. */
  readonly root: string;
  /** Ruta relativa a la raiz del workspace, si angular.json la declara. */
  readonly sourceRoot?: string;
  /** Ruta absoluta al tsconfig del proyecto, si se pudo determinar. */
  readonly tsConfigPath?: string;
}

export interface Workspace {
  readonly root: string;
  readonly kind: WorkspaceKind;
  /** Ruta absoluta a angular.json o tsconfig.json, segun `kind`. `undefined` si no se encontro ninguno. */
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
 * Sube desde `startDir` buscando `angular.json` o, si no hay, `package.json`.
 * Lanza si llega a la raiz del filesystem sin encontrar ninguno.
 */
export async function findWorkspaceRoot(startDir: string): Promise<string> {
  let dir = resolvePath(startDir);

  while (true) {
    if (await pathExists(join(dir, 'angular.json'))) return dir;
    if (await pathExists(join(dir, 'package.json'))) return dir;

    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        `No se encontro "angular.json" ni "package.json" subiendo desde "${startDir}". ` +
          'Corre el indexer dentro de un workspace de Angular o de un proyecto Node valido.',
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

/** Orden de preferencia al buscar el tsconfig "principal" de un proyecto. */
const TSCONFIG_TARGET_PRIORITY = ['build', 'test', 'lint'];

function findTsConfigOption(project: RawAngularProject): string | undefined {
  const targets = project.architect ?? project.targets;
  if (!targets) return undefined;

  for (const targetName of TSCONFIG_TARGET_PRIORITY) {
    const tsConfig = targets[targetName]?.options?.tsConfig;
    if (tsConfig) return tsConfig;
  }

  for (const target of Object.values(targets)) {
    if (target.options?.tsConfig) return target.options.tsConfig;
  }

  return undefined;
}

async function loadAngularCliWorkspace(root: string, angularJsonPath: string): Promise<Workspace> {
  const raw = JSON.parse(await readFile(angularJsonPath, 'utf8')) as RawAngularJson;
  const rawProjects = raw.projects ?? {};

  const projects: WorkspaceProject[] = [];
  for (const [name, project] of Object.entries(rawProjects)) {
    const projectRoot = normalizeRelativePath(project.root ?? '');
    const tsConfigOption = findTsConfigOption(project);

    let tsConfigPath = tsConfigOption ? join(root, tsConfigOption) : undefined;
    if (!tsConfigPath) {
      const fallback = join(root, projectRoot, 'tsconfig.json');
      if (await pathExists(fallback)) tsConfigPath = fallback;
    }

    projects.push({
      name,
      projectType: project.projectType ?? 'unknown',
      root: projectRoot,
      sourceRoot: project.sourceRoot !== undefined ? normalizeRelativePath(project.sourceRoot) : undefined,
      tsConfigPath,
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
      ? [{ name: basename(root), projectType: 'unknown', root: '.', tsConfigPath }]
      : [],
  };
}

/**
 * Carga el workspace en `root`: si hay `angular.json`, expone sus proyectos
 * (soporta varios). Si no, degrada a buscar un `tsconfig.json` en la raiz.
 */
export async function loadWorkspace(root: string): Promise<Workspace> {
  const absoluteRoot = resolvePath(root);
  const angularJsonPath = join(absoluteRoot, 'angular.json');

  if (await pathExists(angularJsonPath)) {
    return loadAngularCliWorkspace(absoluteRoot, angularJsonPath);
  }

  return loadTsConfigOnlyWorkspace(absoluteRoot);
}
