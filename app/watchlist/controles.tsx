"use client";

/**
 * Los controles de una fila: umbral en línea, los dos interruptores y el borrado
 * con confirmación **en línea** —no un modal— que dice qué implica.
 */
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { cambiarUmbral, cambiarVigilancia, quitarTicker } from "./acciones.ts";
import { conAvisoDeSesion } from "./cliente.ts";
import { ESTADO_INICIAL } from "./estado.ts";
import { es } from "../_lib/formato.ts";

// Envueltas una vez al cargar el módulo. El porqué está en `cliente.ts`: sin
// esto, una sesión caducada rompe el render entero de la fila en vez de decir
// que no se ha guardado nada.
const CAMBIAR_UMBRAL = conAvisoDeSesion(cambiarUmbral);
const CAMBIAR_VIGILANCIA = conAvisoDeSesion(cambiarVigilancia);
const QUITAR = conAvisoDeSesion(quitarTicker);

export function Umbral({ ticker, valor }: { ticker: string; valor: number }) {
  const [estado, accion] = useActionState(CAMBIAR_UMBRAL, ESTADO_INICIAL);
  return (
    <form action={accion} className="flex items-center gap-1.5">
      <input type="hidden" name="ticker" value={ticker} />
      <label className="text-meta text-txt-3" htmlFor={`umbral-${ticker}`}>
        umbral
      </label>
      <input
        id={`umbral-${ticker}`}
        name="umbral"
        type="number"
        min="0.5"
        max="20"
        step="0.5"
        defaultValue={es(valor)}
        className="cifra w-16 rounded-chip border border-linea bg-card px-1.5 py-0.5 text-meta"
      />
      <span className="text-meta text-txt-3">%</span>
      <Guardar />
      {estado.tipo === "error" ? (
        <span className="text-meta text-danger-text">{estado.mensaje}</span>
      ) : null}
    </form>
  );
}

export function Interruptor({
  ticker,
  campo,
  activo,
  texto,
}: {
  ticker: string;
  campo: "filings" | "precio";
  activo: boolean;
  texto: string;
}) {
  const [estado, accion] = useActionState(CAMBIAR_VIGILANCIA, ESTADO_INICIAL);
  return (
    <form action={accion} className="flex flex-wrap items-center gap-1.5">
      <input type="hidden" name="ticker" value={ticker} />
      <input type="hidden" name="campo" value={campo} />
      <input type="hidden" name="valor" value={activo ? "0" : "1"} />
      <button
        type="submit"
        aria-pressed={activo}
        className={`inline-flex items-center gap-1 rounded-chip border px-1.5 py-0.5 text-meta ${
          activo
            ? "border-success-border bg-success-bg text-success-text"
            : "border-muted-border bg-muted-bg text-muted-text"
        }`}
      >
        <span aria-hidden>{activo ? "●" : "○"}</span>
        {texto}
      </button>
      {/*
        El interruptor se pinta con lo que dice el servidor, así que cuando algo
        falla se queda como estaba y no miente. Pero quedarse quieto sin decir
        nada se parece demasiado a no haber pulsado: el error se enseña.
      */}
      {estado.tipo === "error" ? (
        <span className="text-meta text-danger-text">{estado.mensaje}</span>
      ) : null}
    </form>
  );
}

export function Borrar({ ticker }: { ticker: string }) {
  const [confirmando, setConfirmando] = useState(false);
  const [estado, accion] = useActionState(QUITAR, ESTADO_INICIAL);

  if (!confirmando) {
    return (
      <button
        type="button"
        onClick={() => setConfirmando(true)}
        className="rounded-chip border border-linea px-2 py-0.5 text-meta text-txt-3 hover:border-danger-border hover:text-danger-text"
      >
        Quitar
      </button>
    );
  }

  return (
    <form action={accion} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="ticker" value={ticker} />
      <span className="text-meta text-txt-2">
        Dejas de vigilar sus documentos y su precio. Los eventos ya registrados se quedan.
      </span>
      <button
        type="submit"
        className="rounded-chip border border-danger-border bg-danger-bg px-2 py-0.5 text-meta font-medium text-danger-text"
      >
        Quitar {ticker}
      </button>
      <button
        type="button"
        onClick={() => setConfirmando(false)}
        className="text-meta text-txt-3 underline underline-offset-2"
      >
        cancelar
      </button>
      {estado.tipo === "error" ? (
        <span className="text-meta text-danger-text">{estado.mensaje}</span>
      ) : null}
    </form>
  );
}

function Guardar() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-chip border border-linea px-2 py-0.5 text-meta text-txt-2 disabled:opacity-60"
    >
      {pending ? "…" : "guardar"}
    </button>
  );
}
