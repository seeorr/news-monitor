/**
 * Las consultas de lectura del dashboard.
 *
 * Viven aquí y no en `app/` por el mismo motivo por el que el alta de la
 * watchlist vive en `watchlist.ts`: el SQL de este proyecto está en un sitio, se
 * prueba con el mismo espía y no se reescribe en cada pantalla que lo necesita.
 * `app/` compone HTML; esto sabe de columnas.
 *
 * Todas reciben el cliente por parámetro —con el de verdad por defecto— para
 * poder mirar la consulta en un test sin una base delante.
 *
 * La lista de columnas se escribe entera en cada consulta y no sale de una
 * constante. No es por gusto: el cliente de Neon escapa **cada hueco de la
 * plantilla como parámetro**, así que un `${COLUMNAS}` no interpolaría SQL sino
 * que mandaría la lista como si fuera un dato. La repetición es el precio de que
 * no haya ningún punto del archivo donde un texto se convierta en consulta.
 *
 * `coalesce(e.importance_score, a.importance_score)` no es defensa contra nada:
 * es que las alertas enviadas **antes** de que `events` tuviera esas columnas
 * guardaron su nota solo en `alerts`. Es el mismo número en el mismo evento, así
 * que leerlo de donde esté es recuperar un dato, no inventarlo. El histórico de
 * alertas es la excepción y lee `a.*` directamente: allí lo que importa es con
 * qué nota se anunció.
 *
 * **Nada de esto se ejecuta en el navegador.** `DATABASE_URL` es un secreto y el
 * driver de Neon es de servidor: quien llame a estas funciones tiene que ser un
 * Server Component o un route handler.
 */
import { neon } from "@neondatabase/serverless";
import type { Ejecutor } from "./cliente.ts";
import { KINDS, SOURCES } from "../schema/event.ts";
// El análisis se lee con el mismo tipo con el que se escribe. Declararlo dos
// veces —una para guardar y otra para leer— es garantizar que un día digan cosas
// distintas y que nadie lo note hasta que una sección de la ficha salga vacía.
import { esAnalisisProfundo, type AnalisisProfundo } from "../pipeline/seen.ts";

export type { AnalisisProfundo };

/**
 * Una fila de `events` tal y como sale de la base, más lo que aporta el join con
 * `alerts`. Los nombres son los de las columnas a propósito: renombrar aquí
 * obligaría a mirar dos sitios para saber de dónde sale un dato.
 */
export interface FilaEvento {
  id: string;
  source: string;
  source_url: string | null;
  kind: string;
  title: string;
  summary: string | null;
  country: string | null;
  series_id: string | null;
  /** Texto, y de precisión mixta: `2026-08-01` en macro, instante ISO en una noticia. */
  observed_at: string;
  /** `timestamptz`: el driver de Neon lo devuelve ya como `Date`, no como texto. */
  first_seen_at: Date;
  actual: number | null;
  previous: number | null;
  consensus: number | null;
  unit: string | null;
  surprise_value: number | null;
  surprise_basis: string | null;
  stale: boolean;
  official: boolean;
  /** Nota del paso 3. Null si el evento nunca se puntuó: no es un cero. */
  importance_score: number | null;
  market_impact_score: number | null;
  sentiment: string | null;
  one_liner: string | null;
  /** Del join con `alerts`: null si el evento no se anunció. */
  sent_at: Date | null;
  deep_analysis: boolean | null;
  body: string | null;
  /**
   * El análisis del paso 4, tal y como lo escribió `saveAlert()`. Es el mismo
   * tipo con el que se guarda —una sola forma de punta a punta— y el driver de
   * Neon devuelve el `jsonb` ya deserializado, así que aquí no se parsea nada.
   *
   * Null por tres motivos distintos y los tres ciertos: el evento no se anunció,
   * se anunció sin llegar al umbral del paso 4, o se anunció antes del 9 de
   * septiembre de 2026, cuando el análisis se formateaba y se tiraba. Todas las
   * alertas del histórico son de ese tercer caso —seis de las ocho llegaron a
   * correr el paso 4— y no se les puede reconstruir sin inventarlo: su prosa
   * sigue entera en `body`, que es lo que hay.
   */
  analysis: AnalisisProfundo | null;
}

export function cliente(databaseUrl: string): Ejecutor {
  return neon(databaseUrl);
}

/**
 * Lo importante: lo más puntuado primero, anunciado o no.
 *
 * `importance_score is not null` no es un detalle de rendimiento —aunque use el
 * índice `events_por_importancia`—: es la regla. Un evento que nunca pasó por el
 * paso 3 no tiene nota, y colarlo aquí lo pondría al final de una lista donde no
 * compite, como si hubiera sacado un cero.
 */
export async function loImportante(
  sql: Ejecutor,
  opts: { limite?: number } = {},
): Promise<FilaEvento[]> {
  return sanear((await sql`
    select
      e.id, e.source, e.source_url, e.kind, e.title, e.summary, e.country, e.series_id,
      e.observed_at, e.first_seen_at,
      e.actual, e.previous, e.consensus, e.unit, e.surprise_value, e.surprise_basis,
      e.stale, e.official,
      coalesce(e.importance_score, a.importance_score)       as importance_score,
      coalesce(e.market_impact_score, a.market_impact_score) as market_impact_score,
      coalesce(e.sentiment, a.sentiment)                     as sentiment,
      e.one_liner,
      a.sent_at, a.deep_analysis, a.body, a.analysis
    from events e left join alerts a on a.event_id = e.id
    where e.importance_score is not null
    order by e.importance_score desc, e.first_seen_at desc
    limit ${techo(opts.limite, 10)}
  `) as FilaEvento[]);
}

export interface FiltrosEventos {
  /** `events.kind`. Vacío = todos. */
  kinds?: string[];
  /** `events.source`. Vacío = todas. */
  sources?: string[];
  /** Solo fuentes primarias (Fed, BCE, SEC, FRED). */
  soloOficiales?: boolean;
  /** Nota mínima del paso 3. Deja fuera lo que nunca se puntuó, y eso se dice en la UI. */
  importanciaMin?: number;
  sentimiento?: string;
  /** Sobre `first_seen_at`, que es timestamptz. **Nunca** sobre `observed_at`, que es texto. */
  desde?: string;
  hasta?: string;
  limite?: number;
  offset?: number;
}

/**
 * Todo lo ingerido, con los filtros que de verdad existen.
 *
 * El orden es cronológico por `first_seen_at`: es la única columna comparable
 * entre un dato macro fechado el 1 de agosto y un titular de hace diez minutos.
 * `observed_at` es texto de precisión mixta y ordenarlo mezclaría los dos.
 *
 * Los filtros vacíos se neutralizan **dentro** del SQL, con un `is null` o un
 * `cardinality(...) = 0`, en vez de componiendo el texto de la consulta según lo
 * que venga. Concatenar un `where` a mano es como se cuela una inyección, y aquí
 * los valores llegan de una URL.
 */
export async function listarEventos(
  sql: Ejecutor,
  filtros: FiltrosEventos = {},
): Promise<FilaEvento[]> {
  const kinds = validos(filtros.kinds, KINDS);
  const sources = validos(filtros.sources, SOURCES);
  const importanciaMin = filtros.importanciaMin ?? null;
  const sentimiento = filtros.sentimiento ?? null;
  const desde = filtros.desde ?? null;
  const hasta = filtros.hasta ?? null;

  return sanear((await sql`
    select
      e.id, e.source, e.source_url, e.kind, e.title, e.summary, e.country, e.series_id,
      e.observed_at, e.first_seen_at,
      e.actual, e.previous, e.consensus, e.unit, e.surprise_value, e.surprise_basis,
      e.stale, e.official,
      coalesce(e.importance_score, a.importance_score)       as importance_score,
      coalesce(e.market_impact_score, a.market_impact_score) as market_impact_score,
      coalesce(e.sentiment, a.sentiment)                     as sentiment,
      e.one_liner,
      a.sent_at, a.deep_analysis, a.body, a.analysis
    from events e left join alerts a on a.event_id = e.id
    where (cardinality(${kinds}::text[]) = 0 or e.kind = any(${kinds}::text[]))
      and (cardinality(${sources}::text[]) = 0 or e.source = any(${sources}::text[]))
      and (${filtros.soloOficiales ?? false}::boolean = false or e.official)
      and (${importanciaMin}::int is null or e.importance_score >= ${importanciaMin}::int)
      and (${sentimiento}::text is null or e.sentiment = ${sentimiento}::text)
      and (${desde}::timestamptz is null or e.first_seen_at >= ${desde}::timestamptz)
      and (${hasta}::timestamptz is null or e.first_seen_at < ${hasta}::timestamptz)
    order by e.first_seen_at desc
    limit ${techo(filtros.limite, 50)} offset ${desplazamiento(filtros.offset)}
  `) as FilaEvento[]);
}

/**
 * El histórico de alertas: lo que de verdad salió a Telegram.
 *
 * Ordena por `sent_at` y no por importancia, porque esta página responde a "qué
 * me ha llegado", no a "qué es lo más grave". Usa el índice `alerts_recientes`.
 */
export async function historialAlertas(
  sql: Ejecutor,
  filtros: {
    importanciaMin?: number;
    desde?: string;
    hasta?: string;
    limite?: number;
    offset?: number;
  } = {},
): Promise<FilaEvento[]> {
  const importanciaMin = filtros.importanciaMin ?? null;
  const desde = filtros.desde ?? null;
  const hasta = filtros.hasta ?? null;

  return sanear((await sql`
    select
      e.id, e.source, e.source_url, e.kind, e.title, e.summary, e.country, e.series_id,
      e.observed_at, e.first_seen_at,
      e.actual, e.previous, e.consensus, e.unit, e.surprise_value, e.surprise_basis,
      e.stale, e.official,
      a.importance_score, a.market_impact_score, a.sentiment, e.one_liner,
      a.sent_at, a.deep_analysis, a.body, a.analysis
    from alerts a join events e on e.id = a.event_id
    where (${importanciaMin}::int is null or a.importance_score >= ${importanciaMin}::int)
      and (${desde}::timestamptz is null or a.sent_at >= ${desde}::timestamptz)
      and (${hasta}::timestamptz is null or a.sent_at < ${hasta}::timestamptz)
    order by a.sent_at desc
    limit ${techo(filtros.limite, 50)} offset ${desplazamiento(filtros.offset)}
  `) as FilaEvento[]);
}

/**
 * La última observación de cada serie macro que se ingiere.
 *
 * `distinct on` es de Postgres y aquí se gana el sitio: la alternativa es una
 * ventana o N consultas. `observed_at` sí ordena bien **dentro** de una serie,
 * que es donde el formato es homogéneo, y hay índice: `events_por_serie`.
 */
export async function ultimasSeries(sql: Ejecutor, seriesIds: string[]): Promise<FilaEvento[]> {
  if (seriesIds.length === 0) return [];
  return sanear((await sql`
    select distinct on (e.series_id)
      e.id, e.source, e.source_url, e.kind, e.title, e.summary, e.country, e.series_id,
      e.observed_at, e.first_seen_at,
      e.actual, e.previous, e.consensus, e.unit, e.surprise_value, e.surprise_basis,
      e.stale, e.official,
      coalesce(e.importance_score, a.importance_score)       as importance_score,
      coalesce(e.market_impact_score, a.market_impact_score) as market_impact_score,
      coalesce(e.sentiment, a.sentiment)                     as sentiment,
      e.one_liner,
      a.sent_at, a.deep_analysis, a.body, a.analysis
    from events e left join alerts a on a.event_id = e.id
    where e.series_id = any(${seriesIds}::text[]) and e.kind = 'macro_release'
    order by e.series_id, e.observed_at desc
  `) as FilaEvento[]);
}

export interface UltimoMovimiento {
  ticker: string;
  observed_at: string;
  actual: number | null;
  unit: string | null;
}

/**
 * El último movimiento de precio que llegó a ser evento, por valor.
 *
 * Es lo que la fila de la watchlist puede enseñar de verdad: los precios de
 * Yahoo se piden en cada ciclo pero **solo se persisten cuando superan el umbral
 * de ese valor**, así que "% de hoy" no existe en la base. Un valor sin
 * movimientos no sale en esta lista, y su fila lo dice en vez de pintar un 0,0 %.
 */
export async function ultimosMovimientos(sql: Ejecutor): Promise<UltimoMovimiento[]> {
  return (await sql`
    select distinct on (e.series_id)
      e.series_id as ticker, e.observed_at, e.actual, e.unit
    from events e
    where e.kind = 'market_move' and e.series_id is not null
    order by e.series_id, e.observed_at desc
  `) as UltimoMovimiento[];
}

export interface Recuento {
  eventos: number;
  puntuados: number;
  alertas: number;
  ultimo: Date | null;
}

/**
 * Los cuatro números de cabecera, en un viaje.
 *
 * Son cuatro agregados sobre dos tablas pequeñas; separarlos serían cuatro
 * viajes por HTTP para nada.
 */
export async function recuento(sql: Ejecutor): Promise<Recuento> {
  const filas = (await sql`
    select
      (select count(*)::int from events) as eventos,
      (select count(*)::int from events where importance_score is not null) as puntuados,
      (select count(*)::int from alerts) as alertas,
      (select max(first_seen_at) from events) as ultimo
  `) as Recuento[];
  return filas[0] ?? { eventos: 0, puntuados: 0, alertas: 0, ultimo: null };
}

/**
 * Deja a null el análisis que no tenga la forma esperada.
 *
 * No es paranoia: el `as FilaEvento[]` de estas consultas es un cast y el `jsonb`
 * no lo valida nadie al volver. Aguas abajo la ficha de detalle entra a los
 * campos sin red, y las tres listas —`/news`, `/alerts` y el Home— pintan el
 * mismo componente, así que **una sola fila mala dejaría las tres en error**, no
 * solo su tarjeta. Un análisis con otra forma no es un análisis: se enseña como
 * lo que es, un hueco.
 *
 * Se hace aquí, en el borde por donde el dato entra en la aplicación, y no en el
 * componente: así una pantalla nueva no tiene que acordarse.
 */
function sanear(filas: FilaEvento[]): FilaEvento[] {
  for (const f of filas) {
    if (f.analysis != null && !esAnalisisProfundo(f.analysis)) f.analysis = null;
  }
  return filas;
}

/** Un límite que llega de una URL no puede pedir la tabla entera. */
function techo(valor: number | undefined, porDefecto: number): number {
  const n = Math.trunc(valor ?? porDefecto);
  if (!Number.isFinite(n) || n <= 0) return porDefecto;
  return Math.min(n, 200);
}

function desplazamiento(valor: number | undefined): number {
  const n = Math.trunc(valor ?? 0);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10_000) : 0;
}

/**
 * Un valor de enum que llega de una URL solo vale si está en el enum.
 *
 * Lo que no está se descarta, y si no queda ninguno el filtro se comporta como
 * si no se hubiera pedido. Es deliberado: la fila de filtros solo ofrece valores
 * válidos, así que un `?kind=cualquier-cosa` es una URL trasteada a mano y
 * enseñarlo todo se entiende mejor que una lista vacía sin motivo aparente.
 */
function validos(valores: string[] | undefined, permitidos: readonly string[]): string[] {
  if (!valores || valores.length === 0) return [];
  return valores.filter((v) => permitidos.includes(v));
}

export interface ActividadFuente {
  source: string;
  eventos: number;
  ultimo: Date;
}

/**
 * Cuánto ha entrado por cada fuente en una ventana reciente.
 *
 * **No es un registro de ejecuciones**: no existe tal cosa, solo los logs de
 * GitHub Actions (hueco G7). Esto es un indicio de vida —si el cron respira, algo
 * ha entrado— y la pantalla lo etiqueta con esas palabras y no con otras. Usa el
 * índice `events_por_fuente`.
 */
export async function actividadPorFuente(
  sql: Ejecutor,
  horas = 24,
): Promise<ActividadFuente[]> {
  const desde = new Date(Date.now() - Math.max(1, horas) * 3_600_000).toISOString();
  return (await sql`
    select e.source, count(*)::int as eventos, max(e.first_seen_at) as ultimo
    from events e
    where e.first_seen_at >= ${desde}::timestamptz
    group by e.source
    order by eventos desc
  `) as ActividadFuente[];
}
