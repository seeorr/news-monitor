import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fileSeenStore, type EstadoEntrega } from "../src/pipeline/seen.ts";

const runFile = promisify(execFile);
const cache = resolve(".cache");
let directory: string;
const eventId = "rss:synthetic:test-durable-delivery";

beforeEach(() => {
  mkdirSync(cache, { recursive: true });
  directory = mkdtempSync(join(cache, "file-delivery-"));
});
afterEach(() => {
  vi.useRealTimers();
  const inside = relative(cache, resolve(directory));
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) throw new Error("invalid_test_cleanup_target");
  rmSync(directory, { recursive: true, force: true });
});

describe("reclamos locales duraderos de Telegram", () => {
  it("reiniciar después de reclamar, sin marcar el evento, no permite enviar otra vez", async () => {
    const first = fileSeenStore(directory);
    expect(await first.claimAlert(eventId, { token: "first-process" })).toBe(true);
    expect(await first.has(eventId)).toBe(false);
    expect(existsSync(join(directory, "seen.json"))).toBe(false);

    const restarted = fileSeenStore(directory);
    expect(await restarted.has(eventId)).toBe(false);
    expect(await restarted.alertState?.(eventId)).toBe("sending");
    expect(await restarted.claimAlert(eventId, { token: "second-process" })).toBe(false);
    expect(readdirSync(directory)).toEqual(["alert-deliveries.json"]);
  });

  it.each<EstadoEntrega>(["sent", "rejected", "uncertain"])("un estado %s sigue bloqueado después del reinicio", async (state) => {
    const first = fileSeenStore(directory);
    expect(await first.claimAlert(eventId, { token: "owner" })).toBe(true);
    await first.finishAlert(eventId, "owner", state);
    const restarted = fileSeenStore(directory);
    expect(await restarted.alertState?.(eventId)).toBe(state);
    expect(await restarted.claimAlert(eventId, { token: "next" })).toBe(false);
  });

  it("doce instancias que compiten por la misma entrega conceden un solo reclamo", async () => {
    const attempts = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      fileSeenStore(directory).claimAlert(eventId, { token: `owner-${i}` })));
    expect(attempts.filter(Boolean)).toHaveLength(1);
    const winner = attempts.findIndex(Boolean);
    await fileSeenStore(directory).finishAlert(eventId, `owner-${winner}`, "sent");
    expect(await fileSeenStore(directory).alertState?.(eventId)).toBe("sent");
    expect(readdirSync(directory)).toEqual(["alert-deliveries.json"]);
  });

  it("la competencia por entregas diferentes conserva todos los reclamos", async () => {
    const attempts = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      fileSeenStore(directory).claimAlert(`${eventId}-${i}`, { token: `owner-${i}` })));
    expect(attempts.every(Boolean)).toBe(true);
    const ledger = JSON.parse(readFileSync(join(directory, "alert-deliveries.json"), "utf8"));
    expect(ledger.version).toBe(1);
    expect(ledger.deliveries).toHaveLength(12);
    expect(new Set(ledger.deliveries.map((row: { eventId: string }) => row.eventId)).size).toBe(12);
  });

  it("solo force cambia de dueño y el token anterior no puede cerrar el nuevo reclamo", async () => {
    const original = fileSeenStore(directory);
    const next = fileSeenStore(directory);
    await original.claimAlert(eventId, { token: "original" });
    await expect(next.finishAlert(eventId, "other", "sent")).rejects.toThrow("alert_claim_lost");
    expect(await next.claimAlert(eventId, { token: "new", force: true })).toBe(true);
    await expect(original.finishAlert(eventId, "original", "sent")).rejects.toThrow("alert_claim_lost");
    expect(await original.alertState?.(eventId)).toBe("sending");
    await next.finishAlert(eventId, "new", "sent");
    expect(await original.alertState?.(eventId)).toBe("sent");
  });

  it("un archivo corrupto falla cerrado y conserva exactamente sus bytes", async () => {
    const path = join(directory, "alert-deliveries.json");
    const corrupted = '{"version":1,"deliveries":[{"eventId":"pending"';
    writeFileSync(path, corrupted, "utf8");
    const store = fileSeenStore(directory);
    await expect(store.alertState?.(eventId)).rejects.toThrow();
    await expect(store.claimAlert(eventId, { token: "owner", force: true })).rejects.toThrow();
    expect(readFileSync(path, "utf8")).toBe(corrupted);
    expect(readdirSync(directory)).toEqual(["alert-deliveries.json"]);
  });

  it("un bloqueo huérfano no caduca ni da permiso para reenviar", async () => {
    vi.useFakeTimers();
    const lock = join(directory, "alert-deliveries.json.lock");
    writeFileSync(lock, JSON.stringify({ pid: 999_999_999 }), "utf8");
    const work = fileSeenStore(directory).claimAlert(eventId, { token: "owner" });
    const assertion = expect(work).rejects.toThrow("alert_delivery_file_busy");
    await vi.runAllTimersAsync();
    await assertion;
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(join(directory, "alert-deliveries.json"))).toBe(false);
  });

  it("los reclamos conservan el archivo previo de ids procesados", async () => {
    const seenPath = join(directory, "seen.json");
    const before = '["event-already-processed"]';
    writeFileSync(seenPath, before, "utf8");
    const store = fileSeenStore(directory);
    expect(await store.has("event-already-processed")).toBe(true);
    await store.claimAlert(eventId, { token: "owner" });
    await store.finishAlert(eventId, "owner", "sent");
    expect(readFileSync(seenPath, "utf8")).toBe(before);
  });

  it("dos procesos Node independientes tampoco obtienen el mismo reclamo", async () => {
    const source = new URL("../src/pipeline/seen.ts", import.meta.url).href;
    const script = `import { fileSeenStore } from ${JSON.stringify(source)};
      const result = await fileSeenStore(process.argv[1]).claimAlert(process.argv[2], { token: process.argv[3] });
      process.stdout.write(JSON.stringify(result));`;
    const attempts = await Promise.all(["process-1", "process-2"].map((token) => runFile(process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", script, directory, eventId, token],
      { cwd: process.cwd(), windowsHide: true })));
    expect(attempts.map(({ stdout }) => JSON.parse(stdout)).filter(Boolean)).toHaveLength(1);
    expect(await fileSeenStore(directory).alertState?.(eventId)).toBe("sending");
  });
});
