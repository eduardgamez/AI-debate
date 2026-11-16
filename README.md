# AI-debate

Varias instancias de un LLM defienden premisas distintas y compiten entre sí; un árbitro va filtrando las que aguantan. [WIP]

Funciona con la suscripción de Claude Code (el CLI oficial ya autenticado), no con la API de pago.

## Cómo se usa

Requisitos: Node 20 o superior y Claude Code instalado con la sesión iniciada (`claude auth login`).

```
npm start
```

Se abre `http://localhost:4747`. No hay nada que instalar.

## Modos

- **Debate.** Escribes una cuestión que no se puede responder con seguridad de primeras. Un modelo detecta sus **huecos de información**: lo que afecta a la respuesta y no se puede saber ni razonando ni buscando (intenciones, carácter, cómo reaccionará alguien, circunstancias no dichas…). Lo que sí se puede averiguar lo da por sabido. Para cada hueco propone varios **rellenos** incompatibles y los reparte en unas pocas **combinaciones** (un relleno por hueco), que puedes editar. Cada IA defiende una combinación y, en cada duelo, solo se discuten los huecos en los que la pareja no coincide. El árbitro puntúa, hueco por hueco, qué relleno es más probable, sin mirar hacia qué respuesta lleva. Los modelos debaten entre sí en inglés y lo que lees sale en español. Tras cada intercambio el árbitro resume, puntúa y corta si hay bucle. En cada ronda cae solo la cuarta parte peor puntuada, hasta un duelo final y un veredicto que también recoge lo válido de las premisas descartadas.
- **Historia.** Pegas una historia (escenas separadas con `---`, o se trocea sola). Cada premisa predice la siguiente escena y un auditor puntúa cuánto se acercó. Solo sirve con historias que el modelo no conozca.

## Ajustes

- Modelo y nivel de razonamiento, por separado para cada papel: creador de premisas (Opus medio por defecto), debatientes (Opus bajo) y árbitro. Los debatientes van por defecto en bajo; la final puede subirse a medio o alto.
- Intercambios por duelo (3 por defecto, uno más en la final): es lo que más pesa en el gasto.
- El árbitro va por defecto en Haiku alto.
- Búsquedas en internet bajo demanda: al generar premisas y cuando un debatiente o el árbitro piden comprobar un dato.

## Límites de la suscripción

La barra superior muestra el estado de los límites (5 horas y semanal) según los comunica el CLI. Si un límite se agota, la competición se para sola, nunca pasa a uso extra de pago, y se puede retomar con «Continuar».

## Estructura

- `server/claude.js`: llamadas al CLI (sin herramientas, sin claves de API).
- `server/engine.js`: reglas de la competición y textos de instrucciones.
- `server/index.js`: servidor local.
- `public/index.html`: la web.
- `data/`: competiciones guardadas (no se suben a git).
