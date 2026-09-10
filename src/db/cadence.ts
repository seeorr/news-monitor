import { neon } from "@neondatabase/serverless";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Ejecutor } from "./cliente.ts";
import { RunRecord, type RunStore } from "../pipeline/cadence.ts";
export function neonRunStore(url: string, sql: Ejecutor = neon(url)): RunStore {
  return {
    async put(record) {
      const row = RunRecord.parse(record);
      await sql`insert into monitor_runs(id,started_at,record) values(${row.id}::uuid,${row.startedAt}::timestamptz,${JSON.stringify(row)}::jsonb)
        on conflict(id) do update set record=excluded.record`;
    },
    async recent(since) {
      const rows = await sql`select record from monitor_runs where started_at >= ${since}::timestamptz order by started_at desc` as {record:unknown}[];
      return rows.map((row) => RunRecord.parse(row.record));
    },
  };
}
export function fileRunStore(stateDir: string): RunStore {
  const dir = join(stateDir, "runs");
  // Un escritor por UUID; checkpoint serializado en main. No se comparte un
  // JSON entre jobs, por lo que una caída no corrompe el historial completo.
  return {
    async put(record) {
      const row = RunRecord.parse(record);
      await mkdir(dir, { recursive: true });
      const path = join(dir, `${row.id}.json`), temp = `${path}.tmp`;
      await writeFile(temp, JSON.stringify(row), { encoding: "utf8", mode: 0o600 });
      await rename(temp, path);
    },
    async recent(since) {
      const names = await readdir(dir).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
      const rows = await Promise.all(names.filter((name) => /^[a-f0-9-]{36}\.json$/.test(name)).map(async (name) =>
        RunRecord.parse(JSON.parse(await readFile(join(dir, name), "utf8")))));
      return rows.filter((row) => row.startedAt >= since).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    },
  };
}
export function memoryRunStore(): RunStore {
  const records = new Map<string, RunRecord>();
  return { async put(row) { records.set(row.id, RunRecord.parse(row)); },
    async recent(since) { return [...records.values()].filter((row) => row.startedAt >= since).map((row) => structuredClone(row)); } };
}
