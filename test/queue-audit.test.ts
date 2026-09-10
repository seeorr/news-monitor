import { describe, expect, it } from "vitest";
import { auditQueue } from "../scripts/auditar-cola.ts";
import { createLogger } from "../src/lib/log.ts";
import { memoryQueueStore, type QueueStore } from "../src/pipeline/queue.ts";

const now = "2026-09-10T10:00:00.000Z";

describe("auditoría de cola en lectura", () => {
  it("explica prioridad sin capturar, reclamar ni cambiar estados y sin texto privado en consola", async () => {
    const queue = memoryQueueStore();
    await queue.capture([{ publisher: "secret-publisher", event: {
      id: "private-id", source: "sec-edgar", series_id: "PRIVATE_TICKER", kind: "filing",
      source_url: "https://private.example.test", title: "PRIVATE_TICKER inflation results",
      summary: "SECRET_BODY", country: "US", observed_at: now, retrieved_at: now,
      actual: null, previous: null, consensus: null, unit: null, surprises: [], stale: false, official: true,
    } }], now);
    const unexpected = async (): Promise<never> => { throw new Error("audit_mutated_queue"); };
    const readOnly: QueueStore = { ...queue, capture: unexpected, claim: unexpected,
      finish: unexpected, finishBatch: unexpected, completeDelivery: unexpected };
    const lines: string[] = [];
    const before = await queue.stats(now);
    const report = await auditQueue(readOnly, { now, maxScoring: 12,
      watchlist: ["PRIVATE_TICKER"], log: createLogger((line) => lines.push(line)) });
    expect(await queue.stats(now)).toEqual(before);
    expect(report.pendingSnapshots).toHaveLength(1);
    expect(report.plan).toMatchObject([{ reason: "watchlist", base: 4, agePoints: 0, points: 4 }]);
    expect(lines.join("\n")).not.toMatch(/PRIVATE_TICKER|SECRET_BODY|private-id|secret-publisher|private\.example/);
    expect(lines.map((line) => JSON.parse(line).code)).toEqual(["QUEUE_STATS", "QUEUE_PLAN", "AUDIT_COMPLETE"]);
  });

  it("tabla ausente falla con 42P01 sin fingir una cola vacía", async () => {
    const error = Object.assign(new Error("private database relation name"), { code: "42P01" });
    const queue: QueueStore = { ...memoryQueueStore(), stats: async () => { throw error; } };
    await expect(auditQueue(queue, { now, maxScoring: 12, log: createLogger(() => {}) })).rejects.toBe(error);
    const lines: string[] = [];
    createLogger((line) => lines.push(line))("UNHANDLED", { stage: "persist", error });
    expect(lines).toEqual(['{"code":"UNHANDLED","stage":"persist","error":"42P01"}']);
  });
});
