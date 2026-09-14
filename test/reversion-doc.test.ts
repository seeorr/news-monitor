import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * `docs/reversion.md` es lo que se lee con prisa, en mitad de un incidente. Un
 * procedimiento que nombra una variable que ya nadie lee, o un workflow que ya no
 * existe, es peor que no tenerlo: se ejecuta, parece que funciona y no hace nada.
 * Pasó con la reversión anterior: pedía «dos llaves» cuando el Worker ya mandaba
 * `mode: auto`. Estas pruebas atan cada orden del documento al archivo real.
 */
const leer = (ruta: string) => readFileSync(new URL(`../${ruta}`, import.meta.url), "utf8");
const doc = leer("docs/reversion.md");
const workflows = readdirSync(new URL("../.github/workflows", import.meta.url)).filter((f) => f.endsWith(".yml"));
const todosLosWorkflows = workflows.map((f) => leer(`.github/workflows/${f}`)).join("\n");

describe("docs/reversion.md sigue diciendo la verdad", () => {
  it("cada variable que manda cambiar la lee algún workflow", () => {
    const variables = [...doc.matchAll(/gh variable (?:set|delete) ([A-Z_]+)/g)].map((m) => m[1]!);
    expect(variables.length).toBeGreaterThanOrEqual(5);
    for (const variable of new Set(variables)) {
      expect(todosLosWorkflows, `ningún workflow lee vars.${variable}`).toContain(`vars.${variable}`);
    }
  });

  it("cada workflow que manda desactivar o activar existe", () => {
    const nombrados = [...doc.matchAll(/gh workflow (?:disable|enable) ([a-z-]+\.yml)/g)].map((m) => m[1]!);
    const citados = [...doc.matchAll(/`([a-z-]+\.yml)`/g)].map((m) => m[1]!);
    expect(nombrados.length).toBeGreaterThanOrEqual(2);
    for (const archivo of new Set([...nombrados, ...citados].filter((f) => f !== "wrangler.yml"))) {
      expect(workflows, `no existe .github/workflows/${archivo}`).toContain(archivo);
    }
  });

  it("parar el reloj con ENABLED:false funciona de verdad en el Worker", () => {
    expect(doc).toContain("--var ENABLED:false");
    expect(leer("cloudflare-dispatcher/wrangler.json")).toMatch(/"ENABLED":\s*"true"/);
    expect(leer("cloudflare-dispatcher/src/worker.ts")).toContain('env.ENABLED === "false"');
  });

  it("una sola llave para capture-only: el Worker no manda su propio modo", () => {
    expect(leer("cloudflare-dispatcher/src/worker.ts")).toMatch(/const MODE = "auto"/);
    expect(leer(".github/workflows/monitor.yml")).toContain("vars.MONITOR_MODE");
  });

  it("los códigos y estados que cita para comprobar existen", () => {
    const codigo = leer("src/lib/log.ts") + leer("src/pipeline/cadence.ts");
    for (const nombre of ["CAPTURE_ONLY", "SCORED", "ALERT_SENT", "LLM_MODEL_FALLBACK", "AI_BUDGET_NOTICE", "processing_paused"]) {
      expect(doc, `el documento ya no cita ${nombre}`).toContain(nombre);
      expect(codigo, `${nombre} ya no existe en el código`).toContain(`"${nombre}"`);
    }
  });

  it("los comandos npm que usa existen", () => {
    const scripts = Object.keys((JSON.parse(leer("package.json")) as { scripts: Record<string, string> }).scripts);
    for (const comando of new Set([...doc.matchAll(/npm run ([a-z:]+)/g)].map((m) => m[1]!))) {
      expect(scripts, `no existe npm run ${comando}`).toContain(comando);
    }
  });

  it("no manda ninguna orden destructiva sobre los datos (fuera de la lista de prohibiciones)", () => {
    // «Lo que no se hace nunca» las nombra justamente para prohibirlas: se excluye esa sección.
    const prohibiciones = /## Lo que no se hace nunca[\s\S]*?(?=\n## )/;
    expect(doc).toMatch(prohibiciones);
    const ordenes = doc.replace(prohibiciones, "");
    expect(ordenes).not.toMatch(/\b(drop\s+table|truncate|delete\s+from|push\s+--force|--force-with-lease)\b/i);
  });
});
