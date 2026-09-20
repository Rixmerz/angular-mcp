/**
 * Resolution of `typescript` and `@angular/compiler` from the node_modules of
 * the ANALYZED PROJECT (not the server's). See docs/PLAN.md, section 4.2 and
 * risk R1: the template parser changes between Angular major versions, so using
 * a version other than the project's produces spurious errors. That is why
 * neither `typescript` nor `@angular/compiler` is ever imported at module level
 * here: they are loaded at runtime with `createRequire` anchored to the project
 * root.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';

import type * as TS from 'typescript';

/** Angular major version and full version, read from `@angular/compiler`. */
export interface AngularVersionInfo {
  readonly full: string;
  readonly major: number;
}

export interface ResolvedProjectDependencies {
  readonly typescript: typeof TS;
  readonly typescriptVersion: string;
  /** The `@angular/compiler` module exactly as the analyzed project exposes it. */
  readonly angularCompiler: unknown;
  readonly angularVersion: AngularVersionInfo;
}

/**
 * A required dependency is missing in the analyzed project. The message always
 * states exactly what to install (never just "something went wrong").
 */
export class MissingDependencyError extends Error {
  readonly packageName: string;
  readonly projectRoot: string;

  constructor(packageName: string, projectRoot: string, installCommand: string) {
    super(
      `Could not find '${packageName}' in the node_modules of "${projectRoot}". ` +
        `This project does not appear to have Angular installed. Install the dependency with:\n  ${installCommand}`,
    );
    this.name = 'MissingDependencyError';
    this.packageName = packageName;
    this.projectRoot = projectRoot;
  }
}

function isModuleNotFoundError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'MODULE_NOT_FOUND'
  );
}

function requireFromProject<T>(projectRoot: string, packageName: string, installCommand: string): T {
  const projectRequire = createRequire(join(projectRoot, 'package.json'));
  try {
    return projectRequire(packageName) as T;
  } catch (error) {
    if (isModuleNotFoundError(error)) {
      throw new MissingDependencyError(packageName, projectRoot, installCommand);
    }
    throw error;
  }
}

interface AngularCompilerModule {
  readonly VERSION?: { readonly full: string; readonly major: string };
}

/**
 * Resolves `typescript` and `@angular/compiler` from the node_modules of
 * `projectRoot`, using the same Node resolution the project itself would use.
 * Throws `MissingDependencyError`, with the exact command to run, when either
 * one is missing.
 */
export function resolveProjectDependencies(projectRoot: string): ResolvedProjectDependencies {
  const typescript = requireFromProject<typeof TS>(
    projectRoot,
    'typescript',
    'npm install --save-dev typescript',
  );

  const angularCompiler = requireFromProject<AngularCompilerModule>(
    projectRoot,
    '@angular/compiler',
    'npm install @angular/compiler',
  );

  const versionExport = angularCompiler.VERSION;
  if (!versionExport || typeof versionExport.full !== 'string') {
    throw new Error(
      `'@angular/compiler' in "${projectRoot}" does not expose 'VERSION'. ` +
        'The installed Angular major version could not be detected.',
    );
  }

  const major = Number.parseInt(versionExport.major, 10);
  if (Number.isNaN(major)) {
    throw new Error(
      `'@angular/compiler' in "${projectRoot}" reports an invalid major version: "${versionExport.major}".`,
    );
  }

  return {
    typescript,
    typescriptVersion: typescript.version,
    angularCompiler,
    angularVersion: { full: versionExport.full, major },
  };
}
