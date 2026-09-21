# v20-app

An Angular 20 fixture, for the version matrix `docs/PLAN.md` section 9.4 asks
for and R1's mitigation depends on.

It exists because the other two fixtures are both Angular 18, so nothing
exercised the behaviour that differs *between* majors — most sharply the
`standalone` default, which flipped to `true` in Angular 19. The indexer reads
that from the analyzed project's own compiler (see `docs/adr/0001-...`), and
until this fixture existed, the Angular-19-and-later branch of that logic was
never run against a real Angular 19+ install.

It is deliberately minimal: only the packages the indexer resolves from an
analyzed project, so CI can install it in seconds. It is not a runnable
application and has no CLI, no builder and no tests of its own.
