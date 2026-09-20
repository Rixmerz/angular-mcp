/**
 * Cache en disco del ProjectGraph, en `.angular-mcp/cache/`. Ver
 * docs/PLAN.md, seccion 4.1 (R2: el grafo se desincroniza del codigo).
 *
 * Principio P1: la cache es solo aceleracion, nunca la fuente de verdad.
 * Todo lo que persiste aqui se puede rederivar volviendo a indexar el
 * codigo. La invalidacion es por hash de archivo: si el hash de un archivo
 * cambio (o el esquema del cache cambio), la entrada correspondiente se
 * trata como obsoleta y se descarta, nunca se repara a mano.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { GraphEdge, GraphNode } from './model.js';
import { normalizeRelativePath } from './model.js';
import type { ProjectGraph } from './index.js';

/** Version del esquema de la cache. Cambia si `CacheFile` cambia de forma. */
export const CACHE_SCHEMA_VERSION = 1;

export const DEFAULT_CACHE_DIR = '.angular-mcp/cache';
export const CACHE_FILE_NAME = 'graph.json';

/** Contenido serializado de la cache: nodos, aristas y el hash de cada archivo fuente. */
export interface CacheFile {
  readonly schemaVersion: number;
  readonly generatedAt: string;
  /** Hash del contenido de cada archivo fuente indexado, por ruta relativa normalizada. */
  readonly fileHashes: Readonly<Record<string, string>>;
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/** Resultado de comparar los hashes cacheados contra los hashes actuales de disco. */
export interface StaleCheck {
  /** Archivos cacheados cuyo hash ya no coincide con el contenido actual. */
  readonly changed: readonly string[];
  /** Archivos actuales sin entrada en la cache. */
  readonly added: readonly string[];
  /** Archivos que estaban cacheados pero no aparecen entre los actuales. */
  readonly removed: readonly string[];
  /** Archivos cuyo hash coincide: seguros de reusar de la cache. */
  readonly unchanged: readonly string[];
}

/** true si no hay ninguna diferencia: la cache esta completamente al dia. */
export function isFresh(check: StaleCheck): boolean {
  return check.changed.length === 0 && check.added.length === 0 && check.removed.length === 0;
}

/** Hash de contenido, usado tanto para archivos en disco como en pruebas. */
export function hashContent(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

/** Hash del contenido actual de un archivo en disco. */
export async function hashFile(absolutePath: string): Promise<string> {
  const content = await readFile(absolutePath);
  return hashContent(content);
}

/**
 * Compara los hashes guardados en una cache contra los hashes actuales de
 * los archivos del proyecto. Pura: no toca disco, para que sea trivial de
 * testear sin fixtures en el filesystem.
 */
export function diffFileHashes(
  cachedHashes: Readonly<Record<string, string>>,
  currentHashes: ReadonlyMap<string, string>,
): StaleCheck {
  const changed: string[] = [];
  const added: string[] = [];
  const unchanged: string[] = [];
  const seen = new Set<string>();

  for (const [rawPath, currentHash] of currentHashes) {
    const path = normalizeRelativePath(rawPath);
    seen.add(path);
    const cachedHash = cachedHashes[path];
    if (cachedHash === undefined) {
      added.push(path);
    } else if (cachedHash !== currentHash) {
      changed.push(path);
    } else {
      unchanged.push(path);
    }
  }

  const removed: string[] = [];
  for (const path of Object.keys(cachedHashes)) {
    if (!seen.has(path)) removed.push(path);
  }

  return { changed, added, removed, unchanged };
}

function isCacheFile(value: unknown): value is CacheFile {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.schemaVersion === 'number' &&
    typeof candidate.generatedAt === 'string' &&
    typeof candidate.fileHashes === 'object' &&
    candidate.fileHashes !== null &&
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.edges)
  );
}

/**
 * Lee y escribe la cache de un `ProjectGraph` en `<projectRoot>/<cacheDir>/graph.json`.
 */
export class GraphCache {
  private readonly cacheFilePath: string;

  constructor(projectRoot: string, cacheDir: string = DEFAULT_CACHE_DIR) {
    this.cacheFilePath = join(projectRoot, cacheDir, CACHE_FILE_NAME);
  }

  get filePath(): string {
    return this.cacheFilePath;
  }

  /**
   * Lee la cache de disco. Devuelve `undefined` si no existe, si el JSON es
   * invalido, o si su `schemaVersion` no coincide con la version actual: una
   * cache de un esquema viejo se trata como inexistente, nunca se migra a
   * mano (P1).
   */
  async read(): Promise<CacheFile | undefined> {
    let raw: string;
    try {
      raw = await readFile(this.cacheFilePath, 'utf8');
    } catch {
      return undefined;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }

    if (!isCacheFile(parsed) || parsed.schemaVersion !== CACHE_SCHEMA_VERSION) {
      return undefined;
    }

    return parsed;
  }

  /** Serializa el grafo completo junto con el hash de cada archivo indexado. */
  async write(graph: ProjectGraph, fileHashes: ReadonlyMap<string, string>): Promise<void> {
    const data: CacheFile = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      fileHashes: Object.fromEntries(
        Array.from(fileHashes, ([path, hash]) => [normalizeRelativePath(path), hash] as const),
      ),
      nodes: graph.allNodes(),
      edges: graph.allEdges(),
    };

    await mkdir(dirname(this.cacheFilePath), { recursive: true });
    await writeFile(this.cacheFilePath, JSON.stringify(data), 'utf8');
  }

  /** Lee la cache y la compara contra los hashes actuales. `undefined` si no hay cache utilizable. */
  async checkStale(currentHashes: ReadonlyMap<string, string>): Promise<StaleCheck | undefined> {
    const cached = await this.read();
    if (!cached) return undefined;
    return diffFileHashes(cached.fileHashes, currentHashes);
  }

  /** Carga los nodos y aristas de una entrada de cache dentro de un `ProjectGraph`. */
  hydrate(graph: ProjectGraph, cached: CacheFile): void {
    graph.addNodes(cached.nodes);
    graph.addEdges(cached.edges);
  }
}
