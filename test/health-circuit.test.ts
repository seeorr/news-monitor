import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { evaluateHealth, type RunRecord } from "../src/pipeline/cadence.ts";

const now = "2026-09-14T12:30:00.000Z";
function run(extra: Partial<RunRecord> = {}): RunRecord {
  return {
    id: randomUUID(), profile: "full", trigger: "schedule", mode: "full",
    startedAt: "2026-09-14T12:20:00.000Z", endedAt: "2026-09-14T12:21:00.000Z",
    captureCompletedAt: "2026-09-14T12:20:20.000Z", status: "success",
    sourcesOk: 4, sourcesFailed: 0, criticalOk: ["ecb-press", "fed-press"], criticalFailed: [],
    captured: 4, unique: 1, pendingBefore: 1, pendingAfter: 0, oldestPendingAt: null,
    scored: 1, sent: 1, ...extra,
  };
}

describe("salud: evidencia del circuito y cuotas actuales", () => {
  it.each(["failed", "partial"] as const)("un run %s reciente no acredita procesamiento ni inventa la causa", status => {
    const health = evaluateHealth([run({ status, scored: 0, sent: 0 })], { now, deliveryConfirmedAt: "2026-09-14T12:15:00.000Z" });
    expect(health.states).toEqual([status === "failed" ? "execution_failed" : "execution_partial"]);
    expect(health.processing).toMatchObject({ state: "unproven", lastRunStatus: status, lastCompletedStatus: status, confirmedAt: null });
    expect(health.fullCircuit).toBe(false);
    expect(health.states).not.toContain("budget_exhausted");
    expect(health.states).not.toContain("telegram_unconfigured");
  });

  it("un running reciente sin final no acredita procesamiento", () => {
    const health = evaluateHealth([run({ status: "running", endedAt: null, scored: 0, sent: 0 })], { now });
    expect(health.processing).toMatchObject({ state: "running", lastCompletedAt: null, confirmedAt: null });
    expect(health.states).toEqual(["circuit_unproven"]);
    expect(health.fullCircuit).toBe(false);
  });

  it("un running nuevo conserva la prueba del éxito anterior mientras siga vigente", () => {
    const ongoing = run({ status: "running", startedAt: "2026-09-14T12:29:00.000Z", endedAt: null,
      captureCompletedAt: null, scored: 0, sent: 0, criticalOk: [] });
    const health = evaluateHealth([ongoing, run()], { now });
    expect(health.states).toEqual(["healthy"]);
    expect(health.fullCircuit).toBe(true);
    expect(health.processing).toMatchObject({ state: "current", lastRunStatus: "running", lastCompletedStatus: "success", inProgress: true });
  });

  it("el éxito anterior no tapa un fallo posterior ya completado", () => {
    const failed = run({ status: "failed", startedAt: "2026-09-14T12:27:00.000Z", endedAt: "2026-09-14T12:28:00.000Z", scored: 0, sent: 0 });
    const health = evaluateHealth([run(), failed], { now });
    expect(health.states).toEqual(["execution_failed"]);
    expect(health.fullCircuit).toBe(false);
  });

  it("un running nuevo no tapa un fallo reciente ni convierte un éxito caducado en vigente", () => {
    const running = run({ status: "running", startedAt: "2026-09-14T12:29:00.000Z", endedAt: null, scored: 0, sent: 0 });
    expect(evaluateHealth([run({ status: "failed" }), running], { now }).states).toContain("execution_failed");
    const old = run({ startedAt: "2026-09-14T08:00:00.000Z", endedAt: "2026-09-14T08:01:00.000Z", captureCompletedAt: "2026-09-14T08:00:20.000Z" });
    const health = evaluateHealth([old, running], { now });
    expect(health.processing.state).toBe("running");
    expect(health.fullCircuit).toBe(false);
    expect(health.states).not.toContain("healthy");
  });

  it("sin acuse de entrega declara circuito no acreditado aunque no haya fallos", () => {
    const health = evaluateHealth([run({ sent: 0 })], { now });
    expect(health.states).toEqual(["circuit_unproven"]);
    expect(health.delivery.state).toBe("unproven");
    expect(health.fullCircuit).toBe(false);
  });

  it("motivos históricos de presupuesto no prueban agotamiento del día", () => {
    const health = evaluateHealth([run()], { now, budgetExhaustedItems: 14, aiReservedToday: 5, aiCallsDay: 120 });
    expect(health.states).toEqual(["healthy"]);
    expect(health.budget).toMatchObject({ exhausted: false, historicalItems: 14, reservedToday: 5, remainingToday: 115 });
    const unmeasured = evaluateHealth([run()], { now, budgetExhaustedItems: 14 });
    expect(unmeasured.budget.exhausted).toBeNull();
    expect(unmeasured.states).not.toContain("budget_exhausted");
  });

  it("el cupo real agotado se declara aunque ninguna noticia conserve ese motivo", () => {
    const health = evaluateHealth([run()], { now, aiReservedToday: 120, aiCallsDay: 120 });
    expect(health.states).toEqual(["budget_exhausted"]);
    expect(health.budget).toMatchObject({ exhausted: true, historicalItems: 0, remainingToday: 0 });
    expect(evaluateHealth([run()], { now, aiReservedToday: 0, aiCallsDay: 0 }).budget.exhausted).toBe(true);
  });

  it("esperas vigentes y cierres terminales no son bloqueos", () => {
    const health = evaluateHealth([run()], { now, deferredDeliveries: 4, terminalDeliveries: 11 });
    expect(health.states).toEqual(["healthy"]);
    expect(health.delivery).toMatchObject({ blocked: 0, uncertain: 0, deferred: 4, terminal: 11 });
  });

  it("healthy implica siempre fullCircuit y viceversa en las combinaciones críticas", () => {
    for (const status of ["running", "failed", "partial", "success"] as const) {
      for (const mode of ["full", "capture-only", "process-only"] as const) {
        for (const trigger of ["manual", "schedule"] as const) {
          for (const sent of [0, 1]) {
            const health = evaluateHealth([run({ status, mode, trigger, sent, endedAt: status === "running" ? null : run().endedAt })], { now });
            expect(health.states.includes("healthy"), JSON.stringify({ status, mode, trigger, sent })).toBe(health.fullCircuit);
          }
        }
      }
    }
  });
});
