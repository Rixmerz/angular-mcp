# Construir el servidor Angular MCP

## Why

Un agente que trabaja sobre un proyecto Angular reconstruye en cada tarea el
mismo grafo de relaciones: componente, template, signal, servicio, inyeccion de
dependencias, interceptor, HTTP, backend. Ese grafo ya existe de forma explicita
en el compilador de Angular y en el AST de TypeScript, pero no hay forma de
consultarlo. El agente lo redescubre leyendo archivos, lo que consume contexto y
turnos en trabajo que no cambia entre tareas.

## What Changes

Este cambio construye las fases 0, 1 y 2 de `docs/PLAN.md`:

- Andamiaje del monorepo y de la integracion continua.
- Dos aplicaciones Angular de prueba, una standalone y una NgModule, con su
  grafo esperado escrito a mano.
- Indexador con extractors por concepto, sobre la API de TypeScript y el parser
  de templates del compilador resuelto desde el proyecto analizado.
- Grafo del proyecto con cache invalidada por hash de archivo.
- Diez herramientas MCP de consulta e impacto.
- Motor de reglas de arquitectura declarativas y verificacion de un diff.
- Cableado del servidor sobre stdio, con recursos y un prompt.

Queda fuera, por decision explicita del plan: el analisis en tiempo de
ejecucion, las mutaciones de alto nivel y otros frameworks.

## Impact

- Repositorio nuevo. No hay codigo existente que romper.
- `packages/server` pasa a ser el paquete publicable.
- `fixtures/` queda como la base de verificacion de precision del grafo.
