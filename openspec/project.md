# angular-mcp

An MCP server that exposes the semantic graph of an Angular project as query
tools. The full plan lives in `docs/PLAN.md`.

## Conventions

- Strict TypeScript, ESM, Node >= 20.
- The server is deterministic: it returns facts derived from the code, not
  judgement.
- Every fact carries a confidence level and its provenance.
- Code, comments, error messages and documentation are written in English.
