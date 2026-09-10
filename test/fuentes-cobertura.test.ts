import { describe, expect, it } from "vitest";
import { parseFeed, toIso } from "../src/lib/feed.ts";
import { agrupar } from "../src/pipeline/agrupar.ts";
import { applyRules } from "../src/pipeline/rules.ts";
import { NormalizedEvent } from "../src/schema/event.ts";
import { FEEDS, getFeedPublisher, publisherForEvent, selectFeeds, toEvents } from "../src/sources/rss.ts";

// Estructura de los formatos públicos observados el 10-09-2026. Texto sintético;
// no se publican artículos comerciales ni datos de la watchlist.
const date = "Thu, 10 Sep 2026 10:00:00 GMT";
const retrievedAt = "2026-09-10T11:00:00.000Z";
const rss = (title: string, link: string, publication = date) =>
  `<rss version="2.0"><channel><item><title>${title}</title><link>${link}</link><pubDate>${publication}</pubDate></item></channel></rss>`;
const event = (feed: string, title: string, link = "https://example.com/article", publication = date) =>
  toEvents(parseFeed(rss(title, link, publication)), FEEDS[feed]!, { retrievedAt })[0]!;

describe("catálogo y activación progresiva", () => {
  it("preserva exactamente los ocho feeds previos por defecto", () => {
    expect(selectFeeds().map((spec) => spec.id)).toEqual([
      "fed-press", "ecb-press", "sec-press", "cnbc-markets", "yahoo-finance",
      "investing-economy", "investing-indicators", "investing-stocks",
    ]);
  });

  it("cada tanda incorpora pocos endpoints y mantiene identidad por editor", () => {
    expect(selectFeeds(["batch1"]).map((spec) => spec.id)).toEqual([
      "bls-employment", "bls-cpi", "bls-ppi", "eia-today",
    ]);
    expect(selectFeeds(["batch2"]).map((spec) => spec.id)).toEqual([
      "boe-news", "boe-publications", "boj-news",
    ]);
    expect(selectFeeds(["core", "batch1", "batch1"])).toHaveLength(12);
    expect(() => selectFeeds(["batch-typo"])).toThrow("rss_batch_unknown");
  });

  it("no duplica endpoints Investing ni da cinco cuotas al mismo editor", () => {
    const investing = Object.values(FEEDS).filter((spec) => spec.publisher === "investing");
    expect(investing).toHaveLength(5);
    expect(new Set(investing.map((spec) => spec.url)).size).toBe(5);
    expect(investing.filter((spec) => spec.batch !== "core").map((spec) => spec.url)).toEqual([
      "https://www.investing.com/rss/news_1.rss", "https://www.investing.com/rss/news_11.rss",
    ]);
    for (const spec of investing) expect(getFeedPublisher(spec.id)).toBe("investing");
    for (const id of ["bls-employment", "bls-cpi", "bls-ppi"]) expect(getFeedPublisher(id)).toBe("bls");
  });

  it("los candidatos bloqueados no se activan ni seleccionando todas las tandas", () => {
    const enabled = selectFeeds(["core", "batch1", "batch2", "batch3"]);
    expect(enabled.some((spec) => spec.enabled === false)).toBe(false);
    expect(enabled.some((spec) => spec.id === "eia-weekly-petroleum")).toBe(false);
    expect(FEEDS["eia-weekly-petroleum"]?.disabledReason).toBe("invalid_dates_and_stale_feed");
    expect(selectFeeds(["batch3"])).toEqual([]);
  });

  it("todas las incorporaciones declaran cobertura, catálogo, términos y atribución", () => {
    for (const spec of Object.values(FEEDS).filter((feed) => feed.batch !== "core")) {
      expect([spec.publisher, spec.topic, spec.region, spec.language, spec.attribution].every(Boolean)).toBe(true);
      expect(spec.catalogUrl).toMatch(/^https:\/\//);
      expect(spec.termsUrl).toMatch(/^https:\/\//);
      expect(new URL(spec.catalogUrl!).hostname).toBe(new URL(spec.url).hostname);
    }
    expect(new Set(Object.values(FEEDS).map((spec) => spec.url)).size).toBe(Object.keys(FEEDS).length);
  });

  it("no convierte tickers o series privadas en editores distintos", () => {
    expect(publisherForEvent({ source: "sec-edgar", series_id: "ACMX" })).toBe("sec");
    expect(publisherForEvent({ source: "yahoo", series_id: "ACMX" })).toBe("yahoo-market");
    expect(publisherForEvent({ source: "fred", series_id: "CPIAUCSL" })).toBe("fred");
    expect(publisherForEvent({ source: "rss", series_id: "investing-forex" })).toBe("investing");
    expect(getFeedPublisher("private-unknown-id")).toBe("rss-unknown");
  });
});

describe("fechas y contenido de las nuevas fuentes", () => {
  it("BLS conserva publicación original, content y captura sin inventar fecha del dato", () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry>
      <id>bls-cpi-release-1</id><title>CPI report for August</title>
      <link href="https://example.com/cpi-release"/><content>Consumer prices increased &amp; energy prices fell.</content>
      <published>2026-09-09T08:30:00-04:00</published><updated>2026-09-10T08:45:00-04:00</updated>
      </entry></feed>`;
    const [release] = toEvents(parseFeed(xml), FEEDS["bls-cpi"]!, { retrievedAt });
    expect(release?.observed_at).toBe("2026-09-09T12:30:00.000Z");
    expect(release?.publication_at).toBe("2026-09-09T12:30:00.000Z");
    expect(release?.data_period_at).toBeNull();
    expect(release?.retrieved_at).toBe(retrievedAt);
    expect(release?.summary).toBe("Consumer prices increased & energy prices fell.");
    expect(release?.actual).toBeNull();
    expect(release?.consensus).toBeNull();
    expect(release && NormalizedEvent.safeParse(release).success).toBe(true);
  });

  it("una actualización Atom sin publicación no inventa la publicación original", () => {
    const xml = `<feed><entry><id>no-publication</id><title>Updated document</title>
      <updated>2026-09-10T08:45:00-04:00</updated></entry></feed>`;
    const [release] = toEvents(parseFeed(xml), FEEDS["bls-cpi"]!, { retrievedAt });
    expect(release?.observed_at).toBe("2026-09-10T12:45:00.000Z");
    expect(release?.publication_at).toBeNull();
  });

  it("no fecha hoy el feed semanal EIA con fecha inválida", () => {
    expect(toIso("################### EST")).toBeNull();
    expect(toEvents(parseFeed(rss("Weekly petroleum report", "https://example.com/weekly", "################### EST")),
      FEEDS["eia-weekly-petroleum"]!, { retrievedAt })).toEqual([]);
  });

  it("respeta el offset de BOJ y diferencia ediciones en una URL reutilizada", () => {
    const first = event("boj-news", "Money stock monthly release", "http://www.boj.or.jp/en/statistics/reused.htm", "Thu, 10 Sep 2026 08:50:00 +0900");
    const repeat = event("boj-news", "Money stock monthly release", "http://www.boj.or.jp/en/statistics/reused.htm", "Thu, 10 Sep 2026 08:50:00 +0900");
    const next = event("boj-news", "Money stock monthly release", "http://www.boj.or.jp/en/statistics/reused.htm", "Fri, 11 Sep 2026 08:50:00 +0900");
    expect(first.observed_at).toBe("2026-09-09T23:50:00.000Z");
    expect(first.id).toBe(repeat.id);
    expect(first.id).not.toBe(next.id);
    expect(first.source_url).toBe("http://www.boj.or.jp/en/statistics/reused.htm");
  });

  it("Investing mantiene fecha sin zona como UTC y enlace como id estable", () => {
    const first = event("investing-forex", "Central bank rate decision", "https://example.com/fx", "2026-09-10 09:10:52");
    const repeat = event("investing-forex", "Central bank rate decision", "https://example.com/fx", "2026-09-10 09:10:52");
    expect(first.observed_at).toBe("2026-09-10T09:10:52.000Z");
    expect(first.summary).toBeNull();
    expect(first.id).toBe(repeat.id);
  });
});

describe("verificación de filtros y agrupación previa a cada tanda", () => {
  it.each([
    ["bls-employment", "Payroll employment increases in August; unemployment unchanged"],
    ["bls-cpi", "CPI increases in August; shelter rises"],
    ["bls-ppi", "PPI for final demand unchanged in August"],
    ["eia-today", "Natural gas regional supply changes"],
    ["boe-news", "Bank announces a financial stability measure"],
    ["boe-publications", "Monetary Policy Report - September 2026"],
    ["boj-news", "Summary of Opinions at the Monetary Policy Meeting"],
  ])("%s entra como fuente primaria y queda sujeto a prioridad y puntuación", (id, title) => {
    expect(applyRules(event(id, title))).toMatchObject({ pass: true, reasonCode: "official" });
  });

  it("agrupa una noticia de divisas repetida en economía; conserva el hecho distinto de energía", () => {
    const forex = event("investing-forex", "Central bank interest rate decision lifts euro", "https://example.com/fx");
    const economy = event("investing-economy", "Central bank interest rate decision lifts euro", "https://example.com/fx");
    const oil = event("investing-commodities", "Crude inventories plunge after supply disruption", "https://example.com/oil");
    expect([forex, economy, oil].every((entry) => applyRules(entry).pass)).toBe(true);
    const groups = agrupar([forex, economy, oil]);
    expect(groups).toHaveLength(2);
    expect(groups.reduce((sum, group) => sum + group.duplicados.length, 0)).toBe(1);
  });

  it("prefiere el comunicado BLS frente a su reproducción en prensa", () => {
    const title = "CPI increases in August as shelter prices rise";
    const groups = agrupar([event("investing-indicators", title), event("bls-cpi", title)]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.representante.series_id).toBe("bls-cpi");
  });

  it("un dato estructurado de FRED y el comunicado BLS siguen siendo conceptos distintos", () => {
    const headline = event("bls-cpi", "CPI report for August");
    const macro = { ...headline, id: "fred:cpi:2026-08-01", source: "fred" as const,
      kind: "macro_release" as const, actual: 3.1, observed_at: "2026-08-01", series_id: "CPI" };
    expect(agrupar([macro, headline])).toHaveLength(2);
  });
});
