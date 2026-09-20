/**
 * Loading of a project's `ts.Program` from its tsconfig. See docs/PLAN.md,
 * section 4.3: public TypeScript API only (`ts.Program`, the type checker),
 * never `NgtscProgram` nor `TemplateTypeChecker` (risk R1, explicitly out of
 * scope for v1).
 *
 * It receives the already-resolved `typescript` module (see `resolve.ts`)
 * instead of importing it itself: it must always be the analyzed project's
 * `typescript`, never the server's.
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

/** Creates a `ts.Program` from a tsconfig.json and exposes its type checker. */
export function createProjectProgram(typescript: typeof TS, tsConfigPath: string): LoadedProgram {
  const configFile = typescript.readConfigFile(tsConfigPath, typescript.sys.readFile);
  if (configFile.error) {
    throw new Error(
      `Could not read "${tsConfigPath}": ` +
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
    throw new Error(`Invalid configuration in "${tsConfigPath}":\n${messages}`);
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
 * Same as `createProjectProgram`, but starting from a `WorkspaceProject`. Fails
 * with an actionable message when no tsconfig was detected for the project.
 */
export function loadProgramForProject(typescript: typeof TS, project: WorkspaceProject): LoadedProgram {
  if (!project.tsConfigPath) {
    throw new Error(
      `No tsconfig was detected for project "${project.name}". ` +
        `Check the "architect" section of angular.json, or add a "tsconfig.json" in "${project.root}".`,
    );
  }

  return createProjectProgram(typescript, project.tsConfigPath);
}

/**
 * One program per tsconfig the project declares, so that sources split across
 * several tsconfigs all get indexed. A standard Angular app puts application
 * code behind `tsconfig.app.json` and specs behind `tsconfig.spec.json`; a
 * program built from only the first contains no `.spec.ts` at all.
 *
 * A tsconfig that fails to load does not take the others down with it: the
 * error is returned alongside the programs that did load, for the caller to
 * report as a broken file (R14).
 */
export function loadProgramsForProject(
  typescript: typeof TS,
  project: WorkspaceProject,
): { readonly programs: readonly LoadedProgram[]; readonly errors: readonly { file: string; error: unknown }[] } {
  const declared = project.tsConfigPaths ?? [];
  const tsConfigPaths = declared.length > 0
    ? declared
    : project.tsConfigPath
      ? [project.tsConfigPath]
      : [];

  if (tsConfigPaths.length === 0) {
    return {
      programs: [],
      errors: [
        {
          file: project.root,
          error: new Error(
            `No tsconfig was detected for project "${project.name}". ` +
              `Check the "architect" section of angular.json, or add a "tsconfig.json" in "${project.root}".`,
          ),
        },
      ],
    };
  }

  const programs: LoadedProgram[] = [];
  const errors: { file: string; error: unknown }[] = [];
  for (const tsConfigPath of tsConfigPaths) {
    try {
      programs.push(createProjectProgram(typescript, tsConfigPath));
    } catch (error) {
      errors.push({ file: tsConfigPath, error });
    }
  }

  return { programs, errors };
}
