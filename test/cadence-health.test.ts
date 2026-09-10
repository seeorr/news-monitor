import { describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { evaluateHealth, healthLimits, privateHealthNotice, sendOperationalNotice, type RunRecord } from "../src/pipeline/cadence.ts";
import { memorySeenStore } from "../src/pipeline/seen.ts";
import { fileRunStore } from "../src/db/cadence.ts";
const now = "2026-09-10T12:30:00.000Z";
const record = (extra: Partial<RunRecord> = {}): RunRecord => ({ id: randomUUID(), profile: "full", trigger: "schedule", mode: "full",
  startedAt: "2026-09-10T12:23:00.000Z", endedAt: "2026-09-10T12:24:00.000Z", captureCompletedAt: "2026-09-10T12:23:20.000Z", status: "success",
  sourcesOk: 4, sourcesFailed: 0, criticalOk: ["ecb-press", "fed-press"], criticalFailed: [], captured: 4, unique: 1,
  pendingBefore: 1, pendingAfter: 0, oldestPendingAt: null, scored: 1, sent: 1, ...extra });
describe("salud medible y aviso privado desactivado", () => {
  it("saludable, retrasado y sin ejecutar son distintos", () => {
    expect(evaluateHealth([record()], { now }).states).toEqual(["healthy"]);
    expect(evaluateHealth([record()], { now: "2026-09-10T12:50:00Z" }).states).toEqual(["delayed"]);
    expect(evaluateHealth([], { now }).states).toEqual(["no_recent_execution"]);
  });
  it("process-only verde no sana la captura ni una fuente crítica fallida", () => {
    const failure = record({ status: "partial", criticalOk: ["fed-press"], criticalFailed: ["ecb-press"], sourcesFailed: 1 });
    const processed = record({ profile: "process", startedAt: "2026-09-10T12:29:00Z", captureCompletedAt: null, criticalOk: [] });
    const report = evaluateHealth([failure, processed], { now, oldestPendingAt: "2026-09-10T09:00:00Z", blockedDeliveries: 1 });
    expect(report.states).toEqual(["delayed", "critical_source_failed", "aged_queue", "delivery_blocked"]);
    expect(report.criticalFailed).toEqual(["ecb-press"]);
  });
  it("SLO configurable, sin ocultar incumplimientos medidos", () => {
    expect(evaluateHealth([record()], { now, limits: healthLimits({ HEALTH_FAST_MINUTES: "5" }) }).states).toContain("delayed");
    expect(evaluateHealth([record()], { now, rateCaptureBreaches: 1 }).states).toContain("delayed");
    expect(() => healthLimits({ HEALTH_FAST_MINUTES: "-1" })).toThrow("invalid_health_limit");
  });
  it("historial durable sobrevive al reinicio y checkpoint conserva el mismo id", async () => {
    mkdirSync(".cache", { recursive: true }); const path = mkdtempSync(join(".cache", "run-history-"));
    const row = record(), first = fileRunStore(path);
    await first.put({ ...row, status: "running", endedAt: null }); await first.put(row);
    const rows = await fileRunStore(path).recent("2026-09-10T00:00:00.000Z");
    expect(rows).toEqual([row]);
  });
  it("el aviso preparado no envía sin habilitación explícita", async () => {
    const send = vi.fn(), report = evaluateHealth([], { now });
    expect(await privateHealthNotice(report, { enabled: false, send })).toBe(false); expect(send).not.toHaveBeenCalled();
    expect(await privateHealthNotice(report, { enabled: true, send })).toBe(true);
    expect(send).toHaveBeenCalledWith(expect.stringContaining("no_recent_execution"));
  });
  it("aviso operativo incierto no reenvía en el mismo día ni afecta al ledger financiero", async () => {
    const seen = memorySeenStore(), send = vi.fn(async () => "uncertain" as const), report = evaluateHealth([], { now });
    expect(await sendOperationalNotice(report, { enabled: false, now, seen, send })).toBe("disabled");
    expect(send).not.toHaveBeenCalled();
    expect(await sendOperationalNotice(report, { enabled: true, now, seen, send })).toBe("uncertain");
    expect(await sendOperationalNotice(report, { enabled: true, now, seen, send })).toBe("blocked");
    expect(send).toHaveBeenCalledTimes(1);
    expect(await seen.alertState?.("financial-event")).toBeNull();
  });
});
