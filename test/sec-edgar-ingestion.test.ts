import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Company, FilingCoverage } from "../src/sources/sec-edgar.ts";

const company: Company = { cik: "0000123456", ticker: "EXAMPLE", name: "Example synthetic" };
const ua = "Synthetic test contact test@example.invalid";
const columns = (forms: string[], day = "2026-09-10") => ({
  accessionNumber: forms.map((_, i) => `0000123456-26-${String(i + 1).padStart(6, "0")}`),
  form: forms,
  filingDate: forms.map(() => day),
  acceptanceDateTime: forms.map(() => `${day}T12:00:00Z`),
  primaryDocument: forms.map((_, i) => `document-${i + 1}.htm`),
  items: forms.map((form) => form === "8-K" ? "2.02,9.01" : ""),
});
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-10T16:00:00Z"));
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unconfigured network boundary"); }));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("SEC submissions: cobertura e intentos", () => {
  it("recupera el 8-K situado después de veinticinco formularios 4 antes de aplicar el límite", async () => {
    const { fetchFilings, toEvents } = await import("../src/sources/sec-edgar.ts");
    vi.mocked(fetch).mockResolvedValue(response({ filings: {
      recent: columns([...Array<string>(25).fill("4"), "8-K", "10-Q"]), files: [],
    } }));
    const coverage: FilingCoverage[] = [];
    const work = fetchFilings(company, ua, { count: 2, onCoverage: (c) => coverage.push(c) });
    await vi.runAllTimersAsync();
    const filings = await work;
    expect(filings.map((f) => f.formType)).toEqual(["8-K", "10-Q"]);
    expect(toEvents(filings, company, { retrievedAt: "2026-09-10T16:00:00Z" })[0]).toMatchObject({
      observed_at: "2026-09-10T12:00:00Z", publication_at: "2026-09-10T12:00:00Z",
      retrieved_at: "2026-09-10T16:00:00Z", title: "EXAMPLE · 8-K — resultados",
    });
    expect(coverage).toEqual([{ total: 27, returned: 2, archivesRead: 0, archiveFailures: 0, truncated: false }]);
    expect(fetch).toHaveBeenCalledWith("https://data.sec.gov/submissions/CIK0000123456.json",
      expect.objectContaining({ headers: expect.objectContaining({ "User-Agent": ua }) }));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("solo pide los archivos históricos que solapan la ventana, con máximo de dos", async () => {
    const { fetchFilings } = await import("../src/sources/sec-edgar.ts");
    const recent = columns(["8-K"]);
    const historical = { ...columns(["10-Q"], "2026-09-09"), accessionNumber: ["0000123456-26-900000"] };
    vi.mocked(fetch).mockResolvedValueOnce(response({ filings: { recent, files: [
      { name: "CIK0000123456-submissions-001.json", filingFrom: "2026-09-08", filingTo: "2026-09-09" },
      { name: "CIK0000123456-submissions-002.json", filingFrom: "2026-09-07", filingTo: "2026-09-08" },
      { name: "CIK0000123456-submissions-003.json", filingFrom: "2026-09-05", filingTo: "2026-09-07" },
      { name: "CIK0000123456-submissions-004.json", filingFrom: "2026-01-01", filingTo: "2026-01-31" },
    ] } })).mockImplementation(async () => response(historical));
    const coverage: FilingCoverage[] = [];
    const work = fetchFilings(company, ua, { since: "2026-09-07T00:00:00Z", maxArchiveFiles: 20,
      onCoverage: (c) => coverage.push(c) });
    await vi.runAllTimersAsync();
    expect((await work).map((f) => f.formType)).toEqual(["8-K", "10-Q"]);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(coverage[0]).toMatchObject({ archivesRead: 2, archiveFailures: 0, truncated: true });
    expect(vi.mocked(fetch).mock.calls.some(([url]) => String(url).endsWith("003.json"))).toBe(false);
  });

  it("un archivo histórico fallido no elimina recent y declara cobertura parcial", async () => {
    const { fetchFilings } = await import("../src/sources/sec-edgar.ts");
    vi.mocked(fetch).mockResolvedValueOnce(response({ filings: {
      recent: columns(["8-K"]), files: [
        { name: "CIK0000123456-submissions-001.json", filingFrom: "2026-09-07", filingTo: "2026-09-09" },
      ],
    } })).mockResolvedValue(response({}, 503));
    const coverage: FilingCoverage[] = [];
    const work = fetchFilings(company, ua, { since: "2026-09-07T00:00:00Z", attempts: 2, backoffMs: 1,
      onCoverage: (c) => coverage.push(c) });
    await vi.runAllTimersAsync();
    expect((await work).map((f) => f.formType)).toEqual(["8-K"]);
    expect(coverage[0]).toMatchObject({ archivesRead: 0, archiveFailures: 1, truncated: true });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("el límite SEC incluye reintentos de varias empresas y la resolución", async () => {
    const { fetchFilings, resolveTickers } = await import("../src/sources/sec-edgar.ts");
    const starts: number[] = [];
    let fail = true;
    vi.mocked(fetch).mockImplementation(async (url) => {
      starts.push(Date.now());
      if (String(url).includes("company_tickers")) return response({ 0: { cik_str: 123456, ticker: "EXAMPLE", title: "Example" } });
      if (fail) { fail = false; return response({}, 503); }
      return response({ filings: { recent: columns(["8-K"]), files: [] } });
    });
    const work = Promise.all([
      resolveTickers(["EXAMPLE"], ua),
      fetchFilings(company, ua, { attempts: 2, backoffMs: 1 }),
      fetchFilings({ ...company, cik: "0000654321" }, ua, { attempts: 2, backoffMs: 1 }),
    ]);
    await vi.runAllTimersAsync();
    const result = await work;
    expect(result[0].companies).toHaveLength(1);
    expect(result[1]).toHaveLength(1);
    expect(result[2]).toHaveLength(1);
    expect(starts).toHaveLength(4);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(150);
  });

  it("señala respuestas de columnas corruptas y no las vende como empresa sin documentos", async () => {
    const { fetchFilings } = await import("../src/sources/sec-edgar.ts");
    vi.mocked(fetch).mockResolvedValue(response({ filings: { recent: { form: ["8-K"] } } }));
    const work = fetchFilings(company, ua);
    const assertion = expect(work).rejects.toMatchObject({ code: "SEC_SHAPE" });
    await vi.runAllTimersAsync();
    await assertion;
  });

  it("conserva subdirectorios oficiales en enlaces a documentos estructurados", async () => {
    const { parseSubmissions } = await import("../src/sources/sec-edgar.ts");
    const raw = { ...columns(["SC 13D"]), primaryDocument: ["xslSCHEDULE_13D_X01/primary_doc.xml"] };
    expect(parseSubmissions(raw, company)[0]?.url).toBe(
      "https://www.sec.gov/Archives/edgar/data/123456/000012345626000001/xslSCHEDULE_13D_X01/primary_doc.xml");
  });
});
