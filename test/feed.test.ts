import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { attr, blocks, decodeEntities, parseFeed, tagText, toIso } from "../src/lib/feed.ts";

/** Los tres feeds tal y como los devolvieron sus servidores el 8 de septiembre de 2026. */
const fixture = (name: string) =>
  readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

const fed = fixture("fed-press.xml");
const ecb = fixture("ecb-press.xml");
const edgar = fixture("edgar-aapl.xml");

describe("RSS", () => {
  it("lee los elementos de un feed con CDATA y BOM, como el de la Fed", () => {
    const items = parseFeed(fed);
    expect(items).toHaveLength(2);
    expect(items[0]?.title).toContain("Federal Reserve Board announces termination");
    expect(items[0]?.link).toBe(
      "https://www.federalreserve.gov/newsevents/pressreleases/enforcement20260904a.htm",
    );
    expect(items[0]?.date).toBe("Fri, 4 Sep 2026 15:00:00 GMT");
  });

  // El feed del BCE viene entero en una línea: sin espacios entre etiquetas y sin
  // saltos. Un parser que se apoye en el formateado del XML no lee ni un elemento.
  it("lee un feed que viene sin saltos de línea, como el del BCE", () => {
    const items = parseFeed(ecb);
    expect(items.length).toBeGreaterThanOrEqual(2);
    expect(items[0]?.title).not.toBe("");
    expect(items[0]?.guid).toContain("ecb.europa.eu");
    expect(items[1]?.guid).not.toBe(items[0]?.guid);
  });

  it("no confunde la cabecera del canal con un elemento", () => {
    const titulos = parseFeed(fed).map((i) => i.title);
    expect(titulos).not.toContain("FRB: Press Release - All Releases");
  });
});

describe("Atom", () => {
  it("saca el enlace del atributo cuando la etiqueta se cierra sola", () => {
    const entradas = blocks(edgar, "entry");
    expect(entradas.length).toBeGreaterThan(0);
    const item = parseFeed(edgar)[0];
    expect(item?.link).toContain("https://www.sec.gov/Archives/edgar/data/320193/");
  });

  it("limpia el HTML del resumen en vez de mandárselo al modelo", () => {
    const item = parseFeed(edgar)[0];
    expect(item?.summary).not.toContain("<b>");
    expect(item?.summary).toContain("Filed:");
  });

  // "filing-date" no es "date": si el prefijo se trata a la ligera, el evento
  // acaba fechado con el día en vez de con el instante de aceptación.
  it("no toma <filing-date> por <date>", () => {
    const entrada = blocks(edgar, "entry")[0]!;
    expect(tagText(entrada, "date")).toBeNull();
    expect(tagText(entrada, "filing-date")).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("texto y atributos", () => {
  it("descodifica las entidades XML", () => {
    expect(decodeEntities("Board&#39;s &amp; Co &lt;x&gt;")).toBe("Board's & Co <x>");
  });

  it("devuelve null cuando la etiqueta no está o está vacía", () => {
    expect(tagText("<item><title></title></item>", "title")).toBeNull();
    expect(tagText("<item></item>", "pubDate")).toBeNull();
  });

  it("lee un atributo entrecomillado con comillas simples", () => {
    expect(attr("<link href='https://x.test/a' />", "link", "href")).toBe("https://x.test/a");
  });

  it("ignora el prefijo de espacio de nombres", () => {
    expect(tagText("<item><dc:date>2026-09-08</dc:date></item>", "date")).toBe("2026-09-08");
  });
});

describe("fechas", () => {
  it("entiende el RFC 822 de RSS y el ISO de Atom", () => {
    expect(toIso("Fri, 4 Sep 2026 15:00:00 GMT")).toBe("2026-09-04T15:00:00.000Z");
    expect(toIso("2026-09-01T16:30:35-04:00")).toBe("2026-09-01T20:30:35.000Z");
  });

  // Sin esto el resultado dependería de la zona de la máquina: en Madrid saldría
  // 07:08:53Z y en el runner de GitHub 09:08:53Z, para el mismo elemento.
  it("lee como UTC la fecha sin zona de Investing", () => {
    expect(toIso("2026-09-10 09:08:53")).toBe("2026-09-10T09:08:53.000Z");
    expect(toIso("2026-09-10T09:08")).toBe("2026-09-10T09:08:00.000Z");
  });

  it("no toca la fecha que sí declara su zona", () => {
    expect(toIso("2026-09-10 09:08:53 GMT")).toBe("2026-09-10T09:08:53.000Z");
    expect(toIso("Sep 10, 2026 08:22 GMT")).toBe("2026-09-10T08:22:00.000Z");
  });

  it("devuelve null antes que inventar una fecha", () => {
    expect(toIso("ayer por la tarde")).toBeNull();
    expect(toIso(null)).toBeNull();
  });
});
