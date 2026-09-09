/**
 * Cargar datos sin que una credencial ausente parezca un error del programa.
 *
 * El ciclo ya distingue esas dos cosas: `describeMissing()` dice qué variable
 * falta, para qué sirve y dónde conseguirla, y sigue con lo que puede. Una
 * pantalla en blanco con un stack trace no dice ninguna de las tres.
 *
 * Se usa desde Server Components. El `sql()` se pide **dentro** del `try` a
 * propósito: es ahí donde se descubre que falta `DATABASE_URL`.
 */
import { FaltaCredencial, sql } from "./servidor.ts";
import type { Ejecutor } from "../../src/db/cliente.ts";

export type Motivo =
  | { tipo: "credencial"; variable: string; para: string; donde: string }
  | { tipo: "error"; mensaje: string };

export type Resultado<T> = { ok: true; datos: T } | { ok: false; motivo: Motivo };

export async function cargar<T>(consulta: (ejecutor: Ejecutor) => Promise<T>): Promise<Resultado<T>> {
  try {
    return { ok: true, datos: await consulta(sql()) };
  } catch (error: unknown) {
    if (error instanceof FaltaCredencial) {
      return {
        ok: false,
        motivo: {
          tipo: "credencial",
          variable: error.variable,
          para: error.para,
          donde: error.donde,
        },
      };
    }
    return {
      ok: false,
      motivo: { tipo: "error", mensaje: error instanceof Error ? error.message : String(error) },
    };
  }
}
