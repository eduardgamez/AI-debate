# AI-debate

Para preguntas que una IA no puede responder de primeras porque le falta información. Varias instancias defienden posibles respuestas a lo que no se sabe y discuten cuáles son más probables. [WIP]

Usa la suscripción de Claude Code, no la API de pago.

## Cómo se usa

Necesitas Node 20 o superior y Claude Code con la sesión iniciada (`claude auth login`).

```
npm start
```

Se abre `http://localhost:4747`.

## Modo debate

1. **Huecos.** Una IA detecta lo que no se puede saber y afecta a la respuesta (carácter de alguien, cómo reaccionará, circunstancias no dichas…). Lo averiguable lo da por sabido.
2. **Rellenos.** Cada hueco tiene varias respuestas posibles, incompatibles entre sí.
3. **Reparto.** Cada instancia defiende una combinación: un relleno por hueco. Puedes editarlas antes de empezar.
4. **Duelos por parejas.** Solo se discuten los huecos en los que la pareja no coincide. Un árbitro puntúa qué relleno es más probable, sin mirar a qué respuesta lleva.
5. **Filtro.** En cada ronda cae la parte peor puntuada (1 de cada 4 por defecto; se elige en el menú). Al final, un veredicto dice el relleno más probable de cada hueco y la respuesta que se sigue.
6. **Siguiente ronda.** Se ordena por nota media y cada una se enfrenta a la mejor clasificada que aún no conozca. Si son impares descansa la peor clasificada que aún no haya descansado; con tres en pie descansa la mejor y pasa directa a la final.

Entre ellas debaten en inglés; lo que lees sale en español.

## Modo historia

Pegas una historia (escenas separadas con `---`, o se trocea sola). Cada combinación predice la siguiente escena y un auditor puntúa cuánto acertó. Solo sirve con historias que la IA no conozca.

## Ajustes

- Modelo y razonamiento de cada papel. Por defecto: creador Opus medio, debatientes Opus bajo, árbitro Haiku alto. La final puede subirse.
- Intercambios por duelo: 3 por defecto. Es lo que más gasta.
- Cuántas caen por ronda: 1 de cada 4, 1 de cada 3 o la mitad. Cuantas más caen, menos rondas y menos gasto.
- Búsquedas en internet, solo cuando hacen falta.

## Límites

Arriba se ve el estado de los límites de 5 horas y semanal. Si uno se agota, el debate se para (nunca pasa a pago) y se retoma con «Continuar».

## Archivos

- `server/claude.js`: llamadas a Claude Code.
- `server/engine.js`: reglas e instrucciones de cada papel.
- `server/index.js`: servidor local.
- `public/index.html`: la web.
- `data/`: debates guardados (fuera de git).
