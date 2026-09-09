/**
 * La fila de filtros: un formulario `GET` y ningún JavaScript.
 *
 * El estado del filtro vive en la URL, que es lo que hace que un filtro se pueda
 * compartir, volver atrás y recargar. Y como es un `form` nativo, la página
 * sigue siendo entera de servidor: no hay ni un componente de cliente por poder
 * elegir una importancia mínima.
 *
 * **Solo se pintan los filtros que funcionan.** Un desplegable de sectores
 * siempre vacío es peor que su ausencia: enseña que el sistema tiene un agujero
 * justo donde promete precisión (huecos G6).
 */
import { KIND_LABEL, SENTIMENT_LABEL, SOURCE_LABEL } from "../_lib/formato.ts";
import { KINDS, SOURCES } from "../../src/schema/event.ts";

const CAMPO =
  "rounded-chip border border-linea bg-card px-2 py-1 text-secundario text-txt";
const ETIQUETA = "flex items-center gap-1.5 text-meta text-txt-3";

export function Filtros({
  accion,
  campos,
}: {
  accion: string;
  campos: React.ReactNode;
}) {
  return (
    <form
      action={accion}
      method="get"
      className="mb-4 flex flex-wrap items-end gap-x-3 gap-y-2 rounded-tarjeta border border-linea bg-card px-3.5 py-3"
    >
      {campos}
      <button
        type="submit"
        className="rounded-chip border border-accent-border bg-accent-bg px-3 py-1 text-secundario font-medium text-accent-text"
      >
        Filtrar
      </button>
      <a href={accion} className="text-meta text-txt-3 underline underline-offset-2">
        limpiar
      </a>
    </form>
  );
}

export function Importancia({ valor }: { valor: string }) {
  return (
    <label className={ETIQUETA}>
      Importancia mínima
      <select name="min" defaultValue={valor} className={CAMPO}>
        <option value="">cualquiera</option>
        {[9, 8, 7, 6, 5, 4, 3, 2, 1].map((n) => (
          <option key={n} value={String(n)}>
            {n} o más
          </option>
        ))}
      </select>
    </label>
  );
}

export function Rango({ desde, hasta }: { desde: string; hasta: string }) {
  return (
    <>
      <label className={ETIQUETA}>
        Desde
        <input type="date" name="desde" defaultValue={desde} className={CAMPO} />
      </label>
      <label className={ETIQUETA}>
        Hasta
        <input type="date" name="hasta" defaultValue={hasta} className={CAMPO} />
      </label>
    </>
  );
}

export function Tipo({ valor }: { valor: string }) {
  return (
    <label className={ETIQUETA}>
      Tipo
      <select name="kind" defaultValue={valor} className={CAMPO}>
        <option value="">todos</option>
        {KINDS.map((k) => (
          <option key={k} value={k}>
            {KIND_LABEL[k] ?? k}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * `coingecko` está en el enum de fuentes y **no tiene implementación**. No se
 * ofrece: un filtro que no puede devolver nada nunca es una promesa falsa.
 */
export function Fuente({ valor }: { valor: string }) {
  return (
    <label className={ETIQUETA}>
      Fuente
      <select name="source" defaultValue={valor} className={CAMPO}>
        <option value="">todas</option>
        {SOURCES.filter((s) => s !== "coingecko").map((s) => (
          <option key={s} value={s}>
            {SOURCE_LABEL[s] ?? s}
          </option>
        ))}
      </select>
    </label>
  );
}

export function Sentimiento({ valor }: { valor: string }) {
  return (
    <label className={ETIQUETA}>
      Sentimiento
      <select name="sentiment" defaultValue={valor} className={CAMPO}>
        <option value="">cualquiera</option>
        {Object.entries(SENTIMENT_LABEL).map(([k, v]) => (
          <option key={k} value={k}>
            {v}
          </option>
        ))}
      </select>
    </label>
  );
}

/**
 * El filtro que la spec original no tenía y que separa señal de ruido mejor que
 * ningún otro: `events.official`. La diferencia entre fuente primaria y prensa
 * gobierna medio pipeline.
 */
export function SoloOficiales({ activo }: { activo: boolean }) {
  return (
    <label className="flex items-center gap-1.5 text-meta text-txt-2">
      <input type="checkbox" name="oficial" value="1" defaultChecked={activo} className="accent-[var(--accent-strong)]" />
      Solo fuentes primarias
    </label>
  );
}
