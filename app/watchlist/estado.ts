/**
 * El estado que devuelven las acciones de la watchlist.
 *
 * Vive aquí y no en `acciones.ts` por una regla del framework que no perdona:
 * **un módulo `"use server"` solo puede exportar funciones asíncronas**. Un
 * objeto constante exportado desde allí llega al cliente como `undefined` y
 * revienta al primer render, sin que el typecheck vea nada raro. Se descubre
 * abriendo la página, no compilándola.
 */
export interface Estado {
  tipo: "vacio" | "ok" | "error";
  mensaje: string;
  /** Lo que hay que saber sin haberlo preguntado: sin CIK, ticker corto, respaldo del entorno. */
  avisos: string[];
  /** Lo escrito, para no perderlo cuando algo falla. */
  ticker?: string;
}

export const ESTADO_INICIAL: Estado = { tipo: "vacio", mensaje: "", avisos: [] };
