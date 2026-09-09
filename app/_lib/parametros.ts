/**
 * Lo que llega por la URL, convertido a algo con lo que se pueda consultar.
 *
 * Nada de esto confía en el valor: los enums se validan otra vez en
 * `src/db/lectura.ts` —que es donde de verdad importa— y aquí solo se traduce.
 * Una fecha `desde` se toma como el principio de ese día en UTC y una `hasta`
 * como el principio del **siguiente**, para que "hasta el 9" incluya el día 9
 * entero; la consulta usa `<`, no `<=`.
 */
export type Parametros = Record<string, string | string[] | undefined>;

export function texto(p: Parametros, clave: string): string {
  const v = p[clave];
  const s = Array.isArray(v) ? v[0] : v;
  return typeof s === "string" ? s.trim() : "";
}

export function numero(p: Parametros, clave: string): number | undefined {
  const s = texto(p, clave);
  if (s === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

export function activo(p: Parametros, clave: string): boolean {
  return texto(p, clave) === "1";
}

/** `AAAA-MM-DD` → instante UTC del principio de ese día. */
export function desdeFecha(p: Parametros, clave: string): string | undefined {
  const s = texto(p, clave);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00Z` : undefined;
}

/** `AAAA-MM-DD` → principio del día siguiente, para que el día pedido entre entero. */
export function hastaFecha(p: Parametros, clave: string): string | undefined {
  const s = texto(p, clave);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return undefined;
  const d = new Date(`${s}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString();
}

/** Una lista de un solo valor, o vacía. Es lo que aceptan los filtros de `lectura.ts`. */
export function lista(p: Parametros, clave: string): string[] {
  const s = texto(p, clave);
  return s === "" ? [] : [s];
}
