/**
 * A minimal, disposable Angular-ish project on disk, for tools that go
 * through the real indexer (`angular_index_project`, `angular_get_index_status`).
 *
 * `typescript` and `@angular/compiler` are symlinked in from this package's
 * own `node_modules` instead of being installed fresh, since `resolve.ts`
 * (R1) always resolves them from the analyzed project's own node_modules via
 * `createRequire` — a bare temp directory would otherwise have neither.
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve as resolvePath } from 'node:path';

const SERVER_ROOT = resolvePath(import.meta.dirname, '../../..');

export interface TempProject {
  readonly root: string;
  readonly cleanup: () => Promise<void>;
}

export async function createTempProject(files: Readonly<Record<string, string>>): Promise<TempProject> {
  const root = await mkdtemp(join(tmpdir(), 'angular-mcp-tool-test-'));

  await mkdir(join(root, 'node_modules'), { recursive: true });
  await symlink(join(SERVER_ROOT, 'node_modules', 'typescript'), join(root, 'node_modules', 'typescript'), 'dir');
  await symlink(join(SERVER_ROOT, 'node_modules', '@angular'), join(root, 'node_modules', '@angular'), 'dir');

  await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'temp-project', version: '0.0.0' }), 'utf8');

  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content, 'utf8');
  }

  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
