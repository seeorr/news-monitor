import { describe, expect, it } from "vitest";
import { analyzeCadence, expectedScheduleSlots, type CadenceRun } from "../scripts/auditar-cadencia.ts";

const end = "2026-09-11T00:00:00Z";
const run = (databaseId: number, createdAt: string, extras: Partial<CadenceRun> = {}): CadenceRun => ({
  databaseId, createdAt, startedAt: createdAt, event: "schedule", status: "completed", conclusion: "success", ...extras,
});

describe("cadencia en lectura y sin confundir cron con ejecuciones manuales", () => {
  it("cuenta 48 slots UTC a :07 y :37, incluso desde una hora no redonda", () => {
    const slots = expectedScheduleSlots(new Date("2026-09-10T12:01:19Z"), new Date("2026-09-11T12:01:19Z"));
    expect(slots).toHaveLength(48);
    expect(slots[0]).toBe("2026-09-10T12:07:00.000Z");
    expect(slots.at(-1)).toBe("2026-09-11T11:37:00.000Z");
  });

  it("incluye el inicio y excluye el final de la ventana para no contar dos veces", () => {
    const result = analyzeCadence([
      run(1, "2026-09-10T00:00:00Z"), run(2, end), run(3, "2026-09-09T23:59:59Z"),
    ], { now: end });
    expect(result.schedule.created).toBe(1);
    expect(result.runs.map((row) => row.id)).toEqual([1]);
    expect(result.history.runsOutsideWindow).toBe(2);
  });

  it("separa los 11 programados de los dos manuales al calcular 11/48", () => {
    const scheduled = Array.from({ length: 11 }, (_, index) =>
      run(index + 1, `2026-09-10T${String(index + 1).padStart(2, "0")}:07:00Z`));
    const result = analyzeCadence([...scheduled,
      run(100, "2026-09-10T12:00:00Z", { event: "workflow_dispatch" }),
      run(101, "2026-09-10T13:00:00Z", { event: "workflow_dispatch" }),
    ], { now: end });
    expect(result.expected.slots).toBe(48);
    expect(result.schedule.created).toBe(11);
    expect(result.schedule.completedSuccess).toBe(11);
    expect(result.schedule.observedToExpectedPercent).toBe(22.92);
    expect(result.workflowDispatch.created).toBe(2);
    expect(result.allEvents.created).toBe(13);
  });

  it("calcula huecos interiores observados y marca por separado los bordes censurados", () => {
    const result = analyzeCadence([
      run(1, "2026-09-10T01:00:00Z"), run(2, "2026-09-10T03:00:00Z"), run(3, "2026-09-10T09:00:00Z"),
    ], { now: end });
    expect(result.schedule.creationGaps.maximumBetweenObservedRuns).toEqual({
      from: "2026-09-10T03:00:00.000Z", to: "2026-09-10T09:00:00.000Z", minutes: 360,
    });
    expect(result.schedule.creationGaps.censoredAtWindowStart?.minutes).toBe(60);
    expect(result.schedule.creationGaps.censoredAtWindowEnd?.minutes).toBe(900);
    expect(result.schedule.creationGaps.observedPairs).toBe(2);
  });

  it("el hueco vacío es una ventana censurada completa, no un intervalo medido entre runs", () => {
    const result = analyzeCadence([], { now: end });
    expect(result.schedule.creationGaps.maximumBetweenObservedRuns).toBeNull();
    expect(result.schedule.creationGaps.censoredAtWindowStart).toBeNull();
    expect(result.schedule.creationGaps.censoredAtWindowEnd).toBeNull();
    expect(result.schedule.creationGaps.wholeWindowWithoutObservedRun?.minutes).toBe(1440);
    expect(result.schedule.observedToExpectedPercent).toBe(0);
  });

  it("startedAt idéntico a createdAt se trata como inicio sin verificar, no espera cero", () => {
    const result = analyzeCadence([run(1, "2026-09-10T10:00:00Z")], { now: end });
    expect(result.runs[0]?.startQuality).toBe("equal_created_at_unverified");
    expect(result.runs[0]?.reportedStartLagMinutes).toBeNull();
    expect(result.schedule.starts.maximumReportedLagMinutes).toBeNull();
    expect(result.schedule.starts.jobStartVerified).toBe(false);
  });

  it("preserva un startedAt posterior sin llamarlo prueba del inicio del trabajo", () => {
    const result = analyzeCadence([run(1, "2026-09-10T10:00:00Z", { startedAt: "2026-09-10T10:05:30Z" })], { now: end });
    expect(result.runs[0]?.startQuality).toBe("after_created_reported");
    expect(result.runs[0]?.reportedStartLagMinutes).toBe(5.5);
    expect(result.runs[0]?.startedAtReported).toBe("2026-09-10T10:05:30.000Z");
    expect(result.meaning.internalProcessingVerified).toBe(false);
    expect(result.meaning.telegramDeliveryVerified).toBe(false);
  });

  it("señala inicios inválidos o ausentes sin inventarlos", () => {
    const result = analyzeCadence([
      run(1, "2026-09-10T10:00:00Z", { startedAt: "2026-09-10T09:59:00Z" }),
      run(2, "2026-09-10T11:00:00Z", { startedAt: null, status: "queued", conclusion: null }),
    ], { now: end });
    expect(result.schedule.starts.quality).toEqual({ before_created_invalid: 1, missing: 1 });
    expect(result.schedule.completedSuccess).toBe(1);
    expect(result.schedule.statuses).toEqual({ completed: 1, queued: 1 });
  });

  it("ordena la salida y evita duplicar un id repetido por la paginación", () => {
    const first = run(1, "2026-09-10T01:00:00Z");
    const second = run(2, "2026-09-10T02:00:00Z");
    const result = analyzeCadence([second, first, first], { now: end });
    expect(result.runs.map((row) => row.id)).toEqual([1, 2]);
    expect(result.schedule.created).toBe(2);
    expect(result.history.duplicateRunIds).toBe(1);
  });

  it("marca una lectura limitada que no alcanza el principio de la ventana", () => {
    const rows = [run(1, "2026-09-10T22:00:00Z"), run(2, "2026-09-10T23:00:00Z")];
    expect(analyzeCadence(rows, { now: end, requestedLimit: 2 }).history.coverage)
      .toBe("limit_reached_before_window_start");
    expect(analyzeCadence(rows, { now: end, requestedLimit: 500 }).history.coverage).toBe("window_covered");
  });

  it("declara fechas de creación inválidas y no vuelca textos arbitrarios", () => {
    const result = analyzeCadence([
      run(1, "invalid"), run(2, "2026-09-10T10:00:00Z", { event: "private-text", status: "private-status", conclusion: "private-error" }),
    ], { now: end });
    expect(result.history.ignoredInvalidCreatedAt).toBe(1);
    expect(result.history.coverage).toBe("uncertain_invalid_dates");
    expect(result.otherEvents.created).toBe(1);
    expect(JSON.stringify(result)).not.toContain("private-");
  });

  it("no atribuye un run retrasado a un slot concreto ni declara procesadas sus noticias", () => {
    const result = analyzeCadence([run(1, "2026-09-10T23:59:00Z")], { now: end });
    expect(result.meaning.expectedSlotsMatchedToRuns).toBe(false);
    expect(result.meaning.internalProcessingVerified).toBe(false);
    expect(result.meaning.equalCreatedAndStartedProvesImmediateStart).toBe(false);
  });

  it("rechaza ventanas inválidas", () => {
    expect(() => analyzeCadence([], { now: "invalid" })).toThrow("cadence_window_invalid");
    expect(() => analyzeCadence([], { now: end, hours: 0 })).toThrow("cadence_window_invalid");
  });
});
