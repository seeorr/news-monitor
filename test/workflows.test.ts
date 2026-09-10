import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const brief = readFileSync(new URL("../.github/workflows/brief.yml", import.meta.url), "utf8");
// Ejecuta exactamente la puerta del YAML, sin necesitar Actions, secretos,
// dependencias YAML ni una copia de sus condiciones que pudiera quedar obsoleta.
const gate = brief.match(/node <<'NODE'\r?\n([\s\S]*?)\r?\n\s+NODE/)!;

function enabled(trigger: string, date: string, overrides: Record<string, unknown> = {}): boolean {
  const event = {
    repository: { default_branch: "main" },
    workflow_run: { head_branch: "main", head_repository: { full_name: "fixture/monitor" }, event: "schedule" },
    ...overrides,
  };
  let output = "";
  runInNewContext(gate[1]!, {
    require: () => ({
      readFileSync: () => JSON.stringify(event),
      appendFileSync: (_path: string, text: string) => { output += text; },
    }),
    process: { env: { GITHUB_EVENT_NAME: trigger, GITHUB_REPOSITORY: "fixture/monitor" } },
    Date: class extends Date { constructor() { super(date); } },
  });
  return output === "enabled=true\n";
}

describe("resumen: ventana y origen del fallback", () => {
  it.each([
    ["2026-09-10T05:59:59Z", false], ["2026-09-10T06:00:00Z", true],
    ["2026-09-10T11:59:59Z", true], ["2026-09-10T12:00:00Z", false],
    ["2026-09-12T08:00:00Z", false], ["2026-09-13T08:00:00Z", false],
    ["2026-09-14T08:00:00Z", true],
  ])("evalúa la fecha UTC real %s → %s", (date, expected) => {
    expect(enabled("workflow_run", date)).toBe(expected);
    expect(enabled("schedule", date)).toBe(expected);
  });

  it("la ejecución manual permite recuperar el resumen fuera de la mañana", () => {
    expect(enabled("workflow_dispatch", "2026-09-13T20:00:00Z")).toBe(true);
  });

  it.each([
    { head_branch: "otra" }, { head_repository: { full_name: "fork/monitor" } },
    { event: "pull_request" }, { event: "push" },
  ])("rechaza un origen no permitido: %j", (override) => {
    expect(enabled("workflow_run", "2026-09-10T08:00:00Z", {
      workflow_run: { head_branch: "main", head_repository: { full_name: "fixture/monitor" },
        event: "schedule", ...override },
    })).toBe(false);
  });

  it("sin rama predeterminada o sin workflow de origen cierra la puerta", () => {
    expect(enabled("workflow_run", "2026-09-10T08:00:00Z", { repository: {} })).toBe(false);
    expect(enabled("workflow_run", "2026-09-10T08:00:00Z", { workflow_run: null })).toBe(false);
    expect(enabled("pull_request", "2026-09-10T08:00:00Z")).toBe(false);
  });

  it("un Monitor lanzado manualmente también permite recuperar la mañana", () => {
    expect(enabled("workflow_run", "2026-09-10T08:00:00Z", {
      workflow_run: { head_branch: "main", head_repository: { full_name: "fixture/monitor" },
        event: "workflow_dispatch" },
    })).toBe(true);
  });
});
