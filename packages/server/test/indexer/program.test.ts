import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import * as typescript from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createProjectProgram, loadProgramForProject } from '../../src/indexer/program.js';
import type { WorkspaceProject } from '../../src/indexer/workspace.js';

describe('createProjectProgram', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'program-test-'));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('creates a ts.Program from the project tsconfig and exposes a working type checker', async () => {
    await writeFile(
      join(projectRoot, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { strict: true, module: 'ES2022', target: 'ES2022' } }),
      'utf8',
    );
    await mkdir(join(projectRoot, 'src'), { recursive: true });
    await writeFile(
      join(projectRoot, 'src', 'user.service.ts'),
      'export class UserService {\n  greet(): string {\n    return "hi";\n  }\n}\n',
      'utf8',
    );

    const loaded = createProjectProgram(typescript, join(projectRoot, 'tsconfig.json'));

    expect(loaded.rootFileNames).toEqual([join(projectRoot, 'src', 'user.service.ts')]);

    const sourceFile = loaded.program.getSourceFile(join(projectRoot, 'src', 'user.service.ts'));
    expect(sourceFile).toBeDefined();

    const classDeclaration = sourceFile!.statements.find(typescript.isClassDeclaration);
    expect(classDeclaration?.name?.text).toBe('UserService');

    const type = loaded.typeChecker.getTypeAtLocation(classDeclaration!);
    expect(type.symbol?.name).toBe('UserService');
  });

  it('throws a clear error when the tsconfig path does not exist', () => {
    expect(() =>
      createProjectProgram(typescript, join(projectRoot, 'does-not-exist.tsconfig.json')),
    ).toThrow(/No se pudo leer/);
  });

  it('throws a clear error when the tsconfig contains invalid options', async () => {
    await writeFile(
      join(projectRoot, 'tsconfig.json'),
      JSON.stringify({ compilerOptions: { target: 'not-a-real-target' } }),
      'utf8',
    );

    expect(() => createProjectProgram(typescript, join(projectRoot, 'tsconfig.json'))).toThrow(
      /Configuracion invalida/,
    );
  });
});

describe('loadProgramForProject', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'program-project-test-'));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it('loads the program using the tsConfigPath from a WorkspaceProject', async () => {
    await writeFile(join(projectRoot, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }), 'utf8');
    await writeFile(join(projectRoot, 'app.component.ts'), 'export class AppComponent {}\n', 'utf8');

    const project: WorkspaceProject = {
      name: 'app',
      projectType: 'application',
      root: '',
      tsConfigPath: join(projectRoot, 'tsconfig.json'),
    };

    const loaded = loadProgramForProject(typescript, project);

    expect(loaded.rootFileNames).toContain(join(projectRoot, 'app.component.ts'));
  });

  it('throws an actionable error naming the project when it has no tsConfigPath', () => {
    const project: WorkspaceProject = {
      name: 'no-tsconfig-app',
      projectType: 'application',
      root: 'apps/no-tsconfig-app',
    };

    expect(() => loadProgramForProject(typescript, project)).toThrow(/no-tsconfig-app/);
  });
});
