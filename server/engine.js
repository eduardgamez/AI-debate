// Motor de la competición.
// Una cuestión difícil depende de HUECOS de información: incógnitas que ni razonando ni buscando
// se pueden resolver con seguridad. Cada hueco admite varios RELLENOS incompatibles entre sí.
// Cada instancia defiende una COMBINACIÓN (un relleno por hueco) y, en cada duelo, solo se
// discuten los huecos en los que las dos combinaciones difieren. Lo que se juzga es qué relleno
// es más probable, nunca hacia qué respuesta lleva.
import { preguntar, preguntarJSON } from './claude.js';

// Lo que se dicen los modelos entre sí va en el idioma de trabajo (inglés salvo que el generador
// decida otro); lo que lee el usuario va siempre en español.
const breve = (idioma) => `Escribe en ${idioma} y en texto plano (sin markdown). Sé tan breve como el contenido permita: cada frase debe aportar algo nuevo. Sin saludos, sin relleno y sin repetir lo ya dicho.`;
const interno = (run) => breve(run.idioma || 'inglés');
const MAX_COMBINACIONES = 12;
const MAX_HUECOS = 8;
const MAX_RELLENOS = 4;
// Hasta este tamaño (en caracteres, ~10.000 palabras) todos leen la conversación entera del duelo;
// solo si la supera se pasa a resumen del árbitro + mensajes nuevos.
const CONVERSACION_ENTERA = 60_000;

const premisa = (run, id) => run.premisas.find((p) => p.id === id);
const media = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
const limitar = (n, min, max) => Math.min(max, Math.max(min, Math.round(Number(n) || 0)));
const lista = (x) => (Array.isArray(x) ? x.map((s) => String(s).trim()).filter(Boolean) : []);
const indices = (run) => run.huecos.map((_, i) => i);

const relleno = (run, p, i) => run.huecos[i].rellenos[p.elige[i]];
const lineas = (run, p, cuales = indices(run)) => cuales.map((i) => `· ${run.huecos[i].pregunta} → ${relleno(run, p, i)}`).join('\n');
const cita = (run, p) => `«${p.titulo}»\n${lineas(run, p)}`;
const difieren = (run, a, b) => indices(run).filter((i) => a.elige[i] !== b.elige[i]);
const sabido = (run) => (run.sabido?.length ? `Datos de partida que no se discuten:\n- ${run.sabido.join('\n- ')}` : '');

function esfuerzoDe(run, ronda, final) {
  if (final && run.config.final) return run.config.final;
  if (run.config.esfuerzo === 'auto') return ronda === 1 ? 'low' : 'medium';
  return run.config.esfuerzo;
}
// Entender un debate es exigente: por defecto el árbitro trabaja en nivel alto.
const arbitro = (run) => ({ modelo: run.config.arbitro, esfuerzo: run.config.arbitroEsfuerzo || 'high' });

const ia = (run, ctx, o) => preguntar({ ...o, signal: ctx.signal, uso: run.uso });
const iaJSON = (run, ctx, o) => preguntarJSON({ ...o, signal: ctx.signal, uso: run.uso });

// Fija las combinaciones que van a competir (las del generador o las editadas por el usuario).
// `elige` va en base 0. Devuelve un mensaje de error o ''.
export function fijarCombinaciones(run, combinaciones) {
  run.premisas = [];
  const vistas = new Set();
  for (const c of Array.isArray(combinaciones) ? combinaciones : []) {
    const titulo = String(c?.titulo ?? '').trim().slice(0, 120);
    if (!titulo) continue;
    const elige = run.huecos.map((h, i) => limitar(c?.elige?.[i], 0, h.rellenos.length - 1));
    const clave = elige.join(',');
    if (vistas.has(clave)) continue; // dos combinaciones idénticas no tienen nada que discutir
    vistas.add(clave);
    run.premisas.push({ id: `p${run.premisas.length + 1}`, titulo, elige, puntos: [], media: null, viva: true, eliminadaEn: null, notas: [] });
    if (run.premisas.length === MAX_COMBINACIONES) break;
  }
  return run.premisas.length < 2 ? 'Hacen falta al menos dos combinaciones distintas.' : '';
}

// ---------- Huecos y combinaciones ----------

export async function generarPremisas(run, ctx) {
  run.estado = 'generando';
  if (run.modo === 'historia') await trocear(run, ctx);
  run.actividad = 'Buscando los huecos de información…';
  ctx.emit();
  const debate = run.modo === 'debate';
  const reparto = `
Después, REPARTO: forma combinaciones eligiendo un relleno de cada hueco. Cada combinación la defenderá una IA distinta, que tendrá que sostener todos sus rellenos a la vez. Las combinaciones no tienen que ser coherentes ni apuntar a ninguna respuesta: son solo un reparto de posiciones. Hazlo de forma inteligente, no una combinación por cada mezcla posible:
- usa el menor número de combinaciones que dé al menos un defensor a cada relleno plausible;
- que las combinaciones compartan rellenos en unos huecos y difieran en otros, para que en cada duelo solo se discutan unos pocos huecos;
- ninguna combinación repetida. Lo normal son entre 3 y 6 (máximo ${MAX_COMBINACIONES}).
Todo lo que escribas en el JSON va en español. Elige además el idioma de trabajo en el que debatirán las IA entre sí: "inglés" por defecto; otro solo si hay una razón clara (por ejemplo, que las fuentes relevantes estén sobre todo en ese idioma).
Responde SOLO con JSON: {"idioma":"inglés","sabido":["dato ya establecido, en una frase"],"huecos":[{"pregunta":"¿…?","rellenos":["…","…"]}],"combinaciones":[{"titulo":"3 a 6 palabras","elige":[1,2]}]}
"elige" tiene un número por hueco, en el mismo orden: el relleno escogido (1 = el primero).`;
  const huecos = `Un hueco cumple tres condiciones: (1) afecta a la respuesta, en la dirección que sea; (2) no se puede saber con seguridad ni razonando ni buscando en internet (intenciones, carácter o estado de ánimo de personas, cómo reaccionará alguien, qué pasará, circunstancias concretas del caso que no se han dicho, datos que no son públicos…); (3) admite varias respuestas plausibles. Verbaliza todos los que importen, también los indirectos o poco obvios. Lo que sí se puede averiguar NO es un hueco: averígualo y ponlo en "sabido".
Formula cada hueco como una pregunta (como mucho ${MAX_HUECOS}) y da entre 2 y ${MAX_RELLENOS} rellenos: respuestas concretas a esa pregunta, incompatibles entre sí (si una es la real, las demás no) y todas plausibles. Un relleno nunca es una respuesta a la cuestión principal.`;
  const system = debate
    ? `Preparas un debate entre varias IA sobre una cuestión que no se puede responder con seguridad de primeras. Tu trabajo NO es responderla, sino detectar sus HUECOS DE INFORMACIÓN: lo que te falta saber para decidirte por una respuesta.
${huecos}
Ejemplo: ante «¿aceptará esta persona la negociación?», huecos posibles: «¿Es buena negociadora?», «¿Suelen aceptarse negociaciones de este tipo?», «¿Reacciona de forma irracional ante la presión?», «¿Qué humor tendrá ese día (descanso, tiempo, otros problemas)?». Rellenos del último: «de buen humor», «irritada o cansada», «indiferente».${run.config.web ? '\nBusca en internet lo que sí sea averiguable, para no convertirlo en hueco.' : ''}${reparto}`
    : `Preparas un juego de predicción sobre una historia de la que solo se conoce el comienzo. Los HUECOS son las incógnitas de la historia que todavía no se pueden saber y que deciden cómo seguirá (motivaciones y carácter de los personajes, secretos, reglas de su mundo, tipo de relato…).
${huecos}
Cada combinación de rellenos servirá para predecir lo que pasará. Si reconoces la historia, no uses lo que sabes de ella.${reparto}`;
  const prompt = debate
    ? `Cuestión:\n${run.pregunta}`
    : `${run.pregunta ? `Lo que se quiere averiguar: ${run.pregunta}\n\n` : ''}Comienzo de la historia:\n${run.escenas[0]}`;
  const r = await iaJSON(run, ctx, {
    modelo: run.config.generadorModelo || run.config.modelo, esfuerzo: run.config.generadorEsfuerzo || 'medium', web: debate && run.config.web, system, prompt,
    alBuscar: (q) => { run.actividad = `Buscando en internet: ${q.slice(0, 120)}`; ctx.emit(); },
  });
  run.idioma = /^[a-záéíóúñü ]{3,30}$/i.test(String(r.idioma ?? '').trim()) ? String(r.idioma).trim().toLowerCase() : 'inglés';
  run.sabido = lista(r.sabido).slice(0, 10);
  run.huecos = (Array.isArray(r.huecos) ? r.huecos : [])
    .map((h) => ({ pregunta: String(h?.pregunta ?? '').trim(), rellenos: lista(h?.rellenos).slice(0, MAX_RELLENOS) }))
    .filter((h) => h.pregunta && h.rellenos.length > 1)
    .slice(0, MAX_HUECOS)
    .map((h) => ({ ...h, notas: h.rellenos.map(() => []) }));
  if (!run.huecos.length) throw new Error('No se han encontrado huecos de información. Prueba a reformular la cuestión.');
  const combinaciones = (Array.isArray(r.combinaciones) ? r.combinaciones : [])
    .map((c) => ({ titulo: c?.titulo, elige: run.huecos.map((_, i) => Number(c?.elige?.[i]) - 1) }));
  const error = fijarCombinaciones(run, combinaciones);
  if (error) throw new Error('No se han podido repartir al menos dos combinaciones distintas. Prueba a reformular.');
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

// Filtro progresivo: en cada ronda cae la parte peor puntuada que elija el usuario (un cuarto por defecto).
function filtrar(run, ronda) {
  for (const p of run.premisas) p.media = media(p.puntos);
  const vivas = run.premisas.filter((p) => p.viva);
  if (vivas.length <= 2) return;
  // Nadie cae sin haber competido al menos una vez.
  const peores = vivas.filter((p) => p.puntos.length).reverse().sort((a, b) => a.media - b.media).slice(0, Math.min(Math.ceil(vivas.length * (run.config.corte || 0.25)), vivas.length - 2));
  for (const p of peores) { p.viva = false; p.eliminadaEn = ronda.n; ronda.eliminadas.push(p.id); }
}

const MAX_MATICES = 5;
const guardarMatices = (run, nuevos) => { for (const m of nuevos) if (run.matices.length < MAX_MATICES && !run.matices.includes(m)) run.matices.push(m); };

function cerrarRonda(run, ronda) {
  guardarMatices(run, ronda.matices);
  if (!ronda.final) filtrar(run, ronda); else for (const p of run.premisas) p.media = media(p.puntos);
  ronda.hecha = true;
}

// ---------- Modo debate ----------

function emparejar(run, vivas) {
  const orden = [...vivas].sort((a, b) => (b.media ?? 5) - (a.media ?? 5));
  const clave = (a, b) => [a, b].sort().join('|');
  const yaVistos = new Set(run.rondas.flatMap((r) => (r.duelos ?? []).map((d) => clave(d.a, d.b))));
  let descansa = null;
  if (orden.length % 2) {
    // Si son impares descansa la peor clasificada que aún no haya descansado.
    const yaDescansaron = new Set(run.rondas.map((r) => r.descansa));
    // Con tres en pie descansa la mejor (semifinal entre las otras dos): así la final no repite duelo.
    // Si esas dos ya se enfrentaron, descansa otra para que la semifinal sea un duelo nuevo.
    const semifinalNueva = (k) => { const [x, y] = orden.filter((_, j) => j !== k); return !yaVistos.has(clave(x.id, y.id)); };
    const i = orden.length === 3 ? Math.max(0, [0, 1, 2].find(semifinalNueva) ?? 0) : orden.findLastIndex((p) => !yaDescansaron.has(p.id));
    descansa = orden.splice(i < 0 ? orden.length - 1 : i, 1)[0].id;
  }
  const parejas = [];
  while (orden.length > 1) {
    const a = orden.shift();
    const i = Math.max(0, orden.findIndex((b) => !yaVistos.has(clave(a.id, b.id))));
    parejas.push([a, orden.splice(i, 1)[0]]);
  }
  // El reparto voraz puede dejar al final una pareja que ya se enfrentó: se intercambia con otra
  // pareja para que nadie repita duelo sobre los mismos huecos mientras haya alternativa.
  const nueva = (x, y) => !yaVistos.has(clave(x.id, y.id));
  for (let i = 0; i < parejas.length; i++) {
    const [x, y] = parejas[i];
    if (nueva(x, y)) continue;
    for (let j = 0; j < parejas.length; j++) {
      if (j === i) continue;
      const [u, v] = parejas[j];
      if (nueva(x, u) && nueva(y, v)) { parejas[i] = [x, u]; parejas[j] = [y, v]; break; }
      if (nueva(x, v) && nueva(y, u)) { parejas[i] = [x, v]; parejas[j] = [y, u]; break; }
    }
  }
  const duelos = parejas.map(([a, b]) => ({ a: a.id, b: b.id, huecos: difieren(run, a, b), notasHuecos: {}, mensajes: [], resumen: '', puntosA: null, puntosB: null, motivo: '', matices: [], estado: 'espera' }));
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
      // Lo que importa de verdad: cuánto ha resistido cada relleno en cada hueco discutido.
      for (const i of d.huecos) {
        const pa = d.notasHuecos[i] ?? 5;
        run.huecos[i].notas[A.elige[i]].push(pa);
        run.huecos[i].notas[B.elige[i]].push(10 - pa);
      }
      ronda.matices.push(...d.matices);
    }
    cerrarRonda(run, ronda);
    ctx.emit();
  }
}

async function duelo(run, ctx, ronda, d) {
  const P = { a: premisa(run, d.a), b: premisa(run, d.b) };
  const enDisputa = d.huecos;
  const deAcuerdo = indices(run).filter((i) => !enDisputa.includes(i));
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
      system: `Eres un verificador de datos neutral. Busca en internet información fiable sobre lo que se te pide (por ejemplo, una estadística o una frecuencia general que ayude a valorar qué es más probable). Responde en 3 frases como máximo: qué dicen los datos y la fuente (nombre y año). Si no hay datos fiables, dilo. ${interno(run)}`,
      prompt: `Contexto: debate sobre «${run.pregunta}».\nA comprobar: ${dato}`,
    });
    d.mensajes.push({ autor: 'verificador', texto: `Dato comprobado: ${dato}\n${r}` });
    ctx.emit();
  };
  const transcribir = (mensajes, yo) => mensajes.map((m) => {
    const quien = m.autor === 'verificador' ? 'Verificador' : yo ? (m.autor === yo ? 'Tú' : 'Rival') : m.autor.toUpperCase();
    return `[${quien}] ${m.texto}`;
  }).join('\n\n');
  // Conversación entera salvo que sea muy larga (y haya ya un resumen al que recurrir).
  const largo = () => d.mensajes.reduce((n, m) => n + m.texto.length, 0);
  const entera = () => !d.resumen || largo() <= CONVERSACION_ENTERA;
  let resumenFinal = false;
  const acuerdo = (p) => (deAcuerdo.length ? `En estos huecos estáis de acuerdo; dalos por buenos y no los discutas:\n${lineas(run, p, deAcuerdo)}` : '');

  for (let i = 1; i <= maxIntercambios; i++) {
    for (const lado of ['a', 'b']) {
      const yo = P[lado];
      const rival = P[lado === 'a' ? 'b' : 'a'];
      const nuevos = d.mensajes.slice(vistos);
      const texto = await ia(run, ctx, {
        modelo: run.config.modelo, esfuerzo: ronda.esfuerzo,
        system: `Eres un debatiente en un duelo de ideas. La cuestión no se puede responder con seguridad porque depende de huecos de información: incógnitas que nadie puede comprobar. Te ha tocado defender un relleno concreto de algunos de esos huecos y tu rival defiende otro incompatible. Lo que se discute es qué relleno es más probable que sea el real; nadie puede demostrarlo, así que argumenta con indicios, frecuencias, conocimiento general, datos y razonamiento. No hay una respuesta final que defender: da igual hacia dónde lleve cada relleno.
Huecos en disputa (solo discutís estos):
${enDisputa.map((h) => `· ${run.huecos[h].pregunta} → Tú: ${relleno(run, yo, h)} | Rival: ${relleno(run, rival, h)}`).join('\n')}
${acuerdo(yo)}
${sabido(run)}
Defiende todos tus rellenos en disputa, aunque te parezcan menos probables: ese es tu papel. El debate es constructivo y honesto: el objetivo común es acercarse a lo más probable, no ganar a cualquier precio. Responde a los mejores argumentos del rival, no a versiones débiles de ellos; reconoce lo que tenga de cierto y explica por qué aun así tu relleno es más probable. Sin descalificaciones, trampas retóricas ni exageraciones. No cedas por cortesía; concede un hueco solo si de verdad has quedado sin argumentos y defiende entonces los demás. Repetir un argumento ya dado te resta puntos. No inventes datos ni fuentes, y no presentes como seguro lo que es una suposición.${run.config.web ? ' Si un dato concreto y comprobable (una estadística, una frecuencia) ayudaría a decidir, termina con una línea "VERIFICAR: <dato>" y un verificador lo buscará en internet; úsalo solo cuando sea decisivo.' : ''} ${interno(run)}`,
        prompt: [
          `Cuestión: ${run.pregunta}`,
          yo.notas.length ? `Lo que quedó de tus duelos anteriores:\n- ${yo.notas.join('\n- ')}` : '',
          ...(entera()
            ? [d.mensajes.length ? `Conversación completa del duelo:\n${transcribir(d.mensajes, lado)}` : '']
            : [`Resumen del duelo hasta ahora (del árbitro):\n${d.resumen}`, nuevos.length ? `Mensajes nuevos:\n${transcribir(nuevos, lado)}` : '']),
          d.mensajes.length ? 'Tu turno.' : 'Abre tú el duelo.',
        ].filter(Boolean).join('\n\n'),
      });
      d.mensajes.push({ autor: lado, texto });
      ctx.emit();
      const pide = texto.match(/^\s*VERIFICAR:\s*(.+)$/m);
      if (pide) await verificar(pide[1]);
    }

    // El resumen solo se pide al acabar el duelo (para el veredicto), salvo que la conversación sea tan
    // larga que haga falta como respaldo para los debatientes.
    const ultimo = i === maxIntercambios;
    const respaldo = largo() > CONVERSACION_ENTERA * 0.8;
    const j = await iaJSON(run, ctx, {
      ...arbitro(run),
      system: `Eres el árbitro imparcial de un duelo. La cuestión depende de huecos de información que nadie puede comprobar; A y B defienden rellenos incompatibles de algunos de ellos. Juzgas, hueco por hueco, qué relleno es más probable que sea el real a la luz de los argumentos y los datos. No juzgues hacia qué respuesta lleva cada relleno: eso no cuenta. Valoras la calidad de los argumentos, nunca la insistencia ni la longitud. Penaliza la deshonestidad: datos inventados, tergiversar al rival o presentar suposiciones como hechos.
Huecos en disputa:
${enDisputa.map((h) => `[${h + 1}] ${run.huecos[h].pregunta} → A: ${relleno(run, P.a, h)} | B: ${relleno(run, P.b, h)}`).join('\n')}
Responde SOLO con JSON:
{"resumen":"","huecos":[{"n":${enDisputa[0] + 1},"puntos_a":5}],"bucle":false,"seguir":true,"motivo":"","matices":[],"verificar":""}
- resumen: ${ultimo || respaldo ? 'obligatorio' : 'escríbelo SOLO si pones seguir=false; si el duelo sigue, déjalo vacío'}. En ${run.idioma || 'inglés'}. Estado completo del duelo, hueco por hueco: qué relleno queda por delante y por qué, argumentos que siguen en pie, argumentos refutados y datos comprobados. No pierdas ninguna idea relevante; elimina solo repeticiones y retórica.
- huecos: una entrada por cada hueco en disputa, con su número; puntos_a de 0 a 10 = cuánto más probable es el relleno de A que el de B (5 = igual de probables).
- bucle: true si se repiten argumentos sin aportar nada nuevo.
- seguir: false si hay bucle, si todos los huecos están claros o si otro intercambio no cambiaría nada.
- motivo: en español, una frase que explique el resultado.
- matices: ${ultimo ? '' : 'solo si pones seguir=false; si el duelo sigue, vacío. '}En español. Sé muy selectivo: como mucho UNA idea, y solo si cambiaría el veredicto final y no está ya en los huecos (algo que nadie ha rebatido o que ha quedado al margen). Máximo 15 palabras. Casi siempre debe ir vacío.
- verificar: un dato comprobable en internet (una estadística, una frecuencia) que ayudaría a decidir algún hueco, o "" si no hay.`,
      prompt: [
        `Cuestión: ${run.pregunta}`,
        sabido(run),
        ...(entera()
          ? [`Conversación completa del duelo:\n${transcribir(d.mensajes)}`]
          : [`Tu resumen anterior:\n${d.resumen}`, `Mensajes nuevos:\n${transcribir(d.mensajes.slice(vistos))}`]),
        `Intercambio ${i} de ${maxIntercambios} como máximo.`,
      ].filter(Boolean).join('\n\n'),
    });
    vistos = d.mensajes.length;
    const resumen = String(j.resumen ?? '').trim();
    if (resumen) d.resumen = resumen;
    const acaba = ultimo || j.seguir === false || j.bucle === true;
    resumenFinal = acaba && Boolean(resumen);
    const notas = Array.isArray(j.huecos) ? j.huecos : [];
    for (const h of enDisputa) {
      const nota = notas.find((x) => Number(x?.n) === h + 1);
      if (nota) d.notasHuecos[h] = limitar(nota.puntos_a, 0, 10);
    }
    d.puntosA = Math.round(media(enDisputa.map((h) => d.notasHuecos[h] ?? 5)));
    d.puntosB = 10 - d.puntosA;
    d.motivo = String(j.motivo ?? '');
    d.bucle = j.bucle === true;
    if (acaba) d.matices = lista(j.matices).slice(0, 1);
    ctx.emit();
    if (acaba) break;
    await verificar(j.verificar);
  }
  if (!resumenFinal) {
    // Respaldo: el árbitro paró sin dejar resumen; se pide aparte, con la conversación entera.
    d.resumen = await ia(run, ctx, {
      ...arbitro(run),
      system: `Resume un duelo ya terminado para el juez final. Hueco por hueco: qué relleno queda por delante y por qué, argumentos que siguen en pie, argumentos refutados y datos comprobados. No pierdas ninguna idea relevante; elimina solo repeticiones y retórica. ${interno(run)}`,
      prompt: `Cuestión: ${run.pregunta}\n\nHuecos en disputa:\n${enDisputa.map((h) => `[${h + 1}] ${run.huecos[h].pregunta} → A: ${relleno(run, P.a, h)} | B: ${relleno(run, P.b, h)}`).join('\n')}\n\nConversación:\n${transcribir(d.mensajes)}`,
    });
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
        system: `Predices cómo sigue una historia dando por ciertas SOLO estas respuestas a sus incógnitas:\n${lineas(run, premisa(run, pr.id))}\nDi qué ocurre en la siguiente escena, de forma concreta y comprobable, en 2 a 4 frases. Si reconoces la historia, no uses lo que sabes de ella. ${interno(run)}`,
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
- matices: como mucho UNO, de 15 palabras como máximo, y solo si es un acierto parcial que cambiaría el veredicto final. Casi siempre vacío.`,
      prompt: `Escena real:\n${run.escenas[n]}\n\nPredicciones:\n${ronda.predicciones.map((pr) => `[${pr.id}] ${pr.texto}`).join('\n\n')}`,
    });
    const notas = Array.isArray(j.notas) ? j.notas : [];
    for (const pr of ronda.predicciones) {
      const nota = notas.find((x) => x?.id === pr.id);
      pr.puntos = limitar(nota?.puntos, 0, 10);
      pr.motivo = String(nota?.motivo ?? '');
      const p = premisa(run, pr.id);
      p.puntos.push(pr.puntos);
      for (const i of indices(run)) run.huecos[i].notas[p.elige[i]].push(pr.puntos);
    }
    ronda.matices.push(...lista(j.matices).slice(0, 1));
    guardarMatices(run, ronda.matices);
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
  const fmt = (n) => (n === null ? 'sin discutir' : `${n.toFixed(1)}/10`);
  const huecos = run.huecos.map((h, i) => `[${i + 1}] ${h.pregunta}\n${h.rellenos.map((r, k) => `   - ${r}: ${fmt(media(h.notas[k]))}`).join('\n')}`).join('\n');
  const tabla = run.premisas.map((p) => `[${p.id}] «${p.titulo}» — media ${fmt(p.media)}, ${p.viva ? 'sigue en pie' : `cayó en la ronda ${p.eliminadaEn}`}`).join('\n');
  const rondas = run.rondas.map((r) => (run.modo === 'debate'
    ? r.duelos.map((d) => `Ronda ${r.n}${r.final ? ' (final)' : ''}: ${d.a} contra ${d.b}, ${d.puntosA}-${d.puntosB}. ${d.motivo}\n${d.resumen}`).join('\n\n')
    : `Escena ${r.n + 1}: ${r.predicciones.map((pr) => `${pr.id}=${pr.puntos} (${pr.motivo})`).join('; ')}`)).join('\n\n');
  const j = await iaJSON(run, ctx, {
    modelo: run.config.modelo, esfuerzo: esfuerzoDe(run, 99, true),
    system: `Eres el juez final. La cuestión dependía de huecos de información que nadie puede comprobar; varias IA han discutido qué relleno de cada hueco es más probable. Con las puntuaciones de cada relleno y lo ocurrido en los duelos, di cuál es el relleno más probable de cada hueco (o si sigue muy igualado) y qué respuesta a la cuestión se sigue de ellos. Sin "el ganador se lo lleva todo": recoge también lo que sigue siendo válido de lo demás. Responde SOLO con JSON: {"ganadora":"id de la combinación mejor parada, o \\"\\" si es un empate real","texto":""}
El texto, en lenguaje llano y en este formato exacto de cuatro apartados, cada uno en una sola línea, separados por saltos de línea:
Conclusión: …
Huecos: … (el relleno más probable de cada uno, muy breve)
Qué se salva de lo demás: …
Queda abierto: …
${breve('español')}`,
    prompt: [
      run.modo === 'debate' ? `Cuestión: ${run.pregunta}` : `Juego de predicción sobre una historia.${run.pregunta ? ` Se quería averiguar: ${run.pregunta}` : ''}`,
      sabido(run),
      `Huecos y puntuación de cada relleno:\n${huecos}`,
      `Combinaciones:\n${tabla}`,
      `Lo ocurrido:\n${rondas}`,
      run.matices.length ? `Matices recogidos por el árbitro:\n- ${run.matices.join('\n- ')}` : '',
    ].filter(Boolean).join('\n\n'),
  });
  run.ganadora = premisa(run, j.ganadora) ? j.ganadora : '';
  run.veredicto = String(j.texto ?? '').trim();
}
