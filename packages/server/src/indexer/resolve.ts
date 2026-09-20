/**
 * Resolucion de `typescript` y `@angular/compiler` desde el node_modules del
 * PROYECTO ANALIZADO (no del servidor). Ver docs/PLAN.md, seccion 4.2 y
 * riesgo R1: el parser de templates cambia entre versiones mayores de
 * Angular, asi que usar una version distinta a la del proyecto produce
 * falsos errores. Por eso nunca se importa `typescript` ni
 * `@angular/compiler` a nivel de modulo aqui: se cargan en runtime con
 * `createRequire` anclado a la raiz del proyecto.
 */

import { createRequire } from 'node:module';
import { join } from 'node:path';

import type * as TS from 'typescript';

/** Version mayor y version completa de Angular, leida de `@angular/compiler`. */
export interface AngularVersionInfo {
  readonly full: string;
  readonly major: number;
}

export interface ResolvedProjectDependencies {
  readonly typescript: typeof TS;
  readonly typescriptVersion: string;
  /** Modulo de `@angular/compiler` tal como lo expone el proyecto analizado. */
  readonly angularCompiler: unknown;
  readonly angularVersion: AngularVersionInfo;
}

/**
 * Falta una dependencia obligatoria en el proyecto analizado. El mensaje
 * siempre dice exactamente que instalar (nunca "algo salio mal").
 */
export class MissingDependencyError extends Error {
  readonly packageName: string;
  readonly projectRoot: string;

  constructor(packageName: string, projectRoot: string, installCommand: string) {
    super(
      `No se encontro '${packageName}' en el node_modules de "${projectRoot}". ` +
        `Este proyecto no parece tener Angular instalado. Instala la dependencia con:\n  ${installCommand}`,
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
 * Resuelve `typescript` y `@angular/compiler` desde el node_modules de
 * `projectRoot`, usando la misma resolucion de Node que usaria el propio
 * proyecto. Lanza `MissingDependencyError` con el comando exacto a correr si
 * falta alguna de las dos.
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
      `'@angular/compiler' en "${projectRoot}" no expone 'VERSION'. ` +
        'No se pudo detectar la version mayor de Angular instalada.',
    );
  }

  const major = Number.parseInt(versionExport.major, 10);
  if (Number.isNaN(major)) {
    throw new Error(
      `'@angular/compiler' en "${projectRoot}" reporta una version mayor invalida: "${versionExport.major}".`,
    );
  }

  return {
    typescript,
    typescriptVersion: typescript.version,
    angularCompiler,
    angularVersion: { full: versionExport.full, major },
  };
}
