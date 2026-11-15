// Motor de la competición: genera premisas, las enfrenta por parejas (modo debate) o las pone
// a predecir una historia (modo historia), y va filtrando por puntos, sin "el ganador se lo lleva todo".
import { preguntar, preguntarJSON } from './claude.js';

// Lo que se dicen los modelos entre sí va en el idioma de trabajo (inglés salvo que el generador
// de premisas decida otro); lo que lee el usuario va siempre en español.
const breve = (idioma) => `Escribe en ${idioma} y en texto plano (sin markdown). Sé tan breve como el contenido permita: cada frase debe aportar algo nuevo. Sin saludos, sin relleno y sin repetir lo ya dicho.`;
const interno = (run) => breve(run.idioma || 'inglés');
const MAX_PREMISAS = 12;

const premisa = (run, id) => run.premisas.find((p) => p.id === id);
const cita = (p) => `«${p.titulo}»\n${p.contenido}`;
const media = (p) => (p.puntos.length ? p.puntos.reduce((a, b) => a + b, 0) / p.puntos.length : null);
const limitar = (n, min, max) => Math.min(max, Math.max(min, Math.round(Number(n) || 0)));
const lista = (x) => (Array.isArray(x) ? x.map((s) => String(s).trim()).filter(Boolean) : []);

function esfuerzoDe(run, ronda, final) {
  if (final && run.config.final) return run.config.final;
  if (run.config.esfuerzo === 'auto') return ronda === 1 ? 'low' : 'medium';
  return run.config.esfuerzo;
}
// Entender un debate es exigente: por defecto el árbitro trabaja en nivel alto.
const arbitro = (run) => ({ modelo: run.config.arbitro, esfuerzo: run.config.arbitroEsfuerzo || 'high' });

const ia = (run, ctx, o) => preguntar({ ...o, signal: ctx.signal, uso: run.uso });
const iaJSON = (run, ctx, o) => preguntarJSON({ ...o, signal: ctx.signal, uso: run.uso });

export function nuevaPremisa(run, titulo, contenido) {
  const id = `p${run.premisas.length + 1}`;
  return { id, titulo: String(titulo).trim().slice(0, 120), contenido: String(contenido).trim(), puntos: [], media: null, viva: true, eliminadaEn: null, notas: [] };
}

// ---------- Premisas ----------

export async function generarPremisas(run, ctx) {
  run.estado = 'generando';
  if (run.modo === 'historia') await trocear(run, ctx);
  run.actividad = 'Buscando los puntos clave y sus premisas…';
  ctx.emit();
  const formato = ` Trabaja en dos pasos.
1) PUNTOS: identifica los puntos de los que depende la respuesta (hechos, mecanismos, datos, criterios). Para cada punto da entre 2 y 4 premisas alternativas: supuestos distintos e incompatibles sobre cómo es la realidad en ese punto. Una premisa nunca es una respuesta a la cuestión, sino algo que puede ser cierto o falso.
2) COMBINACIONES: forma combinaciones distintas eligiendo una premisa de cada punto. Cada combinación debe ser coherente por dentro. No es una respuesta ni una conclusión: es solo un conjunto de premisas, que pueden ser ciertas o falsas. NO crees una combinación por cada mezcla posible: diseña un reparto inteligente. Usa el menor número de combinaciones que (a) dé a cada premisa importante al menos un defensor, (b) junte en cada combinación premisas que encajan entre sí, y (c) haga que las combinaciones difieran en los puntos decisivos, para que al enfrentarse se contraste lo que de verdad importa. Descarta premisas claramente inverosímiles en vez de darles defensor. Lo normal son entre 3 y 6 combinaciones (máximo ${MAX_PREMISAS}).
Todo lo que escribas en el JSON va en español. Elige además el idioma de trabajo en el que debatirán los modelos entre sí: "inglés" por defecto; otro solo si hay una razón clara (por ejemplo, que las fuentes y los datos relevantes estén sobre todo en ese idioma).
Responde SOLO con JSON: {"idioma":"inglés","puntos":[{"nombre":"2 a 5 palabras","opciones":["premisa en una frase","otra premisa"]}],"combinaciones":[{"titulo":"3 a 6 palabras","elige":[1,2]}]}
"elige" tiene un número por punto, en el mismo orden: la opción escogida (1 = la primera).`;
  const debate = run.modo === 'debate';
  const system = debate
    ? `Preparas un debate entre varias IA sobre una cuestión. Cada IA defenderá una combinación de premisas y discutirán cuáles se corresponden con la realidad. Ejemplo: ante «¿qué voto es más útil, al partido A o al B?», un punto sería «cómo se reparte el último escaño», con premisas como «lo decide el resto del partido grande» frente a «lo decide que el pequeño supere cierto umbral»; otro punto, «fiabilidad de las encuestas».${run.config.web ? ' Busca en internet solo si la cuestión depende de datos recientes o concretos.' : ''}${formato}`
    : `Preparas un juego de predicción sobre una historia de la que solo se conoce el comienzo. Los puntos son las incógnitas que mueven la historia (motivaciones de los personajes, reglas de su mundo, tipo de relato); cada combinación de premisas debe servir para predecir lo que pasará. Si reconoces la historia, no uses lo que sabes de ella.${formato}`;
  const prompt = debate
    ? `Cuestión a debatir:\n${run.pregunta}`
    : `${run.pregunta ? `Lo que se quiere averiguar: ${run.pregunta}\n\n` : ''}Comienzo de la historia:\n${run.escenas[0]}`;
  const r = await iaJSON(run, ctx, {
    modelo: run.config.generadorModelo || run.config.modelo, esfuerzo: run.config.generadorEsfuerzo || 'medium', web: debate && run.config.web, system, prompt,
    alBuscar: (q) => { run.actividad = `Buscando en internet: ${q.slice(0, 120)}`; ctx.emit(); },
  });
  run.idioma = /^[a-záéíóúñü ]{3,30}$/i.test(String(r.idioma ?? '').trim()) ? String(r.idioma).trim().toLowerCase() : 'inglés';
  run.puntosClave = (Array.isArray(r.puntos) ? r.puntos : [])
    .map((p) => ({ nombre: String(p?.nombre ?? '').trim(), opciones: lista(p?.opciones) }))
    .filter((p) => p.nombre && p.opciones.length > 1);
  run.premisas = [];
  for (const c of Array.isArray(r.combinaciones) ? r.combinaciones.slice(0, MAX_PREMISAS) : []) {
    const elige = Array.isArray(c?.elige) ? c.elige : [];
    const lineas = run.puntosClave.map((p, i) => `· ${p.nombre}: ${p.opciones[limitar(elige[i], 1, p.opciones.length) - 1]}`);
    if (!c?.titulo || !lineas.length) continue;
    run.premisas.push(nuevaPremisa(run, c.titulo, lineas.join('\n')));
  }
  if (run.premisas.length < 2) throw new Error('No se han podido generar al menos dos combinaciones de premisas. Prueba a reformular.');
  run.estado = 'revision';
  run.actividad = '';
  ctx.emit();
}

async function trocear(run, ctx) {
  if (run.escenas.length) return;
  const texto = run.historia.trim();
  const separador = /^\s*-{3,}\s*$/m;
  let escenas;
  if (separador.test(texto)) {
    escenas = texto.split(separador);
  } else {
    let parrafos = texto.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    if (parrafos.length < 3) parrafos = texto.split(/\n/).map((s) => s.trim()).filter(Boolean);
    if (parrafos.length <= 6) {
      escenas = parrafos;
    } else {
      run.actividad = 'Troceando la historia en escenas…';
      ctx.emit();
      // Solo se envía el arranque de cada párrafo: basta para decidir los cortes y ahorra tokens.
      const numerados = parrafos.map((p, i) => `[${i + 1}] ${p.slice(0, 160)}`).join('\n');
      let inicios = [];
      try {
        const r = await iaJSON(run, ctx, {
          ...arbitro(run),
          system: 'Divides una historia en escenas para un juego de predicción. Recibes el comienzo de cada párrafo, numerado. Elige entre 4 y 10 puntos de corte, justo ANTES de giros, decisiones o desenlaces, para que lo que viene después de cada corte sea difícil de adivinar. Responde SOLO con JSON: {"inicios":[números de párrafo donde empieza cada escena]}',
          prompt: numerados,
        });
        inicios = lista(r.inicios).map(Number).filter((n) => Number.isInteger(n) && n > 1 && n <= parrafos.length);
      } catch (e) { if (ctx.signal.aborted) throw e; }
      if (!inicios.length) {
        const paso = Math.ceil(parrafos.length / 6);
        for (let n = paso + 1; n <= parrafos.length; n += paso) inicios.push(n);
      }
      const cortes = [...new Set([1, ...inicios])].sort((a, b) => a - b);
      escenas = cortes.map((c, i) => parrafos.slice(c - 1, (cortes[i + 1] ?? parrafos.length + 1) - 1).join('\n\n'));
    }
  }
  run.escenas = escenas.map((s) => s.trim()).filter(Boolean);
  if (run.escenas.length < 2) throw new Error('La historia necesita al menos dos escenas. Sepáralas con una línea "---" o pega un texto más largo.');
}

// ---------- Competición ----------

export async function competir(run, ctx) {
  run.estado = 'compitiendo';
  run.error = '';
  run.rondas = run.rondas.filter((r) => r.hecha); // al continuar, la ronda a medias se repite
  if (run.modo === 'debate') await debate(run, ctx); else await historia(run, ctx);
  if (!run.veredicto) await veredicto(run, ctx);
  run.estado = 'terminado';
  run.actividad = '';
  ctx.emit();
}

// Filtro progresivo: en cada ronda cae solo la cuarta parte peor puntuada.
function filtrar(run, ronda) {
  for (const p of run.premisas) p.media = media(p);
  const vivas = run.premisas.filter((p) => p.viva);
  if (vivas.length <= 2) return;
  // Nadie cae sin haber competido al menos una vez.
  const peores = vivas.filter((p) => p.puntos.length).reverse().sort((a, b) => a.media - b.media).slice(0, Math.min(Math.ceil(vivas.length / 4), vivas.length - 2));
  for (const p of peores) { p.viva = false; p.eliminadaEn = ronda.n; ronda.eliminadas.push(p.id); }
}

function cerrarRonda(run, ronda) {
  for (const m of ronda.matices) if (!run.matices.includes(m)) run.matices.push(m);
  if (!ronda.final) filtrar(run, ronda); else for (const p of run.premisas) p.media = media(p);
  ronda.hecha = true;
}

// ---------- Modo debate ----------

function emparejar(run, vivas) {
  const orden = [...vivas].sort((a, b) => (b.media ?? 5) - (a.media ?? 5));
  const clave = (a, b) => [a, b].sort().join('|');
  const yaVistos = new Set(run.rondas.flatMap((r) => (r.duelos ?? []).map((d) => clave(d.a, d.b))));
  const duelos = [];
  let descansa = null;
  if (orden.length % 2) {
    // Si son impares descansa la peor clasificada que aún no haya descansado.
    const yaDescansaron = new Set(run.rondas.map((r) => r.descansa));
    // Con tres en pie descansa la mejor (semifinal entre las otras dos): así la final no repite duelo.
    const i = orden.length === 3 ? 0 : orden.findLastIndex((p) => !yaDescansaron.has(p.id));
    descansa = orden.splice(i < 0 ? orden.length - 1 : i, 1)[0].id;
  }
  while (orden.length > 1) {
    const a = orden.shift();
    const i = Math.max(0, orden.findIndex((b) => !yaVistos.has(clave(a.id, b.id))));
    const [b] = orden.splice(i, 1);
    duelos.push({ a: a.id, b: b.id, mensajes: [], resumen: '', puntosA: null, puntosB: null, motivo: '', matices: [], estado: 'espera' });
  }
  return { duelos, descansa };
}

async function debate(run, ctx) {
  while (!run.rondas.at(-1)?.final) {
    const vivas = run.premisas.filter((p) => p.viva);
    const n = run.rondas.length + 1;
    const final = vivas.length <= 2;
    const ronda = { n, final, esfuerzo: esfuerzoDe(run, n, final), ...emparejar(run, vivas), eliminadas: [], matices: [], hecha: false };
    run.rondas.push(ronda);
    run.actividad = final ? 'Duelo final en curso…' : `Ronda ${n} en curso…`;
    ctx.emit();
    await Promise.all(ronda.duelos.map((d) => duelo(run, ctx, ronda, d)));
    for (const d of ronda.duelos) {
      const [A, B] = [premisa(run, d.a), premisa(run, d.b)];
      A.puntos.push(d.puntosA);
      B.puntos.push(d.puntosB);
      A.notas = [...A.notas, `Contra «${B.titulo}» (${d.puntosA}-${d.puntosB}): ${d.motivo}`].slice(-3);
      B.notas = [...B.notas, `Contra «${A.titulo}» (${d.puntosB}-${d.puntosA}): ${d.motivo}`].slice(-3);
      ronda.matices.push(...d.matices);
    }
    cerrarRonda(run, ronda);
    ctx.emit();
  }
}

async function duelo(run, ctx, ronda, d) {
  const P = { a: premisa(run, d.a), b: premisa(run, d.b) };
  const maxIntercambios = run.config.intercambios + (ronda.final ? 1 : 0);
  let vistos = 0; // mensajes ya recogidos en el resumen del árbitro
  let verificaciones = 0;
  d.estado = 'en curso';

  const verificar = async (dato) => {
    dato = String(dato ?? '').trim();
    if (!run.config.web || !dato || verificaciones >= 2) return;
    verificaciones++;
    const r = await ia(run, ctx, {
      ...arbitro(run), web: true,
      system: `Eres un verificador de datos neutral. Comprueba el dato con una búsqueda en internet. Responde en 3 frases como máximo: qué dicen los datos reales y la fuente (nombre y año). Si no hay datos fiables, dilo. ${interno(run)}`,
      prompt: `Contexto: debate sobre «${run.pregunta}».\nDato a comprobar: ${dato}`,
    });
    d.mensajes.push({ autor: 'verificador', texto: `Dato comprobado: ${dato}\n${r}` });
    ctx.emit();
  };
  const transcribir = (mensajes, yo) => mensajes.map((m) => {
    const quien = m.autor === 'verificador' ? 'Verificador' : yo ? (m.autor === yo ? 'Tú' : 'Rival') : m.autor.toUpperCase();
    return `[${quien}] ${m.texto}`;
  }).join('\n\n');

  for (let i = 1; i <= maxIntercambios; i++) {
    for (const lado of ['a', 'b']) {
      const yo = P[lado];
      const rival = P[lado === 'a' ? 'b' : 'a'];
      const nuevos = d.mensajes.slice(vistos);
      const texto = await ia(run, ctx, {
        modelo: run.config.modelo, esfuerzo: ronda.esfuerzo,
        system: `Eres un debatiente en un duelo de ideas. Defiendes esta combinación de premisas:\n${cita(yo)}\nLo único que se discute es qué premisas se corresponden con la realidad. No hay una respuesta que defender: no defiendas ninguna conclusión ni discutas qué respuesta es preferible. Argumenta por qué tus premisas son ciertas y por qué tu combinación describe la realidad mejor que la del rival; céntrate en los puntos donde vuestras premisas difieren, ataca las suyas mostrando que son falsas y responde a sus ataques con argumentos nuevos. No cedas por cortesía; concede un punto solo si de verdad está refutado y defiende entonces lo que queda en pie. Repetir un argumento ya dado te resta puntos. No inventes datos ni fuentes.${run.config.web ? ' Si un dato concreto y comprobable decidiría la discusión, termina con una línea "VERIFICAR: <dato>" y un verificador lo buscará en internet; úsalo solo cuando sea decisivo.' : ''} ${interno(run)}`,
        prompt: [
          `Cuestión: ${run.pregunta}`,
          `Combinación rival: ${cita(rival)}`,
          yo.notas.length ? `Lo que quedó de tus duelos anteriores:\n- ${yo.notas.join('\n- ')}` : '',
          d.resumen ? `Resumen del duelo hasta ahora (del árbitro):\n${d.resumen}` : '',
          nuevos.length ? `Mensajes nuevos:\n${transcribir(nuevos, lado)}` : '',
          d.mensajes.length ? 'Tu turno.' : 'Abre tú el duelo.',
        ].filter(Boolean).join('\n\n'),
      });
      d.mensajes.push({ autor: lado, texto });
      ctx.emit();
      const pide = texto.match(/^\s*VERIFICAR:\s*(.+)$/m);
      if (pide) await verificar(pide[1]);
    }

    const j = await iaJSON(run, ctx, {
      ...arbitro(run),
      system: `Eres el árbitro imparcial de un duelo entre dos combinaciones de premisas, A y B. Cada combinación elige una premisa por punto. Juzgas solo, punto por punto, qué premisas se corresponden mejor con la realidad; una combinación puede acertar en unos puntos y fallar en otros. No hay respuesta que premiar ni castigar: ignora lo que los debatientes digan sobre qué conclusión es preferible. Valoras la calidad de los argumentos y de los datos, nunca la insistencia ni la longitud. Responde SOLO con JSON:
{"resumen":"","puntos_a":0,"bucle":false,"seguir":true,"motivo":"","matices":[],"verificar":""}
- resumen: en ${run.idioma || 'inglés'}. Estado completo y acumulado del duelo, ordenado por puntos en disputa (qué premisa va ganando en cada uno y por qué): argumentos de cada lado que siguen en pie, argumentos refutados (y por qué) y datos comprobados. Los debatientes solo leerán esto, así que no pierdas ninguna idea relevante; elimina solo repeticiones y retórica.
- puntos_a: de 0 a 10, cuánto mejor se ajusta a la realidad la combinación A frente a la B hasta ahora (5 = empate; B recibe el resto hasta 10).
- bucle: true si se repiten argumentos sin aportar nada nuevo.
- seguir: false si hay bucle, si una premisa ha quedado claramente refutada o si otro intercambio no cambiaría el resultado.
- motivo: en español, una frase que explique la puntuación.
- matices: en español. Ideas válidas aparecidas en estos mensajes que nadie ha rebatido o que quedan al margen de la disputa y merece la pena conservar para el veredicto final. Solo las nuevas y solo las importantes: dos como mucho, una frase cada una; lo normal es que vaya vacío.
- verificar: un dato concreto y comprobable en disputa que decidiría el duelo, o "" si no hay.`,
      prompt: [
        `Cuestión: ${run.pregunta}`,
        `Combinación A: ${cita(P.a)}`,
        `Combinación B: ${cita(P.b)}`,
        d.resumen ? `Tu resumen anterior:\n${d.resumen}` : '',
        `Mensajes nuevos:\n${transcribir(d.mensajes.slice(vistos))}`,
        `Intercambio ${i} de ${maxIntercambios} como máximo.`,
      ].filter(Boolean).join('\n\n'),
    });
    vistos = d.mensajes.length;
    d.resumen = String(j.resumen ?? d.resumen);
    d.puntosA = limitar(j.puntos_a, 0, 10);
    d.puntosB = 10 - d.puntosA;
    d.motivo = String(j.motivo ?? '');
    d.bucle = j.bucle === true;
    d.matices.push(...lista(j.matices));
    ctx.emit();
    if (i === maxIntercambios || j.seguir === false || d.bucle) break;
    await verificar(j.verificar);
  }
  d.estado = 'hecho';
  ctx.emit();
}

// ---------- Modo historia ----------

async function historia(run, ctx) {
  while (run.rondas.length < run.escenas.length - 1) {
    const n = run.rondas.length + 1; // se predice la escena n (la 0 es el comienzo)
    const vivas = run.premisas.filter((p) => p.viva);
    const final = n === run.escenas.length - 1;
    const ronda = { n, final, esfuerzo: esfuerzoDe(run, n, final), predicciones: vivas.map((p) => ({ id: p.id, texto: '', puntos: null, motivo: '' })), eliminadas: [], matices: [], hecha: false };
    run.rondas.push(ronda);
    run.actividad = `Prediciendo la escena ${n + 1} de ${run.escenas.length}…`;
    ctx.emit();
    const hastaAhora = run.escenas.slice(0, n).join('\n\n');
    await Promise.all(ronda.predicciones.map(async (pr) => {
      pr.texto = await ia(run, ctx, {
        modelo: run.config.modelo, esfuerzo: ronda.esfuerzo,
        system: `Predices cómo sigue una historia guiándote SOLO por estas premisas:\n${cita(premisa(run, pr.id))}\nDi qué ocurre en la siguiente escena, de forma concreta y comprobable, en 2 a 4 frases. Si reconoces la historia, no uses lo que sabes de ella. ${interno(run)}`,
        prompt: `Historia hasta ahora:\n${hastaAhora}\n\n¿Qué ocurre a continuación?`,
      });
      ctx.emit();
    }));
    run.actividad = `Auditando las predicciones de la escena ${n + 1}…`;
    ctx.emit();
    const j = await iaJSON(run, ctx, {
      ...arbitro(run),
      system: `Eres el auditor imparcial de un juego de predicción. Compara cada predicción con lo que ocurre de verdad en la escena. Puntúa de 0 a 10 cuánto se acerca en lo esencial (hechos, decisiones, tono), no en los detalles de redacción. Responde SOLO con JSON:
{"notas":[{"id":"","puntos":0,"motivo":"una frase"}],"matices":[]}
Escribe motivo y matices en español.
- matices: aciertos parciales valiosos de predicciones que en conjunto fallaron (puede ir vacío).`,
      prompt: `Escena real:\n${run.escenas[n]}\n\nPredicciones:\n${ronda.predicciones.map((pr) => `[${pr.id}] ${pr.texto}`).join('\n\n')}`,
    });
    const notas = Array.isArray(j.notas) ? j.notas : [];
    for (const pr of ronda.predicciones) {
      const nota = notas.find((x) => x?.id === pr.id);
      pr.puntos = limitar(nota?.puntos, 0, 10);
      pr.motivo = String(nota?.motivo ?? '');
      premisa(run, pr.id).puntos.push(pr.puntos);
    }
    ronda.matices.push(...lista(j.matices));
    for (const m of ronda.matices) if (!run.matices.includes(m)) run.matices.push(m);
    filtrar(run, ronda);
    ronda.hecha = true;
    ctx.emit();
  }
}

// ---------- Veredicto ----------

async function veredicto(run, ctx) {
  run.estado = 'veredicto';
  run.actividad = 'Redactando el veredicto final…';
  ctx.emit();
  const tabla = run.premisas.map((p) => `[${p.id}] ${cita(p)} — media ${p.media === null ? 's/d' : p.media.toFixed(1)}/10, ${p.viva ? 'sigue en pie' : `cayó en la ronda ${p.eliminadaEn}`}`).join('\n');
  const rondas = run.rondas.map((r) => (run.modo === 'debate'
    ? r.duelos.map((d) => `Ronda ${r.n}${r.final ? ' (final)' : ''}: ${d.a} contra ${d.b}, ${d.puntosA}-${d.puntosB}. ${d.motivo}\n${d.resumen}`).join('\n\n')
    : `Escena ${r.n + 1}: ${r.predicciones.map((pr) => `${pr.id}=${pr.puntos} (${pr.motivo})`).join('; ')}`)).join('\n\n');
  const j = await iaJSON(run, ctx, {
    modelo: run.config.modelo, esfuerzo: esfuerzoDe(run, 99, true),
    system: `Eres el juez final de una competición entre combinaciones de premisas. Con todo lo ocurrido, decide qué combinación queda mejor parada y di, punto por punto, qué premisa ha resistido mejor el contraste con la realidad (la mejor mezcla puede no coincidir con ninguna combinación). En «Conclusión» da la respuesta que se sigue de las premisas que han resistido, sin caer en "el ganador se lo lleva todo": recoge también lo que sigue siendo válido de las demás. Responde SOLO con JSON: {"ganadora":"id de la combinación, o \\"\\" si es un empate real","texto":""}
El texto, en lenguaje llano y en este formato exacto de cuatro apartados, cada uno en una sola línea, separados por saltos de línea:
Conclusión: …
Premisas que resisten: … (punto por punto, muy breve)
Qué se salva de las demás: …
Queda abierto: …
${breve('español')}`,
    prompt: [
      run.modo === 'debate' ? `Cuestión: ${run.pregunta}` : `Juego de predicción sobre una historia.${run.pregunta ? ` Se quería averiguar: ${run.pregunta}` : ''}`,
      `Combinaciones:\n${tabla}`,
      `Lo ocurrido:\n${rondas}`,
      run.matices.length ? `Matices recogidos por el árbitro:\n- ${run.matices.join('\n- ')}` : '',
    ].filter(Boolean).join('\n\n'),
  });
  run.ganadora = premisa(run, j.ganadora) ? j.ganadora : '';
  run.veredicto = String(j.texto ?? '').trim();
}
