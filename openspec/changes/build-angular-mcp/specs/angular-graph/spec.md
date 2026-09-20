# Angular semantic graph

## ADDED Requirements

### Requirement: Graph extraction from source

The server SHALL derive every structural fact from the source code on each
query, and SHALL NOT persist as truth any fact it cannot re-derive. The cache
exists only as an accelerator and is invalidated by file hash.

#### Scenario: A file changes outside the server

- **WHEN** a component is edited without going through the server
- **THEN** the next query detects the different hash, reindexes that file and
  returns the new state, without requiring anyone to update the graph by hand

#### Scenario: The cache is empty

- **WHEN** a project that has never been indexed is queried
- **THEN** the server indexes it and answers, rather than failing for lack of a
  cache

### Requirement: Confidence and provenance on every fact

Every node and every edge SHALL carry the file, line and column it came from,
and a confidence level among certain, inferred and unknown. The server SHALL NOT
guess a value it cannot resolve.

#### Scenario: A dynamically built URL

- **WHEN** a service calls HttpClient with a URL assembled at runtime that
  cannot be resolved statically
- **THEN** the call is recorded with urlConfidence unknown and the original
  text, never with an invented URL

#### Scenario: An unresolved template selector

- **WHEN** a template tag matches no component in scope
- **THEN** the edge is emitted with confidence unknown rather than omitted

### Requirement: Compiler resolution from the analyzed project

The server SHALL resolve TypeScript and the Angular compiler from the
node_modules of the project it analyzes, not from its own.

#### Scenario: The project uses a different major version

- **WHEN** the analyzed project uses an Angular version different from the
  server's environment
- **THEN** templates are parsed with the project's compiler, and the detected
  version is reported in the index status

#### Scenario: The project has no Angular installed

- **WHEN** @angular/compiler is missing from the analyzed project
- **THEN** the server fails with a message stating exactly what to install

## ADDED Requirements

### Requirement: Bounded query tools

Every listing tool SHALL accept a limit and return pagination metadata, and
SHALL NOT return the whole graph in one response.

#### Scenario: A large project

- **WHEN** the consumers of a widely used service are queried
- **THEN** the response is paginated with has_more and next_offset, and the
  markdown is truncated while declaring that it was truncated

#### Scenario: An ambiguous symbol name

- **WHEN** two components in a monorepo share a name
- **THEN** the search returns both candidates with their paths, instead of
  picking one

### Requirement: Architecture rule verification

The server SHALL evaluate a diff against the repository's declared rules and
report each violation with the offending edge and an allowed path.

#### Scenario: A component calls HttpClient

- **WHEN** a diff introduces a direct HTTP call in a component and a rule
  forbids it
- **THEN** verification reports the violation with file and line, and suggests
  the component, service, repository path

#### Scenario: The repository already uses another boundary tool

- **WHEN** the project has sheriff or Nx boundary configuration
- **THEN** the server imports it instead of requiring it to be duplicated
