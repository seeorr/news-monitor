"use client";

/**
 * El formulario de acceso. Elementos nativos y los tokens de `globals.css`: no
 * hay librería de componentes en este proyecto y una pantalla de login no es
 * motivo para estrenarla.
 *
 * Es de cliente por una sola cosa: el estado "Comprobando…" mientras la acción
 * viaja. Sin él, un HMAC y un viaje de red se parecen mucho a no haber pulsado.
 */
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { entrar } from "./acciones.ts";
import { ESTADO_INICIAL } from "./estado.ts";

export function FormularioAcceso({ destino, caducada }: { destino: string; caducada: boolean }) {
  const [estado, accion] = useActionState(entrar, ESTADO_INICIAL);

  return (
    <form
      action={accion}
      className="rounded-tarjeta border border-linea bg-card px-5 py-5"
    >
      <h1 className="text-titulo font-medium">Acceso</h1>

      {/*
        Lo único que se cuenta de más, y sólo a quien acaba de perder la sesión:
        que el motivo de estar aquí es que caducó, no que haya hecho algo mal.
      */}
      {caducada ? (
        <p className="mt-2 rounded-chip border border-warning-border bg-warning-bg px-3 py-2 text-secundario text-warning-text">
          La sesión había caducado. Nada de lo que estuvieras haciendo se ha guardado.
        </p>
      ) : null}

      <input type="hidden" name="destino" value={destino} />

      <label className="mt-4 block text-meta text-txt-3" htmlFor="clave">
        Clave
      </label>
      <input
        id="clave"
        name="clave"
        type="password"
        required
        autoFocus
        autoComplete="current-password"
        spellCheck={false}
        className="mt-1 w-full rounded-chip border border-linea bg-page px-2.5 py-1.5 text-cuerpo text-txt"
      />

      <Boton />

      {estado.tipo === "error" ? (
        <p
          role="status"
          className="mt-3 rounded-chip border border-danger-border bg-danger-bg px-3 py-2 text-secundario text-danger-text"
        >
          {estado.mensaje}
        </p>
      ) : null}
    </form>
  );
}

function Boton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-4 w-full rounded-chip border border-accent-border bg-accent-bg px-3.5 py-2 text-cuerpo font-medium text-accent-text disabled:opacity-60"
    >
      {pending ? "Comprobando…" : "Entrar"}
    </button>
  );
}
