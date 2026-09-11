/**
 * Lo que llega por la URL, convertido a algo con lo que se pueda consultar.
 *
 * Nada de esto confía en el valor: los enums se validan otra vez en
 * `src/db/lectura.ts` —que es donde de verdad importa— y aquí solo se traduce.
 * Una fecha `desde` se toma como el principio de ese día en UTC y una `hasta`
 * como el principio del **siguiente**, para que "hasta el 9" incluya el día 9
 * entero; la consulta usa `<`, no `<=`.
 *
 * La regla de esta casa, que costó un 500 aprenderla: **una página de servidor
 * que lanza no devuelve un filtro vacío, devuelve un error**. Cada función de
 * aquí tiene que aguantar cualquier cosa que escriba quien quiera en la barra
 * de direcciones y contestar con un valor o con `undefined`, nunca lanzando.
 */
export type Parametros = Record<string, string | string[] | undefined>;

/**
 * Nada de la URL se lee más largo que esto.
 *
 * No es por la base —los valores viajan como parámetros y `lectura.ts` valida
 * los enums—, sino porque un valor de la URL se **refleja** en la pantalla de
 * filtros, y cien mil caracteres en un filtro no son una búsqueda: son una
 * forma de estropear la página a quien le manden el enlace. Por encima del
 * tope, el valor se trata como si no estuviera.
 */
export const LIMITE_TEXTO = 200;

/** Tope de paginación: 200 × 50 se queda justo debajo del techo de `lectura.ts`. */
export const PAGINA_MAXIMA = 200;

export function texto(p: Parametros, clave: string): string {
  const v = p[clave];
  // Una clave repetida —`?kind=news&kind=filing`— se queda con la primera y con
  // una sola: los filtros de `lectura.ts` aceptan un valor, y elegir en silencio
  // la última sería contestar a una pregunta distinta de la que se ve escrita.
  const s = Array.isArray(v) ? v[0] : v;
  if (typeof s !== "string") return "";
  const limpio = s.trim();
  return limpio.length > LIMITE_TEXTO ? "" : limpio;
}

export function numero(p: Parametros, clave: string): number | undefined {
  const s = texto(p, clave);
  if (s === "") return undefined;
  const n = Number(s);
  // `Number.isFinite` deja pasar dos cosas que no deberían llegar a una
  // consulta: `-0`, que es finito y se imprime "0" en la URL pero no es `0`
  // para `Object.is` ni para quien compare después; y cualquier magnitud por
  // encima del entero seguro, donde la aritmética ya no distingue dos valores
  // contiguos. Fuera los dos.
  if (!Number.isFinite(n) || Math.abs(n) > Number.MAX_SAFE_INTEGER) return undefined;
  return n === 0 ? 0 : n;
}

export function activo(p: Parametros, clave: string): boolean {
  return texto(p, clave) === "1";
}

/**
 * `AAAA-MM-DD` → el principio de ese día en UTC, o nada.
 *
 * Existe porque la comprobación anterior era una expresión regular, y una
 * expresión regular comprueba la **forma**, no que el día exista: `2026-13-45`
 * la pasaba entera. Después `new Date("2026-13-45T00:00:00Z")` es un
 * `Invalid Date`, y `toISOString()` sobre un `Invalid Date` **lanza**. Una
 * fecha imposible en la barra de direcciones tiraba la página.
 *
 * El desbordamiento silencioso es el hermano peor del anterior y por eso hay
 * una segunda comprobación: `Date.UTC(2026, 1, 30)` no falla, devuelve el 2 de
 * marzo. Aceptarlo sería contestar a una pregunta que nadie hizo. Se construye
 * la fecha y se comprueba que los tres campos siguen siendo los que se pidieron;
 * así los bisiestos salen bien sin escribir la regla de los siglos a mano, y un
 * año de dos cifras —que `Date.UTC` interpreta como 19xx— tampoco cuela.
 */
export function diaUTC(valor: unknown): Date | undefined {
  if (typeof valor !== "string") return undefined;
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(valor.trim());
  if (!partes) return undefined;
  const anio = Number(partes[1]), mes = Number(partes[2]), dia = Number(partes[3]);
  const fecha = new Date(Date.UTC(anio, mes - 1, dia));
  if (fecha.getUTCFullYear() !== anio || fecha.getUTCMonth() !== mes - 1 || fecha.getUTCDate() !== dia) {
    return undefined;
  }
  return fecha;
}

/** `AAAA-MM-DD` → instante UTC del principio de ese día. */
export function desdeFecha(p: Parametros, clave: string): string | undefined {
  return diaUTC(texto(p, clave))?.toISOString();
}

/** `AAAA-MM-DD` → principio del día siguiente, para que el día pedido entre entero. */
export function hastaFecha(p: Parametros, clave: string): string | undefined {
  const dia = diaUTC(texto(p, clave));
  // Un día son 86.400.000 ms exactos en UTC, donde no hay horario de verano;
  // sumarlos cruza el fin de mes y el fin de año sin ayuda de nadie.
  return dia === undefined ? undefined : new Date(dia.getTime() + 86_400_000).toISOString();
}

/**
 * ¿Ha pedido un rango al revés?
 *
 * Decisión de producto, escrita aquí para que no se decida otra vez en cada
 * pantalla: un rango invertido **no se corrige y no se descarta**. La consulta
 * sale tal cual y devuelve cero filas, que es la respuesta literalmente correcta
 * a lo que se ha pedido; lo que hace la pantalla es **decirlo**. Darle la vuelta
 * contestaría a otra pregunta, y tirar los dos filtros enseñaría de más.
 *
 * Con una sola fecha, o con una imposible, no hay nada que afirmar.
 */
export function rangoInvertido(p: Parametros): boolean {
  const desde = diaUTC(texto(p, "desde")), hasta = diaUTC(texto(p, "hasta"));
  return desde !== undefined && hasta !== undefined && desde.getTime() > hasta.getTime();
}

/**
 * La página pedida, siempre un entero entre 1 y `PAGINA_MAXIMA`.
 *
 * No se apoya en `numero()` a propósito: allí un desbordamiento es `undefined`
 * —no se puede consultar por él— y aquí `?p=1e308` tiene una respuesta útil, que
 * es la última página. Lo que no se puede es dejar que ese número llegue a
 * multiplicarse por el tamaño de página y salga un offset absurdo.
 */
export function pagina(p: Parametros): number {
  const s = texto(p, "p");
  if (s === "") return 1;
  const n = Number(s);
  if (!Number.isFinite(n)) return 1;
  return Math.min(PAGINA_MAXIMA, Math.max(1, Math.floor(n)));
}

/** Una lista de un solo valor, o vacía. Es lo que aceptan los filtros de `lectura.ts`. */
export function lista(p: Parametros, clave: string): string[] {
  const s = texto(p, clave);
  return s === "" ? [] : [s];
}
