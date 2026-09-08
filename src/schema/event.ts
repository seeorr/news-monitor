/**
 * El contrato de datos del sistema.
 *
 * Toda fuente —FRED, RSS, SEC EDGAR, Yahoo, CoinGecko— normaliza a `NormalizedEvent`.
 * Aguas abajo del normalizador NADIE pregunta de qué fuente viene un evento: si
 * aparece un `if (source === "fred")` en el pipeline, este contrato se ha roto y
 * añadir la siguiente fuente vuelve a costar lo que costó la primera.
 */
import { createHash } from "node:crypto";
import { z } from "zod";

export const SOURCES = ["fred", "rss", "sec-edgar", "yahoo", "coingecko"] as const;
export const KINDS = ["macro_release", "news", "filing", "market_move", "calendar"] as const;

/**
 * De dónde sale la sorpresa. FRED no publica consenso de analistas y no hay
 * fuente gratuita fiable que lo dé, así que la alerta declara SIEMPRE contra qué
 * se compara. Un porcentaje de sorpresa sin base declarada es una cifra que
 * miente por omisión.
 */
export const SurpriseBasis = z.enum(["consensus", "previous", "mean_3m"]);
export type SurpriseBasis = z.infer<typeof SurpriseBasis>;

export const Surprise = z.object({
  value: z.number(),
  basis: SurpriseBasis,
  unit: z.string(),
});
export type Surprise = z.infer<typeof Surprise>;

export const NormalizedEvent = z.object({
  /** Determinista: misma observación → mismo id. Es lo que hace idempotente la alerta. */
  id: z.string().min(1),
  source: z.enum(SOURCES),
  source_url: z.url().nullable(),
  kind: z.enum(KINDS),
  title: z.string().min(1),
  /**
   * Lo que la fuente cuenta del evento, si cuenta algo: la entradilla de una
   * noticia o el asunto de un documento regulatorio. Un dato macro no lo tiene.
   * No es adorno: para un evento sin cifras, es lo unico que el modelo lee.
   */
  summary: z.string().nullable(),
  country: z.string().nullable(),
  series_id: z.string().nullable(),

  /** Fecha del dato. NUNCA se mezcla con retrieved_at. */
  observed_at: z.string(),
  /** Cuándo lo obtuvimos nosotros. */
  retrieved_at: z.string(),

  actual: z.number().nullable(),
  previous: z.number().nullable(),
  /** Solo si alguien lo ha introducido a mano. FRED no lo da. */
  consensus: z.number().nullable(),
  unit: z.string().nullable(),
  surprise: Surprise.nullable(),

  /** El dato es el último válido conocido, no uno fresco. La alerta debe decirlo. */
  stale: z.boolean(),
  /** Fuente oficial (Fed, BLS, SEC, BCE). Pasa el filtro por reglas siempre. */
  official: z.boolean(),
});
export type NormalizedEvent = z.infer<typeof NormalizedEvent>;

/** Id determinista de una observación. */
export function eventId(source: string, seriesId: string, observedAt: string): string {
  return `${source}:${seriesId}:${observedAt}`;
}

/**
 * Id determinista de un elemento de feed.
 *
 * La fecha no vale como discriminante: dos noticias del mismo feed pueden
 * compartir minuto de publicación, y entonces la segunda se tomaría por
 * duplicada de la primera y no se enviaría nunca. El identificador estable lo da
 * el propio feed (`guid`, `id` o el enlace), y aquí se resume para que el id no
 * sea una URL de doscientos caracteres.
 */
export function itemId(source: string, feedId: string, guid: string): string {
  const huella = createHash("sha1").update(guid).digest("hex").slice(0, 12);
  return `${source}:${feedId}:${huella}`;
}

/**
 * Sorpresa con la base más informativa disponible, en este orden:
 * consenso (si alguien lo introdujo) → dato anterior → media de 3 periodos.
 * Devuelve null si no hay nada contra lo que comparar: preferimos un hueco a un cero.
 */
export function computeSurprise(
  actual: number | null,
  refs: { consensus?: number | null; previous?: number | null; mean3m?: number | null },
  unit: string,
): Surprise | null {
  if (actual === null || !Number.isFinite(actual)) return null;
  const candidates: Array<[SurpriseBasis, number | null | undefined]> = [
    ["consensus", refs.consensus],
    ["previous", refs.previous],
    ["mean_3m", refs.mean3m],
  ];
  for (const [basis, ref] of candidates) {
    if (ref !== null && ref !== undefined && Number.isFinite(ref)) {
      return { value: round(actual - ref, 2), basis, unit };
    }
  }
  return null;
}

export function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
