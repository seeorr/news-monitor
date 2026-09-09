"use client";

/**
 * El alta de un valor. Es la única escritura del dashboard y el requisito propio
 * de la sección 6: **debe poder añadirse un valor escribiendo su ticker, sin
 * tocar la terminal.**
 *
 * Es de cliente por dos motivos concretos y no por costumbre: las mayúsculas en
 * vivo mientras se escribe, y el estado "Comprobando ACME en la SEC y en
 * Yahoo…", que tarda un segundo o dos porque son dos peticiones de red y sin él
 * parece que la página se ha colgado.
 *
 * Ni una consulta sale de aquí: el formulario llama a una acción de servidor.
 */
import { useActionState, useState } from "react";
import { useFormStatus } from "react-dom";
import { anadirTicker } from "./acciones.ts";
import { ESTADO_INICIAL, type Estado } from "./estado.ts";

const CAMPO =
  "w-full rounded-chip border border-linea bg-card px-2.5 py-1.5 text-secundario text-txt";
const ETIQUETA = "block text-meta text-txt-3 mb-1";

export function FormularioAlta() {
  const [estado, accion] = useActionState(anadirTicker, ESTADO_INICIAL);
  const [ticker, setTicker] = useState("");

  return (
    <form action={accion} className="rounded-tarjeta border border-linea bg-card px-4 py-3.5">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-40">
          <label className={ETIQUETA} htmlFor="ticker">
            Ticker
          </label>
          <input
            id="ticker"
            name="ticker"
            required
            autoComplete="off"
            spellCheck={false}
            value={ticker}
            onChange={(e) => setTicker(e.target.value.toUpperCase())}
            className={`${CAMPO} font-medium`}
            placeholder="ACME"
          />
        </div>
        <Boton />
      </div>

      {/*
        Tres campos opcionales plegados: el 90 % de las altas son solo un ticker,
        y un formulario de cinco campos para escribir uno invita a no escribirlo.
      */}
      <details className="mt-3">
        <summary className="cursor-pointer text-meta text-txt-3">Más opciones</summary>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          <div>
            <label className={ETIQUETA} htmlFor="nombre">
              Nombre
            </label>
            <input id="nombre" name="nombre" className={CAMPO} placeholder="lo rellena la SEC" />
          </div>
          <div>
            <label className={ETIQUETA} htmlFor="simbolo">
              Símbolo de Yahoo
            </label>
            <input id="simbolo" name="simbolo" className={CAMPO} placeholder="solo si difiere" />
          </div>
          <div>
            <label className={ETIQUETA} htmlFor="umbral">
              Umbral de movimiento (%)
            </label>
            <input
              id="umbral"
              name="umbral"
              type="number"
              min="0.5"
              max="20"
              step="0.5"
              className={CAMPO}
              placeholder="3"
            />
          </div>
        </div>
        <p className="mt-2 text-meta text-txt-3">
          El umbral es por valor a propósito: un 3 % en una utility significa algo, en una
          biotecnológica es un martes cualquiera. Dejar el 3 en todo hace que el sistema parezca
          ruidoso sin serlo.
        </p>
      </details>

      <Resultado estado={estado} />
    </form>
  );
}

function Boton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="rounded-chip border border-accent-border bg-accent-bg px-3.5 py-1.5 text-secundario font-medium text-accent-text disabled:opacity-60"
    >
      {pending ? "Comprobando en la SEC y en Yahoo…" : "Añadir"}
    </button>
  );
}

function Resultado({ estado }: { estado: Estado }) {
  if (estado.tipo === "vacio") return null;
  const ok = estado.tipo === "ok";
  return (
    <div
      className={`mt-3 rounded-chip border px-3 py-2 text-secundario ${
        ok
          ? "border-success-border bg-success-bg text-success-text"
          : "border-danger-border bg-danger-bg text-danger-text"
      }`}
      role="status"
    >
      <p className="font-medium">{estado.mensaje}</p>
      {estado.avisos.length > 0 ? (
        <ul className="mt-1.5 list-disc space-y-1 pl-4 text-meta opacity-90">
          {estado.avisos.map((a) => (
            <li key={a}>{a}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
