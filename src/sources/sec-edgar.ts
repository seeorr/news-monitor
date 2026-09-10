/**
 * SEC EDGAR — la tercera fuente, y la única que habla de empresas concretas.
 *
 * Un 8-K es la empresa contándole al regulador algo que tiene que contar: un
 * cambio de consejero delegado, unos resultados, una adquisición. Llega antes
 * que la prensa y sin interpretación por medio.
 *
 * Dos reglas de la SEC que condicionan el código:
 *
 * 1. **Exigen un User-Agent con un contacto real** (`nombre correo`). Sin él
 *    devuelven 403. Como este repositorio es público, ese contacto no puede
 *    vivir aquí: entra por `SEC_USER_AGENT`. Sin esa variable, la fuente se
 *    salta y se dice por qué — no se intenta a escondidas con otro agente.
 * 2. **Diez peticiones por segundo como máximo.** Aquí se pide una por empresa
 *    de la watchlist, con una pausa corta entre ellas.
 */
import { fetchJson, fetchText, type RetryOptions } from "../lib/http.ts";
import { blocks, tagText } from "../lib/feed.ts";
import { eventId, type NormalizedEvent } from "../schema/event.ts";

const BASE = "https://www.sec.gov";

/**
 * Documentos que mueven el precio. El resto del catálogo de EDGAR —sobre todo
 * los formularios 4 de compraventa de directivos— es ruido diario que se comería
 * la cuota de scoring sin decir nada.
 */
export const FORMS_DEFECTO = ["8-K", "10-Q", "10-K", "6-K", "20-F", "SC 13D"];

export interface Company {
  cik: string;
  ticker: string;
  name: string | null;
}

/** Un documento tal y como lo publica el feed de EDGAR. */
export interface Filing {
  accession: string;
  formType: string;
  formName: string | null;
  filedAt: string;
  url: string | null;
  items: string | null;
}

/** El User-Agent que la SEC exige. Sin contacto no hay peticiones. */
export function secHeaders(userAgent: string): Record<string, string> {
  return { "User-Agent": userAgent, Accept: "application/atom+xml, text/xml" };
}

interface TickerRow {
  cik_str: number;
  ticker: string;
  title: string;
}

let cacheTickers: Map<string, Company> | null = null;

/**
 * Resuelve tickers a CIK con el mapa oficial de la SEC.
 *
 * Un ticker no identifica una empresa en EDGAR: el identificador es el CIK. Se
 * resuelve contra la fuente en vez de mantener una tabla a mano, que es la clase
 * de dato que se queda obsoleto sin avisar. El mapa se cachea en memoria: en un
 * ciclo se pide una vez.
 */
export async function resolveTickers(
  tickers: string[],
  userAgent: string,
  opts: RetryOptions = {},
): Promise<{ companies: Company[]; unknown: string[] }> {
  if (tickers.length === 0) return { companies: [], unknown: [] };

  if (cacheTickers === null) {
    const raw = await fetchJson<Record<string, TickerRow>>(`${BASE}/files/company_tickers.json`, {
      ...opts,
      headers: secHeaders(userAgent),
    });
    cacheTickers = new Map();
    for (const row of Object.values(raw)) {
      if (!row?.ticker) continue;
      cacheTickers.set(row.ticker.toUpperCase(), {
        cik: String(row.cik_str).padStart(10, "0"),
        ticker: row.ticker.toUpperCase(),
        name: row.title ?? null,
      });
    }
  }

  const companies: Company[] = [];
  const unknown: string[] = [];
  for (const t of tickers) {
    const found = cacheTickers.get(t.trim().toUpperCase());
    if (found) companies.push(found);
    else unknown.push(t.trim().toUpperCase());
  }
  return { companies, unknown };
}

/** Últimos documentos de una empresa, sin filtrar por tipo (el filtro es local). */
export async function fetchFilings(
  company: Company,
  userAgent: string,
  opts: RetryOptions & { count?: number } = {},
): Promise<Filing[]> {
  const url =
    `${BASE}/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(company.cik)}` +
    `&type=&dateb=&owner=include&count=${opts.count ?? 10}&output=atom`;
  return parseFilings(await fetchText(url, { ...opts, headers: secHeaders(userAgent) }));
}

/**
 * Documentos de un feed Atom de EDGAR.
 *
 * Los campos que importan no están en el `<entry>` sino dentro de su `<content>`,
 * que es XML propio de la SEC: tipo de documento, fecha de presentación y número
 * de registro. El `<title>` por sí solo ("8-K - Current report") no dice de quién.
 */
export function parseFilings(xml: string): Filing[] {
  const filings: Filing[] = [];

  for (const entry of blocks(xml, "entry")) {
    const accession = tagText(entry, "accession-number");
    const formType = tagText(entry, "filing-type");
    if (!accession || !formType) continue;

    // `updated` es el instante en que la SEC lo aceptó; `filing-date` solo el día.
    // Se prefiere el instante: es más preciso y es igual de real.
    const filedAt = tagText(entry, "updated") ?? tagText(entry, "filing-date");
    if (!filedAt) continue;

    filings.push({
      accession,
      formType,
      formName: tagText(entry, "form-name"),
      filedAt,
      url: tagText(entry, "filing-href"),
      items: tagText(entry, "items-desc"),
    });
  }
  return filings;
}

/** Nombre de la empresa según el propio feed; el ticker no lo trae. */
export function companyName(xml: string): string | null {
  return tagText(xml, "conformed-name");
}

/**
 * Qué es este documento, en una palabra.
 *
 * Un "8-K — Current report" no le dice nada a nadie: puede ser un cambio de
 * auditor o los resultados del trimestre. Lo que lo distingue es el apartado que
 * la propia empresa declara, y el 2.02 es exactamente "resultados de
 * explotacion y situacion financiera". Es la vía gratuita y oficial de saber que
 * una empresa acaba de presentar resultados, sin calendario de earnings de pago.
 */
export function etiqueta(f: Filing): string | null {
  const tipo = f.formType.toUpperCase();
  if (f.items?.includes("2.02")) return "resultados";
  if (tipo.startsWith("10-Q")) return "informe trimestral";
  if (tipo.startsWith("10-K") || tipo.startsWith("20-F")) return "cuentas anuales";
  if (tipo.startsWith("SC 13D")) return "participacion significativa";
  return null;
}

export function toEvents(
  filings: Filing[],
  company: Company,
  opts: { retrievedAt: string; forms?: string[] },
): NormalizedEvent[] {
  const forms = opts.forms ?? FORMS_DEFECTO;

  return filings
    // "8-K/A" es una corrección de un 8-K: mismo peso informativo, así que se
    // compara por prefijo en vez de por igualdad.
    .filter((f) => forms.some((permitido) => f.formType.toUpperCase().startsWith(permitido)))
    .map((f) => ({
      // El número de registro identifica el documento: una empresa puede
      // presentar dos el mismo día, y la fecha sola los confundiría.
      id: eventId("sec-edgar", company.ticker, f.accession),
      source: "sec-edgar" as const,
      source_url: f.url,
      kind: "filing" as const,
      title: `${company.ticker} · ${f.formType} — ${etiqueta(f) ?? f.formName ?? "documento"}`,
      summary: resumen(company, f),
      country: "🇺🇸",
      series_id: company.ticker,
      observed_at: f.filedAt,
      retrieved_at: opts.retrievedAt,

      actual: null,
      previous: null,
      consensus: null,
      unit: null,
      surprises: [],

      stale: false,
      official: true, // Lo presenta la empresa ante el regulador: no hay intermediario.
    }));
}

/**
 * Lo que el modelo va a leer. `items-desc` es la parte con contenido real: dice
 * si el 8-K son resultados (item 2.02) o un cambio en el consejo (item 5.02).
 */
function resumen(company: Company, f: Filing): string {
  const que = etiqueta(f);
  const partes = [
    company.name ? `${company.name} (${company.ticker})` : company.ticker,
    `presenta ${f.formType}${f.formName ? ` (${f.formName})` : ""}${que ? `. Es ${que}` : ""}`,
  ];
  if (f.items) partes.push(`Contenido declarado: ${f.items}`);
  return partes.join(". ") + ".";
}
