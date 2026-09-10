import { describe, expect, it } from "vitest";
import { agrupar } from "../src/pipeline/agrupar.ts";
import type { NormalizedEvent } from "../src/schema/event.ts";

const news = (id: string, title: string, publication: string): NormalizedEvent => ({
  id, source: "rss", source_url: `https://example.com/${id}`, kind: "news", title,
  summary: null, country: "🌐", series_id: "coverage-test",
  observed_at: publication, publication_at: publication,
  retrieved_at: "2026-09-10T12:00:00.000Z", actual: null, previous: null,
  consensus: null, unit: null, surprises: [], stale: false, official: false,
});

describe("no silenciar publicaciones distintas al agrupar el backlog", () => {
  it("separa dos publicaciones mensuales con el mismo titular", () => {
    const first = news("july", "Monthly economic outlook and inflation projections", "2026-07-10T10:00:00Z");
    const second = news("august", first.title, "2026-08-10T10:00:00Z");
    expect(agrupar([first, second])).toHaveLength(2);
    expect(agrupar([second, first])).toHaveLength(2);
  });

  it("usa publicación original aunque se capturen y actualicen el mismo día", () => {
    const first = news("old", "Quarterly outlook from the central bank", "2026-06-10T10:00:00Z");
    const second = news("current", first.title, "2026-09-10T10:00:00Z");
    first.observed_at = second.observed_at; // Misma actualización, publicación diferente.
    expect(agrupar([first, second])).toHaveLength(2);
  });

  it("mantiene recortes de 25 y 50 puntos como dos hechos", () => {
    const first = news("25bps", "Central bank cuts interest rates by 25 basis points amid slowing growth", "2026-09-10T10:00:00Z");
    const second = news("50bps", first.title.replace("25", "50"), "2026-09-10T10:02:00Z");
    expect(agrupar([first, second])).toHaveLength(2);
  });

  it("conserva actualizaciones cuantitativas aunque la prosa sea casi idéntica", () => {
    const first = news("3-1", "CPI rises to 3.1 percent in the latest release", "2026-09-10T10:00:00Z");
    const second = news("3-2", first.title.replace("3.1", "3.2"), "2026-09-10T10:02:00Z");
    expect(agrupar([first, second])).toHaveLength(2);
  });

  it("agrupa dos medios que cuentan el mismo recorte en una misma ventana", () => {
    const first = news("press", "Central bank cuts interest rates by 25 basis points amid slowing growth", "2026-09-10T10:00:00Z");
    const second = { ...news("official", first.title, "2026-09-10T10:01:00Z"), official: true };
    const [group] = agrupar([first, second]);
    expect(agrupar([first, second])).toHaveLength(1);
    expect(group?.representante.id).toBe("official");
    expect(group?.duplicados.map((entry) => entry.id)).toEqual(["press"]);
  });

  it("separa publicaciones apenas fuera de la ventana de 24 horas", () => {
    const first = news("day1", "Central bank releases its daily market operations", "2026-09-09T10:00:00Z");
    const second = news("day2", first.title, "2026-09-10T10:00:01Z");
    expect(agrupar([first, second])).toHaveLength(2);
  });
});
