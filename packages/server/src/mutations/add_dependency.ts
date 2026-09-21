/**
 * Source edit behind `angular_add_dependency` (docs/PLAN.md, section 6,
 * Phase 5): "Adds an `inject()` call or a constructor parameter according to
 * the file's dominant style."
 *
 * The edit is computed as a text splice over the original source rather than
 * by re-printing the AST. The TypeScript printer reformats everything it
 * touches, which would bury a one-line change in a whole-file diff and make
 * the `dry_run` diff useless for review — the opposite of what Phase 5 is for.
 */

import type * as TS from 'typescript';

import { detectInjectionStyle, detectMemberIndent, detectQuoteStyle } from './style.js';
import type { DetectedStyle, InjectionStyle, InjectionStyleCounts } from './style.js';

export interface AddDependencyRequest {
  readonly typescript: typeof TS;
  readonly sourceText: string;
  readonly filePath: string;
  /** Class to add the dependency to. */
  readonly className: string;
  /** Type of the dependency, e.g. `UserService`. */
  readonly dependencyType: string;
  /** Property name to hold it. Defaults to the type name, lower-camel-cased. */
  readonly propertyName?: string;
  /** Module specifier to import the type from, when it is not already imported. */
  readonly importFrom?: string;
  /** Counts from the rest of the project, used only when the class injects nothing yet. */
  readonly projectCounts?: InjectionStyleCounts;
}

export interface AddDependencyResult {
  readonly after: string;
  readonly style: DetectedStyle<InjectionStyle>;
  readonly propertyName: string;
  readonly addedImport: boolean;
  /** Set when the class already has this dependency: the source is returned unchanged. */
  readonly alreadyPresent: boolean;
}

export class AddDependencyError extends Error {}

function lowerCamel(name: string): string {
  return name.length === 0 ? name : `${name[0]!.toLowerCase()}${name.slice(1)}`;
}

function findClass(
  typescript: typeof TS,
  sourceFile: TS.SourceFile,
  className: string,
): TS.ClassDeclaration {
  let found: TS.ClassDeclaration | undefined;

  const visit = (node: TS.Node): void => {
    if (typescript.isClassDeclaration(node) && node.name?.text === className) found = node;
    typescript.forEachChild(node, visit);
  };
  visit(sourceFile);

  if (!found) {
    throw new AddDependencyError(
      `No class named "${className}" in this file. Call angular_find_symbol to check the name, then pass the ref it returns.`,
    );
  }
  return found;
}

/** True when the class already holds this type, either way of injecting it. */
function alreadyInjects(
  typescript: typeof TS,
  classDeclaration: TS.ClassDeclaration,
  dependencyType: string,
  sourceFile: TS.SourceFile,
): boolean {
  for (const member of classDeclaration.members) {
    if (typescript.isPropertyDeclaration(member)) {
      const text = member.getText(sourceFile);
      if (new RegExp(`\\binject\\s*<?\\s*\\(?\\s*${dependencyType}\\b`).test(text)) return true;
      if (member.type && member.type.getText(sourceFile) === dependencyType) return true;
    }
    if (typescript.isConstructorDeclaration(member)) {
      for (const parameter of member.parameters) {
        if (parameter.type?.getText(sourceFile) === dependencyType) return true;
      }
    }
  }
  return false;
}

/** Inserts `specifier` into an existing import from `moduleSpecifier`, or adds a new import. */
function ensureImport(
  typescript: typeof TS,
  sourceFile: TS.SourceFile,
  sourceText: string,
  specifier: string,
  moduleSpecifier: string,
): { text: string; added: boolean } {
  for (const statement of sourceFile.statements) {
    if (!typescript.isImportDeclaration(statement) || !typescript.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== moduleSpecifier) continue;

    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !typescript.isNamedImports(bindings)) continue;

    if (bindings.elements.some((element) => element.name.text === specifier)) {
      return { text: sourceText, added: false };
    }

    // Splice the new specifier in before the closing brace, preserving whatever
    // spacing the file already uses inside it.
    const lastElement = bindings.elements[bindings.elements.length - 1];
    if (!lastElement) continue;
    const insertAt = lastElement.getEnd();
    return {
      text: `${sourceText.slice(0, insertAt)}, ${specifier}${sourceText.slice(insertAt)}`,
      added: true,
    };
  }

  const quote = detectQuoteStyle(sourceText);
  const importLine = `import { ${specifier} } from ${quote}${moduleSpecifier}${quote};\n`;

  const lastImport = [...sourceFile.statements].reverse().find((statement) => typescript.isImportDeclaration(statement));
  const insertAt = lastImport ? lastImport.getEnd() + 1 : 0;

  return {
    text: `${sourceText.slice(0, insertAt)}${importLine}${sourceText.slice(insertAt)}`,
    added: true,
  };
}

/**
 * Returns the file's text with `dependencyType` injected into `className`, in
 * whichever style that file already uses.
 */
export function addDependency(request: AddDependencyRequest): AddDependencyResult {
  const { typescript, sourceText, filePath, className, dependencyType } = request;

  const sourceFile = typescript.createSourceFile(filePath, sourceText, typescript.ScriptTarget.ES2022, true);
  const classDeclaration = findClass(typescript, sourceFile, className);
  const propertyName = request.propertyName ?? lowerCamel(dependencyType);
  const style = detectInjectionStyle(typescript, classDeclaration, request.projectCounts);

  if (alreadyInjects(typescript, classDeclaration, dependencyType, sourceFile)) {
    return { after: sourceText, style, propertyName, addedImport: false, alreadyPresent: true };
  }

  const indent = detectMemberIndent(sourceText, classDeclaration, sourceFile);

  let text = sourceText;
  let addedImport = false;

  if (style.value === 'inject') {
    // `inject()` itself has to be imported from @angular/core before it can be
    // called, and a class using constructor injection may never have imported it.
    const withInject = ensureImport(typescript, sourceFile, text, 'inject', '@angular/core');
    text = withInject.text;
    addedImport = withInject.added;
  }

  if (request.importFrom) {
    const reparsed = typescript.createSourceFile(filePath, text, typescript.ScriptTarget.ES2022, true);
    const withType = ensureImport(typescript, reparsed, text, dependencyType, request.importFrom);
    text = withType.text;
    addedImport = addedImport || withType.added;
  }

  // Re-parse: the import edits above shifted every offset in the file.
  const reparsed = typescript.createSourceFile(filePath, text, typescript.ScriptTarget.ES2022, true);
  const reparsedClass = findClass(typescript, reparsed, className);

  if (style.value === 'inject') {
    const insertAt = reparsedClass.members[0]?.getStart(reparsed) ?? reparsedClass.getEnd() - 1;
    const declaration = `private readonly ${propertyName} = inject(${dependencyType});\n\n${indent}`;
    return {
      after: `${text.slice(0, insertAt)}${declaration}${text.slice(insertAt)}`,
      style,
      propertyName,
      addedImport,
      alreadyPresent: false,
    };
  }

  const constructorDeclaration = reparsedClass.members.find((member) =>
    typescript.isConstructorDeclaration(member),
  ) as TS.ConstructorDeclaration | undefined;

  const parameter = `private readonly ${propertyName}: ${dependencyType}`;

  if (!constructorDeclaration) {
    const insertAt = reparsedClass.members[0]?.getStart(reparsed) ?? reparsedClass.getEnd() - 1;
    const block = `constructor(${parameter}) {}\n\n${indent}`;
    return {
      after: `${text.slice(0, insertAt)}${block}${text.slice(insertAt)}`,
      style,
      propertyName,
      addedImport,
      alreadyPresent: false,
    };
  }

  const parameters = constructorDeclaration.parameters;
  if (parameters.length === 0) {
    // `constructor()` — insert between the parentheses.
    const openParen = text.indexOf('(', constructorDeclaration.getStart(reparsed));
    return {
      after: `${text.slice(0, openParen + 1)}${parameter}${text.slice(openParen + 1)}`,
      style,
      propertyName,
      addedImport,
      alreadyPresent: false,
    };
  }

  // Match the existing parameter list's layout: one per line, or inline.
  const lastParameter = parameters[parameters.length - 1]!;
  const listText = text.slice(parameters[0]!.getStart(reparsed), lastParameter.getEnd());
  const multiline = listText.includes('\n');
  const separator = multiline ? `,\n${indent}${indent}` : ', ';

  const insertAt = lastParameter.getEnd();
  return {
    after: `${text.slice(0, insertAt)}${separator}${parameter}${text.slice(insertAt)}`,
    style,
    propertyName,
    addedImport,
    alreadyPresent: false,
  };
}
