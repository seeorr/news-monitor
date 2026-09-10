import { expect, it } from "vitest";
import { priorizarGrupos } from "../src/pipeline/prioridad.ts";
import type { Grupo } from "../src/pipeline/agrupar.ts";
import type { NormalizedEvent } from "../src/schema/event.ts";

function grupo(id: string, feed: string, fecha: string, override: Partial<NormalizedEvent> = {}): Grupo {
  return {
    representante: {
      id, source: "rss", source_url: null, kind: "news", title: "Noticia de prueba",
      summary: null, country: null, series_id: feed, observed_at: fecha,
      retrieved_at: "2026-09-10T12:00:00Z", actual: null, previous: null,
      consensus: null, unit: null, surprises: [], stale: false, official: false,
      ...override,
    },
    duplicados: [],
  };
}

it("no deja una observación macro antigua detrás de titulares recién publicados", () => {
  const macro = grupo("macro", "serie", "2026-08-01", { source: "fred", kind: "macro_release", official: true });
  const prensa = grupo("prensa", "feed", "2026-09-10T11:00:00Z");
  expect(priorizarGrupos([prensa, macro]).map((g) => g.representante.id)).toEqual(["macro", "prensa"]);
});

it("un feed rápido no consume las plazas de todos los otros feeds", () => {
  const entradas = [
    grupo("a-nueva", "a", "2026-09-10T11:59:00Z"),
    grupo("a-media", "a", "2026-09-10T11:58:00Z"),
    grupo("a-vieja", "a", "2026-09-10T11:57:00Z"),
    grupo("b-nueva", "b", "2026-09-10T10:00:00Z"),
    grupo("b-vieja", "b", "2026-09-10T09:00:00Z"),
    grupo("c-nueva", "c", "2026-09-10T08:00:00Z"),
  ];
  const ids = priorizarGrupos(entradas).map((g) => g.representante.id);
  expect(ids).toEqual(["a-nueva", "b-nueva", "c-nueva", "a-media", "b-vieja", "a-vieja"]);
  expect(ids.slice(0, 3)).toEqual(["a-nueva", "b-nueva", "c-nueva"]);
  expect(entradas[1]!.representante.id).toBe("a-media");
});

it("Yahoo tiene una cola por fuente, no una plaza por ticker", () => {
  const entradas = [
    grupo("y-1", "ACMX", "2026-09-10T11:00:00Z", { source: "yahoo", kind: "market_move" }),
    grupo("y-2", "OTRO", "2026-09-10T10:00:00Z", { source: "yahoo", kind: "market_move" }),
    grupo("rss", "prensa", "2026-09-10T09:00:00Z"),
  ];
  expect(priorizarGrupos(entradas).map((g) => g.representante.id)).toEqual(["y-1", "rss", "y-2"]);
});

it("conserva duplicados y todos los pendientes al cambiar el orden", () => {
  const uno = grupo("uno", "a", "2026-09-10");
  const dos = grupo("dos", "b", "2026-09-10");
  uno.duplicados.push({ ...uno.representante, id: "duplicado" });
  const out = priorizarGrupos([uno, dos]);
  expect(out).toHaveLength(2);
  expect(out.find((g) => g.representante.id === "uno")).toBe(uno);
  expect(uno.duplicados).toHaveLength(1);
  expect(priorizarGrupos([])).toEqual([]);
});
