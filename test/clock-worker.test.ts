import { describe, expect, it, vi } from "vitest";
import worker, { dispatch, selectProfile, type Env, type SafeRecord } from "../cloudflare-dispatcher/src/worker.ts";
const env: Env = { ENABLED: "true", GITHUB_OWNER: "example", GITHUB_REPO: "monitor", GITHUB_WORKFLOW: "monitor.yml",
  GITHUB_REF: "main", GITHUB_TOKEN: "synthetic-sensitive-marker", STRATEGY: "mixed", MONITOR_MODE: "capture-only" };
const at = (minute: number) => Date.UTC(2026, 8, 10, 12, minute);
describe("reloj externo, todas las peticiones simuladas", () => {
  it.each([3,33])("full en %i UTC", (minute) => expect(selectProfile(at(minute), "mixed")).toBe("full"));
  it.each([13,23,43,53])("fast en %i UTC", (minute) => expect(selectProfile(at(minute), "mixed")).toBe("fast"));
  it("observación fuerza fast; no ofrece endpoint HTTP", () => {
    expect(selectProfile(at(3), "fast-only")).toBe("fast"); expect(worker).not.toHaveProperty("fetch");
    expect(() => selectProfile(at(4), "mixed")).toThrow("invalid_config");
  });
  it.each([204,200])("petición exacta, ref configurable y aceptación %i", async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status }));
    const log = vi.fn();
    expect(await dispatch(at(23), { ...env, GITHUB_REF: "release/clock" }, { fetch, log })).toEqual({ state: "accepted", profile: "fast", http: status });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, request] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.github.com/repos/example/monitor/actions/workflows/monitor.yml/dispatches");
    expect(request).toMatchObject({ method: "POST", redirect: "error", headers: { Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`, "X-GitHub-Api-Version": "2026-03-10" } });
    expect(JSON.parse(request.body)).toEqual({ ref: "release/clock", inputs: { profile: "fast", origin: "external", mode: "capture-only" } });
    expect(JSON.stringify(log.mock.calls)).not.toContain(env.GITHUB_TOKEN);
  });
  it.each([401,403,404,422,429,302,500,202])("clasifica HTTP %i sin publicar cuerpos ni repetir dispatch", async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response(env.GITHUB_TOKEN, { status }));
    const records: SafeRecord[] = [];
    const state = [401,403,404,422,429].includes(status) ? "rejected" : "uncertain";
    await expect(dispatch(at(23), env, { fetch, log: (r) => records.push(r) })).rejects.toThrow(`dispatch_${state}`);
    expect(records).toEqual([{ state, profile: "fast", http: status }]); expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("timeout acotado y error de red incierto, con errores sanitizados", async () => {
    const log = vi.fn(); const hanging = vi.fn(() => new Promise<Response>(() => {}));
    await expect(dispatch(at(23), env, { fetch: hanging, log, timeoutMs: 5 })).rejects.toThrow("dispatch_timeout");
    expect(hanging.mock.calls).toHaveLength(1);
    const leaking = vi.fn().mockRejectedValue(new Error(env.GITHUB_TOKEN));
    await expect(dispatch(at(23), env, { fetch: leaking, log })).rejects.toThrow("dispatch_uncertain");
    expect(JSON.stringify(log.mock.calls)).not.toContain(env.GITHUB_TOKEN);
  });
  it("desactivado no requiere secreto; configuración hostil no llega a la red", async () => {
    const fetch = vi.fn(), log = vi.fn();
    expect(await dispatch(at(23), { ...env, ENABLED: "false", GITHUB_TOKEN: undefined }, { fetch, log })).toEqual({ state: "disabled" });
    await expect(dispatch(at(23), { ...env, GITHUB_OWNER: "evil.test/path" }, { fetch, log })).rejects.toThrow("dispatch_invalid_config");
    expect(fetch).not.toHaveBeenCalled();
  });
});
