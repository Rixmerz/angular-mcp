/**
 * Extractor de specs. Ver docs/PLAN.md, seccion 5.1.
 *
 * Asocia un archivo `*.spec.ts` a los simbolos que prueba combinando dos
 * senales, ambas necesarias (nunca se adivina el simbolo probado a partir
 * solo del nombre del archivo):
 *
 *  1. Convencion de nombre: `foo.service.spec.ts` prueba (solo) lo que se
 *     importa desde `./foo.service` (quitar el sufijo `.spec.ts`).
 *  2. Los imports del propio spec: los nombres importados desde ese modulo
 *     son los simbolos probados.
 *
 * Un import de cualquier otro modulo (un modelo, un helper de test) no
 * cuenta como simbolo probado. Emite un nodo `Spec` y una arista
 * `tested_by: Symbol -> Spec` por cada simbolo asociado.
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

/** `foo.service.spec.ts` -> `foo.service`. Si no termina en `.spec.ts`, se deja tal cual. */
function stripSpecSuffix(path: string): string {
  return path.endsWith(SPEC_SUFFIX) ? path.slice(0, -SPEC_SUFFIX.length) : path;
}

/** Resuelve un module specifier relativo (`./foo`, `../bar/foo`) contra el directorio del spec. */
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
 * Extrae el nodo `Spec` y las aristas `tested_by` de un archivo `*.spec.ts`.
 * `relativePath` es la ruta relativa a la raiz del proyecto analizado.
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
