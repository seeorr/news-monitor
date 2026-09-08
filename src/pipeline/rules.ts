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

export function applyRules(
  event: NormalizedEvent,
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
