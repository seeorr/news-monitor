/**
 * Lo que se enseña cuando no se ha podido leer.
 *
 * Dos casos distintos y se distinguen a propósito: **falta una credencial** (no
 * es un fallo, es una configuración incompleta y se dice cuál y dónde
 * conseguirla) y **la base no ha respondido** (eso sí es un fallo, y se dice el
 * mensaje en vez de esconderlo).
 */
import type { Motivo } from "../_lib/cargar.ts";

export function SinDatos({ motivo }: { motivo: Motivo }) {
  if (motivo.tipo === "credencial") {
    return (
      <div className="rounded-tarjeta border border-warning-border bg-warning-bg px-4 py-4">
        <p className="text-cuerpo font-medium text-warning-text">
          Falta la variable {motivo.variable}
        </p>
        <p className="mt-1 text-secundario text-warning-text/90">Para qué sirve: {motivo.para}.</p>
        <p className="mt-1 text-secundario text-warning-text/90">Dónde: {motivo.donde}.</p>
      </div>
    );
  }

  return (
    <div className="rounded-tarjeta border border-danger-border bg-danger-bg px-4 py-4">
      <p className="text-cuerpo font-medium text-danger-text">La base de datos no ha respondido</p>
      <p className="mt-1 text-secundario text-danger-text/90">{motivo.mensaje}</p>
    </div>
  );
}
