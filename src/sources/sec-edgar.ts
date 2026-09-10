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
 * 2. **Diez peticiones por segundo como máximo.** Cada intento HTTP comparte
 *    un limitador de 150 ms, incluidas resolución, empresas y reintentos.
 */
import { fetchJson, type RetryOptions } from "../lib/http.ts";
import { createRateLimiter, positiveInteger } from "../lib/concurrency.ts";
import { blocks, tagText } from "../lib/feed.ts";
import { eventId, type NormalizedEvent } from "../schema/event.ts";

const BASE = "https://www.sec.gov";
const SUBMISSIONS = "https://data.sec.gov/submissions";
const limitSec = createRateLimiter(150);

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
  if (!userAgent.trim()) throw new Error("SEC_CONTACT_MISSING");
  return { "User-Agent": userAgent, Accept: "application/json, application/atom+xml, text/xml" };
}

function secOptions(userAgent: string, opts: RetryOptions): RetryOptions {
  return {
    ...opts,
    headers: secHeaders(userAgent),
    beforeAttempt: async (signal) => {
      await opts.beforeAttempt?.(signal);
      await limitSec(signal);
    },
  };
}

interface TickerRow {
  cik_str: number;
  ticker: string;
  title: string;
}

let cacheTickers: Map<string, Company> | null = null;
let loadingTickers: Promise<void> | null = null;

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
    loadingTickers ??= (async () => {
      const raw = await fetchJson<Record<string, TickerRow>>(`${BASE}/files/company_tickers.json`, secOptions(userAgent, opts));
      const parsed = new Map<string, Company>();
      for (const row of Object.values(raw)) {
        if (!row?.ticker) continue;
        parsed.set(row.ticker.toUpperCase(), {
          cik: String(row.cik_str).padStart(10, "0"),
          ticker: row.ticker.toUpperCase(),
          name: row.title ?? null,
        });
      }
      if (parsed.size === 0) throw Object.assign(new Error("SEC_SHAPE"), { code: "SEC_SHAPE" });
      cacheTickers = parsed;
    })().finally(() => { loadingTickers = null; });
    await loadingTickers;
  }

  const companies: Company[] = [];
  const unknown: string[] = [];
  for (const t of tickers) {
    const found = cacheTickers!.get(t.trim().toUpperCase());
    if (found) companies.push(found);
    else unknown.push(t.trim().toUpperCase());
  }
  return { companies, unknown };
}

interface SubmissionColumns {
  accessionNumber?: string[];
  form?: string[];
  filingDate?: string[];
  acceptanceDateTime?: string[];
  primaryDocument?: string[];
  primaryDocDescription?: string[];
  items?: string[];
}

interface SubmissionFile {
  name: string;
  filingFrom: string;
  filingTo: string;
}

export interface FilingCoverage {
  /** Filas leídas antes de filtrar formularios. */
  total: number;
  returned: number;
  archivesRead: number;
  archiveFailures: number;
  /** Ventana incompleta o más formularios relevantes que el límite. */
  truncated: boolean;
}

function allowedForm(formType: string, forms: readonly string[]): boolean {
  const type = formType.toUpperCase();
  return forms.some((form) => type === form.toUpperCase() || type === `${form.toUpperCase()}/A`);
}

/** Arrays de columnas oficiales, sin truncar los tipos irrelevantes por delante. */
export function parseSubmissions(columns: SubmissionColumns, company: Company): Filing[] {
  if (!Array.isArray(columns.accessionNumber) || !Array.isArray(columns.form) ||
      !Array.isArray(columns.filingDate) || columns.form.length !== columns.accessionNumber.length ||
      columns.filingDate.length !== columns.accessionNumber.length) {
    throw Object.assign(new Error("SEC_SHAPE"), { code: "SEC_SHAPE" });
  }
  return columns.accessionNumber.flatMap((accession, index) => {
    const formType = columns.form![index];
    const filedAt = columns.acceptanceDateTime?.[index] || columns.filingDate![index];
    if (!accession || !formType || !filedAt || !Number.isFinite(Date.parse(filedAt))) return [];
    const document = columns.primaryDocument?.[index];
    const cik = company.cik.replace(/^0+/, "") || "0";
    const archive = `${BASE}/Archives/edgar/data/${cik}/${accession.replaceAll("-", "")}`;
    return [{
      accession, formType,
      formName: columns.primaryDocDescription?.[index] || null,
      filedAt,
      url: document ? `${archive}/${document.split("/").map(encodeURIComponent).join("/")}` : `${archive}/${accession}-index.html`,
      items: columns.items?.[index] || null,
    }];
  });
}

/**
 * Submissions oficial: al menos un año o 1.000 documentos, lo que sea mayor.
 * Filtra los tipos antes del límite (antes se leían solo diez de cualquier tipo).
 * Para una ventana anterior a recent consulta como mucho dos archivos históricos
 * cuyos rangos se solapen. La cobertura incompleta se devuelve explícitamente;
 * un archivo fallido no elimina los documentos ya descargados de esa empresa.
 * https://www.sec.gov/search-filings/edgar-application-programming-interfaces
 */
export async function fetchFilings(
  company: Company,
  userAgent: string,
  opts: RetryOptions & {
    count?: number;
    forms?: string[];
    since?: string;
    maxArchiveFiles?: number;
    onCoverage?: (coverage: FilingCoverage) => void;
  } = {},
): Promise<Filing[]> {
  const cik = company.cik.padStart(10, "0");
  if (!/^\d{10}$/.test(cik)) throw Object.assign(new Error("SEC_SHAPE"), { code: "SEC_SHAPE" });
  const body = await fetchJson<{ filings?: { recent?: SubmissionColumns; files?: SubmissionFile[] } }>(
    `${SUBMISSIONS}/CIK${cik}.json`, secOptions(userAgent, opts));
  const all = parseSubmissions(body.filings?.recent ?? {}, company);
  const since = opts.since ? Date.parse(opts.since) : NaN;
  const oldest = all.reduce((min, item) => Math.min(min, Date.parse(item.filedAt)), Infinity);
  const archives = Number.isFinite(since) && oldest > since
    ? (body.filings?.files ?? []).filter((f) => Date.parse(f.filingTo) + 86_400_000 >= since)
      .sort((a, b) => b.filingTo.localeCompare(a.filingTo)) : [];
  const archiveLimit = opts.maxArchiveFiles === 0 ? 0 : positiveInteger(opts.maxArchiveFiles, 2, 2);
  let archivesRead = 0;
  let archiveFailures = 0;
  for (const file of archives.slice(0, archiveLimit)) {
    if (!/^CIK\d{10}-submissions-\d+\.json$/.test(file.name)) { archiveFailures++; continue; }
    try {
      const columns = await fetchJson<SubmissionColumns>(`${SUBMISSIONS}/${file.name}`, secOptions(userAgent, opts));
      all.push(...parseSubmissions(columns, company));
      archivesRead++;
    } catch {
      // El deadline de tarea corta la recolección desde fuera. Con un fallo HTTP
      // de un archivo, conservar recent y señalar cobertura parcial es mejor.
      archiveFailures++;
    }
  }
  const forms = opts.forms ?? FORMS_DEFECTO;
  const unique = [...new Map(all.map((filing) => [filing.accession, filing])).values()];
  const relevant = unique.filter((f) => allowedForm(f.formType, forms) &&
    (!Number.isFinite(since) || Date.parse(f.filedAt) >= since))
    .sort((a, b) => Date.parse(b.filedAt) - Date.parse(a.filedAt));
  const count = positiveInteger(opts.count, 1_000, 5_000);
  const result = relevant.slice(0, count);
  opts.onCoverage?.({ total: all.length, returned: result.length, archivesRead, archiveFailures,
    truncated: relevant.length > count || archives.length > archiveLimit || archiveFailures > 0 });
  return result;
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
    .filter((f) => allowedForm(f.formType, forms))
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
      publication_at: f.filedAt,
      data_period_at: null,
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
