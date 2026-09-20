# angular-mcp

Servidor MCP que expone el grafo semantico de un proyecto Angular como
herramientas de consulta. El plan completo esta en `docs/PLAN.md`.

## Convenciones

- TypeScript estricto, ESM, Node >= 20.
- El servidor es determinista: devuelve hechos derivados del codigo, no juicio.
- Cada hecho lleva confianza y proveniencia.
