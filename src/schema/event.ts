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

export const SOURCES = ["fred", "eurostat", "rss", "sec-edgar", "yahoo", "coingecko"] as const;
export const KINDS = ["macro_release", "news", "filing", "market_move", "calendar"] as const;

/**
 * De dónde sale la sorpresa. FRED no publica consenso de analistas y no hay
 * fuente gratuita fiable que lo dé, así que la alerta declara SIEMPRE contra qué
 * se compara. Un porcentaje de sorpresa sin base declarada es una cifra que
 * miente por omisión.
 *
 * El orden de esta enumeración es el orden en que se presentan: es el de más a
 * menos informativo, y lo usa `computeSurprises()` para ordenar la lista.
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
  /** Fecha de publicación original, null si el feed solo ofrece actualización. */
  publication_at: z.string().nullable().optional(),
  /** Periodo de la observación macro, no su fecha de publicación. */
  data_period_at: z.string().nullable().optional(),
  /** Primera captura inmutable de la cola; no se renueva al reintentar. */
  first_captured_at: z.string().optional(),
  /** Clasificación determinista persistida antes del límite de lectura. */
  critical_macro: z.boolean().optional(),

  actual: z.number().nullable(),
  previous: z.number().nullable(),
  /** Solo si alguien lo ha introducido a mano. FRED no lo da. */
  consensus: z.number().nullable(),
  unit: z.string().nullable(),
  /**
   * Todas las sorpresas calculables, no la mejor.
   *
   * Comparar el IPC contra el del mes pasado no es una sorpresa, es una
   * variación: el mercado ya se sabía el dato anterior. La media de 3 meses dice
   * otra cosa —si el dato se sale de la tendencia reciente— y ninguna de las dos
   * sustituye al consenso. Quedarse con la primera disponible tiraba la otra.
   *
   * Lista vacía, no `null`: un evento sin cifras —una noticia, un documento— no
   * tiene sorpresas que calcular, y eso es un conjunto vacío, no un hueco.
   * Cada elemento declara su base; esa regla no se rompe en ningún borde.
   */
  surprises: z.array(Surprise),

  /** El dato es el último válido conocido, no uno fresco. La alerta debe decirlo. */
  stale: z.boolean(),
  /** Fuente oficial (Fed, BLS, SEC, BCE). Atribución primaria, no pase automático. */
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
 * Todas las sorpresas calculables, de más a menos informativa: consenso (si
 * alguien lo introdujo a mano), dato anterior y media de 3 periodos.
 *
 * Devuelve **todas** las bases disponibles y no la primera. El motivo: FRED no
 * publica consenso, así que `consensus` está a null casi siempre y la sorpresa
 * se calculaba contra el dato anterior, que es una variación y no una sorpresa
 * —el mercado ya se sabía el dato anterior—. La media de 3 meses responde a otra
 * pregunta: si el dato se sale de la tendencia reciente. Juntas dicen más que
 * cualquiera sola, y descartar una para quedarse con la otra era tirar
 * información que ya estaba calculada.
 *
 * Lista vacía si no hay nada contra lo que comparar: preferimos un hueco a un
 * cero. Cada elemento lleva su base, siempre.
 */
export function computeSurprises(
  actual: number | null,
  refs: { consensus?: number | null; previous?: number | null; mean3m?: number | null },
  unit: string,
): Surprise[] {
  if (actual === null || !Number.isFinite(actual)) return [];
  const candidates: Array<[SurpriseBasis, number | null | undefined]> = [
    ["consensus", refs.consensus],
    ["previous", refs.previous],
    ["mean_3m", refs.mean3m],
  ];
  const out: Surprise[] = [];
  for (const [basis, ref] of candidates) {
    if (ref !== null && ref !== undefined && Number.isFinite(ref)) {
      out.push({ value: round(actual - ref, 2), basis, unit });
    }
  }
  return out;
}

export function round(n: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}
