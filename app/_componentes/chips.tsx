/**
 * Chips de activo y de fuente, y el estado vacío.
 */
import {
  FEED_LABEL,
  SOURCE_LABEL,
  esActivo,
  haceCuanto,
  KIND_LABEL,
} from "../_lib/formato.ts";
import type { FilaEvento } from "../../src/db/lectura.ts";

/**
 * Un ticker en una píldora, sin color semántico propio: el color de esta app
 * significa importancia y sentimiento, y un activo no es ni una cosa ni la otra.
 *
 * Solo se pinta cuando `series_id` es de verdad un activo —`filing` y
 * `market_move`—. Para un dato macro es una serie de FRED y para una noticia es
 * el id del feed: pintarlos como activo diría que la noticia va de ese activo, y
 * eso no lo sabe nadie.
 */
export function ChipActivo({ evento }: { evento: FilaEvento }) {
  if (!esActivo(evento)) return null;
  return (
    <span className="inline-flex items-center rounded-chip bg-raised px-1.5 py-0.5 text-meta font-medium text-txt-2">
      {evento.series_id}
    </span>
  );
}

/**
 * Fuente y tiempo relativo. Si la fuente es primaria —Fed, BCE, SEC, FRED— un
 * punto lo distingue: la diferencia entre fuente primaria y prensa gobierna
 * medio pipeline y merece verse.
 */
export function ChipFuente({ evento, ahora }: { evento: FilaEvento; ahora: Date }) {
  const feed = evento.series_id !== null ? FEED_LABEL[evento.series_id] : undefined;
  const nombre = feed ?? SOURCE_LABEL[evento.source] ?? evento.source;
  return (
    <span className="inline-flex items-center gap-1.5 text-meta text-txt-3 whitespace-nowrap">
      {evento.official ? (
        <span
          className="h-1.5 w-1.5 rounded-full bg-accent"
          title="Fuente primaria: pasa el filtro por reglas siempre"
          aria-label="Fuente primaria"
        />
      ) : null}
      <span>{nombre}</span>
      <span aria-hidden>·</span>
      <time dateTime={evento.first_seen_at.toISOString()}>
        {haceCuanto(evento.first_seen_at, ahora)}
      </time>
    </span>
  );
}

export function ChipTipo({ kind }: { kind: string }) {
  return (
    <span className="inline-flex items-center rounded-chip bg-raised px-1.5 py-0.5 text-meta text-txt-2">
      {KIND_LABEL[kind] ?? kind}
    </span>
  );
}

/**
 * Un vacío que dice **por qué** está vacío y qué falta para que no lo esté.
 *
 * Es el equivalente en pantalla de `describeMissing()` en `src/config.ts`. Los
 * casos que se van a dar desde el primer día —watchlist sin valores, ningún
 * documento porque falta `SEC_USER_AGENT`, cero movimientos porque nadie superó
 * su umbral, agenda sin citas— no son errores, y ninguno se resuelve con un
 * spinner eterno ni con una ilustración simpática.
 */
export function Vacio({
  titulo,
  porque,
  siguiente,
}: {
  titulo: string;
  porque: string;
  siguiente?: React.ReactNode;
}) {
  return (
    <div className="rounded-tarjeta border border-linea border-dashed bg-card px-4 py-6">
      <p className="text-cuerpo font-medium">{titulo}</p>
      <p className="mt-1 text-secundario text-txt-2">{porque}</p>
      {siguiente ? <div className="mt-3 text-secundario text-txt-2">{siguiente}</div> : null}
    </div>
  );
}
