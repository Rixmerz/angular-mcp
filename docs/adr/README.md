# Architecture decisions

One file per decision (`docs/PLAN.md`, section 12). Each records what was
decided, what it cost, and — where one exists — the evidence that settled it.

A decision only earns a file here if reversing it would be expensive or if
someone reading the code would otherwise reasonably ask "why on earth is it
done this way". Preferences do not qualify.

| # | Decision | Status |
|---|---|---|
| [0001](0001-resolve-compiler-from-analyzed-project.md) | Resolve TypeScript and the Angular compiler from the analyzed project | Accepted |
| [0002](0002-no-ngtsc-program.md) | Do not use `NgtscProgram` or `TemplateTypeChecker` | Accepted |
| [0003](0003-index-the-program-closure.md) | Index the program's transitive closure, not the tsconfig root names | Accepted |
| [0004](0004-graph-persistence.md) | Keep the JSON cache; do not adopt SQLite | Accepted |
| [0005](0005-text-splices-for-mutations.md) | Edit source with text splices, not by re-printing the AST | Accepted |
