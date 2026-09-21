/**
 * Tests for the Phase 5 mutations (docs/PLAN.md, section 6).
 *
 * Three properties matter more than the edits themselves, and each is pinned
 * here directly:
 *
 * - `dry_run` defaults to true and nothing reaches disk unless it is turned
 *   off explicitly. That default is the whole safety story of this phase.
 * - The style is read from the file being edited (R8): writing `inject()`
 *   into a codebase of constructor parameters is the hand-fixing the plan
 *   names as this phase's warning sign.
 * - Nothing goes through a shell, and nothing escapes the workspace (R11).
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as typescript from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { addDependency } from '../../src/mutations/add_dependency.js';
import { addRoute, detectRouteLoadingStyle } from '../../src/mutations/add_route.js';
import { applyEdits } from '../../src/mutations/apply.js';
import { diffStat, unifiedDiff } from '../../src/mutations/diff.js';
import { ALLOWED_SCHEMATICS, GenerateError, parseGeneratedFiles, resolveProjectCli, validateGenerateInput } from '../../src/mutations/generate.js';
import { detectInjectionStyle } from '../../src/mutations/style.js';
import { InvalidInputError } from '../../src/tools/index.js';
import { addDependencyWithLazyProjectCounts } from '../../src/tools/mutations.js';

describe('unifiedDiff', () => {
  it('returns nothing when the two sides are identical', () => {
    expect(unifiedDiff('a.ts', 'same\n', 'same\n')).toBe('');
  });

  it('produces a hunk with context, and counts what changed', () => {
    const before = ['one', 'two', 'three', 'four', 'five'].join('\n');
    const after = ['one', 'two', 'CHANGED', 'four', 'five'].join('\n');

    const diff = unifiedDiff('src/a.ts', before, after);

    expect(diff).toContain('--- a/src/a.ts');
    expect(diff).toContain('+++ b/src/a.ts');
    expect(diff).toContain('-three');
    expect(diff).toContain('+CHANGED');
    expect(diff).toContain(' two');
    expect(diffStat(diff)).toEqual({ added: 1, removed: 1 });
  });

  it('does not count the file headers as added or removed lines', () => {
    const diff = unifiedDiff('src/a.ts', 'a\n', 'b\n');

    expect(diffStat(diff)).toEqual({ added: 1, removed: 1 });
  });
});

describe('applyEdits', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'apply-'));
    await writeFile(join(root, 'a.ts'), 'const a = 1;\n', 'utf8');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes nothing on a dry run, and still returns the diff', async () => {
    const result = await applyEdits(root, [{ path: 'a.ts', before: 'const a = 1;\n', after: 'const a = 2;\n' }], true);

    expect(result.dryRun).toBe(true);
    expect(result.filesChanged).toBe(1);
    expect(result.diff).toContain('+const a = 2;');
    // The file on disk is untouched, which is the point of the default.
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = 1;\n');
  });

  it('writes when the dry run is turned off', async () => {
    await applyEdits(root, [{ path: 'a.ts', before: 'const a = 1;\n', after: 'const a = 2;\n' }], false);

    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = 2;\n');
  });

  it('refuses to write outside the project, before writing anything at all (R11)', async () => {
    await expect(
      applyEdits(
        root,
        [
          { path: 'a.ts', before: 'const a = 1;\n', after: 'const a = 2;\n' },
          { path: '../escaped.ts', before: '', after: 'pwned\n' },
        ],
        false,
      ),
    ).rejects.toThrow(InvalidInputError);

    // The valid edit in the same batch was not written either.
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = 1;\n');
  });

  it('reports an edit that changes nothing as unchanged', async () => {
    const result = await applyEdits(root, [{ path: 'a.ts', before: 'same\n', after: 'same\n' }], true);

    expect(result.filesChanged).toBe(0);
    expect(result.diff).toBe('');
  });
});

describe('detectInjectionStyle (R8)', () => {
  function classIn(source: string): typescript.ClassDeclaration {
    const sourceFile = typescript.createSourceFile('a.ts', source, typescript.ScriptTarget.ES2022, true);
    const found = sourceFile.statements.find((statement) => typescript.isClassDeclaration(statement));
    return found as typescript.ClassDeclaration;
  }

  it('follows the class when it already injects with inject()', () => {
    const style = detectInjectionStyle(
      typescript,
      classIn(`class A { private readonly x = inject(XService); }`),
    );

    expect(style.value).toBe('inject');
    expect(style.confidence).toBe('certain');
  });

  it('follows the class when it already injects through the constructor', () => {
    const style = detectInjectionStyle(
      typescript,
      classIn(`class A { constructor(private readonly x: XService) {} }`),
    );

    expect(style.value).toBe('constructor');
    expect(style.confidence).toBe('certain');
  });

  it("falls back to the project's dominant style when the class injects nothing, and says so", () => {
    const style = detectInjectionStyle(typescript, classIn(`class A {}`), {
      injectCalls: 1,
      constructorParameters: 9,
    });

    expect(style.value).toBe('constructor');
    expect(style.confidence).toBe('inferred');
    expect(style.reason).toContain('dominant style');
  });

  it('reports a bare default as unknown rather than as a detection (P4)', () => {
    const style = detectInjectionStyle(typescript, classIn(`class A {}`));

    expect(style.value).toBe('inject');
    expect(style.confidence).toBe('unknown');
    expect(style.reason).toContain('defaulted');
  });
});

describe('addDependency', () => {
  it('adds an inject() property to a class that already uses inject(), importing inject when needed', () => {
    const before = [
      "import { Component } from '@angular/core';",
      '',
      "@Component({ selector: 'a-b', template: '' })",
      'export class AComponent {',
      '  private readonly other = inject(OtherService);',
      '}',
      '',
    ].join('\n');

    const result = addDependency({
      typescript,
      sourceText: before,
      filePath: 'src/a.component.ts',
      className: 'AComponent',
      dependencyType: 'UserService',
      importFrom: './user.service',
    });

    expect(result.style.value).toBe('inject');
    expect(result.after).toContain('private readonly userService = inject(UserService);');
    expect(result.after).toContain("import { UserService } from './user.service';");
    // `inject` itself was pulled into the existing @angular/core import.
    expect(result.after).toMatch(/import \{ Component, inject \} from '@angular\/core';/);
  });

  it('adds a constructor parameter to a class that uses constructor injection', () => {
    const before = [
      'export class AComponent {',
      '  constructor(private readonly other: OtherService) {}',
      '}',
      '',
    ].join('\n');

    const result = addDependency({
      typescript,
      sourceText: before,
      filePath: 'src/a.component.ts',
      className: 'AComponent',
      dependencyType: 'UserService',
    });

    expect(result.style.value).toBe('constructor');
    expect(result.after).toContain('private readonly other: OtherService, private readonly userService: UserService');
    // No inject() import was added, because none is needed.
    expect(result.after).not.toContain('inject(');
  });

  it('creates a constructor when the class has none and the project uses constructor injection', () => {
    const result = addDependency({
      typescript,
      sourceText: 'export class AComponent {\n  title = "x";\n}\n',
      filePath: 'src/a.component.ts',
      className: 'AComponent',
      dependencyType: 'UserService',
      projectCounts: { injectCalls: 0, constructorParameters: 5 },
    });

    expect(result.style.value).toBe('constructor');
    expect(result.after).toContain('constructor(private readonly userService: UserService) {}');
  });

  it('changes nothing when the class already injects that type', () => {
    const before = 'export class AComponent {\n  private readonly userService = inject(UserService);\n}\n';

    const result = addDependency({
      typescript,
      sourceText: before,
      filePath: 'src/a.component.ts',
      className: 'AComponent',
      dependencyType: 'UserService',
    });

    expect(result.alreadyPresent).toBe(true);
    expect(result.after).toBe(before);
  });

  it('names the class in the error when it is not in the file', () => {
    expect(() =>
      addDependency({
        typescript,
        sourceText: 'export class Other {}\n',
        filePath: 'src/a.ts',
        className: 'Missing',
        dependencyType: 'UserService',
      }),
    ).toThrow(/No class named "Missing"/);
  });
});

describe('addRoute', () => {
  const lazyRoutes = [
    "import { Routes } from '@angular/router';",
    '',
    'export const routes: Routes = [',
    '  {',
    "    path: 'users',",
    '    loadComponent: () =>',
    "      import('./users/user-list.component').then((m) => m.UserListComponent),",
    '  },',
    '];',
    '',
  ].join('\n');

  const eagerRoutes = [
    "import { Routes } from '@angular/router';",
    '',
    'export const routes: Routes = [',
    "  { path: 'users', component: UserListComponent },",
    '];',
    '',
  ].join('\n');

  function arrayIn(source: string): typescript.ArrayLiteralExpression {
    const sourceFile = typescript.createSourceFile('r.ts', source, typescript.ScriptTarget.ES2022, true);
    let found: typescript.ArrayLiteralExpression | undefined;
    const visit = (node: typescript.Node): void => {
      if (typescript.isArrayLiteralExpression(node) && !found) found = node;
      typescript.forEachChild(node, visit);
    };
    visit(sourceFile);
    return found!;
  }

  it('writes a lazy route into an array of lazy routes', () => {
    const result = addRoute({
      typescript,
      sourceText: lazyRoutes,
      filePath: 'src/app.routes.ts',
      arrayName: 'routes',
      path: 'orders',
      component: 'OrderListComponent',
      componentPath: './orders/order-list.component',
    });

    expect(result.loading).toBe('loadComponent');
    expect(result.loadingConfidence).toBe('certain');
    expect(result.after).toContain("import('./orders/order-list.component').then((m) => m.OrderListComponent)");
  });

  it('writes an eager route into an array of eager routes', () => {
    const result = addRoute({
      typescript,
      sourceText: eagerRoutes,
      filePath: 'src/app.routes.ts',
      arrayName: 'routes',
      path: 'orders',
      component: 'OrderListComponent',
      componentPath: './orders/order-list.component',
    });

    expect(result.loading).toBe('component');
    expect(result.after).toContain("{ path: 'orders', component: OrderListComponent }");
  });

  it('appends rather than reordering, so an existing catch-all keeps its position', () => {
    const withCatchAll = eagerRoutes.replace(
      "  { path: 'users', component: UserListComponent },",
      "  { path: 'users', component: UserListComponent },\n  { path: '**', component: NotFoundComponent },",
    );

    const result = addRoute({
      typescript,
      sourceText: withCatchAll,
      filePath: 'src/app.routes.ts',
      arrayName: 'routes',
      path: 'orders',
      component: 'OrderListComponent',
      componentPath: './orders/order-list.component',
    });

    // Angular matches in order; silently moving someone's catch-all is not a
    // bounded mutation, so the new route lands after it and the caller sees that.
    const catchAllIndex = result.after.indexOf("path: '**'");
    const newRouteIndex = result.after.indexOf("path: 'orders'");
    expect(catchAllIndex).toBeLessThan(newRouteIndex);
  });

  it('reports an empty or evenly split array as unknown rather than detected (P4)', () => {
    expect(detectRouteLoadingStyle(typescript, arrayIn('const routes = [];')).confidence).toBe('unknown');

    const split = arrayIn(
      "const routes = [{ path: 'a', component: A }, { path: 'b', loadComponent: () => import('./b') }];",
    );
    const detected = detectRouteLoadingStyle(typescript, split);
    expect(detected.confidence).toBe('unknown');
    expect(detected.reason).toContain('evenly split');
  });

  it('changes nothing when the path is already declared', () => {
    const result = addRoute({
      typescript,
      sourceText: eagerRoutes,
      filePath: 'src/app.routes.ts',
      arrayName: 'routes',
      path: 'users',
      component: 'UserListComponent',
      componentPath: './users/user-list.component',
    });

    expect(result.alreadyPresent).toBe(true);
    expect(result.after).toBe(eagerRoutes);
  });

  it('names the array in the error when it is not in the file', () => {
    expect(() =>
      addRoute({
        typescript,
        sourceText: eagerRoutes,
        filePath: 'src/app.routes.ts',
        arrayName: 'MISSING_ROUTES',
        path: 'x',
        component: 'X',
        componentPath: './x',
      }),
    ).toThrow(/No routes array named "MISSING_ROUTES"/);
  });
});

describe('angular_generate safety (R11)', () => {
  it('refuses a schematic it does not know, naming the ones it does', () => {
    expect(() => validateGenerateInput('exec-anything', 'x')).toThrow(GenerateError);
    expect(() => validateGenerateInput('exec-anything', 'x')).toThrow(/Supported: /);
    for (const schematic of ALLOWED_SCHEMATICS) {
      expect(() => validateGenerateInput(schematic, 'features/x')).not.toThrow();
    }
  });

  it('refuses a name that could be read as a flag or as shell syntax', () => {
    for (const name of ['--force', '-x', 'a; rm -rf /', 'a && whoami', 'a$(whoami)', 'a`whoami`', 'a|b']) {
      expect(() => validateGenerateInput('component', name), name).toThrow(GenerateError);
    }
  });

  it('accepts the ordinary path-shaped names schematics take', () => {
    for (const name of ['user-card', 'features/users/user-card', 'core/services/user.service']) {
      expect(() => validateGenerateInput('component', name), name).not.toThrow();
    }
  });

  it('refuses to use a CLI that is not installed in the analyzed project', async () => {
    const root = await mkdtemp(join(tmpdir(), 'no-cli-'));
    try {
      await expect(resolveProjectCli(root)).rejects.toThrow(/not installed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('finds the CLI the project itself installed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'with-cli-'));
    try {
      const binDir = join(root, 'node_modules', '@angular', 'cli', 'bin');
      await mkdir(binDir, { recursive: true });
      await writeFile(join(binDir, 'ng.js'), '// stub\n', 'utf8');

      expect(await resolveProjectCli(root)).toBe(join(binDir, 'ng.js'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('parses the file list out of the CLI output, dry run or not', () => {
    const output = [
      'CREATE src/app/user-card/user-card.component.ts (301 bytes)',
      'CREATE src/app/user-card/user-card.component.html (24 bytes)',
      'UPDATE src/app/app.routes.ts (412 bytes)',
      '',
      'NOTE: The "--dry-run" option means no changes were made.',
    ].join('\n');

    expect(parseGeneratedFiles(output)).toEqual([
      { action: 'create', path: 'src/app/user-card/user-card.component.ts' },
      { action: 'create', path: 'src/app/user-card/user-card.component.html' },
      { action: 'update', path: 'src/app/app.routes.ts' },
    ]);
  });
});

/**
 * Every mutation has to leave a file that still parses. This is the property
 * the unit tests above cannot see: they assert on substrings, and a splice
 * that drops a separator still contains every substring you looked for while
 * producing a file that does not compile.
 */
describe('mutations produce syntactically valid TypeScript', () => {
  function syntaxErrorsIn(source: string): string[] {
    const sourceFile = typescript.createSourceFile('check.ts', source, typescript.ScriptTarget.ES2022, true);
    // `parseDiagnostics` is where the parser records syntax errors.
    const diagnostics = (sourceFile as unknown as { parseDiagnostics?: readonly typescript.Diagnostic[] })
      .parseDiagnostics;
    return (diagnostics ?? []).map((diagnostic) =>
      typescript.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    );
  }

  it('recognizes a broken file, so the check itself is worth something', () => {
    expect(syntaxErrorsIn('const routes = [{ a: 1 } { b: 2 }];').length).toBeGreaterThan(0);
  });

  const routeShapes = [
    // Last element followed by a comma, then a newline: the shape the Angular
    // CLI generates, and the one that first produced an unparseable file.
    "export const routes = [\n  {\n    path: 'orders',\n    loadChildren: () => import('./o').then((m) => m.O),\n  },\n];\n",
    // Last element with no trailing comma.
    "export const routes = [\n  { path: 'a', component: A }\n];\n",
    // Single line.
    "export const routes = [{ path: 'a', component: A }];\n",
    // Empty.
    'export const routes = [];\n',
  ];

  it.each(routeShapes)('adds a route to %j and the file still parses', (source) => {
    const result = addRoute({
      typescript,
      sourceText: source,
      filePath: 'src/app.routes.ts',
      arrayName: 'routes',
      path: 'reports',
      component: 'ReportListComponent',
      componentPath: './reports/report-list.component',
    });

    expect(syntaxErrorsIn(result.after)).toEqual([]);
    expect(result.after).toContain("path: 'reports'");
  });

  const classShapes = [
    'export class A {\n  private readonly x = inject(XService);\n}\n',
    'export class A {\n  constructor(private readonly x: XService) {}\n}\n',
    'export class A {\n  constructor() {}\n}\n',
    'export class A {\n  title = 1;\n}\n',
    'export class A {}\n',
  ];

  it.each(classShapes)('adds a dependency to %j and the file still parses', (source) => {
    const result = addDependency({
      typescript,
      sourceText: source,
      filePath: 'src/a.ts',
      className: 'A',
      dependencyType: 'UserService',
      importFrom: './user.service',
    });

    expect(syntaxErrorsIn(result.after)).toEqual([]);
    expect(result.after).toContain('UserService');
  });

  it('keeps a multi-parameter constructor parsing when one more is added', () => {
    const source = [
      'export class A {',
      '  constructor(',
      '    private readonly x: XService,',
      '    private readonly y: YService,',
      '  ) {}',
      '}',
      '',
    ].join('\n');

    const result = addDependency({
      typescript,
      sourceText: source,
      filePath: 'src/a.ts',
      className: 'A',
      dependencyType: 'UserService',
    });

    expect(syntaxErrorsIn(result.after)).toEqual([]);
    expect(result.after).toContain('private readonly userService: UserService');
  });
});

describe('project counts are only read when the file cannot answer (review finding)', () => {
  const request = {
    typescript,
    filePath: 'src/a.ts',
    className: 'A',
    dependencyType: 'UserService',
  } as const;

  it('does not read the rest of the project when the class already shows a style', async () => {
    let loads = 0;
    const load = async () => {
      loads += 1;
      return { injectCalls: 0, constructorParameters: 0 };
    };

    await addDependencyWithLazyProjectCounts(
      { ...request, sourceText: 'export class A {\n  private readonly x = inject(XService);\n}\n' },
      load,
    );

    // Reading every component and service in the project is expensive and,
    // here, pointless: the class itself settled the style.
    expect(loads).toBe(0);
  });

  it('reads them exactly once when the class shows nothing', async () => {
    let loads = 0;
    const load = async () => {
      loads += 1;
      return { injectCalls: 0, constructorParameters: 7 };
    };

    const result = await addDependencyWithLazyProjectCounts(
      { ...request, sourceText: 'export class A {\n  title = 1;\n}\n' },
      load,
    );

    expect(loads).toBe(1);
    expect(result.style.value).toBe('constructor');
    expect(result.style.confidence).toBe('inferred');
  });
});
