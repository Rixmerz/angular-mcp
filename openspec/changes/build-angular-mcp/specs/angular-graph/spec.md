# Grafo semantico de Angular

## ADDED Requirements

### Requirement: Extraccion del grafo desde el codigo

El servidor DEBE derivar cada hecho estructural del codigo fuente en cada
consulta, y NO DEBE persistir como verdad ningun hecho que no pueda rederivar.
La cache existe solo como aceleracion y se invalida por hash de archivo.

#### Scenario: Un archivo cambia fuera del servidor

- **WHEN** un componente se edita sin pasar por el servidor
- **THEN** la siguiente consulta detecta el hash distinto, reindexa ese archivo
  y devuelve el estado nuevo, sin requerir que nadie actualice el grafo a mano

#### Scenario: La cache esta vacia

- **WHEN** se consulta un proyecto que nunca fue indexado
- **THEN** el servidor lo indexa y responde, en vez de fallar por falta de cache

### Requirement: Confianza y proveniencia en cada hecho

Cada nodo y cada arista DEBEN llevar el archivo, la linea y la columna de donde
salieron, y un nivel de confianza entre certain, inferred y unknown. El servidor
NO DEBE adivinar un valor que no pueda resolver.

#### Scenario: Una URL construida dinamicamente

- **WHEN** un servicio llama a HttpClient con una URL que se arma en tiempo de
  ejecucion y no se puede resolver estaticamente
- **THEN** la llamada se registra con urlConfidence unknown y el texto original,
  nunca con una URL inventada

#### Scenario: Un selector de template sin resolver

- **WHEN** un tag del template no corresponde a ningun componente en el scope
- **THEN** la arista se emite con confidence unknown en vez de omitirse

### Requirement: Resolucion del compilador del proyecto analizado

El servidor DEBE resolver TypeScript y el compilador de Angular desde el
node_modules del proyecto que analiza, no desde el suyo propio.

#### Scenario: El proyecto usa una version mayor distinta

- **WHEN** el proyecto analizado usa una version de Angular distinta a la del
  entorno del servidor
- **THEN** los templates se parsean con el compilador del proyecto, y la version
  detectada se reporta en el estado del indice

#### Scenario: El proyecto no tiene Angular instalado

- **WHEN** falta @angular/compiler en el proyecto analizado
- **THEN** el servidor falla con un mensaje que dice exactamente que instalar

## ADDED Requirements

### Requirement: Herramientas de consulta acotadas

Toda herramienta que liste DEBE aceptar un limite y devolver metadatos de
paginacion, y NO DEBE devolver el grafo entero en una respuesta.

#### Scenario: Un proyecto grande

- **WHEN** se consultan los consumidores de un servicio muy usado
- **THEN** la respuesta viene paginada con has_more y next_offset, y el markdown
  se trunca declarando que se trunco

#### Scenario: Un nombre de simbolo ambiguo

- **WHEN** dos componentes de un monorepo comparten el nombre
- **THEN** la busqueda devuelve ambos candidatos con su ruta, en vez de elegir uno

### Requirement: Verificacion de reglas de arquitectura

El servidor DEBE evaluar un diff contra las reglas declaradas del repositorio y
reportar cada violacion con la arista ofensora y una ruta permitida.

#### Scenario: Un componente llama a HttpClient

- **WHEN** un diff introduce una llamada HTTP directa en un componente y la regla
  lo prohibe
- **THEN** la verificacion reporta la violacion con archivo y linea, y sugiere la
  ruta componente, servicio, repositorio

#### Scenario: El repositorio ya usa otra herramienta de limites

- **WHEN** el proyecto tiene configuracion de sheriff o de limites de Nx
- **THEN** el servidor la importa en vez de exigir que se duplique
