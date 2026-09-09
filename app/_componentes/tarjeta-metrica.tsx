/**
 * La tarjeta de una métrica macro: etiqueta pequeña arriba, cifra grande abajo.
 *
 * Solo es honesta para las tres series que se ingieren de verdad —`CPIAUCSL`,
 * `UNRATE` y `DGS10`, en `src/sources/fred.ts`—. Índices, DXY, oro, petróleo y
 * crypto **no se ingieren**, así que no hay un 2x2 de mercado que pintar: se
 * enseñan las tres que existen y ya (hueco G4). El día que haya un job de
 * precios, este bloque crece sin rediseñarse.
 */
import { InsigniaObsoleto } from "./insignias.tsx";
import { es } from "../_lib/formato.ts";
import { sorpresa } from "../../src/notify/telegram.ts";
import type { SurpriseBasis } from "../../src/schema/event.ts";
import type { FilaEvento } from "../../src/db/lectura.ts";

export function TarjetaMetrica({ serie }: { serie: FilaEvento }) {
  const unidad = serie.unit ?? "";
  const diferencia = serie.surprise_value;
  const color =
    diferencia === null
      ? "text-txt"
      : diferencia > 0
        ? "text-success-text"
        : diferencia < 0
          ? "text-danger-text"
          : "text-txt";

  return (
    <div className="rounded-tarjeta border border-linea bg-card px-3.5 py-3">
      <div className="flex items-start justify-between gap-2">
        <p className="text-meta text-txt-3">{serie.title}</p>
        <InsigniaObsoleto obsoleto={serie.stale} />
      </div>

      <p className={`cifra mt-1 text-cifra font-medium ${color}`}>
        {serie.actual === null ? "—" : `${es(serie.actual)}${unidad}`}
      </p>

      <p className="mt-0.5 text-meta text-txt-3">
        {/*
          La sorpresa declara siempre su base. Un porcentaje de sorpresa sin base
          miente por omisión, y aquí la base nunca es el consenso: FRED no lo
          publica.
        */}
        {diferencia !== null && serie.surprise_basis !== null ? (
          <span className="cifra">
            {sorpresa({
              value: diferencia,
              basis: serie.surprise_basis as SurpriseBasis,
              unit: unidad,
            })}
          </span>
        ) : (
          "sin referencia con la que comparar"
        )}
        <span aria-hidden> · </span>
        <span className="cifra">{serie.observed_at}</span>
      </p>
    </div>
  );
}
