/**
 * Paso 1 de la cascada (§5): filtro por reglas. Gratis, sin LLM.
 *
 * La mayoría de lo que entra muere aquí. Ese es el punto: reduce el volumen que
 * llega al LLM en un 80-90 %, y lo hace con reglas auditables en vez de con una
 * llamada que cuesta dinero y no se puede explicar.
 */
import type { NormalizedEvent } from "../schema/event.ts";

export interface RuleDecision {
  pass: boolean;
  /** Por qué. Va al log: un filtro que no explica sus descartes es una caja negra. */
  reason: string;
}

/** Palabras que, en un titular, casi siempre significan que hay que mirar. */
export const MACRO_KEYWORDS = [
  "cpi", "inflation", "inflación", "fomc", "fed", "rate decision", "tipos",
  "payrolls", "unemployment", "paro", "gdp", "pib", "ecb", "bce",
  "guidance", "earnings", "merger", "acquisition", "ipo", "bankruptcy",
  "downgrade", "upgrade", "sanctions", "tariff", "arancel",
];

/**
 * Lo único que la regla mira de un evento: su titular y si la fuente es
 * primaria. Se declara aparte, y no como `NormalizedEvent`, para que la firma
 * diga la verdad sobre lo que lee, y para que el día que la regla necesite un
 * campo más haya que añadirlo aquí, a la vista, en vez de que entre gratis.
 */
export type Enjuiciable = Pick<NormalizedEvent, "title" | "official">;

export function applyRules(
  event: Enjuiciable,
  opts: { watchlist?: string[] } = {},
): RuleDecision {
  // Fuente oficial (Fed, BLS, SEC, BCE) pasa siempre. Es dato primario, no opinión.
  if (event.official) {
    return { pass: true, reason: "fuente oficial" };
  }

  const haystack = event.title.toLowerCase();

  const watchlist = opts.watchlist ?? [];
  const ticker = watchlist.find((t) => new RegExp(`\\b${escapeRegExp(t)}\\b`, "i").test(event.title));
  if (ticker) {
    return { pass: true, reason: `menciona ${ticker} de la watchlist` };
  }

  const keyword = MACRO_KEYWORDS.find((k) => haystack.includes(k));
  if (keyword) {
    return { pass: true, reason: `keyword macro "${keyword}"` };
  }

  return { pass: false, reason: "sin ticker de la watchlist ni keyword macro" };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * ¿Se anuncia o solo se registra?
 *
 * De una fuente primaria —la Fed, el BCE, un documento ante la SEC, un dato de
 * FRED— basta con que el modelo diga que merece aviso: quien publica ya ha
 * filtrado. Un titular de prensa tiene que llegar al umbral por sí mismo.
 *
 * La diferencia apareció en cuanto entraron cinco feeds: con `needs_alert` como
 * única condición, un "las acciones de X pesan por la inflación" de 6/10 se
 * anunciaba igual que una decisión de tipos. Cuatro avisos así y se deja de
 * mirar el teléfono, que es la única forma real de que este sistema falle.
 */
export function mereceAlerta(
  event: NormalizedEvent,
  scoring: { needs_alert: boolean; importance_score: number },
  umbral: number,
): boolean {
  if (scoring.importance_score >= umbral) return true;
  return event.official && scoring.needs_alert;
}
