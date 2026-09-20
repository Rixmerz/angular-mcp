/**
 * Spec extractor. See docs/PLAN.md, section 5.1.
 *
 * Associates a `*.spec.ts` file with the symbols it tests by combining two
 * signals, both required (the symbol under test is never guessed from the file
 * name alone):
 *
 *  1. Naming convention: `foo.service.spec.ts` tests (only) what is imported
 *     from `./foo.service` (drop the `.spec.ts` suffix).
 *  2. The spec's own imports: the names imported from that module are the
 *     symbols under test.
 *
 * An import from any other module (a model, a test helper) does not count as a
 * symbol under test. Emits one `Spec` node and one `tested_by: Symbol -> Spec`
 * edge per associated symbol.
 */

import { posix } from 'node:path';

import { makeNodeId, normalizeRelativePath } from '../../graph/model.js';
import type { NodeId, Provenance, SpecNode, TestedByEdge } from '../../graph/model.js';

import type * as TS from 'typescript';

const SPEC_SUFFIX = '.spec.ts';

function getProvenance(sourceFile: TS.SourceFile, node: TS.Node, path: string): Provenance {
  const { line, character } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return { file: path, line: line + 1, column: character + 1 };
}

/** `foo.service.spec.ts` -> `foo.service`. Left untouched when it does not end in `.spec.ts`. */
function stripSpecSuffix(path: string): string {
  return path.endsWith(SPEC_SUFFIX) ? path.slice(0, -SPEC_SUFFIX.length) : path;
}

/** Resolves a relative module specifier (`./foo`, `../bar/foo`) against the spec's directory. */
function resolveRelativeModulePath(specDir: string, specifier: string): string {
  return normalizeRelativePath(posix.normalize(posix.join(specDir, specifier)));
}

function collectDescribeNames(typescript: typeof TS, sourceFile: TS.SourceFile): readonly string[] {
  const names: string[] = [];

  function visit(node: TS.Node): void {
    if (
      typescript.isCallExpression(node) &&
      typescript.isIdentifier(node.expression) &&
      node.expression.text === 'describe'
    ) {
      const firstArg = node.arguments[0];
      if (firstArg && typescript.isStringLiteralLike(firstArg)) {
        names.push(firstArg.text);
      }
    }
    typescript.forEachChild(node, visit);
  }

  visit(sourceFile);
  return names;
}

export interface SpecExtractionResult {
  readonly node: SpecNode;
  readonly edges: readonly TestedByEdge[];
}

/**
 * Extracts the `Spec` node and the `tested_by` edges of a `*.spec.ts` file.
 * `relativePath` is the path relative to the root of the analyzed project.
 */
export function extractSpec(typescript: typeof TS, sourceFile: TS.SourceFile, relativePath: string): SpecExtractionResult {
  const path = normalizeRelativePath(relativePath);
  const basePath = stripSpecSuffix(path);
  const specDir = posix.dirname(path);
  const specNodeId = makeNodeId(path, 'Spec');

  const testedRefs: NodeId[] = [];
  const edges: TestedByEdge[] = [];

  for (const statement of sourceFile.statements) {
    if (!typescript.isImportDeclaration(statement)) continue;
    if (!typescript.isStringLiteral(statement.moduleSpecifier)) continue;

    const specifier = statement.moduleSpecifier.text;
    if (!specifier.startsWith('.')) continue;

    const resolvedTargetPath = resolveRelativeModulePath(specDir, specifier);
    if (resolvedTargetPath !== basePath) continue;

    const namedBindings = statement.importClause?.namedBindings;
    if (!namedBindings || !typescript.isNamedImports(namedBindings)) continue;

    for (const element of namedBindings.elements) {
      const importedName = (element.propertyName ?? element.name).text;
      const targetId = makeNodeId(`${resolvedTargetPath}.ts`, importedName);
      testedRefs.push(targetId);
      edges.push({
        kind: 'tested_by',
        from: targetId,
        to: specNodeId,
        provenance: getProvenance(sourceFile, statement, path),
        confidence: 'inferred',
      });
    }
  }

  const specNode: SpecNode = {
    id: specNodeId,
    kind: 'Spec',
    path,
    name: 'Spec',
    describes: collectDescribeNames(typescript, sourceFile),
    testedRefs,
  };

  return { node: specNode, edges };
}
