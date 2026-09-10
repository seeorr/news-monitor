import type { Scoring } from "../ai/cascade.ts";
import type { NormalizedEvent } from "../schema/event.ts";
import { detectRelevance, type RelevanceOptions } from "./relevance.ts";
import { recientes } from "./collect.ts";
export const NEWS_POLICY_VERSION = "two-level-v1";
export type NewsLevel = "important" | "brief" | "digest" | "dashboard" | "none";
export function decideNews(event: NormalizedEvent, scoring: Scoring | null, opts: RelevanceOptions & {
  now: string; briefThreshold?: number; importantThreshold?: number; watchlistImportantThreshold?: number; maxPendingHours?: number; maxItemAgeHours?: number;
}) {
  const relevance = detectRelevance(event, opts);
  const start = Date.parse(event.first_captured_at ?? event.retrieved_at);
  const expiresAt = new Date(start + (opts.maxPendingHours ?? 48) * 3600_000).toISOString();
  const expired = Date.parse(opts.now) >= Date.parse(expiresAt);
  const staleCapture = recientes([event], { now: new Date(start), maxAgeHours: opts.maxItemAgeHours ?? 72 }).length === 0;
  const importance = scoring?.importance_score ?? -1;
  const useful = relevance.admit && !expired && !staleCapture;
  const fact = useful && relevance.factuality === "fact" && !event.stale;
  const important = fact && relevance.evidence === "sufficient" &&
    (importance >= (opts.importantThreshold ?? 7) || (relevance.watchlistRelation === "direct_material" && importance >= (opts.watchlistImportantThreshold ?? 6)));
  const brief = fact && !important && importance >= (opts.briefThreshold ?? 5);
  const digest = useful && importance >= 4;
  const dashboard = relevance.admit && importance >= 3;
  const level: NewsLevel = important ? "important" : brief ? "brief" : digest ? "digest" : dashboard ? "dashboard" : "none";
  return { policyVersion: NEWS_POLICY_VERSION, assignedAt: opts.now, expiresAt, level,
    // Destinos de Telegram excluyentes incluso si el resumen corre antes que
    // una noticia aplazada por cuota: no depende de quién consiga enviar primero.
    eligible: { capture: true, process: useful, dashboard, telegramBrief: brief, morningBrief: digest && !brief && !important, importantAlert: important },
    reasons: [...relevance.reasons, ...(staleCapture ? ["stale_at_capture"] : []), expired ? "expired_interest" : scoring ? `assigned_${level}` : "awaiting_scoring"], relevance };
}
export type NewsDecision = ReturnType<typeof decideNews> & {
  deliveryFormat?: "brief_fallback"; nextAt?: string | null;
  updateOf?: { eventId: string; sourceUrl: string | null; previousFact: string; change: string };
};
