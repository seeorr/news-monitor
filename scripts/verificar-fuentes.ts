/**
 * GET de RSS y catálogos públicos. No carga .env, BD, watchlist, LLM ni Telegram.
 * Los ejemplos quedan solo en .cache/, ignorada por git. La consola da conteos.
 * npx tsx scripts/verificar-fuentes.ts --batches=core,batch1,batch2
 * --include-disabled prueba también candidatos bloqueados, sin activarlos.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFeed, tagText, toIso } from "../src/lib/feed.ts";
import { applyRules } from "../src/pipeline/rules.ts";
import { agrupar } from "../src/pipeline/agrupar.ts";
import { FEEDS, FEED_BATCHES, selectFeeds, toEvents, type FeedSpec } from "../src/sources/rss.ts";

const args = process.argv.slice(2);
const batches = (args.find((arg) => arg.startsWith("--batches="))?.split("=")[1] ?? "core,batch1,batch2").split(",").filter(Boolean);
selectFeeds(batches); // Validar incluso con --include-disabled.
for (const arg of args) {
  if (arg !== "--include-disabled" && !arg.startsWith("--batches=")) throw new Error("argument_unknown");
}
const includeDisabled = args.includes("--include-disabled");
const specs = includeDisabled
  ? Object.values(FEEDS).filter((spec) => batches.includes(spec.batch))
  : selectFeeds(batches);
const retrievedAt = new Date().toISOString();

async function get(url: string) {
  const start = performance.now();
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(12_000),
      headers: { "User-Agent": "news-monitor/0.1 (personal RSS verification)" },
    });
    const body = await response.text();
    return { ok: response.ok, status: response.status, body, bytes: Buffer.byteLength(body),
      elapsedMs: Math.round(performance.now() - start), contentType: response.headers.get("content-type"), error: null };
  } catch (error) {
    return { ok: false, status: null, body: "", bytes: 0,
      elapsedMs: Math.round(performance.now() - start), contentType: null,
      error: error instanceof Error ? error.name : "network_error" };
  }
}

/** Dos fuentes a la vez. Un error devuelve un registro, no aborta las demás. */
async function mapTwo<T, U>(items: readonly T[], fn: (item: T) => Promise<U>): Promise<U[]> {
  const results: U[] = [];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(2, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await fn(items[index]!);
    }
  }));
  return results;
}

// Solo URLs del registro público. No acepta endpoints arbitrarios ni secretos.
const referenceUrls = [...new Set(specs.flatMap((spec) => [spec.catalogUrl, spec.termsUrl]).filter((url): url is string => !!url))];
const references = await mapTwo(referenceUrls, async (url) => ({ url, ...await get(url) }));
const byUrl = new Map(references.map((reference) => [reference.url, reference]));

function inCatalog(spec: FeedSpec): boolean | null {
  if (!spec.catalogUrl) return null; // Los ocho core no se reauditan legalmente aquí.
  const page = byUrl.get(spec.catalogUrl);
  if (!page?.ok) return null;
  const hrefs = [...page.body.matchAll(/href\s*=\s*["']([^"']+)["']/gi)].map((match) => {
    try { return new URL(match[1]!.replace(/&amp;/g, "&"), spec.catalogUrl).href; } catch { return ""; }
  });
  return hrefs.includes(spec.url);
}

const reports = await mapTwo(specs, async (spec) => {
  const response = await get(spec.url);
  const validFeed = response.ok && /<(?:\w+:)?(?:rss|feed|RDF)(?:\s|>)/i.test(response.body);
  const items = validFeed ? parseFeed(response.body) : [];
  const events = toEvents(items, spec, { retrievedAt });
  const decisions = events.map((event) => ({ event, rule: applyRules(event) }));
  const passing = decisions.filter(({ rule }) => rule.pass).map(({ event }) => event);
  const published = events.map((event) => event.observed_at).sort();
  return {
    id: spec.id, publisher: spec.publisher, batch: spec.batch, enabled: spec.enabled !== false,
    disabledReason: spec.disabledReason ?? null, catalogDeclared: inCatalog(spec),
    status: response.status, contentType: response.contentType, bytes: response.bytes, elapsedMs: response.elapsedMs,
    error: response.error ?? (validFeed ? null : "feed_invalid"),
    items: items.length, normalized: events.length, uniqueIds: new Set(events.map((event) => event.id)).size,
    missingDate: items.filter((item) => toIso(item.date) === null).length,
    dateTags: {
      pubDate: items.filter((item) => tagText(item.raw, "pubDate")).length,
      published: items.filter((item) => tagText(item.raw, "published")).length,
      updated: items.filter((item) => tagText(item.raw, "updated")).length,
    },
    oldestPublication: published[0] ?? null, newestPublication: published.at(-1) ?? null,
    passRules: passing.length, discardRules: decisions.filter(({ rule }) => !rule.pass).length,
    ruleReasons: Object.fromEntries([...new Set(decisions.map(({ rule }) => rule.reasonCode))]
      .map((reason) => [reason, decisions.filter(({ rule }) => rule.reasonCode === reason).length])),
    groups: agrupar(passing).length, examples: decisions,
  };
});

const coreLinks = new Set(reports.filter((report) => report.batch === "core")
  .flatMap((report) => report.examples.map(({ event }) => event.source_url)).filter(Boolean));
const baselineAvailable = reports.some((report) => report.batch === "core" && report.error === null);
const allPassing = reports.flatMap((report) => report.examples.filter(({ rule }) => rule.pass).map(({ event }) => event));
const report = {
  retrievedAt, scope: "local-public-get-only", batches, availableBatches: FEED_BATCHES, includeDisabled,
  baselineAvailable,
  references: references.map(({ body: _body, ...reference }) => reference),
  feeds: reports.map((entry) => ({ ...entry,
    urlsAbsentFromCoreSnapshot: baselineAvailable ? entry.examples.filter(({ event }) => !coreLinks.has(event.source_url)).length : null,
  })),
  grouping: { passing: allPassing.length, groups: agrupar(allPassing).length,
    duplicates: agrupar(allPassing).reduce((sum, group) => sum + group.duplicados.length, 0) },
};
const repo = fileURLToPath(new URL("../", import.meta.url));
const destination = resolve(repo, ".cache", `fuentes-${retrievedAt.replace(/[:.]/g, "-")}.json`);
await mkdir(resolve(repo, ".cache"), { recursive: true });
await writeFile(destination, JSON.stringify(report, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ report: destination, retrievedAt, ...report.grouping,
  feeds: report.feeds.map(({ examples: _examples, ...entry }) => entry) }, null, 2));
if (reports.some((entry) => entry.enabled && (entry.error !== null || entry.catalogDeclared === false || entry.normalized === 0))) {
  process.exitCode = 1;
}
