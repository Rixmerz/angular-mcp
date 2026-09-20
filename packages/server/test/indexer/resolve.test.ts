import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { MissingDependencyError, resolveProjectDependencies } from '../../src/indexer/resolve.js';

const serverRequire = createRequire(join(process.cwd(), 'package.json'));

/** Real path of the `typescript` package installed for the server (used only to symlink it into fixtures). */
const realTypescriptPackageDir = dirname(serverRequire.resolve('typescript/package.json'));

const resolveSourcePath = join(process.cwd(), 'src', 'indexer', 'resolve.ts');

/**
 * `resolve.ts` transpiled to JavaScript, once.
 *
 * The child process cannot import the `.ts` directly: Node's native type
 * stripping only exists from 22 on, and the package declares support for
 * 20, where importing an `.mts` dies with ERR_UNKNOWN_FILE_EXTENSION. It is
 * transpiled with the same `typescript` that is already a devDependency, so
 * the test runs the real code on any supported version.
 *
 * This only works because `resolve.ts` imports nothing but Node builtins
 * plus an `import type`, which is erased.
 */
let transpiledResolveSource: string | undefined;

function resolveModuleSource(): string {
  if (transpiledResolveSource === undefined) {
    transpiledResolveSource = ts.transpileModule(readFileSync(resolveSourcePath, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    }).outputText;
  }
  return transpiledResolveSource;
}

/**
 * Vitest runs the tests under its own module runtime (vite-node), which on a
 * real `MODULE_NOT_FOUND` falls back to the server's own resolution instead
 * of failing. That masks exactly the case these tests verify ("it is not
 * installed"), so we run the resolution in a real, isolated `node` process
 * against the real `resolve.ts`.
 */
interface ChildResolveResult {
  readonly ok: boolean;
  readonly name?: string;
  readonly message?: string;
  readonly packageName?: string;
  readonly typescriptVersion?: string;
  readonly angularVersion?: { readonly full: string; readonly major: number };
}

function resolveInRealNodeProcess(projectRoot: string): ChildResolveResult {
  const modulePath = join(projectRoot, '.resolve-module.mjs');
  writeFileSync(modulePath, resolveModuleSource(), 'utf8');
  const harnessPath = join(projectRoot, '.resolve-harness.mjs');
  const harnessSource = `
import { pathToFileURL } from 'node:url';
const [, , modulePath, target] = process.argv;
const mod = await import(pathToFileURL(modulePath).href);
try {
  const resolved = mod.resolveProjectDependencies(target);
  process.stdout.write(JSON.stringify({
    ok: true,
    typescriptVersion: resolved.typescriptVersion,
    angularVersion: resolved.angularVersion,
  }));
} catch (error) {
  process.stdout.write(JSON.stringify({
    ok: false,
    name: error && error.name,
    message: error && error.message,
    packageName: error && error.packageName,
  }));
}
`;
  writeFileSync(harnessPath, harnessSource, 'utf8');

  // Strip NODE_PATH: vitest sets it to its own dependency tree, and a plain
  // Node process (unlike vite-node) genuinely honors it as a global fallback
  // that would otherwise leak the server's own typescript/@angular/compiler
  // into this resolution, defeating the very thing being tested.
  const childEnv = { ...process.env };
  delete childEnv.NODE_PATH;

  return JSON.parse(
    execFileSync(process.execPath, [harnessPath, modulePath, projectRoot], {
      encoding: 'utf8',
      env: childEnv,
    }),
  ) as ChildResolveResult;
}

async function linkRealTypescript(projectRoot: string): Promise<void> {
  await mkdir(join(projectRoot, 'node_modules'), { recursive: true });
  await symlink(realTypescriptPackageDir, join(projectRoot, 'node_modules', 'typescript'), 'dir');
}

/**
 * Installs a fake but working `@angular/compiler` (it exposes `VERSION`) with
 * a version deliberately different from the one the server itself uses
 * (18.x), to prove that resolution reads from the analyzed project and not
 * from the server.
 */
async function writeFakeAngularCompiler(projectRoot: string, version: string): Promise<void> {
  const [major, minor = '0', patch = '0'] = version.split('.');
  const pkgDir = join(projectRoot, 'node_modules', '@angular', 'compiler');
  await mkdir(pkgDir, { recursive: true });
  await writeFile(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name: '@angular/compiler', version, main: 'index.cjs' }),
    'utf8',
  );
  await writeFile(
    join(pkgDir, 'index.cjs'),
    `exports.VERSION = { full: '${version}', major: '${major}', minor: '${minor}', patch: '${patch}' };\n`,
    'utf8',
  );
}

describe('resolveProjectDependencies', () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), 'resolve-test-'));
    await writeFile(join(projectRoot, 'package.json'), JSON.stringify({ name: 'fixture-project' }), 'utf8');
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("resolves 'typescript' and '@angular/compiler' from the analyzed project's own node_modules", async () => {
    await linkRealTypescript(projectRoot);
    await writeFakeAngularCompiler(projectRoot, '17.5.0');

    const resolved = resolveProjectDependencies(projectRoot);

    expect(typeof resolved.typescript.createProgram).toBe('function');
    expect(resolved.typescriptVersion).toBe(resolved.typescript.version);
  });

  it('reports the Angular major version from the fixture project, not from the server', async () => {
    await linkRealTypescript(projectRoot);
    await writeFakeAngularCompiler(projectRoot, '17.5.0');

    const resolved = resolveProjectDependencies(projectRoot);

    expect(resolved.angularVersion).toEqual({ full: '17.5.0', major: 17 });
  });

  it('picks up a different major version from a different fixture project', async () => {
    await linkRealTypescript(projectRoot);
    await writeFakeAngularCompiler(projectRoot, '20.1.3');

    const resolved = resolveProjectDependencies(projectRoot);

    expect(resolved.angularVersion).toEqual({ full: '20.1.3', major: 20 });
  });

  it('throws MissingDependencyError naming "@angular/compiler" and an install command when Angular is not installed', async () => {
    await linkRealTypescript(projectRoot);
    // No @angular/compiler installed: this is the "project has no Angular" case.

    const result = resolveInRealNodeProcess(projectRoot);

    expect(result.ok).toBe(false);
    expect(result.name).toBe(MissingDependencyError.name);
    expect(result.packageName).toBe('@angular/compiler');
    expect(result.message).toContain('@angular/compiler');
    expect(result.message).toContain('npm install @angular/compiler');
  });

  it('throws MissingDependencyError naming "typescript" and an install command when typescript is missing', async () => {
    await writeFakeAngularCompiler(projectRoot, '18.0.0');
    // No typescript installed.

    const result = resolveInRealNodeProcess(projectRoot);

    expect(result.ok).toBe(false);
    expect(result.name).toBe(MissingDependencyError.name);
    expect(result.packageName).toBe('typescript');
    expect(result.message).toContain('npm install --save-dev typescript');
  });

  it('throws an actionable error when the project has no node_modules at all', () => {
    const result = resolveInRealNodeProcess(projectRoot);

    expect(result.ok).toBe(false);
    expect(result.name).toBe(MissingDependencyError.name);
    expect(result.message).toMatch(/does not appear to have Angular installed/i);
  });

  it("throws a clear error when '@angular/compiler' does not export VERSION", async () => {
    await linkRealTypescript(projectRoot);
    const pkgDir = join(projectRoot, 'node_modules', '@angular', 'compiler');
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      join(pkgDir, 'package.json'),
      JSON.stringify({ name: '@angular/compiler', version: '0.0.0', main: 'index.cjs' }),
      'utf8',
    );
    await writeFile(join(pkgDir, 'index.cjs'), 'exports.somethingElse = true;\n', 'utf8');

    expect(() => resolveProjectDependencies(projectRoot)).toThrow(/does not expose 'VERSION'/);
  });
});
