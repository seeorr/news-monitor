import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { dailyBriefStore, recentBriefEvents } from "../src/db/brief.ts";
import type { Ejecutor } from "../src/db/cliente.ts";
import { briefDependencies, parseBriefArgs, runBriefCli, sendBriefTelegram } from "../src/brief.ts";
import { generateBrief, runBrief, selectBriefEvents, type BriefDependencies,
  type BriefEvent, type BriefStore, type StoredBrief } from "../src/pipeline/brief.ts";
import { calcularRegimen, formatRegimen, type Regimen } from "../src/sources/regimen.ts";

const now = new Date("2026-09-09T06:00:00.000Z");
const event = (id: string, extra: Partial<BriefEvent> = {}): BriefEvent => ({
  id, title: `Titular privado ${id}`, one_liner: null, source: "rss", source_url: "https://example.org/news",
  kind: "news", observed_at: "2026-09-08", first_seen_at: "2026-09-08T12:00:00.000Z",
  importance_score: 7, stale: false, ...extra,
});
const regimen: Regimen = { asOf: now.toISOString(), version: "fixture-v1", state: "mixed", signals: [
  { id: "TEST", label: "Señal de prueba", sourceUrl: "https://example.org/series/TEST",
    date: "2026-09-08", value: 20, unit: "puntos", stale: false, vote: 0, detail: "Regla de prueba: 20 es mixto." },
] };

/** Simula operaciones atómicas, no pretende verificar un servidor Postgres. */
function memoryStore() {
  const rows = new Map<string, StoredBrief>();
  const tokens = new Map<string, string>();
  const store = {
    persist: vi.fn<BriefStore["persist"]>(async (brief) => {
      if (!rows.has(brief.date)) rows.set(brief.date, structuredClone({ ...brief, state: "generated" }));
      return structuredClone(rows.get(brief.date)!);
    }),
    claim: vi.fn<BriefStore["claim"]>(async (date, token) => {
      const row = rows.get(date);
      if (!row || !["generated", "rejected"].includes(row.state)) return null;
      row.state = "sending";
      tokens.set(date, token);
      return structuredClone(row);
    }),
    finish: vi.fn<BriefStore["finish"]>(async (date, token, state) => {
      const row = rows.get(date);
      if (!row || row.state !== "sending" || token !== tokens.get(date)) throw new Error("lost_claim");
      row.state = state;
    }),
  };
  return { store, rows };
}
function setup(extra: Partial<BriefDependencies> = {}) {
  const memory = memoryStore();
  const send = vi.fn<NonNullable<BriefDependencies["send"]>>().mockResolvedValue("sent");
  const deps: BriefDependencies = {
    events: async () => [event("fixture")], agenda: async () => [],
    regimen: async () => structuredClone(regimen), formatRegimen,
    store: memory.store, canSend: () => true, send, ...extra,
  };
  return { deps, send, ...memory };
}

describe("contenido determinista", () => {
  it("vacío declara carencias, fechas y cobertura desconocida", async () => {
    const { deps } = setup({ events: async () => [], regimen: async () => calcularRegimen({}, now) });
    const brief = await generateBrief(deps, { now });
    expect(brief.body).toContain("Sin eventos puntuados");
    expect(brief.body).toContain("no demuestra calma");
    expect(brief.body).toContain("insufficient_data");
    expect(brief.body).toContain("2026-09-08T06:00:00.000Z");
    expect(brief.body).toContain("https://fred.stlouisfed.org/releases");
    expect(brief.payload.coverage).toBe("unknown");
    expect(brief).toEqual(await generateBrief(deps, { now }));
  });

  it("fuentes caídas se declaran sin exponer errores ni perder el resto", async () => {
    const { deps } = setup({ agenda: async () => { throw new Error("api_key=SECRETO"); } });
    const brief = await generateBrief(deps, { now });
    expect(brief.body).toContain("Agenda no disponible");
    expect(brief.body).toContain("Titular privado fixture");
    expect(brief.payload.agenda.status).toBe("unavailable");
    expect(JSON.stringify(brief)).not.toContain("SECRETO");
  });

  it("fallos síncronos de eventos y régimen también son carencias", async () => {
    const { deps } = setup({ events: () => { throw Error("sql_privado"); }, regimen: () => { throw Error("secreto"); } });
    const brief = await generateBrief(deps, { now });
    expect(brief.payload.events.status).toBe("unavailable");
    expect(brief.payload.regimen.status).toBe("unavailable");
    expect(brief.body).toContain("actualidad desconocida");
    expect(brief.body).not.toContain("sql_privado");
  });

  it("respeta bordes 24 h, excluye futuros/calendario/no puntuados y desempata estable", () => {
    const rows = [event("old", { first_seen_at: "2026-09-08T05:59:59.999Z", importance_score: 10 }),
      event("end", { first_seen_at: now, importance_score: 10 }),
      event("future", { first_seen_at: "2026-09-10", importance_score: 10 }),
      event("calendar", { kind: "calendar", importance_score: 10 }),
      event("unscored", { importance_score: null }), event("invalid", { first_seen_at: "invalid" }),
      event("boundary", { first_seen_at: "2026-09-08T06:00:00Z", importance_score: 9 }),
      event("b"), event("a"), event("newer", { first_seen_at: "2026-09-09T05:00:00Z" }),
      event("fifth", { importance_score: 6 }), event("sixth", { importance_score: 5 })];
    expect(selectBriefEvents(rows, now).map((r) => r.id)).toEqual(["boundary", "newer", "a", "b", "fifth"]);
    expect(selectBriefEvents(rows.toReversed(), now)).toEqual(selectBriefEvents(rows, now));
  });

  it("acota texto extremo y conserva el payload completo con cinco eventos", async () => {
    const huge = "😀".repeat(10_000);
    const { deps } = setup({ events: async () => Array.from({ length: 5 }, (_, i) => event(`${i}`, {
      title: huge, source_url: `https://example.org/${"x".repeat(2000)}`,
    })), agenda: async () => Array.from({ length: 30 }, (_, i) => ({
      date: "2026-09-10", releaseId: i, title: huge, country: "XX",
    })), formatRegimen: () => huge });
    const brief = await generateBrief(deps, { now });
    expect(brief.body.length).toBeLessThanOrEqual(4096);
    expect(brief.body).not.toMatch(/[\uD800-\uDFFF]/u);
    expect(brief.body).toContain("detalle en registro");
    expect(brief.body).toContain("5. 7/10");
    expect(brief.body).toContain("AGENDA FRED");
    expect(brief.body).toContain("RÉGIMEN");
    expect(brief.body).toContain("Fuente: example.org");
    expect(brief.payload.events.status === "ok" && brief.payload.events.data[4]?.title).toBe(huge);
    expect(brief.payload.regimenText).toBe(huge);
  });

  it("integra valores, fechas y regla del formateador real de régimen", async () => {
    const { deps } = setup();
    const brief = await generateBrief(deps, { now });
    expect(brief.body).toContain("Regla: unanimidad");
    expect(brief.body).toContain("20 puntos · 2026-09-08");
    expect(brief.body).toContain(regimen.signals[0]!.sourceUrl);
    expect(brief.payload.regimen).toEqual({ status: "ok", data: regimen });
  });

  it("una señal de contexto sin voto no finge carencia si tiene datos", async () => {
    const { deps } = setup({ regimen: async () => ({ ...regimen, state: "risk_on",
      signals: [{ ...regimen.signals[0]!, id: "DTWEXBGS", vote: null }] }) });
    expect((await generateBrief(deps, { now })).payload.gaps).toEqual([]);
  });

  it("cuatro señales sintéticas conservan TODOS los valores, fechas y fuentes sin URLs repetidas", async () => {
    const ids = ["VIXCLS", "SP500", "BAMLH0A0HYM2", "DTWEXBGS"];
    const r: Regimen = { ...regimen, state: "risk_on", signals: ids.map((id, i) => ({
      ...regimen.signals[0]!, id, label: id, value: 123 + i, date: `2026-09-0${i + 1}`,
      sourceUrl: `https://example.org/${id}`, vote: i === 3 ? null : 1,
      detail: i === 3 ? "Contexto sin voto; no es DXY." : "Regla de prueba sintética.",
    })) };
    const { deps } = setup({ regimen: async () => r,
      events: async () => Array.from({ length: 5 }, (_, i) => event(String(i), {
        one_liner: "Contexto original de prueba sin modelo.",
      })) });
    const brief = await generateBrief(deps, { now });
    for (const s of r.signals) {
      expect(brief.body).toContain(`${s.label}: ${s.value} puntos · ${s.date}`);
      expect(brief.body.split(s.sourceUrl)).toHaveLength(2);
    }
    expect(brief.body).toContain("Liquidez no cubierta");
    expect(brief.body).toContain("Contexto original de prueba");
    expect(brief.body).toContain("5. 7/10");
    expect(brief.body.length).toBeLessThanOrEqual(4096);
    expect(brief.payload.gaps).toEqual([]);
  });

  it("one_liner conserva la prosa original y queda trazada en el payload", async () => {
    const { deps } = setup({ events: async () => [event("context", { one_liner: "Contexto ya persistido." })] });
    const brief = await generateBrief(deps, { now });
    expect(brief.body).toContain("Contexto: Contexto ya persistido.");
    expect(brief.payload.events.status === "ok" && brief.payload.events.data[0]?.one_liner)
      .toBe("Contexto ya persistido.");
  });

  it("agenda ordenada, filtrada, trazable y eventos obsoletos etiquetados", async () => {
    const agenda = vi.fn<BriefDependencies["agenda"]>().mockResolvedValue([
      { date: "2026-09-11", releaseId: 10, title: "IPC", country: "US" },
      { date: "2026-09-10", releaseId: 50, title: "Empleo", country: "US" },
      { date: "2026-08-01", releaseId: 10, title: "Pasado", country: "US" },
    ]);
    const { deps } = setup({ agenda, events: async () => [event("old-data", { stale: true })] });
    const brief = await generateBrief(deps, { now });
    expect(agenda).toHaveBeenCalledWith({ desde: "2026-09-09", dias: 7 });
    expect(brief.body.indexOf("Empleo")).toBeLessThan(brief.body.indexOf("IPC"));
    expect(brief.body).not.toContain("Pasado");
    expect(brief.body).toContain("OBSOLETO");
    expect(brief.payload.agendaWindow.to).toBe("2026-09-16");
  });
});

describe("persistencia y entrega", () => {
  it("por defecto persiste y nunca envía ni reclama", async () => {
    const { deps, store, send } = setup();
    expect((await runBrief(deps, { now })).state).toBe("generated");
    expect(store.persist).toHaveBeenCalledOnce();
    expect(store.claim).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("dry incluso con send no escribe, reclama ni comprueba credenciales", async () => {
    const canSend = vi.fn(() => true);
    const { deps, store, send } = setup({ canSend });
    expect((await runBrief(deps, { now, dry: true, send: true })).state).toBe("dry");
    expect(store.persist).not.toHaveBeenCalled();
    expect(store.claim).not.toHaveBeenCalled();
    expect(store.finish).not.toHaveBeenCalled();
    expect(canSend).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("veinte ejecuciones concurrentes envían una vez y los duplicados quedan bloqueados", async () => {
    const { deps, send, store } = setup();
    const results = await Promise.all(Array.from({ length: 20 }, () => runBrief(deps, { now, send: true })));
    expect(send).toHaveBeenCalledOnce();
    expect(results.filter((r) => r.state === "sent")).toHaveLength(1);
    expect(results.filter((r) => r.state === "blocked")).toHaveLength(19);
    expect(store.finish).toHaveBeenCalledOnce();
    expect((await runBrief(deps, { now, send: true })).state).toBe("blocked");
    expect(send).toHaveBeenCalledOnce();
  });

  it("envía el cuerpo ya persistido, aunque aparezcan otras noticias ese día", async () => {
    const { deps, send } = setup();
    const original = await runBrief(deps, { now });
    deps.events = async () => [event("nuevo-privado")];
    await runBrief(deps, { now: new Date("2026-09-09T07:00:00Z"), send: true });
    expect(send).toHaveBeenCalledWith(original.brief.body);
    expect(send.mock.calls[0]![0]).not.toContain("nuevo-privado");
  });

  it("fallo previo de credenciales permite un intento posterior", async () => {
    const { deps, send, store } = setup({ canSend: () => false });
    expect((await runBrief(deps, { now, send: true })).state).toBe("failed_before_send");
    expect(store.claim).not.toHaveBeenCalled();
    deps.canSend = () => true;
    expect((await runBrief(deps, { now, send: true })).state).toBe("sent");
    expect(send).toHaveBeenCalledOnce();
  });

  it("fallo de persistencia no hace claim ni envía", async () => {
    const { deps, send, store } = setup();
    store.persist.mockRejectedValueOnce(Error("db_private"));
    expect((await runBrief(deps, { now, send: true })).state).toBe("failed_before_send");
    expect(store.claim).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("rechazo explícito permite retry, sin reintentar dentro de la ejecución", async () => {
    const { deps, send } = setup();
    send.mockResolvedValueOnce("rejected");
    expect((await runBrief(deps, { now, send: true })).state).toBe("rejected");
    expect(send).toHaveBeenCalledOnce();
    expect((await runBrief(deps, { now, send: true })).state).toBe("sent");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("timeout ambiguo bloquea siguientes envíos", async () => {
    const { deps, send, rows } = setup();
    send.mockRejectedValueOnce(Error("timeout con contenido privado"));
    expect((await runBrief(deps, { now, send: true })).state).toBe("uncertain");
    expect(rows.get("2026-09-09")?.state).toBe("uncertain");
    expect((await runBrief(deps, { now, send: true })).state).toBe("blocked");
    expect(send).toHaveBeenCalledOnce();
  });

  it.each(["sent", "uncertain", "rejected"] as const)("si falla el registro de %s no libera el claim", async (outcome) => {
    const { deps, send, store, rows } = setup();
    send.mockResolvedValueOnce(outcome);
    store.finish.mockRejectedValueOnce(Error("db_unreachable"));
    expect((await runBrief(deps, { now, send: true })).state)
      .toBe(outcome === "sent" ? "record_failed_after_send" : "uncertain");
    expect(rows.get("2026-09-09")?.state).toBe("sending");
    expect((await runBrief(deps, { now, send: true })).state).toBe("blocked");
    expect(send).toHaveBeenCalledOnce();
  });

  it("si el claim se aplica pero se pierde su respuesta no envía ni lo recicla", async () => {
    const { deps, store, send } = setup();
    const claim = store.claim.getMockImplementation()!;
    store.claim.mockImplementationOnce(async (date, token) => { await claim(date, token); throw Error("lost_ack"); });
    expect((await runBrief(deps, { now, send: true })).state).toBe("failed_before_send");
    expect((await runBrief(deps, { now, send: true })).state).toBe("blocked");
    expect(send).not.toHaveBeenCalled();
  });

  it("fecha UTC cambia sin depender del huso horario", async () => {
    const { deps, rows } = setup();
    const result = await runBrief(deps, { now: new Date("2026-09-10T00:30:00+02:00") });
    expect(result.brief.date).toBe("2026-09-09");
    expect(rows.size).toBe(1);
  });
});

describe("contrato SQL y migración, sin ejecutar DB", () => {
  function spy(results: unknown[] = []) {
    const calls: { text: string; values: unknown[] }[] = [];
    const sql: Ejecutor = async (parts, ...values) => {
      calls.push({ text: parts.join("?"), values });
      return results.shift() ?? [];
    };
    return { sql, calls };
  }

  it("filtra ventana y calendar antes de LIMIT; ordena puntuación con fallback histórico", async () => {
    const { sql, calls } = spy();
    await recentBriefEvents(sql, now);
    const { text, values } = calls[0]!;
    expect(text).toContain("coalesce(e.importance_score, a.importance_score) is not null");
    expect(text).toContain("e.one_liner");
    expect(text).toContain("e.kind <> 'calendar'");
    expect(text).toContain("e.first_seen_at >= ?::timestamptz");
    expect(text).toContain("e.first_seen_at < ?::timestamptz");
    expect(text).toMatch(/order by coalesce\(e.importance_score, a.importance_score\) desc,\s+e.first_seen_at desc, e.id asc\s+limit 5/);
    expect(values).toEqual(["2026-09-08T06:00:00.000Z", now.toISOString()]);
    expect(text).not.toMatch(/where.*observed_at/);
  });

  it("INSERT no sobrescribe y el SELECT usa otro snapshot", async () => {
    const { deps } = setup();
    const brief = await generateBrief(deps, { now });
    const { sql, calls } = spy([[], [{ ...brief, state: "generated" }]]);
    expect(await dailyBriefStore(sql).persist(brief)).toEqual({ ...brief, state: "generated" });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.text).toContain("on conflict (brief_date) do nothing");
    expect(calls[0]!.text).not.toContain("Titular privado");
    expect(calls[0]!.values).toEqual([brief.date, brief.body, JSON.stringify(brief.payload)]);
    expect(calls[1]!.text).toContain("brief_date::text as date");
  });

  it("claim es un UPDATE condicional, sin caducidad, con token y cuerpo ganador", async () => {
    const { sql, calls } = spy();
    expect(await dailyBriefStore(sql).claim("2026-09-09", "claim-test")).toBeNull();
    const { text, values } = calls[0]!;
    expect(text).toContain("send_state = 'sending'");
    expect(text).toContain("send_state in ('generated', 'rejected')");
    expect(text).toContain("returning brief_date::text as date, body, payload");
    expect(text).not.toContain("interval");
    expect(values).toEqual(["claim-test", "2026-09-09"]);
  });

  it("finish exige propietario y detecta la pérdida del claim", async () => {
    const { sql, calls } = spy();
    await expect(dailyBriefStore(sql).finish("2026-09-09", "claim-test", "sent")).rejects.toThrow("brief_claim_lost");
    expect(calls[0]!.text).toContain("claim_token = ? and send_state = 'sending'");
  });

  it("migración idempotente tiene fecha única, payload, límite y estados explícitos", () => {
    const text = readFileSync(new URL("../neon/migrations/20260909_resumen_diario.sql", import.meta.url), "utf8");
    expect(text).toContain("create table if not exists daily_briefs");
    expect(text).toContain("brief_date date primary key");
    expect(text).toContain("payload jsonb not null");
    expect(text).toContain("between 1 and 4096");
    expect(text).toContain("'generated', 'sending', 'sent', 'rejected', 'uncertain'");
    expect(text).not.toMatch(/\b(drop|alter)\s+table/i);
  });
});

describe("Telegram simulado y privacidad CLI", () => {
  it.each([
    [200, { ok: true, result: { message_id: 1 } }, "sent"],
    [400, { ok: false, error_code: 400 }, "rejected"],
    [429, { ok: false, error_code: 429 }, "rejected"],
    [408, { ok: false, error_code: 408 }, "uncertain"],
    [500, { ok: false, error_code: 500 }, "uncertain"],
    [200, {}, "uncertain"], [400, {}, "uncertain"],
    [200, { ok: true }, "uncertain"],
  ])("HTTP %s y respuesta %j ⇒ %s", async (status, body, expected) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(body), { status: Number(status) }));
    expect(await sendBriefTelegram("fixture-token", "fixture-chat", "texto", request)).toBe(expected);
    expect(request).toHaveBeenCalledOnce();
    const submitted = JSON.parse(String(request.mock.calls[0]![1]!.body));
    expect(submitted.text).toBe("texto");
    expect(submitted.parse_mode).toBeUndefined();
  });

  it("red caída y cuerpo ilegible son inciertos sin retry", async () => {
    const request = vi.fn<typeof fetch>().mockRejectedValueOnce(Error("timeout"))
      .mockResolvedValueOnce(new Response("not JSON", { status: 502 }));
    expect(await sendBriefTelegram("fixture", "fixture", "texto", request)).toBe("uncertain");
    expect(request).toHaveBeenCalledTimes(1);
    expect(await sendBriefTelegram("fixture", "fixture", "texto", request)).toBe("uncertain");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it.each([[], ["--dry"], ["--send"]])("stdout sólo contiene estado y conteos con %j", async (...args) => {
    const { deps } = setup();
    const log = vi.fn();
    const preview = vi.fn();
    expect(await runBriefCli(args as string[], { deps, now, env: {}, log, preview })).toBe(0);
    expect(log.mock.calls.flat().join(" ")).not.toContain("Titular privado");
    expect(log.mock.calls.flat().join(" ")).toContain("eventos=1");
    expect(preview).not.toHaveBeenCalled();
  });

  it("preview sólo local, con dry; Actions se rechaza aunque diga false", async () => {
    expect(() => parseBriefArgs(["--preview"], {})).toThrow();
    for (const value of ["true", "false", ""]) {
      expect(() => parseBriefArgs(["--dry", "--preview"], { GITHUB_ACTIONS: value })).toThrow();
    }
    const { deps, store } = setup();
    const preview = vi.fn();
    expect(await runBriefCli(["--dry", "--preview"], { deps, now, env: {}, preview, log: vi.fn() })).toBe(0);
    expect(preview.mock.calls[0]![0]).toContain("Titular privado");
    expect(store.persist).not.toHaveBeenCalled();
  });

  it("error privado de DB/preview no aparece en salida", async () => {
    const { deps } = setup();
    const log = vi.fn();
    const preview = vi.fn().mockRejectedValue(Error("Titular privado api_key=SECRETO"));
    expect(await runBriefCli(["--dry", "--preview"], { deps, now, env: {}, preview, log })).toBe(1);
    expect(log.mock.calls.flat().join(" ")).not.toMatch(/Titular|SECRETO/);
  });

  it("sin configuración dry funciona y marca tres fuentes ausentes, sin red", async () => {
    const deps = briefDependencies({});
    const brief = await runBrief(deps, { now, dry: true });
    expect(brief.state).toBe("dry");
    expect(brief.brief.payload.gaps).toHaveLength(3);
    expect((await runBrief(deps, { now })).state).toBe("failed_before_send");
  });
});
