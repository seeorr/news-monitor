/** Conteos del embudo RSS: ninguna prosa ni identificador de cartera sale al log. */
import { FEEDS } from "../sources/rss.ts";
import type { NormalizedEvent } from "../schema/event.ts";
import type { Logger } from "../lib/log.ts";
import { applyRules, type RuleDecision } from "./rules.ts";

export function registrarEmbudoFeeds(
  etapas: {
    events: NormalizedEvent[];
    fresh: NormalizedEvent[];
    candidates: NormalizedEvent[];
    nuevos: NormalizedEvent[];
    watchlist: NonNullable<Parameters<typeof applyRules>[1]>["watchlist"];
  },
  log: Logger,
): void {
  const contar = (events: NormalizedEvent[], feed: string) =>
    events.filter((e) => e.source === "rss" && e.series_id === feed).length;
  for (const feed of Object.keys(FEEDS)) {
    const total = contar(etapas.events, feed);
    if (total === 0) continue; // Vacío/fallo ya figura en SOURCE_OK / SOURCE_FAILED.
    const fresh = contar(etapas.fresh, feed);
    const passed = contar(etapas.candidates, feed);
    const nuevos = contar(etapas.nuevos, feed);
    log("FEED_FUNNEL", { source: "rss", stage: "dedupe", feed, total, fresh, passed,
      new: nuevos, seen: passed - nuevos, discarded: fresh - passed });
    const reasons = new Map<RuleDecision["reasonCode"], number>();
    for (const event of etapas.fresh) {
      if (event.source !== "rss" || event.series_id !== feed) continue;
      const { reasonCode } = applyRules(event, { watchlist: etapas.watchlist });
      reasons.set(reasonCode, (reasons.get(reasonCode) ?? 0) + 1);
    }
    for (const [reason, count] of reasons) {
      log("RULE_REASON", { source: "rss", stage: "rules", feed, reason, count });
    }
  }
}
