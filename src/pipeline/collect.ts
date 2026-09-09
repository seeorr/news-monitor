/**
 * Recolección: todas las fuentes, un solo montón de eventos normalizados.
 *
 * La regla que gobierna este archivo es que **una fuente caída no puede tumbar
 * el ciclo**. Si el BCE no responde, se sigue con el resto y se dice cuál falló:
 * un monitor que se calla porque un feed dio 503 es exactamente el fallo que
 * este proyecto existe para no tener.
 *
 * Aguas abajo de aquí nadie pregunta de qué fuente viene un evento.
 */
import type { Config } from "../config.ts";
import { desdeEntorno, leerWatchlist, type Vigilado } from "../db/watchlist.ts";
import { applyTransform, fetchObservations, SERIES, toEvent } from "../sources/fred.ts";
import { FEEDS, fetchFeed, toEvents as feedEvents } from "../sources/rss.ts";
import { fetchCotizacion, toEvent as movimientoEvent } from "../sources/mercado.ts";
import {
  fetchFilings,
  resolveTickers,
  toEvents as filingEvents,
  type Company,
} from "../sources/sec-edgar.ts";
import { HttpError } from "../lib/http.ts";
import type { NormalizedEvent } from "../schema/event.ts";

export interface SourceFailure {
  source: string;
  detail: string;
}

export interface Collected {
  events: NormalizedEvent[];
  failures: SourceFailure[];
  /** Fuentes que respondieron. Cero con fallos = el ciclo no ha visto nada. */
  ok: number;
  /** La watchlist que se ha usado de verdad, para que el filtro por reglas use la misma. */
  vigilados: Vigilado[];
}

interface Task {
  name: string;
  run: () => Promise<NormalizedEvent[]>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * La watchlist que manda.
 *
 * La tabla de Neon primero: es donde alguien la ha editado a mano y donde cada
 * valor lleva su propio umbral. Las variables de entorno quedan de respaldo para
 * desarrollo y para el día en que la base no conteste; que la lista esté vacía
 * no es un error, solo significa que aún no se vigila ninguna empresa.
 */
export async function watchlistEfectiva(
  config: Config,
  log: (...a: unknown[]) => void = () => {},
): Promise<Vigilado[]> {
  if (config.databaseUrl) {
    try {
      const filas = await leerWatchlist(config.databaseUrl);
      if (filas.length > 0) return filas;
      log("· Watchlist vacía en Neon: se usa la del entorno, si la hay.");
    } catch (err) {
      log(`· No se pudo leer la watchlist de Neon (${String(err)}). Se usa la del entorno.`);
    }
  }
  return desdeEntorno(config.watchlist, config.secWatchlist);
}

/**
 * Envuelve el log para que ningun ticker de la watchlist salga en claro. Se
 * numeran las tareas de precios en vez de nombrarlas, pero los mensajes de
 * error los compone cada fuente y no hay forma de auditarlos uno a uno: esta
 * red se pone al final, donde el texto ya esta formado.
 *
 * En local, con la watchlist a la vista en Neon, se pierde poco: el numero de
 * tarea basta para saber cual fallo mirando el orden de `vigilados`.
 *
 * Se exporta porque **la red tiene que estar en el borde de salida del proceso,
 * no dentro de una funcion**. Puesta solo aqui cubria la ingesta y dejaba fuera
 * todo lo que `main.ts` imprime despues: el titular de cada evento y el cuerpo
 * entero de la alerta. Y los titulos de precios y de documentos llevan el ticker
 * dentro por construccion —"ACME +4,20 % en la sesion", "ACME · 8-K"—, asi que
 * la primera sesion que superara un umbral habria publicado el valor en un log
 * que cualquiera puede leer.
 */
export function taparTickers(
  log: (...a: unknown[]) => void,
  vigilados: Vigilado[],
): (...a: unknown[]) => void {
  const simbolos = vigilados
    .flatMap((v) => [v.ticker, v.quoteSymbol])
    .filter((s): s is string => Boolean(s));
  if (simbolos.length === 0) return log;

  const escapado = simbolos.map((s) => s.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&"));
  const re = new RegExp(`\\b(?:${escapado.join("|")})\\b`, "gi");
  return (...a: unknown[]) =>
    log(...a.map((x) => (typeof x === "string" ? x.replace(re, "•••") : x)));
}

export async function collectEvents(
  config: Config,
  opts: { retrievedAt: string; log?: (...a: unknown[]) => void },
): Promise<Collected> {
  const logCrudo = opts.log ?? (() => {});
  const retrievedAt = opts.retrievedAt;
  const vigilados = await watchlistEfectiva(config, logCrudo);
  // El repositorio es publico y los logs de Actions tambien: cualquiera puede
  // leer la salida de cada ciclo. Los errores de Yahoo y de EDGAR llevan el
  // simbolo dentro del mensaje, asi que sin tapar esto la watchlist se
  // publicaria sola cada media hora — justo el dato que vive en Neon para
  // no estar aqui. Se tapa en la salida y no fuente por fuente, para que una
  // fuente nueva no tenga que acordarse.
  const log = taparTickers(logCrudo, vigilados);
  const tasks: Task[] = [];

  // ── FRED ───────────────────────────────────────────────────────────────────
  if (config.fredApiKey) {
    for (const spec of Object.values(SERIES)) {
      tasks.push({
        name: `fred:${spec.id}`,
        run: async () => {
          const raw = await fetchObservations(spec, config.fredApiKey!);
          const series = applyTransform(raw, spec);
          return [toEvent(series, spec, { retrievedAt })];
        },
      });
    }
  }

  // ── Feeds ──────────────────────────────────────────────────────────────────
  const elegidos = config.feeds.length > 0 ? config.feeds : Object.keys(FEEDS);
  for (const id of elegidos) {
    const spec = FEEDS[id];
    if (!spec) {
      log(`· Feed "${id}" no está en el registro: se ignora.`);
      continue;
    }
    tasks.push({
      name: `rss:${spec.id}`,
      run: async () => feedEvents(await fetchFeed(spec), spec, { retrievedAt }),
    });
  }

  // ── SEC EDGAR ──────────────────────────────────────────────────────────────
  // Dos condiciones, y las dos se explican en voz alta si no se cumplen: sin
  // contacto la SEC responde 403, y sin watchlist no hay a quién vigilar.
  const conFilings = vigilados.filter((v) => v.vigilarFilings);
  if (conFilings.length > 0 && config.secUserAgent) {
    tasks.push({
      name: "sec-edgar",
      run: async () => {
        const ua = config.secUserAgent!;
        const companies = await resolverEmpresas(conFilings, ua, log);
        const eventos: NormalizedEvent[] = [];
        for (const company of companies) {
          const filings = await fetchFilings(company, ua);
          eventos.push(
            ...filingEvents(filings, company, {
              retrievedAt,
              forms: config.edgarForms.length > 0 ? config.edgarForms : undefined,
            }),
          );
          await sleep(150); // La SEC pide como mucho 10 peticiones por segundo.
        }
        return eventos;
      },
    });
  } else if (conFilings.length > 0) {
    log("· SEC EDGAR: hay watchlist pero falta SEC_USER_AGENT. Se salta la fuente.");
  }

  // ── Precios ────────────────────────────────────────────────────────────────
  // Una tarea por valor y no una sola: si Yahoo se atraganta con un símbolo, se
  // pierde ese y no la cartera entera.
  const conPrecio = vigilados.filter((x) => x.vigilarPrecio);
  for (const [i, v] of conPrecio.entries()) {
    const symbol = v.quoteSymbol ?? v.ticker;
    tasks.push({
      // Numerada, no nombrada: el log es publico. Ver `taparTickers`.
      name: `yahoo:#${i + 1}`,
      run: async () => {
        const c = await fetchCotizacion(symbol);
        const evento = movimientoEvent(c, {
          ticker: v.ticker,
          nombre: v.nombre,
          umbral: v.umbralMovimiento,
          retrievedAt,
        });
        return evento ? [evento] : [];
      },
    });
  }

  // ── Ejecución ──────────────────────────────────────────────────────────────
  const events: NormalizedEvent[] = [];
  const failures: SourceFailure[] = [];
  let ok = 0;

  for (const task of tasks) {
    try {
      const nuevos = await task.run();
      events.push(...nuevos);
      ok++;
      log(`✓ ${task.name}: ${nuevos.length} evento(s)`);
    } catch (err) {
      const detail = err instanceof HttpError ? `${err.message} — ${err.body}` : String(err);
      failures.push({ source: task.name, detail });
      log(`✕ ${task.name} falló: ${detail}`);
    }
  }

  return { events, failures, ok, vigilados };
}

/**
 * Empresas listas para EDGAR.
 *
 * El CIK guardado en la watchlist se usa tal cual; solo se pregunta a la SEC por
 * los que no lo tienen. Así una lista ya resuelta no descarga el mapa completo
 * de tickers en cada ciclo.
 */
async function resolverEmpresas(
  vigilados: Vigilado[],
  userAgent: string,
  log: (...a: unknown[]) => void,
): Promise<Company[]> {
  const listas: Company[] = vigilados
    .filter((v) => v.cik)
    .map((v) => ({ cik: v.cik!, ticker: v.ticker, name: v.nombre }));

  const pendientes = vigilados.filter((v) => !v.cik).map((v) => v.ticker);
  if (pendientes.length === 0) return listas;

  const { companies, unknown } = await resolveTickers(pendientes, userAgent);
  if (unknown.length > 0) {
    log(`· Tickers que la SEC no reconoce: ${unknown.join(", ")}. Se ignoran.`);
  }
  return [...listas, ...companies];
}

/**
 * Eventos lo bastante recientes como para merecer una mirada.
 *
 * Un feed no publica solo lo de hoy: trae su historial. Sin este corte, la
 * primera ejecución puntuaría treinta noticias de hace tres semanas y las
 * anunciaría como novedades.
 *
 * El corte solo vale donde `observed_at` es el momento de publicación —una
 * noticia, un documento de la SEC—. En un dato macro `observed_at` es el periodo
 * al que se refiere: el IPC de agosto lleva fecha del 1 de agosto y se publica a
 * mediados de septiembre. Aplicarle este filtro lo tiraría siempre, que es justo
 * el dato por el que existe el monitor. Ahí la novedad la decide el registro de
 * vistos, no el calendario.
 */
const FECHADOS_AL_PUBLICAR = new Set(["news", "filing"]);

export function recientes(
  events: NormalizedEvent[],
  opts: { now: Date; maxAgeHours: number },
): NormalizedEvent[] {
  const limite = opts.now.getTime() - opts.maxAgeHours * 3600_000;
  return events.filter((e) => {
    if (!FECHADOS_AL_PUBLICAR.has(e.kind)) return true;
    const t = Date.parse(e.observed_at);
    if (!Number.isFinite(t)) return true; // Sin fecha interpretable, que decida el scoring.
    return t >= limite;
  });
}

/** Lo más nuevo primero: si el techo del ciclo corta, que corte por lo viejo. */
export function porFecha(events: NormalizedEvent[]): NormalizedEvent[] {
  return [...events].sort((a, b) => Date.parse(b.observed_at) - Date.parse(a.observed_at));
}
