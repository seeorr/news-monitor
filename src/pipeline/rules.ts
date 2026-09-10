/** Puerta de procesamiento: señales temáticas y evidencia son cosas distintas. */
import { applySignals, type Enjuiciable, type RuleOptions, type RuleDecision } from "./rules-core.ts";
import { detectRelevance } from "./relevance.ts";
export { RULE_REASON_CODES, MACRO_KEYWORDS, mereceAlerta } from "./rules-core.ts";
export type { RuleReasonCode, RuleDecision, RuleWatchlistEntry, RuleOptions, Enjuiciable } from "./rules-core.ts";
export function applyRules(event: Enjuiciable, opts: RuleOptions = {}): RuleDecision {
  const evidence = detectRelevance(event, opts);
  const signal = applySignals(event, opts);
  if (!evidence.admit) return { pass: false, reasonCode: ["rumour", "opinion", "promotion", "routine"].includes(evidence.factuality) ? "low_signal" : "no_match", reason: evidence.reasons.join("; ") };
  return { pass: true, reasonCode: signal.pass ? signal.reasonCode : evidence.topic === "corporate" ? "corporate" : "market", reason: evidence.reasons.join("; ") };
}
