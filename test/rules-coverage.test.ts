import { describe, expect, it } from "vitest";
import { applyRules } from "../src/pipeline/rules.ts";

const news = (title: string, summary: string | null = null) => ({ title, summary, official: false });

// Patrones de falsos negativos observados en RSS públicos el 10-09-2026,
// reformulados: no se publica un corpus comercial ni una cartera de inversión.
describe("cobertura de divisas, energía y metales", () => {
  it.each([
    ["Sterling gains on BoE rate hike expectations", "macro"],
    ["BoJ signals a change to its monetary policy framework", "macro"],
    ["Bank considers a rate cut next week", "macro"],
    ["The employment situation report points to weaker hiring", "macro"],
    ["OPEC crude output declines as several producers curb pumping", "market"],
    ["Copper production falls during maintenance at major mines", "market"],
    ["Brent climbs following tanker attacks in Hormuz", "geopolitics"],
    ["Gold reacts to Treasury yield pressure", "macro"],
    ["Gold surges after a shortage of bullion supply", "market"],
    ["Copper inventories plunge across major warehouses", "market"],
    ["Dollar rallies as investors unwind short positions", "market"],
    ["Yen jumps during a broad currency sell-off", "market"],
    ["El oro se desploma al cierre de la sesión", "market"],
  ])("acepta un hecho identificable: %s", (title, reasonCode) => {
    expect(applyRules(news(title))).toMatchObject({ pass: true, reasonCode });
  });

  it("recupera el canal económico cuando solo está en la entradilla", () => {
    expect(applyRules(news("Further disruptions reported", "The closure blocks tanker traffic.")))
      .toMatchObject({ pass: true, reasonCode: "geopolitics" });
  });

  it.each([
    "Gold rally targets: Hourly levels",
    "Copper supply concerns: Live levels",
    "Dollar plunge scenario: Technical analysis",
    "Oil prices and OPEC: Technical levels",
    "Morning Bid: Fed inflation jitters",
  ])("descarta el formato mecánico aunque contenga términos que abrirían la puerta: %s", (title) => {
    expect(applyRules(news(title))).toMatchObject({ pass: false, reasonCode: "low_signal" });
  });

  it.each([
    "A dollar donated helps local schools",
    "The gold collection opens at the museum",
    "Copper cookware is back in fashion",
    "Silver jewellery exhibition starts today",
    "Pound and euro little changed at midday",
    "Five places to visit during a quiet week",
  ])("no acepta solo el nombre de una moneda o metal: %s", (title) => {
    expect(applyRules(news(title))).toMatchObject({ pass: false, reasonCode: "no_match" });
  });

  it("la mención vigilada no rescata highlights mecánicos", () => {
    expect(applyRules(news("ACMX earnings call highlights"), { watchlist: ["ACMX"] }))
      .toMatchObject({ pass: false, reasonCode: "low_signal" });
  });
});
