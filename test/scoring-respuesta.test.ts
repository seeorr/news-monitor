import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { Scoring, scoreEvent } from "../src/ai/cascade.ts";
import type { NormalizedEvent } from "../src/schema/event.ts";

const evento: NormalizedEvent = {
  id: "rss:prueba:longitud", source: "rss", source_url: "https://example.com/news",
  kind: "news", title: "Acme anuncia que no habrá cierre de su fábrica.",
  summary: null, country: null, series_id: "prueba",
  observed_at: "2026-09-10T10:00:00Z", retrieved_at: "2026-09-10T10:01:00Z",
  actual: null, previous: null, consensus: null, unit: null,
  surprises: [], stale: false, official: false,
};
const valido: Scoring = {
  importance_score: 6, market_impact_score: 5, sentiment: "neutral",
  needs_alert: true, one_liner: "La empresa mantiene su fábrica abierta.",
};

/** El SDK y su helper parsean de verdad. Solo se sustituye el transporte HTTP:
 * nunca sale una petición de red ni se entrega parsed_output ya fabricado. */
function preparar(output: unknown) {
  const requests: Record<string, unknown>[] = [];
  const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
    requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return new Response(JSON.stringify({
      id: "msg_prueba", type: "message", role: "assistant", model: "test",
      content: [{ type: "text", text: JSON.stringify(output) }],
      stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  const client = new Anthropic({ apiKey: "test-no-real-key", fetch, maxRetries: 0 });
  const fallback = vi.fn();
  return {
    fetch, requests, fallback,
    deps: { client, modelScoring: "test", modelAnalysis: "test", onScoringSummaryFallback: fallback },
  };
}

describe("respuesta de scoring atravesando el parser del SDK real", () => {
  it("una cifra sin respaldo se sustituye antes de llegar a cola, dashboard o resumen", async () => {
    const { deps, fallback } = preparar({ ...valido, one_liner: "La empresa elimina 1000 empleos y sube un 5 %." });
    expect((await scoreEvent(evento, deps)).one_liner).toBe(evento.title);
    expect(fallback).toHaveBeenCalledTimes(1);
  });
  it("conserva todos los campos de una respuesta válida con una única llamada", async () => {
    const { deps, fetch, fallback, requests } = preparar(valido);
    expect(await scoreEvent(evento, deps)).toEqual(valido);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(JSON.stringify(requests[0]!.output_config)).toContain("180 caracteres");
  });

  it("acepta exactamente 200 caracteres sin modificar el resumen", async () => {
    const output = { ...valido, one_liner: "a".repeat(200) };
    const { deps, fetch, fallback } = preparar(output);
    expect(await scoreEvent(evento, deps)).toEqual(output);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("201 caracteres no pierden el evento: usa el titular íntegro, incluida su negación", async () => {
    const { deps, fetch, fallback } = preparar({ ...valido, one_liner: "a".repeat(201) });
    const result = await scoreEvent(evento, deps);
    expect(result).toEqual({ ...valido, one_liner: evento.title });
    expect(result.one_liner).toContain("no habrá cierre");
    expect(Scoring.safeParse(result).success).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledWith();
  });

  it("si tampoco cabe el titular, declara el hueco sin cortar una frase", async () => {
    const largo = { ...evento, title: "La empresa ".repeat(21) + "no cerrará la fábrica." };
    const { deps, fetch, fallback } = preparar({ ...valido, one_liner: "a".repeat(300) });
    const result = await scoreEvent(largo, deps);
    expect(result).toEqual({
      ...valido, one_liner: "Sin resumen breve; consulta el titular completo y la fuente.",
    });
    expect(Scoring.safeParse(result).success).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  });

  it.each([
    { importance_score: 6.5 }, { importance_score: 11 }, { importance_score: -1 },
    { market_impact_score: 5.5 }, { market_impact_score: 11 },
    { sentiment: "positive" }, { needs_alert: "true" }, { one_liner: 123 },
    // Un resumen largo no oculta que otro campo era inválido.
    { importance_score: 11, one_liner: "a".repeat(201) },
  ])("sigue rechazando campos inválidos sin reintentar: %j", async (change) => {
    const { deps, fetch, fallback } = preparar({ ...valido, ...change });
    await expect(scoreEvent(evento, deps)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
  });
});
