/**
 * Dominant-style detection for the Phase 5 mutations (docs/PLAN.md, R8:
 * "Detect the dominant style before writing").
 *
 * A mutation that writes `inject()` into a codebase of constructor parameters
 * is code someone has to fix by hand, which R8 names as the warning sign for
 * this whole phase. So the style is read out of the file being edited, and
 * only from the project when the file itself says nothing.
 *
 * Everything here is a count over the AST. Where a file genuinely has no
 * signal, the answer is reported as a fallback rather than dressed up as a
 * detection.
 */

import type * as TS from 'typescript';

/** How a class receives its dependencies. */
export type InjectionStyle = 'inject' | 'constructor';

export interface DetectedStyle<T> {
  readonly value: T;
  /**
   * `certain` when the file itself showed the pattern, `inferred` when it was
   * taken from the rest of the project, `unknown` when nothing was found and
   * a default was used (P4).
   */
  readonly confidence: 'certain' | 'inferred' | 'unknown';
  readonly reason: string;
}

export interface InjectionStyleCounts {
  readonly injectCalls: number;
  readonly constructorParameters: number;
}

/**
 * Counts both injection styles inside one class: `inject()` initializers on
 * properties, and parameters with an accessibility modifier or a decorator on
 * the constructor.
 */
export function countInjectionStyles(
  typescript: typeof TS,
  classDeclaration: TS.ClassDeclaration,
): InjectionStyleCounts {
  let injectCalls = 0;
  let constructorParameters = 0;

  for (const member of classDeclaration.members) {
    if (typescript.isPropertyDeclaration(member) && member.initializer) {
      const initializer = member.initializer;
      if (
        typescript.isCallExpression(initializer) &&
        typescript.isIdentifier(initializer.expression) &&
        initializer.expression.text === 'inject'
      ) {
        injectCalls += 1;
      }
      continue;
    }

    if (typescript.isConstructorDeclaration(member)) {
      for (const parameter of member.parameters) {
        // A plain parameter is not a dependency; one carrying `private`/
        // `readonly` or a decorator like `@Inject(TOKEN)` is.
        const hasModifier = (parameter.modifiers?.length ?? 0) > 0;
        if (hasModifier) constructorParameters += 1;
      }
    }
  }

  return { injectCalls, constructorParameters };
}

/**
 * The injection style to write into `classDeclaration`.
 *
 * The file wins when it has any signal at all. `projectCounts`, when given,
 * decides for a class that injects nothing yet. With neither, the fallback is
 * `inject`, which is what current Angular documents — and it is reported as a
 * fallback, not as something detected.
 */
export function detectInjectionStyle(
  typescript: typeof TS,
  classDeclaration: TS.ClassDeclaration,
  projectCounts?: InjectionStyleCounts,
): DetectedStyle<InjectionStyle> {
  const own = countInjectionStyles(typescript, classDeclaration);

  if (own.injectCalls > 0 || own.constructorParameters > 0) {
    const value: InjectionStyle = own.injectCalls >= own.constructorParameters ? 'inject' : 'constructor';
    return {
      value,
      confidence: 'certain',
      reason:
        `the class already uses ${value === 'inject' ? 'inject()' : 'constructor parameters'} ` +
        `(${own.injectCalls} inject call(s), ${own.constructorParameters} constructor parameter(s))`,
    };
  }

  if (projectCounts && (projectCounts.injectCalls > 0 || projectCounts.constructorParameters > 0)) {
    const value: InjectionStyle =
      projectCounts.injectCalls >= projectCounts.constructorParameters ? 'inject' : 'constructor';
    return {
      value,
      confidence: 'inferred',
      reason:
        `the class injects nothing yet, so the project's dominant style was used ` +
        `(${projectCounts.injectCalls} inject call(s) vs ${projectCounts.constructorParameters} constructor parameter(s))`,
    };
  }

  return {
    value: 'inject',
    confidence: 'unknown',
    reason: 'neither the class nor the project shows an existing injection style; defaulted to inject()',
  };
}

/** The indentation of a class's members, so inserted code matches the file. */
export function detectMemberIndent(sourceText: string, classDeclaration: TS.ClassDeclaration, sourceFile: TS.SourceFile): string {
  const firstMember = classDeclaration.members[0];
  if (!firstMember) return '  ';

  const start = firstMember.getStart(sourceFile);
  const lineStart = sourceText.lastIndexOf('\n', start - 1) + 1;
  const indent = sourceText.slice(lineStart, start);

  return /^\s*$/.test(indent) && indent.length > 0 ? indent : '  ';
}

export type QuoteStyle = "'" | '"';

/** The quote character the file predominantly uses for its imports. */
export function detectQuoteStyle(sourceText: string): QuoteStyle {
  const single = (sourceText.match(/from '[^']*'/g) ?? []).length;
  const double = (sourceText.match(/from "[^"]*"/g) ?? []).length;
  return double > single ? '"' : "'";
}
