# 2. Do not use `NgtscProgram` or `TemplateTypeChecker`

**Status:** Accepted · **Relates to:** `docs/PLAN.md` R1, R16, §13

## Decision

Template and scope analysis is done with `parseTemplate` from
`@angular/compiler` plus the ordinary TypeScript type checker. Angular's
`NgtscProgram` and `TemplateTypeChecker` are not used anywhere.

## Why

They are semi-internal API. They would give exact types inside templates and
correct standalone-import scope resolution in hard cases, but they change
without notice between minors, and this server is pinned to whatever version
the analyzed project happens to have (ADR 1). A break there would be a break
against a project we do not control and cannot pin.

## What it costs

Scope resolution is our own: a component's own `imports` when standalone, its
declaring NgModule's `declarations` otherwise. Cases that cannot be resolved —
re-exports, `forwardRef`, some barrels — are reported `unknown` rather than
guessed, which is R16's mitigation.

## Revisit when

R16 materialises: a real project shows a material share of `uses_in_template`
edges marked `unknown` for selectors that plainly do resolve. At that point
`TemplateTypeChecker` becomes worth its instability, and only for those cases.

The grep that proves this decision still holds:

```
rg 'NgtscProgram|TemplateTypeChecker' packages/server/src
```

should match only comments explaining the exclusion.
