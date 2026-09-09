/**
 * Una fila de la watchlist.
 *
 * La columna de la derecha **no puede ser "% de hoy"**, y esa es la decisión que
 * define este componente: los precios de Yahoo se piden en cada ciclo pero solo
 * se persisten cuando superan el umbral del valor (`toEvent()` devuelve null en
 * caso contrario, en `src/sources/mercado.ts`). Lo que hay en la base es el
 * último movimiento que **sí** llegó a ser evento, y eso es lo que se enseña.
 *
 * La alternativa era cotizar en vivo desde el servidor en cada carga de página.
 * Cuesta una llamada a Yahoo por valor y por render contra un servicio sin SLA,
 * a cambio de un número que este sistema ha decidido a propósito no vigilar
 * salvo cuando se sale del umbral.
 */
import { conSigno, es } from "../_lib/formato.ts";
import type { UltimoMovimiento } from "../../src/db/lectura.ts";
import type { Vigilado } from "../../src/db/watchlist.ts";

export function FilaWatchlist({
  valor,
  movimiento,
}: {
  valor: Vigilado;
  movimiento: UltimoMovimiento | undefined;
}) {
  const pct = movimiento?.actual ?? null;
  const color = pct === null ? "text-txt-3" : pct > 0 ? "text-success-text" : "text-danger-text";

  return (
    <div className="flex items-center justify-between gap-3 border-b border-linea py-2 last:border-b-0">
      <div className="min-w-0">
        <p className="text-secundario font-medium">
          {valor.ticker}
          {valor.quoteSymbol && valor.quoteSymbol !== valor.ticker ? (
            <span className="ml-1.5 text-meta font-normal text-txt-3">{valor.quoteSymbol}</span>
          ) : null}
        </p>
        <p className="truncate text-meta text-txt-3">
          {valor.nombre ?? "sin nombre resuelto"}
          <span aria-hidden> · </span>
          umbral <span className="cifra">{es(valor.umbralMovimiento)} %</span>
        </p>
      </div>

      <div className="shrink-0 text-right">
        {pct === null ? (
          <p className="text-meta text-txt-3">sin movimientos</p>
        ) : (
          <>
            <p className={`cifra text-secundario font-medium ${color}`}>
              {conSigno(pct)}
              {movimiento?.unit ?? "%"}
            </p>
            <p className="cifra text-meta text-txt-3">{movimiento?.observed_at}</p>
          </>
        )}
      </div>
    </div>
  );
}

/** Qué se le vigila. Dos interruptores que hoy son de solo lectura: la CLI los pone. */
export function VigilanciaDe({ valor }: { valor: Vigilado }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      <Marca activa={valor.vigilarFilings} texto="documentos" />
      <Marca activa={valor.vigilarPrecio} texto="precio" />
      {valor.cik === null ? (
        <span
          className="inline-flex items-center rounded-chip border border-stale-border bg-stale-bg px-1.5 py-0.5 text-meta text-stale-text"
          title="Sin CIK no hay documentos: la SEC no identifica una empresa por su ticker"
        >
          sin CIK
        </span>
      ) : null}
    </div>
  );
}

function Marca({ activa, texto }: { activa: boolean; texto: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-chip border px-1.5 py-0.5 text-meta ${
        activa
          ? "border-success-border bg-success-bg text-success-text"
          : "border-muted-border bg-muted-bg text-muted-text"
      }`}
    >
      <span aria-hidden>{activa ? "●" : "○"}</span>
      {texto}
    </span>
  );
}
