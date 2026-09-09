/**
 * La watchlist: qué se vigila y con qué sensibilidad.
 *
 * Vive en Neon y no en el repositorio porque el repositorio es público y esta
 * lista dice en qué invierte su dueño. Las variables de entorno siguen valiendo
 * como respaldo —para desarrollo, o para el día en que la base no responda—,
 * pero mandan las filas de la tabla.
 */
import { neon } from "@neondatabase/serverless";
import type { Ejecutor } from "./cliente.ts";

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
 * justo lo que no puede comprobarse leyendo el código y confiando. Se declara
 * una sola vez, en `cliente.ts`, y se reexporta aquí para no partir en dos el
 * mismo tipo el día que cambie.
 */
export type { Ejecutor } from "./cliente.ts";

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

/**
 * Cambia lo que se puede cambiar de una fila que ya existe.
 *
 * Es un `update` de columnas y **no un alta repetida**, que es la forma
 * equivocada de editar aquí: un `insert ... on conflict` que no traiga un campo
 * lo deja como estaba —bien— pero obliga a mandar la fila entera para tocar un
 * solo valor, y ese es justo el camino por el que el umbral se perdía.
 *
 * Cada campo lleva su `coalesce`: lo que no llega, no se toca. Devuelve si la
 * fila existía, para poder distinguir "cambiado" de "ese ticker no está".
 */
export async function actualizar(
  databaseUrl: string,
  ticker: string,
  cambios: { umbral?: number | null; vigilarFilings?: boolean | null; vigilarPrecio?: boolean | null },
  sql: Ejecutor = neon(databaseUrl),
): Promise<boolean> {
  const filas = (await sql`
    update watchlist set
      umbral_movimiento = coalesce(${cambios.umbral ?? null}::double precision, umbral_movimiento),
      vigilar_filings   = coalesce(${cambios.vigilarFilings ?? null}::boolean, vigilar_filings),
      vigilar_precio    = coalesce(${cambios.vigilarPrecio ?? null}::boolean, vigilar_precio)
    where ticker = ${ticker.toUpperCase()}
    returning ticker
  `) as unknown[];
  return filas.length > 0;
}
