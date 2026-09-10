/**
 * Lector de feeds RSS 2.0 y Atom, sin dependencias.
 *
 * Un parser de XML completo son 300 KB de dependencia para leer cuatro etiquetas
 * de un formato que lleva veinte años congelado. Esto lee lo que un feed de
 * prensa publica de verdad —título, enlace, identificador, fecha y resumen— y
 * deja el XML crudo del elemento a mano para los campos propios de una fuente
 * (EDGAR mete el tipo de documento dentro de `<content>`).
 *
 * Lo que sí hace bien, porque es donde se rompen los parsers caseros:
 * CDATA, entidades, prefijos de espacio de nombres (`dc:date`), atributos con
 * comillas simples y elementos sin espacios entre ellos (el feed del BCE viene
 * en una sola línea).
 */

export interface FeedItem {
  title: string;
  link: string | null;
  /** Identificador estable del elemento: `guid`, `id` o, si no hay, el enlace. */
  guid: string | null;
  /** La fecha tal y como la publica el feed. Sin convertir: eso es cosa de `toIso`. */
  date: string | null;
  publicationDate?: string | null;
  updatedDate?: string | null;
  summary: string | null;
  /** XML del elemento, para leer campos que solo existen en una fuente. */
  raw: string;
}

/** Elementos del feed, en el orden en que vienen. RSS (`item`) y Atom (`entry`). */
export function parseFeed(xml: string): FeedItem[] {
  const bloques = [...blocks(xml, "item"), ...blocks(xml, "entry")];
  return bloques.map(toItem).filter((i) => i.title !== "");
}

function toItem(raw: string): FeedItem {
  const link = tagText(raw, "link") ?? attr(raw, "link", "href");
  const guid = tagText(raw, "guid") ?? tagText(raw, "id") ?? link;
  const publicationDate =
    tagText(raw, "pubDate") ??
    tagText(raw, "date") ?? // dc:date
    tagText(raw, "published");
  const updatedDate = tagText(raw, "updated");
  const date = publicationDate ?? updatedDate;
  const summary = tagText(raw, "description") ?? tagText(raw, "summary");

  return {
    title: (tagText(raw, "title") ?? "").trim(),
    link,
    guid,
    date,
    publicationDate,
    updatedDate,
    summary: summary === null ? null : sinHtml(summary),
    raw,
  };
}

/** Todos los `<nombre>…</nombre>` del documento, con su contenido. */
export function blocks(xml: string, name: string): string[] {
  const re = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "gi");
  return [...xml.matchAll(re)].map((m) => m[1] ?? "");
}

/**
 * Texto del primer `<nombre>` que aparezca, ignorando el prefijo de espacio de
 * nombres. Devuelve null si la etiqueta no existe o está vacía: un hueco es un
 * hueco, no una cadena vacía que luego parece un dato.
 */
export function tagText(xml: string, name: string): string | null {
  const re = new RegExp(`<(?:\\w+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:\\w+:)?${name}>`, "i");
  const m = re.exec(xml);
  if (!m || m[1] === undefined) return null;
  const valor = decodeEntities(unwrapCdata(m[1])).trim();
  return valor === "" ? null : valor;
}

/** Atributo de una etiqueta, incluidas las que se cierran solas (`<link href="…"/>`). */
export function attr(xml: string, tag: string, name: string): string | null {
  const re = new RegExp(`<(?:\\w+:)?${tag}\\s[^>]*${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i");
  const m = re.exec(xml);
  const valor = m?.[2] ?? m?.[3];
  return valor ? decodeEntities(valor).trim() : null;
}

function unwrapCdata(s: string): string {
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1");
}

/** Las cinco de XML más las numéricas. No hace falta la tabla HTML entera. */
export function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** Un resumen con etiquetas HTML dentro se queda en su texto. EDGAR manda `<b>` en el suyo. */
export function sinHtml(s: string): string {
  return unwrapCdata(s)
    .replace(/<br\s*\/?>/gi, " · ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Una fecha a la que le falta la zona horaria. Investing.com publica
 * `2026-09-10 09:08:53` y se queda ahí.
 */
const SIN_ZONA = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/;

/**
 * Fecha del feed a instante ISO. RSS trae RFC 822 ("Fri, 4 Sep 2026 15:00:00 GMT")
 * y Atom trae ISO 8601; `Date` entiende los dos.
 *
 * La fecha **sin zona** se lee como UTC, y eso es una decisión, no un detalle.
 * `Date.parse("2026-09-10 09:08:53")` la interpretaría como hora local, así que el
 * mismo elemento tendría un instante aquí y otro en el runner de GitHub, que va en
 * UTC: dos horas de diferencia en el campo que decide si una noticia es reciente o
 * ya no se mira. Investing publica en GMT —el 10 de septiembre de 2026 su elemento
 * más nuevo decía 09:08:53 mientras su propia cabecera `Date` decía 09:21 GMT, con
 * diez elementos repartidos en cuatro minutos—, así que UTC no solo es estable:
 * es lo que la fuente quiere decir.
 *
 * Devuelve null si no se puede interpretar. Un evento sin fecha fiable no se
 * descarta por eso, pero tampoco se le inventa la de hoy: eso lo convertiría en
 * noticia fresca cada vez que el cron pasa.
 */
export function toIso(date: string | null): string | null {
  if (!date) return null;
  const m = SIN_ZONA.exec(date.trim());
  const t = Date.parse(m ? `${m[1]}T${m[2]}Z` : date);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}
