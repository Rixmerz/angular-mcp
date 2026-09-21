/**
 * `angular_get_api_contract` — docs/PLAN.md, section 6, Phase 3.
 *
 * "What does this endpoint actually return?" If the repository ships an
 * OpenAPI or Swagger document, the answer comes from it and is `certain`. If
 * it does not, the answer is whatever the call site's TypeScript generics say
 * — which is what the frontend *believes*, not what the backend promises — and
 * is reported as `inferred`, exactly as the plan requires.
 *
 * The distinction is the point. An agent that cannot tell a contract from an
 * assumption will write code against the assumption (R7).
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parse as parseYaml } from 'yaml';
import { z } from 'zod';

import { formatFacts } from '../format/index.js';
import type { Fact } from '../format/index.js';
import type { HttpCallNode } from '../graph/model.js';

import { defineTool, READ_ONLY_ANNOTATIONS } from './internal/define.js';
import { InvalidInputError } from './internal/errors.js';
import { makeFact } from './internal/facts.js';
import { formattedResponseSchema, pagingInputShape, rootInputField } from './internal/schemas.js';

/**
 * Where an OpenAPI document conventionally lives. Searched in order; the
 * first that parses wins. Nothing is fetched over the network (R11).
 */
export const OPENAPI_CANDIDATE_PATHS = [
  'openapi.json',
  'openapi.yaml',
  'openapi.yml',
  'swagger.json',
  'swagger.yaml',
  'swagger.yml',
  'api/openapi.json',
  'api/openapi.yaml',
  'docs/openapi.json',
  'docs/openapi.yaml',
  'src/api/openapi.json',
  'src/api/openapi.yaml',
] as const;

interface OpenApiDocument {
  readonly paths?: Record<string, Record<string, unknown>>;
}

export interface LoadedContractSource {
  readonly path: string;
  readonly document: OpenApiDocument;
}

/** Reads the first OpenAPI document found under `root`, or undefined when there is none. */
export async function loadOpenApiDocument(root: string): Promise<LoadedContractSource | undefined> {
  for (const candidate of OPENAPI_CANDIDATE_PATHS) {
    let text: string;
    try {
      text = await readFile(join(root, candidate), 'utf8');
    } catch {
      continue;
    }

    try {
      const document = (candidate.endsWith('.json') ? JSON.parse(text) : parseYaml(text)) as OpenApiDocument;
      if (document && typeof document === 'object' && document.paths) {
        return { path: candidate, document };
      }
    } catch {
      // A malformed document is skipped rather than fatal: the next candidate
      // may be the real one, and a broken file is not a reason to answer
      // nothing at all (R14's principle, applied here).
      continue;
    }
  }

  return undefined;
}

/**
 * Matches a call's URL pattern against an OpenAPI path template.
 *
 * `/api/users/{id}` and `${environment.apiUrl}/users/${id}` describe the same
 * endpoint, so both sides are reduced to their literal segments with every
 * parameter collapsed to a single placeholder. A pattern the extractor could
 * not resolve (`urlConfidence: 'unknown'`) is never matched against anything:
 * guessing which endpoint an unresolved URL meant is exactly the failure P4
 * exists to prevent.
 */
export function normalizeUrlForMatching(url: string): string {
  return url
    .replace(/\$\{[^}]*\}/g, '{}') // template literal holes
    .replace(/\{[^}]*\}/g, '{}') // OpenAPI path parameters
    .replace(/^https?:\/\/[^/]+/, '') // origin
    // A template literal that starts with its base URL (`${environment.apiUrl}/users`)
    // has just become `{}/users`: that leading hole is the origin, not a path segment.
    .replace(/^\{\}/, '')
    .replace(/\?.*$/, '') // query string
    .replace(/\/+$/, '') // trailing slash
    .toLowerCase();
}

/** True when a call URL and an OpenAPI path describe the same endpoint shape. */
export function urlMatchesOpenApiPath(callUrl: string, openApiPath: string): boolean {
  const normalizedCall = normalizeUrlForMatching(callUrl);
  const normalizedPath = normalizeUrlForMatching(openApiPath);
  if (normalizedCall === normalizedPath) return true;

  // The call's URL usually carries a base the document omits, so a suffix
  // match on whole segments counts, while a partial segment does not.
  return normalizedCall.endsWith(normalizedPath) && normalizedPath.length > 0;
}

const inputSchema = {
  root: rootInputField,
  url_pattern: z
    .string()
    .optional()
    .describe('Substring of the URL to look up, e.g. "/users". One of "url_pattern" or "http_call_ref" is required.'),
  http_call_ref: z
    .string()
    .optional()
    .describe('Full ref of an HttpCall node, as angular_list_http_calls reports it.'),
  ...pagingInputShape,
};

const outputSchema = {
  source: z
    .enum(['openapi', 'typescript-generics', 'none'])
    .describe(
      '"openapi": read from a document in the repository, so it is the backend\'s stated contract. ' +
        '"typescript-generics": read from the call site\'s type arguments, so it is what the frontend assumes. ' +
        '"none": neither was available.',
    ),
  sourcePath: z.string().optional().describe('The OpenAPI document the contract came from, when source is "openapi".'),
  matchCount: z.number().int(),
  result: formattedResponseSchema,
};

function contractFactsFromOpenApi(
  calls: readonly HttpCallNode[],
  source: LoadedContractSource,
): Fact[] {
  const facts: Fact[] = [];

  for (const call of calls) {
    if (call.urlConfidence === 'unknown') {
      facts.push(
        makeFact({
          kind: 'Contract',
          summary: `${call.method} ${call.urlPattern} — URL could not be resolved statically, so it was not matched against the document`,
          provenance: { file: call.path },
          confidence: 'unknown',
          detail: { ref: call.id, method: call.method, urlPattern: call.urlPattern },
        }),
      );
      continue;
    }

    const matchedPath = Object.keys(source.document.paths ?? {}).find((openApiPath) =>
      urlMatchesOpenApiPath(call.urlPattern, openApiPath),
    );

    if (!matchedPath) {
      facts.push(
        makeFact({
          kind: 'Contract',
          summary: `${call.method} ${call.urlPattern} — no matching path in ${source.path}`,
          provenance: { file: call.path },
          confidence: 'unknown',
          detail: { ref: call.id, method: call.method, urlPattern: call.urlPattern },
        }),
      );
      continue;
    }

    const operations = source.document.paths?.[matchedPath] ?? {};
    const operation = operations[call.method.toLowerCase()];

    facts.push(
      makeFact({
        kind: 'Contract',
        summary: `${call.method} ${matchedPath} — defined in ${source.path}`,
        provenance: { file: source.path },
        confidence: operation ? 'certain' : 'unknown',
        detail: {
          ref: call.id,
          openApiPath: matchedPath,
          method: call.method,
          operation: operation ?? null,
          note: operation ? undefined : `The path exists but declares no "${call.method.toLowerCase()}" operation.`,
        },
      }),
    );
  }

  return facts;
}

function contractFactsFromGenerics(calls: readonly HttpCallNode[]): Fact[] {
  return calls.map((call) =>
    makeFact({
      kind: 'Contract',
      summary:
        `${call.method} ${call.urlPattern} — response ${call.responseTypeText ?? 'unknown'}` +
        (call.requestTypeText ? `, request ${call.requestTypeText}` : ''),
      provenance: { file: call.path },
      // The type argument is read straight from the AST, but it describes what
      // this codebase expects, not what the API guarantees. That gap is the
      // whole reason the plan asks for `inferred` here.
      confidence: 'inferred',
      detail: {
        ref: call.id,
        method: call.method,
        urlPattern: call.urlPattern,
        urlConfidence: call.urlConfidence,
        responseTypeText: call.responseTypeText,
        requestTypeText: call.requestTypeText,
      },
    }),
  );
}

export const getApiContractTool = defineTool({
  name: 'angular_get_api_contract',
  description:
    'Looks up the request and response shape of an HTTP endpoint the project calls. When the repository ships an ' +
    'OpenAPI or Swagger document, the contract is read from it and marked certain. When it does not, the call ' +
    "site's TypeScript generics are reported instead and marked inferred — that is what this codebase assumes " +
    'the API returns, not what the API promises. Nothing is fetched over the network.',
  inputSchema,
  outputSchema,
  annotations: { ...READ_ONLY_ANNOTATIONS, title: 'Get API contract' },
  async handler(input, context) {
    const root = context.resolveRoot(input.root);
    const graph = context.requireGraph(root);

    if (!input.url_pattern && !input.http_call_ref) {
      throw new InvalidInputError(
        'Provide "url_pattern" or "http_call_ref". Call angular_list_http_calls first to see what the project calls.',
      );
    }

    const allCalls = graph.nodesByKind('HttpCall') as HttpCallNode[];
    const calls = allCalls.filter((call) => {
      if (input.http_call_ref) return call.id === input.http_call_ref;
      return call.urlPattern.toLowerCase().includes((input.url_pattern ?? '').toLowerCase());
    });

    if (calls.length === 0) {
      return {
        source: 'none' as const,
        matchCount: 0,
        result: formatFacts([], { limit: input.limit, offset: input.offset, format: input.format, title: 'API contract' }),
      };
    }

    const openApi = await loadOpenApiDocument(root);
    const facts = openApi ? contractFactsFromOpenApi(calls, openApi) : contractFactsFromGenerics(calls);

    return {
      source: openApi ? ('openapi' as const) : ('typescript-generics' as const),
      sourcePath: openApi?.path,
      matchCount: calls.length,
      result: formatFacts(facts, {
        limit: input.limit,
        offset: input.offset,
        format: input.format,
        title: openApi ? `API contract (from ${openApi.path})` : 'API contract (inferred from TypeScript generics)',
      }),
    };
  },
});
