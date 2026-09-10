/**
 * Auditoría de entrada RSS, sin LLM, envíos ni escrituras en Neon.
 * `--detalle` guarda los titulares y motivos en .cache/ (privado e ignorado por Git).
 * Los logs mantienen el vocabulario cerrado incluso al ejecutarlo localmente.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { neon } from "@neondatabase/serverless";
import { loadConfig, loadDotEnv } from "../src/config.ts";
import { createLogger } from "../src/lib/log.ts";
import { FEEDS, fetchFeed, toEvents } from "../src/sources/rss.ts";
import { recientes, porFecha, watchlistEfectiva } from "../src/pipeline/collect.ts";
import { applyRules } from "../src/pipeline/rules.ts";
import { agrupar } from "../src/pipeline/agrupar.ts";
import { registrarEmbudoFeeds } from "../src/pipeline/diagnostico.ts";
import { priorizarGrupos } from "../src/pipeline/prioridad.ts";
import type { NormalizedEvent } from "../src/schema/event.ts";

const log = createLogger();
async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  // Sin consultar el registro no se puede afirmar qué candidato es nuevo.
  if (!config.databaseUrl) {
    log("CONFIG_MISSING", { stage: "startup", variable: "DATABASE_URL", count: 1 });
    process.exitCode = 1;
    return;
  }
  const now = new Date();
  const watchlist = await watchlistEfectiva(config, (line) => console.log(line));
  const elegidos = config.feeds.length ? config.feeds : Object.keys(FEEDS);
  const events: NormalizedEvent[] = [];
  let failures = 0;
  for (const id of elegidos) {
    const spec = FEEDS[id];
    if (!spec) {
      log("FEED_UNKNOWN", { source: "rss", stage: "collect", count: 1 });
      failures++;
      continue;
    }
    try {
      const items = await fetchFeed(spec);
      const normalized = toEvents(items, spec, { retrievedAt: now.toISOString() });
      events.push(...normalized);
      log("FEED_NORMALIZED", { source: "rss", feed: id, stage: "collect", total: items.length,
        count: normalized.length, discarded: items.length - normalized.length });
      log("SOURCE_OK", { source: "rss", feed: id, stage: "collect", count: normalized.length });
    } catch (error) {
      failures++;
      log("SOURCE_FAILED", { source: "rss", feed: id, stage: "collect", error });
    }
  }

  const fresh = recientes(events, { now, maxAgeHours: config.maxItemAgeHours });
  const candidates = fresh.filter((e) => applyRules(e, { watchlist }).pass);
  // Una consulta SELECT, con parámetros. No se llama a seen.mark ni al ciclo.
  type Guardado = { id: string; importance_score: number | null; market_impact_score: number | null };
  let guardados: Guardado[] = [];
  if (config.databaseUrl && candidates.length) {
    const sql = neon(config.databaseUrl);
    guardados = await sql`select id, importance_score, market_impact_score from events
      where id = any(${candidates.map((e) => e.id)}::text[])` as Guardado[];
  }
  const seen = new Map(guardados.map((e) => [e.id, e]));
  const nuevos = porFecha(candidates.filter((e) => !seen.has(e.id)));
  registrarEmbudoFeeds({ events, fresh, candidates, nuevos, watchlist }, log);
  const grupos = priorizarGrupos(agrupar(nuevos, { umbral: config.umbralAgrupacion }));
  const budget = grupos.slice(0, config.maxScoringPerCycle);
  log("SCORING_LIMIT", { stage: "scoring", count: budget.length, discarded: grupos.length - budget.length });

  if (process.argv.includes("--detalle")) {
    // Nunca volcamos títulos/URLs en un log público de Actions.
    if (process.env["GITHUB_ACTIONS"] === "true") throw new Error("private_detail_unavailable_in_actions");
    const frescos = new Set(fresh.map((e) => e.id));
    const seleccionados = new Set(budget.map((g) => g.representante.id));
    const duplicados = new Map(grupos.flatMap((g) => g.duplicados.map((e) => [e.id, g.representante.id] as const)));
    const detalle = events.map((e) => {
      const decision = applyRules(e, { watchlist });
      const estado = !frescos.has(e.id) ? "antigua" : !decision.pass ? "descartada_reglas"
        : seen.has(e.id) ? "ya_procesada" : duplicados.has(e.id) ? "agrupada"
        : seleccionados.has(e.id) ? "pendiente_puntuacion" : "pendiente_cupo";
      return { id: e.id, feed: e.series_id, title: e.title, summary: e.summary, url: e.source_url,
        publishedAt: e.observed_at, estado, motivo: decision.reason, reasonCode: decision.reasonCode,
        puntuacionGuardada: seen.get(e.id) ?? null, representante: duplicados.get(e.id) ?? null };
    });
    await mkdir(".cache", { recursive: true });
    await writeFile(".cache/auditoria-filtros.json", JSON.stringify({
      fecha: now.toISOString(), alcance: "RSS actual; no ejecuta modelos ni envíos; el cupo real también lo comparten macro, filings y precios",
      deduplicacionConsultada: Boolean(config.databaseUrl), maxAgeHours: config.maxItemAgeHours,
      alertThreshold: config.alertThreshold, maxScoringPerCycle: config.maxScoringPerCycle, failures, eventos: detalle,
    }, null, 2), "utf8");
  }
  log("AUDIT_COMPLETE", { stage: "cycle", total: events.length, fresh: fresh.length,
    passed: candidates.length, new: nuevos.length, failed: failures });
  if (failures > 0) process.exitCode = 1;
}
main().catch((error: unknown) => {
  log("UNHANDLED", { stage: "cycle", error });
  process.exitCode = 1;
});
