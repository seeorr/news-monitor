/**
 * El estado que devuelve el formulario de acceso.
 *
 * Vive aquí y no en `acciones.ts` por la misma regla que en la watchlist: un
 * módulo `"use server"` sólo puede exportar funciones asíncronas, y una
 * constante exportada desde allí llega al cliente como `undefined`.
 *
 * Sólo tiene dos estados y un único mensaje posible. No hay un "clave
 * incorrecta" separado de un "usuario desconocido", ni un contador de intentos:
 * cada distinción que se enseñe es información que hoy no tiene quien la pide.
 */
export interface EstadoAcceso {
  tipo: "vacio" | "error";
  mensaje: string;
}

export const ESTADO_INICIAL: EstadoAcceso = { tipo: "vacio", mensaje: "" };
