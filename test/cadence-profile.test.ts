import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { executionProfile } from "../src/pipeline/profile.ts";
const workflow = readFileSync(new URL("../.github/workflows/monitor.yml", import.meta.url), "utf8");
describe("validación de perfiles sin red", () => {
  it.each(["fast", "full", "process"])("acepta %s antes del ciclo", (profile) => {
    expect(executionProfile({ MONITOR_PROFILE: profile }).profile).toBe(profile);
    const out = execFileSync(process.execPath, ["scripts/validate-profile.mjs"], { env: { NODE_ENV: "test", MONITOR_PROFILE: profile }, encoding: "utf8", windowsHide: true });
    expect(JSON.parse(out)).toMatchObject({ code: "PROFILE_VALID", profile });
  });
  it("manual por defecto full y process adapta el modo existente", () => {
    expect(executionProfile({})).toMatchObject({ profile: "full", processOnly: false, trigger: "manual" });
    expect(executionProfile({ MONITOR_PROFILE: "process" }).processOnly).toBe(true);
    expect(executionProfile({ MONITOR_MODE: "process-only" }).processOnly).toBe(true);
  });
  it("perfil desconocido aborta en el validador sin imprimirlo", () => {
    const result = spawnSync(process.execPath, ["scripts/validate-profile.mjs"], { env: { NODE_ENV: "test", MONITOR_PROFILE: "private-invalid-marker" }, encoding: "utf8", windowsHide: true });
    expect(result.status).toBe(1); expect(result.stderr).toContain("PROFILE_INVALID");
    expect(result.stderr).not.toContain("private-invalid-marker");
    expect(() => executionProfile({ MONITOR_PROFILE: "unknown" })).toThrow("invalid_monitor_profile");
    expect(() => executionProfile({ MONITOR_PROFILE: "process", MONITOR_MODE: "capture-only" })).toThrow();
  });
  it("cron de respaldo independiente, grupo común, no cancela envíos", () => {
    expect(workflow).toContain('cron: "7 * * * *"'); expect(workflow).toContain('cron: "37 * * * *"');
    expect(workflow).toContain("group: monitor"); expect(workflow).toContain("cancel-in-progress: false");
    expect(workflow).toContain("github.event_name == 'schedule' && 'full'");
    expect(workflow.indexOf("node scripts/validate-profile.mjs")).toBeLessThan(workflow.indexOf("run: npm ci"));
    expect(workflow).toContain("steps.profile.outputs.valid == 'true'");
    expect(workflow).not.toMatch(/\bsleep\s+\d/);
  });
});
