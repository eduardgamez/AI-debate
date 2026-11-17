# AI-debate

Para preguntas que una IA no puede responder de primeras porque le falta información. Varias instancias defienden posibles respuestas a lo que no se sabe y discuten cuáles son más probables. 

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

Solo sirve con historias que la IA no conozca.

1. **Fragmentos.** Si separas la historia con `---`, se corta ahí. Si no, el árbitro la parte: cuanto más larga, más fragmentos, con cortes justo antes de cada giro.
2. **Creador.** Lee la historia entera y elige incógnitas que aún no se saben y ayudan a predecir: sobre todo rasgos de personalidad y circunstancias personales. Cada una tiene varias posturas («¿tiene rasgos psicopáticos?»: no, leves, claros). Son rasgos ocultos, nunca hechos futuros, y solo de personajes que ya han aparecido.
3. **Versiones.** Cada IA da por ciertas varias posturas. Pueden compartir alguna, pero cada versión va en una dirección distinta. Puedes editarlas antes de empezar.
4. **Cada fragmento.** Cada IA predice lo que pasará. Se revela el fragmento, cada una defiende brevemente en qué acertó y el árbitro le pone nota del 1 al 10. Además, el árbitro marca cada postura como contradicha, apoyada o sin datos.
5. **Filtro.** Cae la fracción peor parada (en el último fragmento ya no). Pesa sobre todo que el texto contradiga sus posturas (−3 cada vez); un apoyo suma poco (+1) y la nota de predicción solo desempata. Que el texto aún no diga nada no se castiga. En su primera ronda, una IA solo cae si el texto la contradice. De las que caen no queda rastro.
6. **Refuerzo.** El creador ve las IA en juego y cómo le va a cada postura. Cuida que cada incógnita aún sin resolver tenga al menos dos posturas defendidas, y mete IA nuevas (hasta las «IA a la vez» elegidas) con combinaciones prometedoras o incógnitas nuevas. No toca las que siguen. Una postura que cayó puede volver si vuelve a parecerle buena.
7. **Veredicto.** Para cada incógnita, la postura mejor parada entre las que llegan al final. Nada queda abierto.

## Ajustes

- Modelo y razonamiento de cada papel. Por defecto: creador Opus medio, debatientes Opus bajo, árbitro Sonnet alto. La final puede subirse.
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
