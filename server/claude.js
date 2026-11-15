// Llama al CLI oficial de Claude Code con la suscripción ya iniciada (nunca con la API de pago).
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

function bin() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const enPath = spawnSync('which', ['claude'], { encoding: 'utf8' });
  if (enPath.status === 0 && enPath.stdout.trim()) return enPath.stdout.trim();
  for (const ruta of [join(homedir(), '.local', 'bin', 'claude'), join(homedir(), '.claude', 'local', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) {
    if (existsSync(ruta)) return ruta;
  }
  return 'claude';
}
const BIN = bin();

// Una clave de API heredada cambiaría en silencio a facturación por API; una sesión de
// Claude Code padre tampoco debe colarse.
function entorno() {
  const env = { ...process.env };
  for (const nombre of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete env[nombre];
  return env;
}

export function sesion() {
  const r = spawnSync(BIN, ['auth', 'status'], { encoding: 'utf8', timeout: 8000, env: entorno() });
  try {
    const s = JSON.parse(r.stdout);
    return { ok: s.loggedIn === true && s.authMethod === 'claude.ai', plan: s.subscriptionType || '' };
  } catch { return { ok: false, plan: '' }; }
}

// Carpeta vacía: las instancias no ven ningún proyecto.
const CARPETA = join(tmpdir(), 'ai-debate-cli');
mkdirSync(CARPETA, { recursive: true });

// Estado de los límites de la suscripción, tal como lo va contando el CLI.
export const limites = {};

const MAX_A_LA_VEZ = 3;
let activas = 0;
const cola = [];
const esperarHueco = () => (activas < MAX_A_LA_VEZ ? (activas++, Promise.resolve()) : new Promise((r) => cola.push(r)));
const soltarHueco = () => { const siguiente = cola.shift(); if (siguiente) siguiente(); else activas--; };

export async function preguntar(o) {
  await esperarHueco();
  try { return await ejecutar(o); } finally { soltarHueco(); }
}

function ejecutar({ system, prompt, modelo, esfuerzo, web = false, signal, uso, alBuscar }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Detenido'));
    const args = [
      '-p', '--output-format', 'stream-json', '--verbose',
      '--model', modelo, '--effort', esfuerzo, '--system-prompt', system,
      // Sin herramientas: la búsqueda web es la única opcional.
      '--tools', web ? 'WebSearch' : '', ...(web ? ['--allowedTools', 'WebSearch'] : []),
      '--strict-mcp-config', '--setting-sources', '', '--no-session-persistence', '--disable-slash-commands',
    ];
    const hijo = spawn(BIN, args, { cwd: CARPETA, stdio: ['pipe', 'pipe', 'pipe'], env: entorno() });
    let errores = '';
    let hecho = false;
    let reloj;
    const abortar = () => terminar(new Error('Detenido'));
    function terminar(error, texto) {
      if (hecho) return;
      hecho = true;
      clearTimeout(reloj);
      signal?.removeEventListener('abort', abortar);
      hijo.kill();
      if (error) reject(error); else resolve(texto);
    }
    const reiniciarReloj = () => {
      clearTimeout(reloj);
      reloj = setTimeout(() => terminar(new Error('Claude lleva demasiado tiempo sin responder.')), 300_000);
    };
    reiniciarReloj();
    signal?.addEventListener('abort', abortar);

    createInterface({ input: hijo.stdout }).on('line', (linea) => {
      let ev;
      try { ev = JSON.parse(linea); } catch { return; }
      reiniciarReloj();
      if (ev.type === 'rate_limit_event' && ev.rate_limit_info?.rateLimitType) {
        const i = ev.rate_limit_info;
        limites[i.rateLimitType] = { estado: i.status, reinicia: i.resetsAt, uso: i.utilization ?? null };
        // Límite agotado: se para ya (en vez de quedarse esperando) y nunca se pasa a uso extra de pago.
        if (i.status === 'rejected' || i.isUsingOverage) {
          const hora = i.resetsAt ? new Date(i.resetsAt * 1000).toLocaleString('es', { weekday: 'long', hour: '2-digit', minute: '2-digit' }) : '';
          const cual = i.rateLimitType === 'five_hour' ? 'de 5 horas' : 'semanal';
          return terminar(new Error(`Se ha agotado el límite ${cual} de la suscripción.${hora ? ` Se renueva el ${hora}.` : ''} Pulsa «Continuar» entonces.`));
        }
      }
      if (ev.type === 'assistant') {
        for (const parte of ev.message?.content ?? []) {
          if (parte.type === 'tool_use' && parte.name === 'WebSearch') alBuscar?.(String(parte.input?.query ?? ''));
        }
      }
      if (ev.type === 'result') {
        if (uso) {
          const u = ev.usage ?? {};
          uso.llamadas += 1;
          uso.entrada += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          uso.salida += u.output_tokens ?? 0;
          uso.coste += ev.total_cost_usd ?? 0;
          uso.busquedas += u.server_tool_use?.web_search_requests ?? 0;
        }
        const texto = typeof ev.result === 'string' ? ev.result.trim() : '';
        if (ev.is_error || ev.subtype !== 'success') terminar(new Error(texto || 'Claude no pudo completar la petición.'));
        else if (!texto) terminar(new Error('Claude devolvió una respuesta vacía.'));
        else terminar(null, texto);
      }
    });
    hijo.stderr.on('data', (trozo) => { errores = (errores + trozo).slice(-600); });
    hijo.on('error', () => terminar(new Error('No se pudo arrancar Claude Code en este ordenador.')));
    hijo.on('exit', (codigo) => terminar(new Error(errores.trim() || `Claude Code se cerró de forma inesperada (${codigo ?? '?'}).`)));
    hijo.stdin.on('error', () => {});
    hijo.stdin.end(prompt);
  });
}

function extraerJSON(texto) {
  const inicio = texto.indexOf('{');
  const fin = texto.lastIndexOf('}');
  if (inicio < 0 || fin <= inicio) throw new Error('sin JSON');
  return JSON.parse(texto.slice(inicio, fin + 1));
}

// Pide una respuesta en JSON; si llega mal formada, lo reintenta una vez.
export async function preguntarJSON(o) {
  const texto = await preguntar(o);
  try { return extraerJSON(texto); } catch { /* reintento */ }
  const otra = await preguntar({ ...o, prompt: `${o.prompt}\n\nIMPORTANTE: responde únicamente con el objeto JSON válido, sin texto antes ni después.` });
  try { return extraerJSON(otra); } catch { throw new Error('Una instancia no devolvió una respuesta con el formato esperado.'); }
}
