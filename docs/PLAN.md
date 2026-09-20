# Angular MCP — Plan de construcción

> Estado: propuesta inicial. Este documento es el plan de trabajo, no una especificación cerrada.
> Cada fase tiene criterios de salida explícitos; no se avanza a la siguiente sin cumplirlos.

---

## 1. Problema y objetivo

Un agente que trabaja sobre un proyecto Angular gasta la mayor parte de su contexto y
de sus turnos reconstruyendo, en cada tarea, el mismo grafo de relaciones:

```
Component → Template → Signal/Observable → Service → DI → Interceptor → HTTP → Backend
```

Además debe recordar convenciones del repositorio, rutas, contratos, lifecycle y tests
asociados. Nada de eso cambia entre tareas, pero el agente lo redescubre cada vez.

**Objetivo:** construir un servidor MCP que extraiga ese grafo del código de forma
determinista y lo exponga mediante herramientas semánticas, de modo que el agente
trabaje sobre conceptos (componente, servicio, ruta, contrato) y no sobre archivos.

**Resultado esperado:** para una tarea típica ("agrega paginación a usuarios"), el agente
obtiene en una o dos llamadas el subgrafo afectado, los patrones existentes similares, los
tests relevantes y las reglas de arquitectura aplicables, en lugar de leer diez archivos.

---

## 2. Principios de diseño (no negociables)

| # | Principio | Consecuencia práctica |
|---|-----------|------------------------|
| P1 | **Derivar, no recordar** | Todo hecho estructural sale del código en cada consulta (con cache por hash). El agente nunca "actualiza el grafo" a mano. |
| P2 | **El MCP es determinista** | Devuelve hechos, subgrafos y coincidencias. No recomienda implementaciones; eso es trabajo del LLM. |
| P3 | **Lectura antes que escritura** | Las herramientas de consulta e impacto llegan primero. Las mutaciones se habilitan solo cuando el grafo demuestre ser confiable. |
| P4 | **Honestidad sobre cobertura** | Cada hecho lleva `confidence` y `provenance` (archivo:línea). Lo que no se puede inferir se reporta como `unknown`, nunca se adivina. |
| P5 | **Usar el compilador, no reimplementarlo** | Metadata, DI y AST de templates vienen del propio `@angular/compiler` del proyecto analizado. |
| P6 | **Respuestas acotadas** | Toda herramienta que lista soporta `limit`, `depth` y `format` (markdown/json). Nada devuelve el grafo entero. |
| P7 | **Reglas declarativas y versionadas** | La arquitectura vive en un archivo en el repo del usuario, junto al código, no dentro del MCP. |

---

## 3. Alcance

### Dentro del alcance (v1)

- Proyectos Angular **standalone** y **NgModule** (ambos desde el inicio; los proyectos reales son mixtos).
- Workspaces Angular CLI (`angular.json`) con uno o varios proyectos.
- Análisis estático: componentes, directivas, pipes, servicios, DI, signals, inputs/outputs,
  bindings de template, rutas (incluyendo lazy), guards/resolvers, interceptores,
  llamadas HTTP, specs asociados.
- Reglas de arquitectura declarativas y verificación de un diff contra ellas.
- Detección de patrones similares existentes (para "hazlo como ya se hace aquí").
- Transporte **stdio** (uso local desde Claude Code, Cursor, etc.).

### Fuera del alcance (v1)

- Runtime: errores en ejecución, tráfico de red, logs, builds en vivo. Requiere instrumentación
  del proceso y es un proyecto aparte. Se deja un punto de extensión.
- Mutaciones de alto nivel (`add_signal`, `bind_template`). Solo se evalúan en Fase 5, tras validar el grafo.
- Otros frameworks (React, Svelte, Nest). El diseño del núcleo debe permitirlo, pero no se implementa.
- Transporte HTTP remoto multi-cliente. Solo si aparece un caso de uso real.
- Monorepos Nx con `project.json` sin `angular.json`: soporte básico en v1 (detección), completo en v2.

---

## 4. Arquitectura

```
                         ┌────────────────────────────┐
                         │        Cliente MCP         │
                         │  (Claude Code, Cursor...)  │
                         └─────────────┬──────────────┘
                                       │ stdio (JSON-RPC)
                         ┌─────────────▼──────────────┐
                         │      angular-mcp-server    │
                         │  tools · resources · prompts│
                         └─────────────┬──────────────┘
                                       │
          ┌────────────────────────────┼────────────────────────────┐
          ▼                            ▼                            ▼
┌──────────────────┐        ┌──────────────────┐        ┌──────────────────┐
│   Query Engine   │        │   Rules Engine   │        │  Pattern Finder  │
│ find / who_uses  │        │ layers, boundaries│        │ similar_to       │
│ impact / routes  │        │ check diff        │        │ (estructural)    │
└────────┬─────────┘        └────────┬─────────┘        └────────┬─────────┘
         │                           │                           │
         └───────────────────────────┼───────────────────────────┘
                                     ▼
                         ┌────────────────────────────┐
                         │        Project Graph       │
                         │  nodos + aristas + prov.   │
                         │  (memoria + cache en disco)│
                         └─────────────┬──────────────┘
                                       │
                         ┌─────────────▼──────────────┐
                         │          Indexer           │
                         │  extractors por concepto   │
                         └─────────────┬──────────────┘
                                       │
          ┌────────────────────────────┼────────────────────────────┐
          ▼                            ▼                            ▼
┌──────────────────┐        ┌──────────────────┐        ┌──────────────────┐
│ TypeScript API   │        │ @angular/compiler│        │ Config readers   │
│ (ts.Program)     │        │ parseTemplate    │        │ angular.json,    │
│ decoradores, DI, │        │ AST de template  │        │ tsconfig, rules, │
│ inject(), signals│        │ bindings, @if/@for│       │ openapi (opc.)   │
└──────────────────┘        └──────────────────┘        └──────────────────┘
```

### 4.1 Capas

**Indexer.** Conjunto de *extractors* independientes, uno por concepto. Cada extractor
recibe un `ts.SourceFile` (o un template) y emite nodos y aristas con proveniencia.
Son puros y testeables en aislamiento.

**Project Graph.** Grafo tipado en memoria con índices por tipo de nodo, por nombre y
por archivo. Se serializa a `.angular-mcp/cache/` con el hash de cada archivo fuente.
Al arrancar, solo se reindexan los archivos cuyo hash cambió.

**Query Engine.** Traduce las herramientas MCP a recorridos del grafo. Aplica `limit`,
`depth` y formato de salida.

**Rules Engine.** Carga `angular-mcp.rules.yaml` del repositorio del usuario, la valida
contra un esquema y evalúa aristas del grafo (o de un diff) contra ella.

**Pattern Finder.** Dado un nodo, busca nodos estructuralmente similares (misma forma de
dependencias, mismos tipos de estado, misma forma de llamada HTTP). No usa embeddings en v1;
es comparación de firmas estructurales.

**Server.** Capa fina: registra herramientas con Zod, anotaciones y esquemas de salida.
Sin lógica de dominio.

### 4.2 Decisión clave: usar el compilador del proyecto analizado

El MCP **no** empaqueta su propia versión de `@angular/compiler`. Resuelve
`@angular/compiler` y `typescript` desde el `node_modules` del proyecto analizado.

Razón: el parser de templates cambia entre versiones mayores (control flow `@if/@for`,
`@defer`, `@let`, signal inputs). Usar una versión distinta a la del proyecto produce
falsos errores de parseo o bindings mal resueltos.

Consecuencia: el MCP debe tolerar un rango de versiones (mínimo Angular 17) y tener una
capa adaptadora por versión mayor. Ver riesgo R1.

### 4.3 Qué se usa del compilador y qué no

| Necesidad | Fuente | Estabilidad |
|-----------|--------|-------------|
| Decoradores, clases, imports, `inject()`, signals | API pública de TypeScript (`ts.Program`, type checker) | Alta |
| AST de templates y bindings | `parseTemplate` de `@angular/compiler` | Media-alta (público, cambia por versión mayor) |
| Resolución de a qué componente pertenece un tag del template | Propia, a partir del `imports` del componente o `declarations` del módulo | Alta (es nuestra) |
| Type-checking de templates (tipo exacto de cada binding) | `NgtscProgram` + `TemplateTypeChecker` | **Baja** (API semi-interna usada por el Language Service) |

Decisión: **v1 no usa `TemplateTypeChecker`**. Los tipos de bindings se infieren desde la
clase del componente vía TypeScript. Esto cubre el 90% de los casos y evita depender de
API interna. Se reevalúa en v2 si hay demanda de precisión de tipos en templates.

---

## 5. Modelo de datos

### 5.1 Nodos

Identificador único: `ruta/relativa/al/archivo.ts#NombreSimbolo`. Nunca solo el nombre
(varios `UserListComponent` en un monorepo es un caso real).

| Tipo | Atributos principales |
|------|------------------------|
| `Component` | selector, standalone, changeDetection, templatePath o inline, stylePaths, inputs[], outputs[], signals[], lifecycleHooks[], hostBindings[] |
| `Directive` | selector, standalone, inputs[], outputs[], hostDirectives[] |
| `Pipe` | name, standalone, pure |
| `Service` | providedIn, isInjectable |
| `NgModule` | declarations[], imports[], exports[], providers[] |
| `Route` | path, componentRef, lazy (loadComponent/loadChildren), guards[], resolvers[], children[], data |
| `Guard` / `Resolver` / `Interceptor` | kind (class o functional) |
| `Template` | path, inline, parseErrors[] |
| `Signal` | ownerRef, name, kind (signal/computed/linkedSignal/input/model/output/viewChild/resource/toSignal), typeText, initialValueText |
| `Observable` | ownerRef, name, typeText (solo campos declarados; no se sigue el flujo RxJS en v1) |
| `HttpCall` | method, urlPattern, urlConfidence (literal/template/unknown), requestTypeText, responseTypeText, callerRef |
| `Spec` | path, describes[] (nombres bajo `describe(...)`), testedRefs[] |
| `Model` | interfaces/tipos/clases usadas como DTO (heurística: exportadas y referenciadas en HttpCall o inputs) |
| `File` | path, hash, lastIndexed |

### 5.2 Aristas

Todas las aristas llevan `provenance: { file, line, column }` y `confidence: 'certain' | 'inferred' | 'unknown'`.

```
declares          File        → Symbol
injects           Component|Directive|Service|Guard → Service        (constructor o inject())
provides          NgModule|Component|Route → Service
imports           Component|NgModule → Component|Directive|Pipe|NgModule
renders           Component   → Template
uses_in_template  Template    → Component|Directive|Pipe             (por selector resuelto)
binds             Template    → Signal|Observable|Method|Property    (nombre + tipo de binding)
emits             Template    → Output
routes_to         Route       → Component
child_of          Route       → Route
guarded_by        Route       → Guard
resolves_with     Route       → Resolver
calls_http        Service|Component → HttpCall
intercepted_by    HttpCall    → Interceptor                           (si es global y detectable)
returns           HttpCall    → Model
tested_by         Symbol      → Spec
extends           Class       → Class
```

### 5.3 Archivo de reglas (`angular-mcp.rules.yaml`)

Vive en la raíz del proyecto del usuario. Ejemplo:

```yaml
version: 1
layers:
  ui:        { match: ["src/app/**/*.component.ts", "src/app/**/*.directive.ts"] }
  state:     { match: ["src/app/**/*.store.ts", "src/app/**/state/**"] }
  data:      { match: ["src/app/**/*.service.ts", "src/app/**/data/**"] }
  domain:    { match: ["src/app/**/domain/**"] }
  shared:    { match: ["src/app/shared/**"] }

boundaries:
  ui:     { may_depend_on: [state, data, domain, shared] }
  state:  { may_depend_on: [data, domain, shared] }
  data:   { may_depend_on: [domain, shared] }
  domain: { may_depend_on: [shared] }
  shared: { may_depend_on: [] }

constraints:
  - id: no-http-in-components
    description: Los componentes no hacen llamadas HTTP directas.
    forbid: { edge: calls_http, from: Component }
  - id: services-own-http
    description: Solo servicios de la capa data llaman HttpClient.
    forbid: { edge: calls_http, from_layer_not: data }
  - id: onpush-required
    description: Todo componente usa OnPush.
    require: { node: Component, attr: changeDetection, equals: OnPush }
    severity: warning

decisions:
  - id: pagination-server-side
    text: La paginación se hace siempre del lado del servidor.
    applies_to: ["src/app/**/*-list.component.ts"]
```

Si el proyecto ya usa `@softarc/sheriff` o `@nx/enforce-module-boundaries`, el MCP
**importa** esa configuración en vez de exigir una duplicada (ver R10).

---

## 6. Herramientas MCP

Prefijo `angular_` para convivir con otros servidores. Toda herramienta de lectura tiene
`readOnlyHint: true`. Toda herramienta que lista acepta `limit` (default 20), `offset` y
`format: 'markdown' | 'json'` (default markdown). Toda respuesta incluye `provenance`.

### Fase 1 — Índice y consulta

| Herramienta | Entrada | Salida | Notas |
|-------------|---------|--------|-------|
| `angular_index_project` | `root?`, `project?`, `force?` | resumen: nodos por tipo, archivos, tiempo, errores de parseo | Idempotente. Incremental por hash. |
| `angular_get_index_status` | — | `fresh/stale`, archivos pendientes, versión de Angular detectada | Permite al agente saber si debe reindexar. |
| `angular_find_symbol` | `query`, `kind?`, `limit?` | candidatos con id, kind, path, selector | Búsqueda por nombre, selector o path. Siempre devuelve candidatos, no uno solo. |
| `angular_get_component` | `ref`, `depth?` | ficha completa: template, estado, dependencias, bindings, consumidores, rutas que lo cargan, HTTP alcanzable, specs | La herramienta central. `depth` limita el recorrido de HTTP alcanzable. |
| `angular_get_service` | `ref` | inyectado en, inyecta, llamadas HTTP, providedIn, specs | |
| `angular_get_route_tree` | `project?`, `path_prefix?`, `depth?` | árbol de rutas con lazy, guards, resolvers, componente destino | |
| `angular_who_uses` | `ref`, `via?` (imports/injects/uses_in_template/routes_to) | lista de consumidores con tipo de arista y proveniencia | |
| `angular_get_template_bindings` | `ref` | bindings clasificados: interpolación, property, event, two-way, control flow, con símbolo resuelto y tipo si se conoce | |
| `angular_list_http_calls` | `filter?` (method, url_pattern, caller) | llamadas con confianza de URL | Base para la capa de contratos. |
| `angular_impact_of` | `refs[]` o `files[]`, `depth?` | subgrafo afectado hacia arriba (consumidores) y hacia abajo (dependencias), agrupado por tipo, más specs alcanzados | La herramienta para "voy a tocar X". |

### Fase 2 — Arquitectura

| Herramienta | Entrada | Salida |
|-------------|---------|--------|
| `angular_list_rules` | — | reglas cargadas, origen (propio / sheriff / nx), capas resueltas por archivo |
| `angular_check_rules` | `diff?` (unified) o `files[]` o nada (todo el proyecto) | violaciones con regla, arista ofensora, proveniencia y sugerencia de ruta permitida |
| `angular_explain_layer` | `file` | a qué capa pertenece, por qué (regla de match), qué puede importar |

`angular_check_rules` con un diff es el **gatekeeper**: el agente lo llama antes de escribir
o después de generar el cambio, y obtiene violaciones concretas.

### Fase 3 — Patrones y contratos

| Herramienta | Entrada | Salida |
|-------------|---------|--------|
| `angular_find_similar` | `ref`, `aspect?` (dependencies/state/http/template) | nodos con firma estructural parecida, ordenados por similitud, con la diferencia resumida |
| `angular_get_api_contract` | `url_pattern` o `http_call_ref` | si existe OpenAPI/Swagger en el repo: schema de request/response. Si no: tipos TS inferidos y `confidence: inferred` |
| `angular_list_decisions` | `applies_to?` | decisiones declaradas en el archivo de reglas que aplican a un path |

### Fase 4 — Recursos y prompts MCP

- Resource `angular://project/summary`: resumen del proyecto (conteos, versión, capas).
- Resource `angular://rules`: el archivo de reglas tal como se cargó.
- Prompt `angular_plan_change`: plantilla que guía al agente a llamar `find_symbol → get_component → impact_of → find_similar → check_rules` antes de proponer un cambio. Es la única pieza "opinada" del servidor y es opcional.

### Fase 5 — Mutaciones acotadas (condicional)

Solo si las fases 1–3 alcanzan las métricas de la sección 10. Todas con `dry_run: true`
por defecto y devolviendo un diff, nunca escribiendo directamente sin confirmación.

| Herramienta | Estrategia |
|-------------|------------|
| `angular_generate` | Envuelve `ng generate` (schematics del propio proyecto, incluidas las custom). Aporta valor porque resuelve el path y las opciones según convenciones detectadas. |
| `angular_add_route` | Inserta en el array de rutas correcto (resuelto por el grafo), respetando lazy/eager según el patrón dominante. |
| `angular_add_dependency` | Agrega `inject()` o parámetro de constructor según el estilo dominante del archivo. |

`add_signal` y `bind_template` **no** entran en v1. Son las más frágiles y las que menos
valor agregan frente a que el LLM edite con el contexto que ya le da `get_component`.

---

## 7. Fases, entregables y criterios de salida

Estimaciones para una persona a tiempo completo. Son rangos, no compromisos.

### Fase 0 — Fundaciones (1 semana)

**Entregables**
- Repositorio TypeScript: `pnpm`, `tsconfig` estricto, ESLint, Vitest, build con `tsup` o `tsc`.
- Esqueleto del servidor con `@modelcontextprotocol/sdk` sobre stdio y una herramienta `angular_ping`.
- Dos apps fixture en `fixtures/`: una standalone moderna (signals, control flow, lazy routes, interceptores funcionales) y una NgModule legacy (constructor DI, `RouterModule.forRoot`, `*ngIf`).
- Ground truth manual para ambas fixtures en `fixtures/*/expected-graph.json`.
- CI: lint, typecheck, tests, y matriz de versiones de Angular (mínimo dos versiones mayores).

**Criterio de salida:** el servidor arranca en MCP Inspector y la matriz de CI está verde.

### Fase 1 — Indexer y consultas (3–4 semanas)

**Entregables**
- Extractors: `decorators`, `di`, `signals`, `templates`, `routes`, `http`, `specs`, `modules`.
- Project Graph con cache en disco por hash.
- Herramientas de la Fase 1 completas.
- Detección de workspace (`angular.json`, `tsconfig` por proyecto).
- Resolución de `@angular/compiler` desde el `node_modules` del proyecto analizado.

**Criterio de salida**
- Precisión ≥ 95% y recall ≥ 90% de nodos y aristas contra el ground truth de ambas fixtures.
- Indexación completa de una app de 500 archivos en < 15 s en frío y < 2 s incremental.
- Ninguna respuesta de herramienta supera 8 KB en markdown con `limit` por defecto.

### Fase 2 — Reglas (1–2 semanas)

**Entregables**
- Esquema y validación del archivo de reglas.
- Rules Engine y las tres herramientas de Fase 2.
- Importador de configuración de `sheriff` y de `nx` boundaries (lectura, no escritura).
- Documentación del formato de reglas con ejemplos.

**Criterio de salida**
- `angular_check_rules` detecta el 100% de las violaciones plantadas en las fixtures, sin falsos positivos.
- Un diff que introduce `HttpClient` en un componente produce una violación con sugerencia de ruta permitida.

### Fase 3 — Patrones y contratos (2 semanas)

**Entregables**
- Pattern Finder por firma estructural.
- Lector de OpenAPI (si existe en el repo) y vínculo `HttpCall → operación`.
- Herramientas de Fase 3.

**Criterio de salida**
- Para "agrega paginación a usuarios" sobre la fixture, `find_similar` devuelve el componente que ya pagina en el primer resultado.

### Fase 4 — Evaluación y hardening (2 semanas)

**Entregables**
- 10 preguntas de evaluación (formato de la sección 9.3) sobre las fixtures, con respuestas verificadas.
- Benchmark A/B de 5 tareas reales con y sin el MCP (ver sección 10).
- Watcher de archivos opcional (`chokidar`) para invalidación en caliente.
- Manejo de errores accionable en todas las herramientas.
- README con instalación para Claude Code y Cursor.

**Criterio de salida:** métricas de la sección 10 cumplidas. Publicación `0.1.0`.

### Fase 5 — Mutaciones acotadas (condicional, 2–3 semanas)

Solo se abre si la Fase 4 muestra que el grafo es confiable en al menos un proyecto real
externo a las fixtures. Entregables según sección 6, Fase 5.

---

## 8. Riesgos y mitigaciones

| ID | Riesgo | Prob. | Impacto | Mitigación | Señal de alerta |
|----|--------|-------|---------|------------|-----------------|
| R1 | La API de `@angular/compiler` cambia entre versiones mayores y rompe el parser de templates. | Alta | Alto | Resolver el compilador desde el proyecto analizado. Capa adaptadora por versión mayor. Matriz de CI con ≥ 2 versiones. No usar `TemplateTypeChecker` en v1. | Tests de la matriz fallan al subir una versión de fixture. |
| R2 | El grafo se desincroniza del código (cache vieja, archivos editados fuera del MCP). | Alta | Alto | Hash por archivo en cada consulta. `get_index_status` con `stale`. Watcher opcional. Nunca persistir hechos que no se puedan rederivar. | Una consulta devuelve un símbolo que ya no existe. |
| R3 | Cobertura parcial de llamadas HTTP (URLs construidas dinámicamente, `environment.apiUrl`, interceptores que reescriben). | Alta | Medio | `urlConfidence` explícito. Resolver constantes simples y `environment.*` por evaluación estática limitada. Reportar `unknown` en el resto. | Más del 30% de HttpCalls con `unknown` en un proyecto real. |
| R4 | Proyectos híbridos NgModule + standalone producen resolución incorrecta de selectores en templates. | Media | Alto | Ambas fixtures desde Fase 0. Resolución de scope por componente: `imports` propios o `declarations` del módulo que lo declara. | `uses_in_template` con `confidence: unknown` para selectores conocidos. |
| R5 | Repos grandes (miles de archivos, monorepo) hacen la indexación lenta o consumen mucha memoria. | Media | Alto | Indexación por proyecto de `angular.json`, no del workspace entero. Templates parseados bajo demanda y cacheados. Límites de tiempo y paginación. Evaluar SQLite si > 5k archivos. | Indexación en frío > 60 s. |
| R6 | Respuestas demasiado grandes saturan el contexto del agente, reproduciendo el problema que se quería resolver. | Alta | Alto | `limit`, `depth` y `format` en todo. Fichas en markdown resumidas por defecto, JSON completo solo bajo petición. Tope de 8 KB por defecto. | El agente pide `limit` altos repetidamente o trunca. |
| R7 | El agente confía en el grafo sin verificar y actúa sobre un hecho inferido erróneo. | Media | Alto | `confidence` y `provenance` en cada hecho. Descripciones de herramientas que dicen explícitamente qué es inferido. Nunca omitir el archivo:línea. | Tareas del benchmark fallan por un hecho `inferred` incorrecto. |
| R8 | Las mutaciones generan código que viola las convenciones del repositorio. | Alta | Medio | Mutaciones diferidas a Fase 5 y condicionadas a métricas. Delegar a schematics del propio proyecto. `dry_run` por defecto. Detectar estilo dominante antes de escribir. | Cualquier mutación que necesite ser corregida a mano en el benchmark. |
| R9 | El MCP incorpora razonamiento (recomendaciones, prioridades) y se convierte en un LLM dentro de un LLM: no determinista, difícil de testear. | Media | Medio | P2. Revisión de cada herramienta: si la salida no es reproducible desde el grafo, no entra. El único elemento "opinado" es el prompt opcional. | Aparece una herramienta cuya salida no se puede testear con igualdad exacta. |
| R10 | Duplicación de reglas con `sheriff`, `eslint-plugin-boundaries` o Nx: dos fuentes de verdad que divergen. | Media | Medio | Importador de esas configuraciones. El archivo propio solo agrega `constraints` y `decisions` que esas herramientas no cubren. | Un usuario mantiene dos archivos de capas. |
| R11 | Seguridad: path traversal en `root`/`files`, ejecución de comandos al envolver `ng generate` o tests. | Baja | Alto | Validar que todo path resuelva dentro del root. Sin shell: `spawn` con argumentos como array. Timeouts. Sin acceso de red. | Test de seguridad falla. |
| R12 | Scope creep hacia runtime, otros frameworks o mutaciones tempranas. | Alta | Medio | Gates por fase con criterios de salida. Sección 3 como referencia en cada revisión. | Un PR agrega una herramienta no listada en la sección 6. |
| R13 | Ambigüedad de nombres (varios símbolos con el mismo nombre en un monorepo). | Media | Medio | Ids = `path#símbolo`. `find_symbol` siempre devuelve candidatos. Las demás herramientas exigen `ref` completo. | El agente llama `get_component` con un nombre pelado y recibe el equivocado. |
| R14 | Template inline vs archivo, templates con errores de sintaxis, `templateUrl` relativo mal resuelto. | Media | Bajo | Almacenar `parseErrors` en el nodo `Template` y exponerlos. No abortar el índice por un template roto. | Índice aborta por un solo archivo. |
| R15 | Falta de evidencia de que el MCP realmente reduce contexto y turnos. | Media | Alto | Benchmark A/B desde Fase 4 con métricas de la sección 10. No publicar sin números. | No hay benchmark al cerrar Fase 4. |
| R16 | Dependencia de `NgtscProgram` para resolver el scope de standalone imports en casos complejos (re-exports, `forwardRef`, barrels). | Media | Medio | Resolución propia vía type checker de TS para imports y barrels. Casos no resueltos marcados `unknown`. Reevaluar `NgtscProgram` en v2 solo para esos casos. | Fixture con barrels muestra `imports` con `unknown`. |

---

## 9. Estrategia de pruebas

### 9.1 Unitarias (por extractor)

Cada extractor se prueba contra fragmentos de código mínimos: entrada `ts.SourceFile`,
salida nodos/aristas esperados. Cubrir:

- DI por constructor, por `inject()`, con `@Optional`, `@Inject(TOKEN)`, `inject(TOKEN, { optional: true })`.
- Signals: `signal`, `computed`, `linkedSignal`, `input`, `input.required`, `model`, `output`, `viewChild`, `toSignal`, `resource`, `httpResource`.
- Templates: interpolación, `[prop]`, `(event)`, `[(ngModel)]`, `@if/@for/@switch/@defer/@let`, `*ngIf/*ngFor`, pipes, referencias `#ref`.
- Rutas: array literal, `provideRouter`, `RouterModule.forRoot/forChild`, `loadChildren` con `import()`, `loadComponent`, `children`, guards funcionales y de clase.
- HTTP: `HttpClient.get/post/put/patch/delete`, genéricos, URL literal, template literal, concatenación, `environment.apiUrl`.

### 9.2 Integración (por fixture)

Índice completo de cada fixture comparado con `expected-graph.json` mediante igualdad
estructural (ignorando orden). Cualquier divergencia es un fallo, no una advertencia.

### 9.3 Evaluación con agente

Diez preguntas en el formato de evaluación de MCP (`evaluation.xml`), independientes,
de solo lectura, con respuesta única verificable. Ejemplos:

- "¿Qué componente carga la ruta `/admin/users` y qué guard la protege?"
- "¿Qué servicios inyecta transitivamente `OrderDetailComponent` hasta llegar a una llamada HTTP?"
- "¿Cuál es el único componente que hace una llamada HTTP directa, violando la regla `no-http-in-components`?"

### 9.4 Matriz de versiones

CI ejecuta las fixtures con al menos dos versiones mayores de Angular instaladas en
`fixtures/*/node_modules`. Al publicar una versión mayor nueva de Angular se agrega a
la matriz antes de cualquier otro trabajo.

---

## 10. Métricas de éxito (Fase 4)

Benchmark: cinco tareas reales sobre una fixture ampliada, ejecutadas por el mismo agente
con y sin el MCP, tres repeticiones cada una.

| Métrica | Objetivo |
|---------|----------|
| Tokens de entrada consumidos por tarea | −50% con MCP |
| Archivos leídos completos por tarea | −60% con MCP |
| Turnos hasta la primera edición correcta | −40% con MCP |
| Tasa de éxito de la tarea (tests pasan) | ≥ igual que sin MCP; nunca menor |
| Violaciones de arquitectura introducidas | 0 con `check_rules` en el flujo |
| Precisión del grafo vs ground truth | ≥ 95% |
| Indexación incremental | < 2 s |

Si la tasa de éxito baja con el MCP, se detiene la Fase 5 y se investiga R7.

---

## 11. Stack técnico

| Área | Elección | Motivo |
|------|----------|--------|
| Lenguaje | TypeScript, ESM, Node ≥ 20 | Mismo ecosistema que Angular; SDK MCP de primera clase. |
| MCP | `@modelcontextprotocol/sdk` | Oficial. `registerTool` con Zod, `outputSchema`, anotaciones. |
| Parseo TS | API de `typescript` (del proyecto analizado) | Sin dependencias extra; `ts-morph` solo si simplifica mucho la Fase 5. |
| Parseo templates | `@angular/compiler` (del proyecto analizado) | Ver 4.2. |
| Validación | Zod | Esquemas de entrada, de salida y del archivo de reglas. |
| Reglas | YAML + esquema Zod | Legible en revisión de código. |
| Cache | JSON por archivo en `.angular-mcp/cache/` | Simple, inspeccionable, sin dependencias nativas. SQLite se evalúa en R5. |
| Watcher | `chokidar` (opcional) | Invalidación en caliente. |
| Tests | Vitest | Rápido, ESM nativo. |
| Build | `tsup` | Un binario `angular-mcp` ejecutable con `npx`. |
| Gestor | `pnpm` | Workspace para `packages/server` y `fixtures/*`. |
| CI | GitHub Actions | Matriz de versiones de Angular. |

Logs siempre a `stderr` (stdio reserva `stdout` para el protocolo).

---

## 12. Estructura del repositorio propuesta

```
angular-mcp/
├── docs/
│   ├── PLAN.md                 ← este documento
│   ├── RULES.md                ← formato del archivo de reglas
│   └── adr/                    ← decisiones de arquitectura (una por archivo)
├── packages/
│   └── server/
│       ├── src/
│       │   ├── index.ts        ← entrada stdio
│       │   ├── server.ts       ← registro de tools/resources/prompts
│       │   ├── tools/          ← una herramienta por archivo
│       │   ├── indexer/
│       │   │   ├── workspace.ts
│       │   │   ├── program.ts  ← carga de ts.Program y del compilador del proyecto
│       │   │   └── extractors/
│       │   ├── graph/          ← modelo, índices, cache
│       │   ├── rules/          ← esquema, carga, evaluación, importadores
│       │   ├── patterns/       ← firmas estructurales y similitud
│       │   └── format/         ← markdown/json, truncado, paginación
│       └── test/
├── fixtures/
│   ├── standalone-app/
│   │   └── expected-graph.json
│   └── ngmodule-app/
│       └── expected-graph.json
├── evals/
│   └── evaluation.xml
└── .github/workflows/ci.yml
```

---

## 13. Decisiones abiertas

| Decisión | Opciones | Cuándo se decide |
|----------|----------|------------------|
| Persistencia del grafo | JSON por archivo vs SQLite | Fin de Fase 1, con datos de rendimiento reales. |
| Soporte Nx sin `angular.json` | v1 básico vs v2 completo | Según demanda tras 0.1.0. |
| Seguir el flujo RxJS (`pipe`, `switchMap`) para conectar observables con HTTP | v1 no; v2 posible | Si el benchmark muestra que el agente lo necesita. |
| `TemplateTypeChecker` para tipos exactos en templates | Excluido en v1 | v2, solo si R16 se materializa. |
| Nombre del paquete npm | `angular-mcp-server` vs `@rixmerz/angular-mcp` | Antes de publicar 0.1.0. |
| Licencia | MIT vs Apache-2.0 | Antes de publicar 0.1.0. |

---

## 14. Extensibilidad futura (no comprometida)

- **Runtime:** un segundo servidor o un modo opcional que consuma errores del `ng serve`,
  resultados de tests y tráfico HTTP del navegador, y los enlace a nodos del grafo.
- **Otros frameworks:** el Project Graph, el Rules Engine y el Pattern Finder son agnósticos.
  Solo los extractors son específicos de Angular. Un `react-mcp` reutilizaría el 60% del núcleo.
- **Contratos vivos:** vincular `HttpCall` con el backend real (Nest, Spring) cuando ambos
  repos estén disponibles en el mismo workspace.

---

## 15. Resumen ejecutivo

1. Extraer el grafo Angular del compilador, no reinventarlo.
2. Derivar siempre; nunca recordar. Cache por hash, nunca memoria editable.
3. Consultas e impacto primero; mutaciones solo tras demostrar confiabilidad con números.
4. Cada hecho con confianza y proveniencia; lo desconocido se declara desconocido.
5. Reglas de arquitectura declarativas en el repo del usuario, importando las que ya existan.
6. Cinco fases con criterios de salida medibles; la Fase 5 es condicional.
