import { describe, expect, it } from 'vitest';

import { makeNodeId, normalizeRelativePath, parseNodeId } from '../../src/graph/model.js';
import type { Confidence, GraphEdge, GraphNode, InjectsEdge, ServiceNode } from '../../src/graph/model.js';

describe('makeNodeId', () => {
  it('joins the relative path and the symbol with "#"', () => {
    expect(makeNodeId('src/app/user.service.ts', 'UserService')).toBe(
      'src/app/user.service.ts#UserService',
    );
  });

  it('normalizes backslashes and a leading "./" in the path', () => {
    expect(makeNodeId('.\\src\\app\\user.service.ts', 'UserService')).toBe(
      'src/app/user.service.ts#UserService',
    );
    expect(makeNodeId('./src/app/user.service.ts', 'UserService')).toBe(
      'src/app/user.service.ts#UserService',
    );
  });

  it('throws when the symbol is empty, since a bare path is never a valid node id', () => {
    expect(() => makeNodeId('src/app/user.service.ts', '')).toThrow();
  });
});

describe('parseNodeId', () => {
  it('splits a node id back into its path and symbol', () => {
    expect(parseNodeId('src/app/user.service.ts#UserService')).toEqual({
      path: 'src/app/user.service.ts',
      symbol: 'UserService',
    });
  });

  it('throws for an id without "#", since a bare name is never a valid node id (R13)', () => {
    expect(() => parseNodeId('UserService')).toThrow();
  });

  it('is the inverse of makeNodeId for a normalized path', () => {
    const id = makeNodeId('src/app/user.service.ts', 'UserService');
    expect(parseNodeId(id)).toEqual({ path: 'src/app/user.service.ts', symbol: 'UserService' });
  });
});

describe('normalizeRelativePath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizeRelativePath('src\\app\\user.ts')).toBe('src/app/user.ts');
  });

  it('strips a leading "./"', () => {
    expect(normalizeRelativePath('./src/app/user.ts')).toBe('src/app/user.ts');
  });

  it('leaves an already-normalized path untouched', () => {
    expect(normalizeRelativePath('src/app/user.ts')).toBe('src/app/user.ts');
  });
});

describe('edge shape (tabla 5.2)', () => {
  it('every edge carries provenance and confidence regardless of its kind', () => {
    const confidences: Confidence[] = ['certain', 'inferred', 'unknown'];

    const edges: GraphEdge[] = confidences.map((confidence) => ({
      kind: 'injects',
      from: makeNodeId('src/app/user-list.component.ts', 'UserListComponent'),
      to: makeNodeId('src/app/user.service.ts', 'UserService'),
      provenance: { file: 'src/app/user-list.component.ts', line: 12, column: 3 },
      confidence,
      via: 'constructor',
      optional: false,
    }));

    for (const edge of edges) {
      expect(edge.provenance.file).toBeTypeOf('string');
      expect(edge.provenance.line).toBeGreaterThan(0);
      expect(edge.provenance.column).toBeGreaterThan(0);
      expect(['certain', 'inferred', 'unknown']).toContain(edge.confidence);
    }
  });

  it('typed edge variants keep their edge-specific fields alongside provenance/confidence', () => {
    const edge: InjectsEdge = {
      kind: 'injects',
      from: makeNodeId('src/app/user-list.component.ts', 'UserListComponent'),
      to: makeNodeId('src/app/user.service.ts', 'UserService'),
      provenance: { file: 'src/app/user-list.component.ts', line: 12, column: 3 },
      confidence: 'certain',
      via: 'inject',
      optional: false,
    };

    expect(edge.via).toBe('inject');
  });
});

describe('node shape (tabla 5.1)', () => {
  it('a node id is always "path#symbol", never a bare name', () => {
    const service: ServiceNode = {
      id: makeNodeId('src/app/user.service.ts', 'UserService'),
      kind: 'Service',
      path: 'src/app/user.service.ts',
      name: 'UserService',
      providedIn: 'root',
      isInjectable: true,
    };

    const node: GraphNode = service;
    expect(node.id).toContain('#');
    expect(node.id).not.toBe(node.name);
  });
});
