import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const monitor = readFileSync(new URL("../.github/workflows/monitor.yml", import.meta.url), "utf8");
const brief = readFileSync(new URL("../.github/workflows/brief.yml", import.meta.url), "utf8");
const gate = brief.match(/node <<'NODE'\r?\n([\s\S]*?)\r?\n\s+NODE/);

/** Ejecuta el JavaScript exacto del workflow; FS y reloj son las únicas fronteras. */
function gateAllows(options: { trigger?: string; origin?: string; title?: string; repoMode?: string;
  branch?: string; repository?: string; conclusion?: string } = {}): boolean {
  if (!gate) throw new Error("workflow_gate_missing");
  const event = {
    repository: { default_branch: "main" },
    workflow_run: {
      name: "Monitor", display_title: options.title ?? "Monitor (full)",
      head_branch: options.branch ?? "main", head_repository: { full_name: options.repository ?? "synthetic/monitor" },
      event: options.origin ?? "workflow_dispatch", conclusion: options.conclusion ?? "success",
    },
  };
  let output = "";
  runInNewContext(gate[1]!, {
    require: (name: string) => {
      if (name !== "node:fs") throw new Error("unexpected_workflow_dependency");
      return { readFileSync: () => JSON.stringify(event),
        appendFileSync: (_path: string, text: string) => { output += text; } };
    },
    process: { env: { GITHUB_EVENT_NAME: options.trigger ?? "workflow_run",
      GITHUB_REPOSITORY: "synthetic/monitor", MONITOR_MODE: options.repoMode ?? "full" } },
    Date: class extends Date { constructor() { super("2026-09-10T08:00:00Z"); } },
  });
  return output === "enabled=true\n";
}

function actualRunTitle(mode: string, repoMode: string, profile = "full"): string {
  const template = monitor.match(/^run-name: (.*)$/m)?.[1];
  if (!template) throw new Error("monitor_run_name_missing");
  return template.replace(/\$\{\{(.*?)\}\}/g, (_match, expression: string) => String(runInNewContext(expression,
    { inputs: { mode, profile }, vars: { MONITOR_MODE: repoMode }, github: { event_name: "workflow_dispatch" } })));
}

describe("capture-only no dispara mensajes por la cadena de workflows", () => {
  it.each(["schedule", "workflow_dispatch"])("bloquea un Monitor capture-only originado por %s durante la mañana", (origin) => {
    expect(gateAllows({ origin, title: actualRunTitle("capture-only", "full") })).toBe(false);
  });

  it("el modo heredado del repositorio queda en el título y también bloquea la recuperación", () => {
    expect(actualRunTitle("", "capture-only")).toBe("Monitor (capture-only) [full]");
    expect(actualRunTitle("auto", "capture-only")).toBe("Monitor (capture-only) [full]");
    expect(gateAllows({ title: actualRunTitle("", "capture-only"), repoMode: "full" })).toBe(false);
  });

  it.each(["workflow_run", "schedule", "workflow_dispatch"])("MONITOR_MODE=capture-only bloquea el resumen con trigger %s", (trigger) => {
    expect(gateAllows({ trigger, repoMode: "capture-only", title: "Monitor (full)" })).toBe(false);
  });

  it("mantiene la recuperación para full y evita efectos indirectos de fast/process/fallo", () => {
    expect(gateAllows({ title: actualRunTitle("full", "") })).toBe(true);
    expect(gateAllows({ title: actualRunTitle("process-only", "") })).toBe(false);
    for (const profile of ["fast", "process"]) expect(gateAllows({ title: actualRunTitle("full", "", profile) })).toBe(false);
    expect(gateAllows({ title: actualRunTitle("full", "", "invalid"), conclusion: "failure" })).toBe(false);
  });

  it("una ejecución de otro repositorio o rama sigue sin atravesar la puerta", () => {
    expect(gateAllows({ repository: "fork/monitor" })).toBe(false);
    expect(gateAllows({ branch: "untrusted" })).toBe(false);
  });

  it("evalúa la puerta antes del checkout y condiciona todos los pasos con efectos externos", () => {
    expect(gate).not.toBeNull();
    const position = brief.indexOf(gate![0]);
    expect(position).toBeLessThan(brief.indexOf("uses: actions/checkout"));
    expect(brief.slice(0, position + gate![0].length)).not.toContain("secrets.");
    const steps = brief.split(/\r?\n(?= {6}- )/);
    const effects = steps.filter((step) => /uses: actions\/(?:checkout|setup-node)|run: npm (?:ci|run)/.test(step));
    expect(effects.length).toBeGreaterThanOrEqual(6);
    for (const step of effects) expect(step).toContain("if: steps.ventana.outputs.enabled == 'true'");
  });

  it("el aviso de fallo del propio Monitor también queda desactivado en capture-only", () => {
    const expression = monitor.match(/if: \$\{\{\s*(failure\(\)[^\r\n]*?)\s*\}\}/)?.[1];
    expect(expression).toBeDefined();
    const evaluate = (mode: string, valid = "true") => runInNewContext(expression!, { failure: () => true, env: { MONITOR_MODE: mode }, steps: { profile: { outputs: { valid } } } });
    expect(evaluate("capture-only")).toBe(false);
    expect(evaluate("full")).toBe(true);
    expect(evaluate("full", "")).toBe(false);
  });
});
