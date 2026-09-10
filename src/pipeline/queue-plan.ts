import { agrupar, type Grupo } from "./agrupar.ts";
import { applyRules, type RuleOptions } from "./rules.ts";
import type { QueueEntry } from "./queue.ts";
import { detectRelevance } from "./relevance.ts";

export interface QueuePlanItem {
  group: Grupo;
  entries: QueueEntry[];
  publisher: string;
  base: number;
  agePoints: number;
  points: number;
  reason: "macro_release" | "watchlist" | "material_news" | "news" | "routine_official";
  firstCapturedAt: string;
}

/** Un punto cada seis horas esperando. Sin techo: lo viejo acaba adelantando
 * incluso a una novedad importante. Ser oficial por sí solo no da prioridad. */
export function planQueue(
  entries: readonly QueueEntry[],
  opts: { now: Date; limit: number; capacity?: number; watchlist?: RuleOptions["watchlist"]; groupThreshold?: number },
): QueuePlanItem[] {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const groups = agrupar(entries.map((e) => e.event), { umbral: opts.groupThreshold });
  const candidates = groups.map((group): QueuePlanItem => {
    const members = [group.representante, ...group.duplicados].map((e) => byId.get(e.id)!);
    const representative = byId.get(group.representante.id)!;
    const firstCapturedAt = members.map((e) => e.first_captured_at).sort()[0]!;
    const agePoints = Math.floor(Math.max(0, opts.now.getTime() - Date.parse(firstCapturedAt)) / 21_600_000);
    const { base, reason } = signal(representative, opts.watchlist);
    return { group, entries: members, publisher: representative.publisher, base, agePoints,
      points: base + agePoints, reason, firstCapturedAt };
  });
  const compare = (a: QueuePlanItem, b: QueuePlanItem) => b.points - a.points ||
    a.firstCapturedAt.localeCompare(b.firstCapturedAt) || a.group.representante.id.localeCompare(b.group.representante.id);
  const queues = new Map<string, QueuePlanItem[]>();
  for (const candidate of candidates) {
    const queue = queues.get(candidate.publisher) ?? [];
    queue.push(candidate);
    queues.set(candidate.publisher, queue);
  }
  for (const queue of queues.values()) queue.sort(compare);
  const out: QueuePlanItem[] = [];
  const routineCap = Math.floor((opts.capacity ?? opts.limit) / 4);
  let routines = 0;
  while (queues.size && out.length < opts.limit) {
    // Una plaza por EDITOR y ronda; cinco feeds de Investing siguen siendo una.
    const round = [...queues.entries()].sort((a, b) => compare(a[1][0]!, b[1][0]!));
    for (const [publisher, queue] of round) {
      if (out.length >= opts.limit) break;
      // Varias instituciones rutinarias tampoco deben ocupar juntas el cupo:
      // como máximo un cuarto mientras quede una candidata no rutinaria.
      const protectNews = routines >= routineCap && [...queues.values()].some((items) =>
        items.some((item) => item.reason !== "routine_official"));
      const index = protectNews ? queue.findIndex((item) => item.reason !== "routine_official") : 0;
      if (index < 0) continue;
      const chosen = queue.splice(index, 1)[0]!;
      out.push(chosen);
      if (chosen.reason === "routine_official") routines++;
      if (!queue.length) queues.delete(publisher);
    }
  }
  return out;
}

function signal(entry: QueueEntry, watchlist: RuleOptions["watchlist"]): Pick<QueuePlanItem, "base" | "reason"> {
  const e = entry.event;
  if (e.kind === "macro_release") return { base: 4, reason: "macro_release" };
  // Se consulta sin privilegio oficial para detectar una relación concreta.
  const rule = applyRules({ ...e, official: false }, { watchlist });
  if (detectRelevance(e, { watchlist }).watchlistRelation === "direct_material" || e.kind === "market_move") {
    return { base: 4, reason: "watchlist" };
  }
  const text = `${e.title} ${e.summary ?? ""}`.toLowerCase();
  const routine = /\b(speech|remarks|working paper|appointment|appoints|conference|seminar|discurso|nombramiento|research paper|banknote)\b/u.test(text);
  const material = /\b(cpi|ppi|payrolls|employment situation|consumer price|producer price|rate decision|monetary policy|bank rate|interest rates|inflation|earnings|resultados)\b/u.test(text);
  const concreteDecision = /\b(rate decision|rate cut|rate hike|cuts? (?:interest|bank) rate|raises? (?:interest|bank) rate|announces? (?:a )?(?:cut|hike))\b/u.test(text);
  if (e.official && routine && !concreteDecision) return { base: 0, reason: "routine_official" };
  if (material || ["macro", "geopolitics", "market"].includes(rule.reasonCode)) return { base: 3, reason: "material_news" };
  return { base: 1, reason: "news" };
}
