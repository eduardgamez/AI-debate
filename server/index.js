// Servidor local: sirve la web y dirige las competiciones. Solo escucha en este ordenador.
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { limites, sesion } from './claude.js';
import { competir, fijarCombinaciones, generarPremisas } from './engine.js';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATOS = process.env.AI_DEBATE_DATA || join(RAIZ, 'data');
const PUERTO = Number(process.env.PORT) || 4747;
mkdirSync(DATOS, { recursive: true });

const MODELOS = ['opus', 'sonnet', 'haiku'];
const ESFUERZOS = ['auto', 'low', 'medium', 'high'];
const EN_MARCHA = ['generando', 'compitiendo', 'veredicto'];

const runs = new Map(); // id -> competición
const vivos = new Map(); // id -> { ctrl, oyentes } (lo que no se guarda en disco)

for (const archivo of readdirSync(DATOS).filter((f) => f.endsWith('.json'))) {
  try {
    const run = JSON.parse(readFileSync(join(DATOS, archivo), 'utf8'));
    if (EN_MARCHA.includes(run.estado)) { run.estado = 'detenido'; run.actividad = ''; }
    runs.set(run.id, run);
  } catch { /* archivo dañado: se ignora */ }
}

let estadoSesion = null;
const vivo = (id) => { if (!vivos.has(id)) vivos.set(id, { ctrl: null, oyentes: new Set() }); return vivos.get(id); };
const guardar = (run) => writeFileSync(join(DATOS, `${run.id}.json`), JSON.stringify(run));
const paquete = (run) => `data: ${JSON.stringify({ run, limites })}\n\n`;
function emitir(run) {
  guardar(run);
  for (const res of vivo(run.id).oyentes) res.write(paquete(run));
}

// Lanza una fase larga en segundo plano y deja el estado coherente si falla o se detiene.
function lanzar(run, fase) {
  const v = vivo(run.id);
  v.ctrl = new AbortController();
  const ctrl = v.ctrl;
  const ctx = { signal: ctrl.signal, emit: () => emitir(run) };
  fase(run, ctx).catch((error) => {
    const detenido = ctrl.signal.aborted && run.estado !== 'error';
    ctrl.abort(); // corta las demás instancias que sigan trabajando
    run.estado = detenido && error.message === 'Detenido' ? 'detenido' : 'error';
    run.error = run.estado === 'error' ? error.message : '';
    run.actividad = '';
    emitir(run);
  }).finally(() => { if (v.ctrl === ctrl) v.ctrl = null; });
}

function leerCuerpo(req) {
  return new Promise((resolve, reject) => {
    let datos = '';
    req.on('data', (t) => { datos += t; if (datos.length > 2_000_000) reject(new Error('Demasiado texto.')); });
    req.on('end', () => { try { resolve(datos ? JSON.parse(datos) : {}); } catch { reject(new Error('Petición no válida.')); } });
    req.on('error', reject);
  });
}
const json = (res, codigo, cuerpo) => { res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(cuerpo)); };

const servidor = http.createServer(async (req, res) => {
  try {
    // Ninguna otra web abierta en el navegador puede gastar la suscripción desde aquí.
    const host = String(req.headers.host ?? '').split(':')[0];
    if (!['localhost', '127.0.0.1'].includes(host)) return json(res, 403, { error: 'Solo local.' });
    if (req.method !== 'GET' && !String(req.headers['content-type'] ?? '').startsWith('application/json')) return json(res, 415, { error: 'Formato no admitido.' });

    const url = new URL(req.url, 'http://localhost');
    const partes = url.pathname.split('/').filter(Boolean);

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(readFileSync(join(RAIZ, 'public', 'index.html')));
    }
    if (partes[0] !== 'api') return json(res, 404, { error: 'No existe.' });

    if (req.method === 'GET' && partes[1] === 'inicio') {
      const lista = [...runs.values()].sort((a, b) => b.creado - a.creado).map((r) => ({ id: r.id, modo: r.modo, titulo: r.titulo, estado: r.estado }));
      if (!estadoSesion?.ok) estadoSesion = sesion(); // se comprueba una vez; solo se repite si no había sesión
      return json(res, 200, { lista, limites, sesion: estadoSesion });
    }

    if (req.method === 'POST' && partes[1] === 'runs' && partes.length === 2) {
      const c = await leerCuerpo(req);
      const modo = c.modo === 'historia' ? 'historia' : 'debate';
      const pregunta = String(c.pregunta ?? '').trim();
      const historia = String(c.historia ?? '').trim();
      if (modo === 'debate' && !pregunta) return json(res, 400, { error: 'Escribe qué quieres debatir.' });
      if (modo === 'historia' && !historia) return json(res, 400, { error: 'Pega la historia.' });
      const run = {
        id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, creado: Date.now(), modo, pregunta, historia, escenas: [],
        titulo: (pregunta || historia).replace(/\s+/g, ' ').slice(0, 70),
        config: {
          modelo: MODELOS.includes(c.modelo) ? c.modelo : 'opus',
          esfuerzo: ESFUERZOS.includes(c.esfuerzo) ? c.esfuerzo : 'low',
          final: ['medium', 'high'].includes(c.final) ? c.final : '', // '' = igual que el resto
          corte: [0.25, 1 / 3, 0.5].includes(c.corte) ? c.corte : 0.25,
          intercambios: [1, 2, 3, 4].includes(c.intercambios) ? c.intercambios : 3,
          ias: Number.isInteger(c.ias) ? Math.min(20, Math.max(2, c.ias)) : 8, // modo historia: IA a la vez
          palabras: [150, 250, 400].includes(c.palabras) ? c.palabras : 250, // modo historia: largo de cada fragmento
          generadorModelo: MODELOS.includes(c.generadorModelo) ? c.generadorModelo : (MODELOS.includes(c.modelo) ? c.modelo : 'opus'),
          generadorEsfuerzo: ['low', 'medium', 'high'].includes(c.generadorEsfuerzo) ? c.generadorEsfuerzo : 'medium',
          arbitro: MODELOS.includes(c.arbitro) ? c.arbitro : 'sonnet',
          arbitroEsfuerzo: ['low', 'medium', 'high'].includes(c.arbitroEsfuerzo) ? c.arbitroEsfuerzo : 'high',
          web: c.web === true,
        },
        estado: 'generando', actividad: '', error: '', idioma: '', sabido: [], huecos: [], premisas: [], rondas: [], matices: [], ganadora: '', veredicto: '',
        uso: { llamadas: 0, entrada: 0, salida: 0, coste: 0, busquedas: 0 },
      };
      runs.set(run.id, run);
      guardar(run);
      lanzar(run, generarPremisas);
      return json(res, 200, { id: run.id });
    }

    const run = runs.get(partes[2]);
    if (partes[1] !== 'runs' || !run) return json(res, 404, { error: 'No existe.' });
    const accion = partes[3];

    if (req.method === 'GET' && accion === 'eventos') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(paquete(run));
      const { oyentes } = vivo(run.id);
      oyentes.add(res);
      req.on('close', () => oyentes.delete(res));
      return;
    }
    if (req.method === 'POST' && accion === 'empezar') {
      if (run.estado !== 'revision') return json(res, 409, { error: 'Ya ha empezado.' });
      const c = await leerCuerpo(req);
      const anteriores = run.premisas;
      const error = fijarCombinaciones(run, c.premisas);
      if (error) { run.premisas = anteriores; return json(res, 400, { error }); }
      lanzar(run, competir);
      return json(res, 200, {});
    }
    if (req.method === 'POST' && accion === 'detener') {
      vivo(run.id).ctrl?.abort();
      return json(res, 200, {});
    }
    if (req.method === 'POST' && accion === 'continuar') {
      if (!['detenido', 'error'].includes(run.estado) || vivo(run.id).ctrl) return json(res, 409, { error: 'No se puede continuar ahora.' });
      lanzar(run, run.premisas.length ? competir : generarPremisas);
      return json(res, 200, {});
    }
    if (req.method === 'DELETE' && !accion) {
      vivo(run.id).ctrl?.abort();
      runs.delete(run.id);
      rmSync(join(DATOS, `${run.id}.json`), { force: true });
      return json(res, 200, {});
    }
    return json(res, 404, { error: 'No existe.' });
  } catch (error) {
    if (!res.headersSent) json(res, 500, { error: error.message });
  }
});

servidor.listen(PUERTO, '127.0.0.1', () => {
  const direccion = `http://localhost:${PUERTO}`;
  console.log(`AI-debate en marcha: ${direccion}`);
  if (process.argv.includes('--abrir')) spawn('open', [direccion], { stdio: 'ignore' }).on('error', () => {});
});
