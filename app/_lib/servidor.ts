/**
 * El acceso a la base, desde el servidor y solo desde el servidor.
 *
 * `DATABASE_URL` es un secreto y el driver de Neon es de servidor. Ninguna
 * consulta se hace desde el navegador y esta variable **nunca** entra en una
 * `NEXT_PUBLIC_`. Este dashboard no es un panel público: enseña una cartera.
 *
 * Ningún archivo que importe esto puede llevar `"use client"`. Si algún día uno
 * lo lleva, el build fallará al intentar meter `@neondatabase/serverless` en el
 * bundle del navegador, que es exactamente lo que se quiere que pase.
 */
import { cliente } from "../../src/db/lectura.ts";
import type { Ejecutor } from "../../src/db/cliente.ts";

/**
 * Falta una credencial. No es un error del programa: es una configuración
 * incompleta, y la pantalla tiene que decir **cuál** falta y para qué sirve, no
 * quedarse con un spinner eterno. Es lo mismo que hace `describeMissing()` en
 * `src/config.ts` con el ciclo.
 */
export class FaltaCredencial extends Error {
  constructor(
    readonly variable: string,
    readonly para: string,
    readonly donde: string,
  ) {
    super(`Falta ${variable}`);
    this.name = "FaltaCredencial";
  }
}

export function urlBaseDeDatos(): string | null {
  return process.env["DATABASE_URL"] ?? null;
}

export function claveFred(): string | null {
  return process.env["FRED_API_KEY"] ?? null;
}

/**
 * El cliente SQL de la petición.
 *
 * No se cachea entre peticiones a propósito: el driver de Neon va por HTTP y no
 * mantiene conexión, así que un cliente por render no cuesta nada y evita
 * arrastrar estado entre peticiones de un servidor que puede ser compartido.
 */
export function sql(): Ejecutor {
  const url = urlBaseDeDatos();
  if (!url) {
    throw new FaltaCredencial(
      "DATABASE_URL",
      "leer los eventos, las alertas y la watchlist: sin ella el dashboard no tiene de dónde sacar nada",
      "Panel de Neon → Connection string (pooled)",
    );
  }
  return cliente(url);
}
