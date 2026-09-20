/**
 * Carga del `ts.Program` de un proyecto, a partir de su tsconfig. Ver
 * docs/PLAN.md, seccion 4.3: solo API publica de TypeScript (`ts.Program`,
 * type checker), nunca `NgtscProgram` ni `TemplateTypeChecker` (riesgo R1,
 * excluidos explicitamente de la v1).
 *
 * Recibe el modulo `typescript` ya resuelto (ver `resolve.ts`) en vez de
 * importarlo el mismo: debe ser siempre el `typescript` del proyecto
 * analizado, nunca el del servidor.
 */

import { dirname } from 'node:path';

import type * as TS from 'typescript';

import type { WorkspaceProject } from './workspace.js';

export interface LoadedProgram {
  readonly program: TS.Program;
  readonly typeChecker: TS.TypeChecker;
  readonly rootFileNames: readonly string[];
  readonly options: TS.CompilerOptions;
}

/** Crea un `ts.Program` a partir de un tsconfig.json y expone su type checker. */
export function createProjectProgram(typescript: typeof TS, tsConfigPath: string): LoadedProgram {
  const configFile = typescript.readConfigFile(tsConfigPath, typescript.sys.readFile);
  if (configFile.error) {
    throw new Error(
      `No se pudo leer "${tsConfigPath}": ` +
        typescript.flattenDiagnosticMessageText(configFile.error.messageText, '\n'),
    );
  }

  const parsed = typescript.parseJsonConfigFileContent(
    configFile.config,
    typescript.sys,
    dirname(tsConfigPath),
  );

  if (parsed.errors.length > 0) {
    const messages = parsed.errors
      .map((diagnostic) => typescript.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      .join('\n');
    throw new Error(`Configuracion invalida en "${tsConfigPath}":\n${messages}`);
  }

  const program = typescript.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
  });

  return {
    program,
    typeChecker: program.getTypeChecker(),
    rootFileNames: parsed.fileNames,
    options: parsed.options,
  };
}

/**
 * Igual que `createProjectProgram`, pero a partir de un `WorkspaceProject`.
 * Falla con un mensaje accionable si el proyecto no tiene tsconfig detectado.
 */
export function loadProgramForProject(typescript: typeof TS, project: WorkspaceProject): LoadedProgram {
  if (!project.tsConfigPath) {
    throw new Error(
      `El proyecto "${project.name}" no tiene un tsconfig detectado. ` +
        `Revisa la seccion "architect" de angular.json, o agrega un "tsconfig.json" en "${project.root}".`,
    );
  }

  return createProjectProgram(typescript, project.tsConfigPath);
}
