/**
 * Los siete casos que el diagnóstico tiene que saber distinguir.
 *
 * No basta con una lista plana de estados: captura, procesamiento, entrega y
 * disparador son cuatro circuitos distintos y una captura manual reciente no
 * acredita ninguno de los otros tres.
 */
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { HEALTH_STATE_MEANING, evaluateHealth, type RunRecord } from "../src/pipeline/cadence.ts";

const now = "2026-09-10T12:30:00.000Z";
const record = (extra: Partial<RunRecord> = {}): RunRecord => ({ id: randomUUID(), profile: "full", trigger: "schedule", mode: "full",
  startedAt: "2026-09-10T12:23:00.000Z", endedAt: "2026-09-10T12:24:00.000Z", captureCompletedAt: "2026-09-10T12:23:20.000Z", status: "success",
  sourcesOk: 4, sourcesFailed: 0, criticalOk: ["ecb-press", "fed-press"], criticalFailed: [], captured: 4, unique: 1,
  pendingBefore: 1, pendingAfter: 0, oldestPendingAt: null, scored: 1, sent: 1, ...extra });

describe("diagnóstico: captura, procesamiento, entrega y disparador por separado", () => {
  it("1 · captura activa y procesamiento pausado no es ni healthy ni delayed", () => {
    // Horas en capture-only: la captura está al día y nadie procesa. Es una
    // pausa intencional, no un retraso.
    const runs = [record({ mode: "capture-only", startedAt: "2026-09-10T12:23:00.000Z", scored: 0, sent: 0 }),
      record({ mode: "capture-only", startedAt: "2026-09-10T12:08:00.000Z", captureCompletedAt: "2026-09-10T12:08:20.000Z", scored: 0, sent: 0 }),
      record({ mode: "capture-only", startedAt: "2026-09-10T08:00:00.000Z", captureCompletedAt: "2026-09-10T08:00:20.000Z", scored: 0, sent: 0 })];
    const report = evaluateHealth(runs, { now });
    expect(report.states).toEqual(["processing_paused"]);
    expect(report.capture.state).toBe("current");
    expect(report.processing.state).toBe("paused");
    expect(report.fullCircuit).toBe(false);
  });

  it("2 · disparador automático inactivo con pruebas manuales recientes", () => {
    const report = evaluateHealth([record({ trigger: "manual" }), record({ trigger: "manual", startedAt: "2026-09-10T12:10:00.000Z" })], { now });
    expect(report.states).toEqual(["trigger_inactive"]);
    expect(report.trigger.state).toBe("manual_only");
    expect(report.trigger.runs).toEqual({ external: 0, schedule: 0, manual: 2 });
    // La captura manual sí está viva: el problema es solo el disparador.
    expect(report.capture.state).toBe("current");
    expect(report.fullCircuit).toBe(false);
  });

  it("3 · fuentes parcialmente caídas, sin confundirlas con retraso de captura", () => {
    const sana = record({ startedAt: "2026-09-10T12:20:00.000Z", captureCompletedAt: "2026-09-10T12:20:20.000Z" });
    const parcial = record({ startedAt: "2026-09-10T12:26:00.000Z", captureCompletedAt: "2026-09-10T12:26:20.000Z",
      status: "partial", sourcesFailed: 1, criticalOk: ["ecb-press", "fed-press"], criticalFailed: ["boj-news"] });
    const report = evaluateHealth([sana, parcial], { now });
    expect(report.states).toEqual(["critical_source_failed", "execution_partial"]);
    expect(report.criticalFailed).toEqual(["boj-news"]);
    expect(report.criticalStale).toEqual([]);
    expect(report.capture.state).toBe("current");
  });

  it("4 · presupuesto agotado se ve y se cuenta", () => {
    const report = evaluateHealth([record()], { now, budgetExhaustedItems: 3, aiReservedToday: 120, aiCallsDay: 120 });
    expect(report.states).toEqual(["budget_exhausted"]);
    expect(report.budget).toEqual({ exhausted: true, items: 3, historicalItems: 3, reservedToday: 120, dayLimit: 120, remainingToday: 0 });
  });

  it("5 · Telegram sin configurar solo se declara cuando consta, no por omisión", () => {
    expect(evaluateHealth([record()], { now }).states).toEqual(["healthy"]);
    expect(evaluateHealth([record()], { now }).delivery.state).toBe("confirmed");
    const report = evaluateHealth([record({ sent: 0 })], { now, telegramConfigured: false });
    expect(report.states).toEqual(["telegram_unconfigured"]);
    expect(report.delivery.state).toBe("unconfigured");
    // En capture-only nadie entrega: faltar el token no es una incidencia.
    expect(evaluateHealth([record({ mode: "capture-only", scored: 0, sent: 0 })], { now, telegramConfigured: false }).states)
      .not.toContain("telegram_unconfigured");
  });

  it("6 · entrega rechazada o incierta se separa del bloqueo genérico", () => {
    const report = evaluateHealth([record()], { now, blockedDeliveries: 3, uncertainDeliveries: 1 });
    expect(report.states).toEqual(["delivery_blocked", "delivery_uncertain"]);
    expect(report.delivery.state).toBe("uncertain");
    expect(report.delivery.blocked).toBe(3);
    expect(report.delivery.uncertain).toBe(1);
  });

  it("7 · el circuito completo exige disparo automático, procesamiento y entrega acreditada", () => {
    const completo = evaluateHealth([record()], { now });
    expect(completo.states).toEqual(["healthy"]);
    expect(completo.fullCircuit).toBe(true);
    // Mismos datos, origen manual: deja de ser circuito completo.
    expect(evaluateHealth([record({ trigger: "manual" })], { now }).fullCircuit).toBe(false);
    // Automático pero sin procesar ni entregar: tampoco.
    expect(evaluateHealth([record({ mode: "capture-only", scored: 0, sent: 0 })], { now }).fullCircuit).toBe(false);
    // Automático y procesando, pero sin ninguna entrega acreditada: tampoco.
    expect(evaluateHealth([record({ scored: 1, sent: 0 })], { now }).fullCircuit).toBe(false);
  });
});

describe("incidencias antiguas y volumen", () => {
  it("una caída que nadie ha vuelto a intentar no deja el sistema en rojo para siempre", () => {
    // El perfil de hoy no incluye boj-news: la caída de hace seis días no se ha
    // reproducido ni desmentido. No es una caída en curso demostrable.
    const vieja = record({ startedAt: "2026-09-04T09:00:00.000Z", captureCompletedAt: "2026-09-04T09:00:20.000Z",
      status: "partial", sourcesFailed: 1, criticalOk: ["ecb-press"], criticalFailed: ["boj-news"] });
    const report = evaluateHealth([vieja, record()], { now });
    expect(report.states).toEqual(["healthy"]);
    expect(report.criticalFailed).toEqual([]);
    expect(report.criticalStale).toEqual(["boj-news"]);
  });

  it("una caída en curso sigue en rojo aunque venga de lejos", () => {
    const vieja = record({ startedAt: "2026-09-04T09:00:00.000Z", captureCompletedAt: "2026-09-04T09:00:20.000Z",
      status: "partial", sourcesFailed: 1, criticalOk: ["ecb-press"], criticalFailed: ["boj-news"] });
    const reciente = record({ startedAt: "2026-09-10T12:26:00.000Z", captureCompletedAt: "2026-09-10T12:26:20.000Z",
      status: "partial", sourcesFailed: 1, criticalOk: ["ecb-press", "fed-press"], criticalFailed: ["boj-news"] });
    const report = evaluateHealth([vieja, reciente, record()], { now });
    expect(report.states).toContain("critical_source_failed");
    expect(report.criticalFailed).toEqual(["boj-news"]);
    expect(report.criticalStale).toEqual([]);
  });

  it("la cola informa de cuántos y de cuán viejos, no solo de un booleano", () => {
    const report = evaluateHealth([record()], { now, oldestPendingAt: "2026-09-10T09:00:00.000Z", pendingItems: 521 });
    expect(report.states).toEqual(["aged_queue"]);
    expect(report.queue).toEqual({ pending: 521, oldestPendingAt: "2026-09-10T09:00:00.000Z", ageMinutes: 210, aged: true });
  });

  it("cada estado publicado tiene explicación en vocabulario cerrado", () => {
    const report = evaluateHealth([record({ mode: "capture-only", trigger: "manual", scored: 0, sent: 0 })],
      { now, telegramConfigured: false, uncertainDeliveries: 1, budgetExhaustedItems: 1, aiReservedToday: 120, aiCallsDay: 120 });
    expect(report.states).toEqual(["trigger_inactive", "processing_paused", "budget_exhausted", "delivery_uncertain"]);
    for (const state of report.states) expect(HEALTH_STATE_MEANING[state]).toBeTruthy();
    expect(Object.keys(HEALTH_STATE_MEANING)).toHaveLength(14);
  });
});
