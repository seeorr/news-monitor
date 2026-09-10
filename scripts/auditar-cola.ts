/**
 * Solo lectura de la cola. No recolecta, puntúa, reclama ni entrega.
 * --detalle escribe únicamente .cache/auditoria-cola.json; prohibido en Actions.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadConfig, loadDotEnv } from "../src/config.ts";
import { neonQueueStore } from "../src/db/queue.ts";
import { createLogger, type Logger, type LogFields } from "../src/lib/log.ts";
import { watchlistEfectiva } from "../src/pipeline/collect.ts";
import { planQueue } from "../src/pipeline/queue-plan.ts";
import { fileQueueStore, type QueueStore } from "../src/pipeline/queue.ts";
import type { RuleOptions } from "../src/pipeline/rules.ts";

/** Separado del CLI para probar el informe sin base, red ni credenciales. */
export async function auditQueue(queue: QueueStore, options: {
  now: string;
  maxScoring: number;
  scanLimit?: number;
  groupThreshold?: number;
  watchlist?: RuleOptions["watchlist"];
  log: Logger;
}) {
  const [stats, pending, delivery] = await Promise.all([
    queue.stats(options.now), queue.listPending(options.now, options.scanLimit),
    queue.listDeliveryPending(options.scanLimit),
  ]);
  const plan = planQueue(pending, { now: new Date(options.now), limit: options.maxScoring,
    watchlist: options.watchlist, groupThreshold: options.groupThreshold });
  for (const row of stats) {
    const [source, feed] = row.source_key.split(":");
    // El logger valida contra catálogos. Nunca escribe ids, títulos ni editor libre.
    const origin = { source: source as LogFields["source"], feed };
    options.log("QUEUE_STATS", { stage: "persist", ...origin,
      captured: row.captured, unique: row.unique, pending: row.pending,
      processing: row.processing, retryable: row.retryable_failed,
      scored: row.scored, discarded: row.discarded, processed: row.processed,
      deliveryPending: row.delivery_pending, oldestHours: Math.floor(row.oldest_pending_age_hours) });
    for (const [reason, count] of Object.entries(row.discarded_by_reason)) {
      options.log("QUEUE_DISCARDED", { stage: "persist", ...origin,
        queueReason: reason as LogFields["queueReason"], count });
    }
  }
  for (const [index, item] of plan.entries()) {
    const event = item.group.representante;
    options.log("QUEUE_PLAN", { stage: "scoring", source: event.source,
      feed: event.source === "rss" ? event.series_id ?? undefined : undefined,
      publisher: item.publisher, priority: item.reason, points: item.points, agePoints: item.agePoints,
      index: index + 1, count: item.entries.length });
  }
  options.log("AUDIT_COMPLETE", { stage: "cycle", total: stats.reduce((sum, row) => sum + row.unique, 0),
    pending: stats.reduce((sum, row) => sum + row.pending, 0), count: pending.length,
    deliveryPending: stats.reduce((sum, row) => sum + row.delivery_pending, 0) });
  return {
    at: options.now,
    scope: "Solo lectura. El escaneo reclamable rota por editor y envejece dentro de cada editor antes de aplicar scanLimit. Finalizaciones limitadas por scanLimit; estadísticas sobre toda la cola. No reclama, procesa ni entrega.",
    scanLimit: options.scanLimit ?? 500,
    maxScoring: options.maxScoring,
    stats,
    pendingSnapshots: pending,
    pendingDeliverySnapshots: delivery,
    plan: plan.map((item) => ({
      representativeId: item.group.representante.id, duplicateIds: item.group.duplicados.map((event) => event.id),
      publisher: item.publisher, reason: item.reason, base: item.base,
      agePoints: item.agePoints, points: item.points, firstCapturedAt: item.firstCapturedAt,
    })),
  };
}

async function main(): Promise<void> {
  const detail = process.argv.includes("--detalle");
  if (detail && process.env["GITHUB_ACTIONS"] === "true") throw new Error("private_detail_unavailable_in_actions");
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  loadDotEnv(join(repo, ".env"));
  const config = loadConfig();
  const log = createLogger();
  const queue = config.databaseUrl ? neonQueueStore(config.databaseUrl)
    : fileQueueStore(resolve(repo, config.stateDir));
  log("STATE_OPEN", { stage: "persist", source: config.databaseUrl ? "neon" : "file" });
  // Fallar aquí preserva 42P01 si falta la migración. No hace fallback a memoria.
  const watchlist = await watchlistEfectiva(config);
  const report = await auditQueue(queue, { now: new Date().toISOString(), maxScoring: config.maxScoringPerCycle,
    scanLimit: config.queueScanLimit, groupThreshold: config.umbralAgrupacion, watchlist, log });
  if (detail) {
    const cache = join(repo, ".cache");
    await mkdir(cache, { recursive: true });
    await writeFile(join(cache, "auditoria-cola.json"), JSON.stringify(report, null, 2), "utf8");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    createLogger()("UNHANDLED", { stage: "persist", error });
    process.exitCode = 1;
  });
}
