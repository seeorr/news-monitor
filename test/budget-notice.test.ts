import { describe, expect, it, vi } from "vitest";
import { BUDGET_NOTICE_TEXT, sendBudgetNotice } from "../src/pipeline/cadence.ts";
import { memorySeenStore } from "../src/pipeline/seen.ts";

const at = "2026-09-14T14:10:00.000Z";

describe("aviso de cupo de IA agotado", () => {
  it("sale una sola vez por día UTC aunque el ciclo lo pida cada diez minutos", async () => {
    const seen = memorySeenStore();
    const send = vi.fn(async () => "sent" as const);
    expect(await sendBudgetNotice({ now: at, seen, send })).toBe("sent");
    expect(await sendBudgetNotice({ now: "2026-09-14T14:20:00.000Z", seen, send })).toBe("blocked");
    expect(await sendBudgetNotice({ now: "2026-09-14T23:59:59.000Z", seen, send })).toBe("blocked");
    expect(send).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledWith(BUDGET_NOTICE_TEXT);
    // Día UTC nuevo: vuelve a poder avisar.
    expect(await sendBudgetNotice({ now: "2026-09-15T00:05:00.000Z", seen, send })).toBe("sent");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("no comparte id con el aviso del vigilante: uno gastado no bloquea al otro", async () => {
    const seen = memorySeenStore();
    expect(await seen.claimAlert("operational-health:2026-09-14", { token: "vigilante" })).toBe(true);
    expect(await sendBudgetNotice({ now: at, seen, send: async () => "sent" })).toBe("sent");
  });

  it("un envío que lanza queda uncertain y no se repite solo ese día", async () => {
    const seen = memorySeenStore();
    const send = vi.fn(async (): Promise<"sent"> => { throw new Error("network"); });
    expect(await sendBudgetNotice({ now: at, seen, send })).toBe("uncertain");
    expect(await sendBudgetNotice({ now: at, seen, send })).toBe("blocked");
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("el texto no promete nada que dependa de la configuración ni lleva datos del ciclo", () => {
    expect(BUDGET_NOTICE_TEXT).toContain("00:00 UTC");
    expect(BUDGET_NOTICE_TEXT).not.toMatch(/\d{2,}\s*(intentos|reservas)/);
  });
});
