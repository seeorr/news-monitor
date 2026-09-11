import { describe, expect, it } from "vitest";
import { contentFingerprint, memoryQueueStore, prepareQueueCaptures } from "../src/pipeline/queue.ts";
import type { NormalizedEvent } from "../src/schema/event.ts";

/**
 * Qué pasa cuando una fuente corrige el contenido y conserva el identificador.
 *
 * Hasta ahora, nada: el `on conflict` de la captura tocaba la última fecha y el
 * contador y **no miraba el contenido**, así que la corrección entraba, se
 * comparaba con la fila existente y se tiraba. El original no se sobrescribía
 * —eso estaba bien— pero la corrección era invisible: ni se guardaba, ni se
 * contaba, ni había forma de saber que había ocurrido.
 */

const base: NormalizedEvent = {
  id: "rss:ecb-press:revision",
  source: "rss",
  source_url: "https://www.ecb.europa.eu/press/pr/date/2026/html/decisions.en.html",
  kind: "news",
  title: "Monetary policy decisions",
  summary: "El Consejo de Gobierno ha decidido mantener los tipos.",
  country: "EA",
  series_id: null,
  observed_at: "2026-09-10T12:15:00.000Z",
  retrieved_at: "2026-09-10T12:20:00.000Z",
  actual: null,
  previous: null,
  consensus: null,
  unit: null,
  surprises: [],
  stale: false,
  official: true,
};

const con = (cambios: Partial<NormalizedEvent>): NormalizedEvent => ({ ...base, ...cambios });

/** Captura el mismo id dos veces y devuelve la fila resultante. */
async function capturarDosVeces(primero: NormalizedEvent, despues: NormalizedEvent) {
  const cola = memoryQueueStore();
  await cola.capture([{ event: primero, publisher: "ECB" }], "2026-09-10T12:20:00.000Z");
  await cola.capture([{ event: despues, publisher: "ECB" }], "2026-09-10T13:40:00.000Z");
  const filas = await cola.listPending("2026-09-10T14:00:00.000Z", 10);
  expect(filas, "el id es el mismo: tiene que seguir siendo una sola fila").toHaveLength(1);
  return filas[0]!;
}

describe("una fuente que corrige lo que ya publicó", () => {
  it("guarda la corrección sin tocar el original", async () => {
    const fila = await capturarDosVeces(base, con({
      title: "Monetary policy decisions (corrected)",
      summary: "El Consejo de Gobierno ha decidido BAJAR los tipos 25 puntos básicos.",
    }));

    // El histórico sigue siendo lo que se vio la primera vez. Esto ya era así y
    // no debe cambiar: sobrescribirlo sería perder lo que de verdad se observó.
    expect(fila.event.title).toBe("Monetary policy decisions");

    // Y esto es lo que faltaba: antes la corrección no existía en ninguna parte.
    expect(fila.revision).not.toBeNull();
    expect(fila.revision!.title).toBe("Monetary policy decisions (corrected)");
    expect(fila.revision_count).toBe(1);
    expect(fila.revised_at).toBe("2026-09-10T13:40:00.000Z");

    // La observación sigue contándose aparte de la revisión.
    expect(fila.capture_count).toBe(2);
  });

  it("una cifra distinta es una corrección, aunque el titular sea el mismo", async () => {
    const fila = await capturarDosVeces(
      con({ kind: "macro_release", title: "HICP flash estimate", actual: 2.1, unit: "%" }),
      con({ kind: "macro_release", title: "HICP flash estimate", actual: 2.7, unit: "%" }),
    );
    expect(fila.revision_count).toBe(1);
    expect(fila.revision!.actual).toBe(2.7);
    // El dato original no se pierde: es contra lo que se compara una revisión.
    expect(fila.event.actual).toBe(2.1);
  });

  it("reescribir la entradilla o añadir seguimiento a la URL NO es una corrección", async () => {
    const fila = await capturarDosVeces(base, con({
      summary: "El Consejo de Gobierno mantiene los tipos de interés sin cambios.",
      source_url: `${base.source_url}?utm_source=newsletter&utm_campaign=diario`,
      retrieved_at: "2026-09-10T13:39:00.000Z",
    }));
    // Si esto contara, el aviso de "noticia corregida" dejaría de significar
    // nada: los medios reescriben la entradilla continuamente.
    expect(fila.revision_count).toBe(0);
    expect(fila.revision).toBeNull();
    expect(fila.revised_at).toBeNull();
    expect(fila.capture_count).toBe(2);
  });

  it("ver la misma corrección dos veces no la cuenta dos veces", async () => {
    const cola = memoryQueueStore();
    const corregido = con({ title: "Monetary policy decisions (corrected)" });
    await cola.capture([{ event: base, publisher: "ECB" }], "2026-09-10T12:20:00.000Z");
    await cola.capture([{ event: corregido, publisher: "ECB" }], "2026-09-10T13:40:00.000Z");
    await cola.capture([{ event: corregido, publisher: "ECB" }], "2026-09-10T13:50:00.000Z");
    const [fila] = await cola.listPending("2026-09-10T14:00:00.000Z", 10);
    expect(fila!.revision_count).toBe(1);
    expect(fila!.capture_count).toBe(3);
  });

  it("las estadísticas dicen cuántas filas ha corregido cada fuente", async () => {
    const cola = memoryQueueStore();
    await cola.capture([{ event: base, publisher: "ECB" }], "2026-09-10T12:20:00.000Z");
    await cola.capture([{ event: con({ title: "Monetary policy decisions (corrected)" }), publisher: "ECB" }],
      "2026-09-10T13:40:00.000Z");
    const [stats] = await cola.stats("2026-09-10T14:00:00.000Z");
    expect(stats!.revised).toBe(1);
    expect(stats!.unique).toBe(1);
    expect(stats!.captured).toBe(2);
  });
});

describe("qué cuenta como contenido a efectos de corrección", () => {
  it("el mismo hecho escrito con otros espacios o mayúsculas es el mismo hecho", () => {
    expect(contentFingerprint(con({ title: "  MONETARY   policy Decisions  " })))
      .toBe(contentFingerprint(base));
    // Un punto final tampoco corrige nada.
    expect(contentFingerprint(con({ title: "Monetary policy decisions." })))
      .toBe(contentFingerprint(base));
  });

  it("una negación NO es el mismo hecho", () => {
    expect(contentFingerprint(con({ title: "ECB raises rates" })))
      .not.toBe(contentFingerprint(con({ title: "ECB does not raise rates" })));
  });

  it("una coma entre dígitos se respeta: 2,5 no es 25", () => {
    expect(contentFingerprint(con({ title: "Inflación del 2,5%" })))
      .not.toBe(contentFingerprint(con({ title: "Inflación del 25%" })));
  });

  it("la entradilla y la URL no entran en la huella", () => {
    expect(contentFingerprint(con({ summary: "otra cosa completamente distinta", source_url: "https://otro.example/x" })))
      .toBe(contentFingerprint(base));
  });
});

describe("filas escritas antes de que existiera la huella", () => {
  it("se les calcula sobre su original, sin inventarles una corrección", () => {
    const [fila] = prepareQueueCaptures([{ event: base, publisher: "ECB" }], "2026-09-10T12:20:00.000Z");
    // Se simula la fila antigua quitándole los campos que no existían.
    const { fingerprint, revision, revised_at, revision_count, ...antigua } = fila!;
    expect(fingerprint).toBe(contentFingerprint(base));
    expect(revision).toBeNull();
    expect(revised_at).toBeNull();
    expect(revision_count).toBe(0);
    expect(antigua.event.id).toBe(base.id);
  });
});
