/**
 * La watchlist: qué se vigila y con qué sensibilidad.
 *
 * Vive en Neon y no en el repositorio porque el repositorio es público y esta
 * lista dice en qué invierte su dueño. Las variables de entorno siguen valiendo
 * como respaldo —para desarrollo, o para el día en que la base no responda—,
 * pero mandan las filas de la tabla.
 */
import { neon } from "@neondatabase/serverless";

export interface Vigilado {
  ticker: string;
  nombre: string | null;
  cik: string | null;
  /** Símbolo en Yahoo cuando no coincide con el ticker (EUNL.DE). */
  quoteSymbol: string | null;
  vigilarFilings: boolean;
  vigilarPrecio: boolean;
  /** Movimiento diario, en %, a partir del cual la sesión merece un aviso. */
  umbralMovimiento: number;
}

/**
 * Un cliente SQL ya abierto, que es lo que devuelve `neon()`.
 *
 * Existe para poder mirar la consulta del alta en un test sin una base delante:
 * su `on conflict` decide qué se conserva de una fila que ya estaba, y eso es
 * justo lo que no puede comprobarse leyendo el código y confiando.
 */
export type Ejecutor = (strings: TemplateStringsArray, ...valores: unknown[]) => Promise<unknown>;

interface Fila {
  ticker: string;
  nombre: string | null;
  cik: string | null;
  quote_symbol: string | null;
  vigilar_filings: boolean;
  vigilar_precio: boolean;
  umbral_movimiento: number;
}

export async function leerWatchlist(databaseUrl: string): Promise<Vigilado[]> {
  const sql = neon(databaseUrl);
  const filas = (await sql`
    select ticker, nombre, cik, quote_symbol, vigilar_filings, vigilar_precio, umbral_movimiento
    from watchlist order by ticker
  `) as Fila[];
  return filas.map(deFila);
}

export async function anadir(
  databaseUrl: string,
  entrada: { ticker: string; nombre?: string | null; cik?: string | null; quoteSymbol?: string | null; umbral?: number },
  sql: Ejecutor = neon(databaseUrl),
): Promise<void> {
  // `on conflict do update` y no `do nothing`: volver a añadir un ticker con más
  // datos —el CIK ya resuelto, por ejemplo— tiene que completar la fila, no
  // ignorarse en silencio.
  //
  // Y completar es exactamente eso: **ningún campo que llegue vacío pisa lo que
  // ya había**. El umbral era la excepción y era un fallo silencioso: se
  // escribía `excluded.umbral_movimiento`, que con un alta sin `--umbral` vale
  // el 3 por defecto, así que reañadir un valor para rellenarle el nombre le
  // borraba el umbral que alguien había pensado. Por eso el umbral entra dos
  // veces en la consulta: el valor por defecto solo vale para una fila nueva.
  const umbral = entrada.umbral ?? null;
  await sql`
    insert into watchlist (ticker, nombre, cik, quote_symbol, umbral_movimiento)
    values (
      ${entrada.ticker.toUpperCase()}, ${entrada.nombre ?? null}, ${entrada.cik ?? null},
      ${entrada.quoteSymbol ?? null}, coalesce(${umbral}::double precision, 3)
    )
    on conflict (ticker) do update set
      nombre = coalesce(excluded.nombre, watchlist.nombre),
      cik = coalesce(excluded.cik, watchlist.cik),
      quote_symbol = coalesce(excluded.quote_symbol, watchlist.quote_symbol),
      umbral_movimiento = coalesce(${umbral}::double precision, watchlist.umbral_movimiento)
  `;
}

export async function quitar(databaseUrl: string, ticker: string): Promise<boolean> {
  const sql = neon(databaseUrl);
  const filas = await sql`delete from watchlist where ticker = ${ticker.toUpperCase()} returning ticker`;
  return filas.length > 0;
}

/**
 * La watchlist efectiva: la tabla, y si no hay base de datos, las variables de
 * entorno. Nunca las dos mezcladas a medias — un ticker que está en la tabla y
 * en el entorno con umbrales distintos tendría dos verdades, y la de la tabla es
 * la que alguien ha decidido a mano.
 */
export function desdeEntorno(tickers: string[], secTickers: string[]): Vigilado[] {
  const todos = new Set([...tickers, ...secTickers].map((t) => t.toUpperCase()));
  return [...todos].map((ticker) => ({
    ticker,
    nombre: null,
    cik: null,
    quoteSymbol: null,
    vigilarFilings: secTickers.map((t) => t.toUpperCase()).includes(ticker),
    vigilarPrecio: true,
    umbralMovimiento: 3,
  }));
}

function deFila(f: Fila): Vigilado {
  return {
    ticker: f.ticker,
    nombre: f.nombre,
    cik: f.cik,
    quoteSymbol: f.quote_symbol,
    vigilarFilings: f.vigilar_filings,
    vigilarPrecio: f.vigilar_precio,
    umbralMovimiento: Number(f.umbral_movimiento),
  };
}
