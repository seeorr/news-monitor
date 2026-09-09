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

/**
 * Un activo que el análisis del paso 4 señala como afectado, con su dirección y
 * su confianza.
 *
 * No es lo mismo que `ChipActivo` y por eso no es el mismo componente: aquel
 * pinta el activo **del que va** el evento —`series_id`, cuando de verdad es un
 * ticker— y este los que el modelo dice que se ven afectados. Hasta hoy no
 * tenían de dónde salir: vivían dentro de la prosa de `alerts.body`, y sacarlos
 * de ahí con expresiones regulares era la adivinanza que el hueco G2 prohibía.
 *
 * El color va en la flecha y no en la píldora. `ChipActivo` no lleva color
 * porque un activo no es ni importancia ni sentimiento; una **dirección** sí lo
 * es, y verde y rojo significan aquí lo mismo que en el resto de la app.
 *
 * La flecha se repite tantas veces como la confianza, igual que `arrows()`
 * repite el círculo en la alerta de Telegram. La misma confianza del mismo
 * activo leída de dos formas sería el fallo de coherencia que ya obligó a
 * unificar `sorpresa()`.
 */
export function ChipActivoAfectado({
  activo,
}: {
  activo: { symbol: string; direction: string; confidence: number };
}) {
  const simbolo = activo.symbol.trim();
  if (simbolo === "") return null;

  const veces = Math.max(1, Math.min(3, Math.round(activo.confidence)));
  const sube = activo.direction === "up";
  const baja = activo.direction === "down";
  const color = sube ? "text-success-text" : baja ? "text-danger-text" : "text-txt-3";
  const dice = sube ? "sube" : baja ? "baja" : "sin dirección clara";
  const flecha = sube ? "↑".repeat(veces) : baja ? "↓".repeat(veces) : "·";

  return (
    <span
      className="inline-flex items-center gap-1 rounded-chip bg-raised px-1.5 py-0.5 text-meta font-medium text-txt-2"
      title={`${simbolo}: ${dice}${sube || baja ? ` · confianza ${veces} de 3` : ""}`}
    >
      {simbolo}
      <span className={color} aria-label={dice}>
        {flecha}
      </span>
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
