import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findWorkspaceRoot, loadWorkspace } from '../../src/indexer/workspace.js';

async function writeJson(path: string, data: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, JSON.stringify(data), 'utf8');
}

describe('loadWorkspace', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'workspace-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('reads a single-project angular.json and exposes its sourceRoot and tsconfig', async () => {
    await writeJson(join(root, 'angular.json'), {
      version: 1,
      projects: {
        app: {
          projectType: 'application',
          root: '',
          sourceRoot: 'src',
          architect: {
            build: { options: { tsConfig: 'tsconfig.app.json' } },
            test: { options: { tsConfig: 'tsconfig.spec.json' } },
          },
        },
      },
    });

    const workspace = await loadWorkspace(root);

    expect(workspace.kind).toBe('angular-cli');
    expect(workspace.configPath).toBe(join(root, 'angular.json'));
    expect(workspace.projects).toEqual([
      {
        name: 'app',
        projectType: 'application',
        root: '',
        sourceRoot: 'src',
        tsConfigPath: join(root, 'tsconfig.app.json'),
      },
    ]);
  });

  it('supports workspaces with several projects (app + library)', async () => {
    await writeJson(join(root, 'angular.json'), {
      version: 1,
      projects: {
        app: {
          projectType: 'application',
          root: '',
          sourceRoot: 'src',
          architect: { build: { options: { tsConfig: 'tsconfig.app.json' } } },
        },
        'my-lib': {
          projectType: 'library',
          root: 'projects/my-lib',
          sourceRoot: 'projects/my-lib/src',
          architect: { build: { options: { tsConfig: 'projects/my-lib/tsconfig.lib.json' } } },
        },
      },
    });

    const workspace = await loadWorkspace(root);

    expect(workspace.projects).toHaveLength(2);
    const byName = Object.fromEntries(workspace.projects.map((project) => [project.name, project]));

    expect(byName.app?.tsConfigPath).toBe(join(root, 'tsconfig.app.json'));
    expect(byName['my-lib']?.root).toBe('projects/my-lib');
    expect(byName['my-lib']?.sourceRoot).toBe('projects/my-lib/src');
    expect(byName['my-lib']?.tsConfigPath).toBe(join(root, 'projects/my-lib/tsconfig.lib.json'));
  });

  it('falls back to "<projectRoot>/tsconfig.json" when a project has no tsConfig option in architect', async () => {
    await writeJson(join(root, 'angular.json'), {
      version: 1,
      projects: {
        app: { projectType: 'application', root: 'apps/app', sourceRoot: 'apps/app/src' },
      },
    });
    await mkdir(join(root, 'apps', 'app'), { recursive: true });
    await writeFile(join(root, 'apps', 'app', 'tsconfig.json'), '{}', 'utf8');

    const workspace = await loadWorkspace(root);

    expect(workspace.projects[0]?.tsConfigPath).toBe(join(root, 'apps', 'app', 'tsconfig.json'));
  });

  it('degrades to looking for a root tsconfig.json when there is no angular.json', async () => {
    await writeFile(join(root, 'tsconfig.json'), '{}', 'utf8');

    const workspace = await loadWorkspace(root);

    expect(workspace.kind).toBe('tsconfig-only');
    expect(workspace.configPath).toBe(join(root, 'tsconfig.json'));
    expect(workspace.projects).toHaveLength(1);
    expect(workspace.projects[0]?.tsConfigPath).toBe(join(root, 'tsconfig.json'));
  });

  it('reports no usable config when neither angular.json nor tsconfig.json exist', async () => {
    const workspace = await loadWorkspace(root);

    expect(workspace.kind).toBe('tsconfig-only');
    expect(workspace.configPath).toBeUndefined();
    expect(workspace.projects).toEqual([]);
  });
});

describe('findWorkspaceRoot', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'workspace-root-test-'));
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('finds the ancestor directory that contains angular.json', async () => {
    await writeFile(join(root, 'angular.json'), '{}', 'utf8');
    const nested = join(root, 'projects', 'app', 'src', 'app');
    await mkdir(nested, { recursive: true });

    expect(await findWorkspaceRoot(nested)).toBe(root);
  });

  it('falls back to the ancestor directory that contains package.json when there is no angular.json', async () => {
    await writeFile(join(root, 'package.json'), '{}', 'utf8');
    const nested = join(root, 'src', 'app');
    await mkdir(nested, { recursive: true });

    expect(await findWorkspaceRoot(nested)).toBe(root);
  });

  it('throws when neither angular.json nor package.json is found up to the filesystem root', async () => {
    const isolated = join(root, 'no-config-anywhere');
    await mkdir(isolated, { recursive: true });

    await expect(findWorkspaceRoot(isolated)).rejects.toThrow(/Could not find "angular.json" or "package.json"/);
  });
});
