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
import { sorpresas } from "../../src/notify/telegram.ts";
import type { FilaEvento } from "../../src/db/lectura.ts";

export function TarjetaMetrica({ serie }: { serie: FilaEvento }) {
  const unidad = serie.unit ?? "";
  // El color lo decide la primera sorpresa, que es la de base mas informativa
  // —consenso si existe, si no el dato anterior—. Las dos se escriben; el color
  // es uno solo porque la cifra grande tambien lo es, y pintarla de dos colores
  // a la vez no significa nada.
  const linea = sorpresas(serie.surprises);
  const diferencia = serie.surprises[0]?.value ?? null;
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
          Cada sorpresa declara su base, y salen todas las que hay: contra el dato
          anterior y contra la media de 3 meses dicen cosas distintas —una es la
          variacion, la otra si el dato se sale de la tendencia— y ninguna es la
          buena. Contra el consenso casi nunca hay: FRED no lo publica.
        */}
        {linea !== null ? (
          <span className="cifra">{linea}</span>
        ) : (
          "sin referencia con la que comparar"
        )}
        <span aria-hidden> · </span>
        <span className="cifra">{serie.observed_at}</span>
      </p>
    </div>
  );
}
