/** Contratos SQL sin red. No equivalen a una ejecución contra Postgres real. */
import { describe, expect, it } from "vitest";
import type { Ejecutor } from "../src/db/cliente.ts";
import { listarSinConfirmar, reconciliar } from "../src/db/reconciliacion.ts";

function probe(result: unknown = []) {
  const calls: Array<{ text: string; values: unknown[] }> = [];
  let response = result;
  const sql: Ejecutor = async (parts, ...values) => {
    calls.push({ text: parts.join(" ? ").replace(/\s+/g, " ").trim(), values });
    return response;
  };
  return { calls, sql, respond: (value: unknown) => { response = value; } };
}

describe("listado de entregas sin confirmar", () => {
  it("pide las inciertas y las en vuelo, y deja fuera los avisos operativos", async () => {
    const p = probe([]);
    await listarSinConfirmar(p.sql);
    const texto = p.calls[0]!.text;
    expect(texto).toContain("state in ('uncertain', 'sending')");
    expect(texto).toContain("event_id not like 'operational-%'");
  });

  it("trae el titular con left join: una entrega sin evento no puede desaparecer de la lista", async () => {
    const p = probe([]);
    await listarSinConfirmar(p.sql);
    expect(p.calls[0]!.text).toContain("left join events");
  });

  it("normaliza la fila y sobrevive a un evento que ya no existe", async () => {
    const p = probe([
      { event_id: "rss:x:1", state: "uncertain", attempts: 1, claimed_at: "2026-09-22T14:04:36.852Z",
        created_at: "2026-09-22T14:04:36.852Z", title: "Gold falls", kind: "news", observed_at: "2026-09-22T09:44:01.000Z" },
      { event_id: "rss:x:2", state: "sending", attempts: 2, claimed_at: null,
        created_at: null, title: null, kind: null, observed_at: null },
    ]);
    const filas = await listarSinConfirmar(p.sql);
    expect(filas).toHaveLength(2);
    expect(filas[0]).toMatchObject({ eventId: "rss:x:1", state: "uncertain", attempts: 1, title: "Gold falls" });
    expect(filas[0]!.claimedAt).toBe("2026-09-22T14:04:36.852Z");
    expect(filas[1]).toMatchObject({ eventId: "rss:x:2", title: null, claimedAt: null, publishedAt: null });
  });
});

describe("escritura del veredicto", () => {
  it("'llego' cierra en sent", async () => {
    const p = probe([{ event_id: "rss:x:1" }]);
    expect(await reconciliar(p.sql, "rss:x:1", "llego")).toBe(true);
    expect(p.calls[0]!.values).toEqual(["sent", "rss:x:1"]);
  });

  it("'no-llego' cierra en undeliverable", async () => {
    const p = probe([{ event_id: "rss:x:1" }]);
    expect(await reconciliar(p.sql, "rss:x:1", "no-llego")).toBe(true);
    expect(p.calls[0]!.values).toEqual(["undeliverable", "rss:x:1"]);
  });

  it("solo toca filas en 'uncertain': una en vuelo no se cierra por detrás", async () => {
    const p = probe([]);
    await reconciliar(p.sql, "rss:x:1", "no-llego");
    const texto = p.calls[0]!.text;
    expect(texto).toContain("state = 'uncertain'");
    expect(texto).not.toContain("sending");
  });

  it("no reescribe settled_at ni toca alerts", async () => {
    const p = probe([]);
    await reconciliar(p.sql, "rss:x:1", "llego");
    const texto = p.calls[0]!.text;
    expect(texto).not.toContain("settled_at");
    expect(texto).not.toContain("alerts");
    expect(texto).toContain("updated_at = now()");
  });

  it("devuelve false cuando no habia nada que cerrar", async () => {
    const p = probe([]);
    expect(await reconciliar(p.sql, "rss:desconocida", "llego")).toBe(false);
  });

  it("no escribe un estado fuera del CHECK del ledger", async () => {
    for (const veredicto of ["llego", "no-llego"] as const) {
      const p = probe([{ event_id: "x" }]);
      await reconciliar(p.sql, "x", veredicto);
      expect(["sent", "undeliverable"]).toContain(p.calls[0]!.values[0]);
    }
  });
});
