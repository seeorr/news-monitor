import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { memoryQueueStore, fileQueueStore } from "../src/pipeline/queue.ts";
import { memorySeenStore } from "../src/pipeline/seen.ts";
import { memoryControlStore, fileControlStore, BudgetExhausted } from "../src/pipeline/control.ts";
import { deliverNews, type NewsDeliveryOptions } from "../src/pipeline/news-delivery.ts";
import { captureCandidates, processQueue } from "../src/pipeline/queue-cycle.ts";
import { decideNews } from "../src/pipeline/news-policy.ts";
import { planQueue } from "../src/pipeline/queue-plan.ts";
import { sameStory, relatedUpdate } from "../src/pipeline/agrupar.ts";
import { scoreEvent, analyzeEvent, type CascadeDeps, type Scoring, type Analysis } from "../src/ai/cascade.ts";
import { formatImportant, formatInteresting } from "../src/notify/news-formats.ts";
import type { NormalizedEvent } from "../src/schema/event.ts";

export const NOW = "2026-09-10T10:00:00.000Z";
export const event = (id: string, title = "Copper production falls during maintenance", extra: Partial<NormalizedEvent> = {}): NormalizedEvent => ({
  id, title, summary: "The operator confirms a temporary reduction in copper production while maintenance is completed.",
  source: "rss", series_id: "cnbc-markets", source_url: `https://example.test/${id}`, kind: "news", country: null,
  observed_at: NOW, retrieved_at: NOW, actual: null, previous: null, consensus: null, unit: null,
  surprises: [], stale: false, official: false, ...extra,
});
const score = (importance = 5, one_liner = "La producción de cobre cae durante las tareas de mantenimiento."): Scoring => ({
  importance_score: importance, market_impact_score: importance, needs_alert: importance >= 7, sentiment: "neutral", one_liner,
});
const analysis: Analysis = { why_it_matters: "La menor oferta podría presionar a los compradores que dependen de esta producción.",
  catalysts: [], risks: ["No consta cuánto durará la interrupción."], affected_assets: [], what_to_watch: ["La confirmación del reinicio por parte del operador."] };
function options(extra: Partial<NewsDeliveryOptions> = {}) {
  return { now: NOW, queue: memoryQueueStore(), control: memoryControlStore(), seen: memorySeenStore(), deps: null,
    briefHour: 6, briefDay: 24, importantHour: 3, importantDay: 12, batchSize: 3, briefIntervalMinutes: 60,
    maxPendingHours: 48, maxDeep: 3, briefThreshold: 5, importantThreshold: 7, watchlistImportantThreshold: 6,
    canSend: true, maxItems: 500, ...extra, send: vi.fn(extra.send ?? (async (_body: string) => "sent" as const)) };
}
// `at` fecha la captura: la cola de entrega ordena por antigüedad, así que sin
// controlarla no se puede colocar nada "delante" de otra cosa en la ventana.
async function prepare(o: NewsDeliveryOptions, e: NormalizedEvent, s = score(), at = NOW) {
  await o.queue.capture([{ event: e, publisher: e.series_id! }], at);
  await o.queue.claim([e.id], { token: e.id, now: at });
  await o.queue.finishBatch([{ id: e.id, outcome: { state: "scored", score: s, needs_delivery: true } }], e.id, at);
}
function deps(parse: ReturnType<typeof vi.fn>): CascadeDeps {
  return { client: { messages: { parse } }, modelScoring: "existing-cheap-test", modelAnalysis: "existing-deep-test" } as unknown as CascadeDeps;
}

describe("dos niveles, con transportes simulados", () => {
  it("proveedores indisponibles paran el lote y conservan las otras candidatas", async () => {
    const o = options();
    await captureCandidates(o.queue, [event("a"), event("b", "Gold exports halted after mine closure")], { now: NOW, maxAgeHours: 72 });
    const unavailable = Object.assign(new Error("providers unavailable"), { code: "LLM_UNAVAILABLE" });
    const scorer = vi.fn().mockRejectedValue(unavailable);
    const result = await processQueue(o.queue, { now: () => NOW, maxScoring: 12, hasProcessed: o.seen.has, score: scorer });
    expect(result).toMatchObject({ attempted: 1, scored: 0, failed: 1 });
    expect(scorer).toHaveBeenCalledTimes(1);
    expect((await o.queue.stats()).reduce((n, row) => n + row.retryable_failed, 0)).toBe(1);
    expect(await o.queue.listPending(NOW)).toHaveLength(1);
  });
  it("hecho general produce breve sin modelo profundo ni watchlist", async () => {
    const parse = vi.fn(), o = options({ deps: deps(parse) });
    await prepare(o, event("general"));
    expect(await deliverNews(o)).toMatchObject({ sent: 1, deep: 0 });
    expect(parse).not.toHaveBeenCalled();
    expect(o.send.mock.calls[0]![0]).toContain("producción de cobre");
    expect(await o.control.getDecision("general")).toMatchObject({ level: "brief", eligible: { telegramBrief: true, importantAlert: false } });
  });
  it("hecho importante con contexto obtiene análisis, nunca un segundo breve", async () => {
    const parse = vi.fn().mockResolvedValue({ parsed_output: analysis, stop_reason: "end_turn" }), o = options({ deps: deps(parse) });
    await prepare(o, event("major"), score(8));
    await deliverNews(o); await deliverNews(o);
    expect(parse).toHaveBeenCalledTimes(1); expect(o.send).toHaveBeenCalledTimes(1);
    expect(o.send.mock.calls[0]![0]).toContain("inferencia");
    expect(await o.control.getDecision("major")).toMatchObject({ level: "important" });
  });
  it("watchlist material gana prioridad y umbral propio; una mención no basta", async () => {
    const watchlist = [{ ticker: "ACMX", nombre: "Acme" }];
    const direct = event("direct", "Acme cuts earnings guidance", { summary: "Acme confirms lower earnings guidance because its main production line is halted." });
    const incidental = event("incidental", "Copper production falls; Acme is among buyers mentioned");
    expect(decideNews(direct, score(6), { now: NOW, watchlist })).toMatchObject({ level: "important", relevance: { watchlistRelation: "direct_material" } });
    expect(decideNews(incidental, score(6), { now: NOW, watchlist })).toMatchObject({ level: "brief", relevance: { watchlistRelation: "incidental" } });
    const o = options({ watchlist, deps: deps(vi.fn()) });
    await o.queue.capture([direct, incidental].map((e) => ({ event: e, publisher: "same" })), NOW);
    expect(planQueue(await o.queue.listPending(NOW), { now: new Date(NOW), limit: 1, watchlist })[0]!.group.representante.id).toBe("direct");
    await prepare(o, event("incidental-send", incidental.title), score(6));
    expect((await deliverNews(o)).deep).toBe(0);
  });
  it("una actualización numérica enlaza el breve anterior y permite alerta detallada", async () => {
    const o = options({ deps: deps(vi.fn().mockResolvedValue({ parsed_output: analysis, stop_reason: "end_turn" })) });
    const first = event("first", "Acme cuts earnings guidance 5 percent", { summary: null });
    const next = event("next", "Acme cuts earnings guidance 50 percent", { summary: "Acme confirms a material reduction in its annual earnings guidance." });
    await prepare(o, first, score(5, "Acme recorta sus previsiones un 5 %.")); await deliverNews(o);
    await prepare(o, next, score(8, "Acme recorta sus previsiones un 50 %.")); await deliverNews(o);
    expect(o.send).toHaveBeenCalledTimes(2);
    expect(o.send.mock.calls[1]![0]).toContain("Antes: Acme recorta sus previsiones un 5 %.");
    expect(await o.control.getDecision("next")).toMatchObject({ updateOf: { eventId: "first" } });
    expect(relatedUpdate(first, next)).toBe(true);
  });
  it("una copia tardía se descarta sin puntuación ni mensaje adicional", async () => {
    const o = options(), e = event("original");
    await prepare(o, e); await deliverNews(o);
    await captureCandidates(o.queue, [{ ...e, id: "copy" }], { now: NOW, maxAgeHours: 72 });
    const scoring = vi.fn().mockResolvedValue(score());
    await processQueue(o.queue, { now: () => NOW, maxScoring: 12, score: scoring, hasProcessed: o.seen.has });
    await deliverNews(o); expect(scoring).not.toHaveBeenCalled(); expect(o.send).toHaveBeenCalledTimes(1);
    expect((await o.queue.storyContext(e)).find((r) => r.id === "copy")?.reason).toBe("duplicate_story");
  });
  it.each([
    ["Acme cuts guidance 5 percent", "Acme cuts guidance 50 percent"],
    ["Acme acquires Beta", "Acme does not acquire Beta"],
    ["Acme acquires Beta", "Delta acquires Beta"],
    ["Acme reports earnings in August", "Acme reports earnings in September"],
    ["Acme signs contract for 100 million", "Acme signs contract for 100 billion"],
  ])("no funde diferencias materiales: %s / %s", (a, b) => expect(sameStory(event("a", a), event("b", b))).toBe(false));
  it("resumen y avisos son excluyentes incluso antes de reclamar Telegram", () => {
    expect(decideNews(event("brief"), score(5), { now: NOW }).eligible).toMatchObject({ telegramBrief: true, morningBrief: false });
    expect(decideNews(event("important"), score(8), { now: NOW }).eligible).toMatchObject({ importantAlert: true, morningBrief: false });
    expect(decideNews(event("digest"), score(4), { now: NOW }).eligible).toMatchObject({ telegramBrief: false, importantAlert: false, morningBrief: true });
  });
  it("aprovecha una plaza sobrante reduciendo un lote de tres", async () => {
    const o = options({ briefHour: 3, briefIntervalMinutes: 0 });
    await o.control.reserve({ id: "previous", resource: "brief", units: 2, now: NOW, hourLimit: 3, dayLimit: 24 });
    for (let i = 0; i < 3; i++) await prepare(o, event(`partial-${i}`));
    await deliverNews(o);
    expect(o.send).toHaveBeenCalledTimes(1); expect(await o.queue.listDeliveryPending()).toHaveLength(2);
    expect((await o.control.stats(NOW)).find(r => r.resource === "brief")?.units).toBe(3);
  });
  it("un límite horario conserva la noticia y la entrega al liberar capacidad", async () => {
    const o = options({ briefHour: 1, briefIntervalMinutes: 0, batchSize: 1 });
    await prepare(o, event("a")); await prepare(o, event("b", "Gold production falls"));
    await deliverNews(o); await deliverNews(o);
    expect(o.send).toHaveBeenCalledTimes(1); expect(await o.queue.listDeliveryPending()).toHaveLength(1);
    expect((await o.control.getDecision("b"))?.reasons).toContain("deferred_quota_hour_limit");
    await deliverNews({ ...o, now: "2026-09-10T11:01:00.000Z" });
    expect(o.send).toHaveBeenCalledTimes(2); expect(await o.queue.listDeliveryPending()).toHaveLength(0);
  });
  it("de noche el breve espera sin gastar cupo y el importante sale igual", async () => {
    const noche = "2026-09-10T23:30:00.000Z"; // 01:30 en Madrid
    const o = options({ now: noche, briefQuietHours: { desde: 0, hasta: 8, zona: "Europe/Madrid" } });
    await prepare(o, event("breve"), score(5), noche);
    await prepare(o, event("urgente", "Gold exports halted after mine closure"), score(8, "Se detienen las exportaciones de oro."), noche);
    expect(await deliverNews(o)).toMatchObject({ sent: 1 });
    expect(o.send.mock.calls[0]![0]).toContain("exportaciones de oro");
    expect(await o.control.getDecision("breve")).toMatchObject({ nextAt: "2026-09-11T06:00:00.000Z" });
    expect((await o.control.getDecision("breve"))?.reasons).toContain("deferred_quiet_hours");
    expect((await o.control.stats(noche)).find((r) => r.resource === "brief")?.units ?? 0).toBe(0);
    expect((await o.queue.listDeliveryPending()).map((e) => e.id)).toEqual(["breve"]);
    await deliverNews({ ...o, now: "2026-09-11T06:04:00.000Z" }); // 08:04 en Madrid
    expect(o.send).toHaveBeenCalledTimes(2); expect(await o.queue.listDeliveryPending()).toHaveLength(0);
  });
  it("la antigüedad caduca con motivo explícito, sin renovar la primera captura", async () => {
    const o = options(); await prepare(o, event("old"));
    await deliverNews({ ...o, now: "2026-09-13T10:00:00.000Z" });
    expect(o.send).not.toHaveBeenCalled();
    expect((await o.control.getDecision("old"))?.reasons).toContain("expired_interest");
    expect(await o.queue.listDeliveryPending()).toHaveLength(0);
  });
  it("un breve irredactable se aparta solo y no bloquea el canal", async () => {
    // Regresión: el guardarraíl antifabricación salía del lote entero, así que
    // la noticia con una cifra sin respaldo encabezaba la cola cada ciclo y las
    // sanas caducaban a las 48 h sin enviarse. Debe apartarse ella, no el canal.
    const o = options();
    await prepare(o, event("veneno"), score(5, "El cobre cae un 9 % tras el cierre de la planta."));
    await prepare(o, event("sana-1")); await prepare(o, event("sana-2"));
    expect(await deliverNews(o)).toMatchObject({ sent: 1, failed: 1 });
    expect(o.send).toHaveBeenCalledTimes(1);
    const cuerpo = o.send.mock.calls[0]![0] as string;
    expect(cuerpo).not.toContain("9 %");
    expect(cuerpo.match(/producción de cobre/g)).toHaveLength(2);
    expect((await o.control.getDecision("veneno"))?.reasons).toContain("deferred_content_unsupported_fact");
    // Y deja de competir por la ventana: cerrada sin entregar, no pendiente.
    expect(await o.queue.listDeliveryPending()).toHaveLength(0);
    expect(await o.seen.alertState?.("veneno")).toBe("undeliverable");
  });
  it("fallo profundo degrada al hecho breve sin inventar números", async () => {
    const o = options({ deps: deps(vi.fn().mockRejectedValue(new Error("network"))) });
    await prepare(o, event("fallback"), score(8)); await deliverNews(o);
    expect(o.send).toHaveBeenCalledTimes(1); expect(o.send.mock.calls[0]![0]).not.toContain("inferencia");
    expect(await o.control.getDecision("fallback")).toMatchObject({ level: "important", deliveryFormat: "brief_fallback" });
    expect(() => formatInteresting(event("x"), score(5, "El cobre cae un 9 %."))).toThrow("short_fact_not_supported");
    expect(() => formatImportant(event("x"), score(8), { ...analysis, why_it_matters: "El impacto alcanza un 5 %." })).toThrow("analysis_numbers_not_supported");
  });
  it("entrega incierta no se reenvía, incluso si la cola seguía pendiente", async () => {
    const o = options({ send: vi.fn(async () => "uncertain" as const) });
    await prepare(o, event("uncertain")); await deliverNews(o); await deliverNews(o);
    expect(o.send).toHaveBeenCalledTimes(1); expect(await o.seen.alertState?.("uncertain")).toBe("uncertain");
  });
  it("un envío incierto deja rastro: estado HTTP o error, número de noticias, sin reenviar", async () => {
    const outcomes: unknown[] = [];
    const o = options({ send: async () => ({ state: "uncertain", code: "telegram_502" }) as never, onDeliveryOutcome: (x) => outcomes.push(x) });
    await prepare(o, event("unc"));
    expect(await deliverNews(o)).toMatchObject({ sent: 0, failed: 1 });
    expect(outcomes).toEqual([{ state: "uncertain", count: 1, http: 502 }]);
    const thrown = new Error("network down");
    const o2 = options({ send: async () => { throw thrown; }, onDeliveryOutcome: (x) => outcomes.push(x) });
    await prepare(o2, event("throw"));
    await deliverNews(o2);
    expect(outcomes.at(-1)).toEqual({ state: "uncertain", count: 1, error: thrown });
    // Cerrada en `uncertain`: la vuelta siguiente no la reenvía.
    await deliverNews(o2);
    expect(o2.send).toHaveBeenCalledTimes(1);
  });
  it("dos consumidores solo pueden reclamar una misma noticia", async () => {
    const o = options(); await prepare(o, event("race"));
    await Promise.all([deliverNews(o), deliverNews(o)]);
    expect(o.send).toHaveBeenCalledTimes(1);
  });
  it("presupuesto IA agotado no realiza la petición ni pierde la candidata", async () => {
    const o = options(), parse = vi.fn(); await captureCandidates(o.queue, [event("budget")], { now: NOW, maxAgeHours: 72 });
    const d = deps(parse); d.beforeRequest = async () => { throw new BudgetExhausted("2026-09-11T00:00:00Z"); };
    const result = await processQueue(o.queue, { now: () => NOW, maxScoring: 12, hasProcessed: o.seen.has, score: (e) => scoreEvent(e, d) });
    // El cupo funcionando no es un fallo: se informa aparte y el ciclo no sale en rojo.
    expect(result).toMatchObject({ attempted: 1, failed: 0, budgetExhausted: true });
    expect(parse).not.toHaveBeenCalled();
    expect((await o.queue.storyContext(event("budget")))[0]).toMatchObject({ state: "retryable_failed", reason: "budget_exhausted" });
  });
  it("cuenta cada reintento profundo y sus tokens reales, sin API", async () => {
    const parse = vi.fn().mockResolvedValueOnce({ parsed_output: { ...analysis, why_it_matters: "Impacto del 9876 %." }, usage: { input_tokens: 100, output_tokens: 30 } })
      .mockResolvedValueOnce({ parsed_output: analysis, usage: { input_tokens: 110, output_tokens: 40 } });
    const d = deps(parse), before = vi.fn(async () => "receipt"), after = vi.fn(async () => {});
    d.beforeRequest = before; d.afterRequest = after; await analyzeEvent(event("tokens"), d);
    expect(before.mock.calls.map((c: unknown[]) => c[0])).toEqual([
      expect.objectContaining({ attempt: 1, stage: "analysis" }), expect.objectContaining({ attempt: 2, stage: "analysis" }),
    ]);
    expect(after).toHaveBeenNthCalledWith(2, "receipt", { inputTokens: 110, outputTokens: 40, result: "success" });
  });
  it("al guardar, el análisis pasa el mismo control estricto que Telegram, también what_to_watch", async () => {
    // «3 meses» era un número «estructural» para el control anterior, y what_to_watch ni se miraba.
    const conCifraInventada = { ...analysis, what_to_watch: ["La producción de los próximos 3 meses."] };
    const parse = vi.fn().mockResolvedValueOnce({ parsed_output: conCifraInventada })
      .mockResolvedValueOnce({ parsed_output: analysis });
    const fabricaciones: string[][] = [];
    const d = { ...deps(parse), onFabrication: (_intento: number, v: string[]) => fabricaciones.push(v) };
    expect(await analyzeEvent(event("estricto"), d)).toEqual(analysis);
    expect(parse).toHaveBeenCalledTimes(2);
    expect(fabricaciones).toEqual([["la cifra 3 no aparece en los datos de entrada"]]);

    const siempreInventa = vi.fn().mockResolvedValue({ parsed_output: conCifraInventada });
    await expect(analyzeEvent(event("estricto-2"), deps(siempreInventa))).rejects.toMatchObject({ name: "FabricationError" });
    expect(siempreInventa).toHaveBeenCalledTimes(2);
  });
  it("al guardar, los activos que no están en la fuente se quitan", async () => {
    const conActivos = { ...analysis, affected_assets: [
      { symbol: "Copper", direction: "up" as const, confidence: 2 },
      { symbol: "ACME", direction: "down" as const, confidence: 1 },
    ] };
    const parse = vi.fn().mockResolvedValue({ parsed_output: conActivos });
    const guardado = await analyzeEvent(event("activos"), deps(parse));
    expect(guardado.affected_assets.map((a) => a.symbol)).toEqual(["Copper"]);
  });
});

/**
 * La cabeza de la cola de entrega.
 *
 * `listDeliveryPending` ordena por crítico, antigüedad e id, y devuelve como
 * mucho `maxItems`. Lo que entra en el lote sale de ahí y de `batchSize`. Un
 * candidato que falla siempre por la misma razón —una cifra que la fuente no
 * respalda— vuelve a encabezar esa lista en cada ciclo, y como el lote se corta
 * por delante, las noticias sanas que van detrás no llegan a entrar nunca.
 *
 * El arreglo de `f7e6b00` salva el lote —el irredactable no arrastra a los
 * demás— pero no la ventana: el irredactable sigue `delivery_pending` y sigue
 * siendo el primero mañana. Estos casos fijan que un fallo determinista deje de
 * competir por la ventana **sin** darse por entregado.
 */
describe("la cabeza de la cola no la ocupa un fallo determinista", () => {
  const veneno = (i: number) => `El cobre cae un ${i + 1} % tras el cierre de la planta.`;
  async function cola(o: NewsDeliveryOptions) {
    // Tres irredactables capturadas antes que tres sanas: van delante.
    for (let i = 0; i < 3; i++) await prepare(o, event(`v${i}`, `Plant ${i} halted`), score(5, veneno(i)), `2026-09-10T09:0${i}:00.000Z`);
    for (let i = 0; i < 3; i++) await prepare(o, event(`s${i}`, `Copper output falls in plant ${i}`), score(), `2026-09-10T09:1${i}:00.000Z`);
  }
  it("tres irredactables delante no impiden que salgan las sanas", async () => {
    const o = options({ briefIntervalMinutes: 0 });
    await cola(o);
    expect(await deliverNews(o)).toMatchObject({ sent: 1, failed: 3 });
    const cuerpo = o.send.mock.calls[0]![0] as string;
    expect(cuerpo).not.toContain("%");
    expect(cuerpo.match(/producción de cobre/g)).toHaveLength(3);
  });
  it("y siguen saliendo en ciclos sucesivos: el irredactable no vuelve a competir", async () => {
    const o = options({ briefIntervalMinutes: 0 });
    await cola(o);
    await deliverNews(o);
    // Décimo ciclo: la cola de entrega ya no tiene nada que ofrecer.
    for (let ciclo = 2; ciclo <= 10; ciclo++) await deliverNews({ ...o, now: `2026-09-10T${10 + ciclo}:00:00.000Z` });
    expect(o.send).toHaveBeenCalledTimes(1);
    expect(await o.queue.listDeliveryPending()).toHaveLength(0);
  });
  it("el irredactable queda cerrado como no entregable, nunca como entregado", async () => {
    const o = options({ briefIntervalMinutes: 0 });
    await cola(o);
    await deliverNews(o);
    for (const id of ["v0", "v1", "v2"]) {
      expect(await o.seen.alertState?.(id)).toBe("undeliverable");
      expect((await o.control.getDecision(id))?.reasons).toContain("deferred_content_unsupported_fact");
    }
  });
  it("un lote irreducible por longitud tampoco se queda a vivir en la cabeza", async () => {
    // Un solo breve que no cabe: el enlace de la fuente se lo come entero.
    const o = options({ batchSize: 1, briefIntervalMinutes: 0 });
    await prepare(o, event("gigante", "Copper production falls during maintenance",
      { source_url: `https://example.test/x?q=${"a".repeat(4200)}` }), score(), "2026-09-10T09:00:00.000Z");
    await prepare(o, event("sana"), score(), "2026-09-10T09:30:00.000Z");
    await deliverNews(o);
    expect((await o.control.getDecision("gigante"))?.reasons).toContain("deferred_content_too_long");
    expect(await o.seen.alertState?.("gigante")).toBe("undeliverable");
    await deliverNews({ ...o, now: "2026-09-10T11:00:00.000Z" });
    expect(o.send).toHaveBeenCalledTimes(1);
    expect(o.send.mock.calls[0]![0]).toContain("producción de cobre");
  });
});

describe("qué se hace con cada desenlace del transporte", () => {
  it("un 429 aplaza la noticia, respeta retry_after y la reintenta sin perderla", async () => {
    const o = options({ briefIntervalMinutes: 0, send: vi.fn()
      .mockResolvedValueOnce({ state: "rejected", rejection: "recoverable", retryAfterMs: 120_000, code: "telegram_429" })
      .mockResolvedValueOnce({ state: "sent" }) });
    await prepare(o, event("limitada"));
    await deliverNews(o);
    expect(await o.seen.alertState?.("limitada")).toBe("deferred");
    expect((await o.queue.listDeliveryPending()).map((r) => r.id)).toEqual(["limitada"]);
    expect((await o.control.getDecision("limitada"))?.reasons).toContain("deferred_transport_rate_limited");
    // Antes del plazo que pidió Telegram no se vuelve a llamar.
    await deliverNews({ ...o, now: "2026-09-10T10:01:00.000Z" });
    expect(o.send).toHaveBeenCalledTimes(1);
    await deliverNews({ ...o, now: "2026-09-10T10:03:00.000Z" });
    expect(o.send).toHaveBeenCalledTimes(2);
    expect(await o.seen.alertState?.("limitada")).toBe("sent");
    expect(await o.queue.listDeliveryPending()).toHaveLength(0);
  });
  it("un rechazo permanente no se reintenta jamás y deja de ocupar la cola", async () => {
    const o = options({ briefIntervalMinutes: 0, send: vi.fn(async () => ({ state: "rejected" as const, rejection: "permanent" as const, code: "telegram_400" })) });
    await prepare(o, event("prohibida"));
    await deliverNews(o); await deliverNews({ ...o, now: "2026-09-11T09:00:00.000Z" });
    expect(o.send).toHaveBeenCalledTimes(1);
    expect(await o.seen.alertState?.("prohibida")).toBe("rejected");
    expect(await o.queue.listDeliveryPending()).toHaveLength(0);
  });
  it("un timeout no provoca reenvío automático ni se libera por tiempo", async () => {
    const o = options({ briefIntervalMinutes: 0, send: vi.fn(async () => ({ state: "uncertain" as const, code: "telegram_408" })) });
    await prepare(o, event("dudosa"));
    await deliverNews(o);
    // Un mes después sigue bloqueada: `uncertain` no caduca. Solo una persona.
    await deliverNews({ ...o, now: "2026-10-10T10:00:00.000Z" });
    expect(o.send).toHaveBeenCalledTimes(1);
    expect(await o.seen.alertState?.("dudosa")).toBe("uncertain");
    expect(await o.seen.claimAlert("dudosa", { token: "otro", now: "2026-10-10T10:00:00.000Z" })).toBe(false);
  });
  it("sin credenciales el modo entregable falla de forma visible y no pierde la noticia", async () => {
    const o = options({ canSend: false });
    await prepare(o, event("sin-credenciales"));
    expect(await deliverNews(o)).toMatchObject({ telegramUnconfigured: true, sent: 0 });
    expect((await o.control.getDecision("sin-credenciales"))?.reasons).toContain("telegram_unconfigured");
    expect((await o.queue.listDeliveryPending()).map((r) => r.id)).toEqual(["sin-credenciales"]);
    expect(await o.seen.alertState?.("sin-credenciales")).toBeNull();
  });
  it("el fallo de la copia al grupo queda identificado aparte del privado", async () => {
    const o = options({ afterSent: vi.fn(async () => { throw new Error("grupo caído"); }) });
    await prepare(o, event("copia"));
    expect(await deliverNews(o)).toMatchObject({ sent: 1, failed: 0, groupFailed: 1 });
    expect(await o.seen.alertState?.("copia")).toBe("sent");
    const razones = (await o.control.getDecision("copia"))?.reasons ?? [];
    expect(razones).toContain("group_copy_failed");
    expect(razones).not.toContain("group_copy_sent");
  });
  it("una caída después de que Telegram acepte no produce un segundo mensaje", async () => {
    // El peor instante: el mensaje ya está en el teléfono y el proceso muere
    // antes de escribir nada de vuelta. Lo único que importa es la vuelta 2.
    const seen = memorySeenStore();
    vi.spyOn(seen, "saveAlert").mockRejectedValueOnce(new Error("el proceso se murió aquí"));
    const o = options({ seen, briefIntervalMinutes: 0 });
    await prepare(o, event("caida"));
    expect(await deliverNews(o)).toMatchObject({ sent: 0, failed: 1 });
    expect(o.send).toHaveBeenCalledTimes(1);
    // Queda en vuelo, y en vuelo se queda: ni el ciclo ni el reloj lo liberan.
    expect(await seen.alertState?.("caida")).toBe("sending");
    await deliverNews({ ...o, now: "2026-10-10T10:00:00.000Z" });
    expect(o.send).toHaveBeenCalledTimes(1);
    expect(seen.alerts).toHaveLength(0);
    expect(await o.queue.listDeliveryPending()).toHaveLength(0);
  });
  it("un rechazo del grupo no se confunde con un fallo del grupo ni con el privado", async () => {
    const o = options({ afterSent: vi.fn(async () => "rejected" as const) });
    await prepare(o, event("copia-rechazada"));
    expect(await deliverNews(o)).toMatchObject({ sent: 1, groupFailed: 1, groupSent: 0 });
    expect((await o.control.getDecision("copia-rechazada"))?.reasons).toContain("group_copy_rejected");
  });
});

describe("reservas persistentes independientes", () => {
  it("reabre archivo, impide sobrecupo concurrente y conserva decisiones", async () => {
    mkdirSync(".cache", { recursive: true }); const dir = mkdtempSync(join(process.cwd(), ".cache", "news-control-"));
    const stores = Array.from({ length: 12 }, () => fileControlStore(dir));
    const results = await Promise.all(stores.map((s, i) => s.reserve({ id: `r${i}`, resource: "brief", units: 1, now: NOW, hourLimit: 3, dayLimit: 3 })));
    expect(results.filter((r) => r.allowed)).toHaveLength(3);
    await stores[0]!.putDecision("x", decideNews(event("x"), score(), { now: NOW }));
    expect(await fileControlStore(dir).getDecision("x")).toMatchObject({ level: "brief" });
    expect(await fileControlStore(dir).reserve({ id: "important", resource: "important", units: 1, now: NOW, dayLimit: 1 })).toMatchObject({ allowed: true });
    expect(await fileControlStore(dir).reserve({ id: "tomorrow", resource: "brief", units: 1, now: "2026-09-11T10:00:00Z", dayLimit: 3 })).toMatchObject({ allowed: true });
  });
  it("120 llamadas admitidas como máximo; el coste desconocido no es cero", async () => {
    const c = memoryControlStore();
    const result = await Promise.all(Array.from({ length: 130 }, (_, i) => c.reserve({ id: `ai-${i}`, resource: "ai", units: 1, now: NOW, dayLimit: 120 })));
    expect(result.filter((r) => r.allowed)).toHaveLength(120);
    expect((await c.stats(NOW)).find((r) => r.resource === "ai")).toEqual({ resource: "ai", units: 120, calls: 120, costUsd: null });
  });
  it("31 capturadas, cupo 12, reinicio y feed vacío preservan 19; repetir no duplica", async () => {
    mkdirSync(".cache", { recursive: true }); const dir = mkdtempSync(join(process.cwd(), ".cache", "news-restart-"));
    let q = fileQueueStore(dir);
    const entries = Array.from({ length: 31 }, (_, i) => event(`n${i}`, `Copper production falls in plant ${i}`));
    await captureCandidates(q, entries, { now: NOW, maxAgeHours: 72 });
    const scoring = vi.fn().mockResolvedValue(score());
    await processQueue(q, { now: () => NOW, maxScoring: 12, hasProcessed: async () => false, score: scoring });
    q = fileQueueStore(dir); await captureCandidates(q, [], { now: NOW, maxAgeHours: 72 });
    expect(await q.listPending(NOW)).toHaveLength(19);
    expect(await captureCandidates(q, entries, { now: NOW, maxAgeHours: 72 })).toMatchObject({ unique: 0, repeated: 31 });
    expect(scoring).toHaveBeenCalledTimes(12);
  });
});
