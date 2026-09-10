/**
 * Cadencia en lectura: gh run list del workflow Monitor, sin títulos ni logs.
 * CLI: npx tsx scripts/auditar-cadencia.ts
 * Importar analyzeCadence en tests no ejecuta gh ni escribe archivos.
 */
import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface CadenceRun {
  databaseId?: number;
  event?: string;
  createdAt?: string | null;
  startedAt?: string | null;
  status?: string;
  conclusion?: string | null;
}

const STATUSES = ["completed", "in_progress", "queued", "requested", "waiting", "pending"] as const;
const CONCLUSIONS = ["success", "failure", "cancelled", "timed_out", "skipped", "neutral", "action_required", "stale", "startup_failure"] as const;
type RunEvent = "schedule" | "workflow_dispatch" | "other";
type StartQuality = "after_created_reported" | "equal_created_at_unverified" | "before_created_invalid" | "missing";

function instant(value: unknown): number | null {
  if (typeof value !== "string" || value.trim() === "") return null;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}
function countBy<T>(items: readonly T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const value = key(item);
    counts[value] = (counts[value] ?? 0) + 1;
  }
  return counts;
}
function minutes(milliseconds: number): number {
  return Math.round(milliseconds / 60_000 * 1000) / 1000;
}
function gap(from: number, to: number) {
  return { from: new Date(from).toISOString(), to: new Date(to).toISOString(), minutes: minutes(to - from) };
}

/** Slots pedidos, no slots entregados: no se asigna cada run retrasado a un cron. */
export function expectedScheduleSlots(start: Date, end: Date): string[] {
  if (!Number.isFinite(start.valueOf()) || !Number.isFinite(end.valueOf()) || end <= start) throw new Error("cadence_window_invalid");
  if (end.valueOf() - start.valueOf() > 31 * 24 * 3600_000) throw new Error("cadence_window_too_large");
  const slots: string[] = [];
  for (let hour = Math.floor(start.valueOf() / 3600_000) * 3600_000; hour < end.valueOf(); hour += 3600_000) {
    for (const minute of [7, 37]) {
      const slot = hour + minute * 60_000;
      if (slot >= start.valueOf() && slot < end.valueOf()) slots.push(new Date(slot).toISOString());
    }
  }
  return slots;
}

export function analyzeCadence(
  input: readonly CadenceRun[],
  options: { now: string | Date; hours?: number; requestedLimit?: number },
) {
  const end = new Date(options.now);
  const hours = options.hours ?? 24;
  if (!Number.isFinite(end.valueOf()) || !Number.isFinite(hours) || hours <= 0 || hours > 31 * 24) throw new Error("cadence_window_invalid");
  const start = new Date(end.valueOf() - hours * 3600_000);
  const requestedLimit = options.requestedLimit ?? 500;
  const expected = expectedScheduleSlots(start, end);
  const ids = new Set<number>();
  let duplicateRunIds = 0;
  let ignoredInvalidCreatedAt = 0;
  const rows = input.flatMap((run) => {
    const created = instant(run.createdAt);
    if (created === null) { ignoredInvalidCreatedAt++; return []; }
    const id = Number.isSafeInteger(run.databaseId) && run.databaseId! > 0 ? run.databaseId : undefined;
    if (id !== undefined) {
      if (ids.has(id)) { duplicateRunIds++; return []; }
      ids.add(id);
    }
    const reportedStart = instant(run.startedAt);
    const startQuality: StartQuality = reportedStart === null ? "missing" :
      reportedStart < created ? "before_created_invalid" :
        reportedStart === created ? "equal_created_at_unverified" : "after_created_reported";
    const event: RunEvent = run.event === "schedule" || run.event === "workflow_dispatch" ? run.event : "other";
    const status = (STATUSES as readonly string[]).includes(run.status ?? "") ? run.status! : "unknown";
    const conclusion = !run.conclusion ? "none" : (CONCLUSIONS as readonly string[]).includes(run.conclusion) ? run.conclusion : "unknown";
    return [{ id, createdAt: new Date(created).toISOString(),
      startedAtReported: reportedStart === null ? null : new Date(reportedStart).toISOString(),
      startQuality, reportedStartLagMinutes: startQuality === "after_created_reported" ? minutes(reportedStart! - created) : null,
      event, status, conclusion, created }];
  }).sort((a, b) => a.created - b.created || (a.id ?? 0) - (b.id ?? 0));
  const inWindow = rows.filter((run) => run.created >= start.valueOf() && run.created < end.valueOf());
  type Row = typeof rows[number];

  function summarize(selected: readonly Row[]) {
    const observedGaps = selected.slice(1).map((run, index) => gap(selected[index]!.created, run.created));
    const maximumGap = [...observedGaps].sort((a, b) => b.minutes - a.minutes)[0] ?? null;
    const first = selected[0]?.created;
    const last = selected.at(-1)?.created;
    const startLags = selected.map((run) => run.reportedStartLagMinutes).filter((lag): lag is number => lag !== null);
    return {
      created: selected.length,
      completedSuccess: selected.filter((run) => run.status === "completed" && run.conclusion === "success").length,
      statuses: countBy(selected, (run) => run.status), conclusions: countBy(selected, (run) => run.conclusion),
      firstCreatedAt: first === undefined ? null : new Date(first).toISOString(),
      lastCreatedAt: last === undefined ? null : new Date(last).toISOString(),
      creationGaps: { observedPairs: observedGaps.length, maximumBetweenObservedRuns: maximumGap,
        // Solo tramos de esta ventana. No se supone el run anterior ni el siguiente.
        censoredAtWindowStart: first === undefined ? null : gap(start.valueOf(), first),
        censoredAtWindowEnd: last === undefined ? null : gap(last, end.valueOf()),
        wholeWindowWithoutObservedRun: selected.length === 0 ? gap(start.valueOf(), end.valueOf()) : null },
      starts: { quality: countBy(selected, (run) => run.startQuality),
        maximumReportedLagMinutes: startLags.length ? Math.max(...startLags) : null,
        // run_started_at no acredita inicio del job ni procesamiento interno.
        jobStartVerified: false },
    };
  }

  const schedule = summarize(inWindow.filter((run) => run.event === "schedule"));
  const earliest = rows[0]?.created;
  const coverage = ignoredInvalidCreatedAt > 0 ? "uncertain_invalid_dates" :
    input.length < requestedLimit || (earliest !== undefined && earliest <= start.valueOf()) ? "window_covered" : "limit_reached_before_window_start";
  return {
    code: "CADENCE_AUDIT", readOnly: true, workflow: "monitor.yml", window: { start: start.toISOString(), end: end.toISOString(), hours, inclusion: "start_inclusive_end_exclusive" },
    history: { fetched: input.length, requestedLimit, validUniqueRuns: rows.length, duplicateRunIds, ignoredInvalidCreatedAt,
      oldestFetchedAt: earliest === undefined ? null : new Date(earliest).toISOString(), coverage,
      runsOutsideWindow: rows.length - inWindow.length },
    expected: { minutesUTC: [7, 37], slots: expected.length },
    schedule: { ...schedule, observedToExpectedPercent: expected.length ? Math.round(schedule.created / expected.length * 10_000) / 100 : null },
    workflowDispatch: summarize(inWindow.filter((run) => run.event === "workflow_dispatch")),
    otherEvents: summarize(inWindow.filter((run) => run.event === "other")),
    allEvents: summarize(inWindow),
    runs: inWindow.map(({ created: _created, ...run }) => run),
    meaning: {
      expectedSlotsMatchedToRuns: false, internalProcessingVerified: false, telegramDeliveryVerified: false,
      equalCreatedAndStartedProvesImmediateStart: false,
    },
  };
}

export async function auditCadenceCli(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  if (args.length === 1 && args[0] === "--help") {
    console.log("npx tsx scripts/auditar-cadencia.ts — lectura de 500 runs de Monitor; ventana 24 h UTC; guarda .cache/cadencia-*.json");
    return;
  }
  if (args.length) throw new Error("cadence_argument_unknown");
  const repo = fileURLToPath(new URL("../", import.meta.url));
  const output = execFileSync("gh", ["run", "list", "--workflow", "monitor.yml", "--limit", "500",
    "--json", "databaseId,event,createdAt,startedAt,status,conclusion"], {
    cwd: repo, encoding: "utf8", windowsHide: true, timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  });
  const raw: unknown = JSON.parse(output);
  if (!Array.isArray(raw) || raw.some((item) => item === null || typeof item !== "object")) throw new Error("cadence_response_invalid");
  const report = analyzeCadence(raw as CadenceRun[], { now: new Date(), requestedLimit: 500 });
  const directory = resolve(repo, ".cache");
  const destination = resolve(directory, `cadencia-${report.window.end.replace(/[:.]/g, "-")}.json`);
  await mkdir(directory, { recursive: true });
  await writeFile(destination, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(report, null, 2));
}

const invokedFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedFile === import.meta.url) {
  auditCadenceCli().catch(() => {
    // No imprimir stderr de gh, mensajes de autenticación ni paths de configuración.
    console.error(JSON.stringify({ code: "CADENCE_READ_FAILED", readOnly: true }));
    process.exitCode = 1;
  });
}
