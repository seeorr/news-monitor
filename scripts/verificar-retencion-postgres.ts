/**
 * La retención, contra PostgreSQL de verdad (PGlite en WASM, desde .cache).
 *
 * No carga `.env`, no consulta `DATABASE_URL` y no toca producción. Prepararlo
 * es lo mismo que para las otras verificaciones:
 *   npm pack @electric-sql/pglite@0.5.8 --ignore-scripts --pack-destination .cache --cache .cache/npm
 *   mkdir .cache/pglite && tar -xf .cache/electric-sql-pglite-0.5.8.tgz -C .cache/pglite
 *   npx tsx scripts/verificar-retencion-postgres.ts
 *
 * Qué se comprueba aquí y no en un test con dobles: que la fila podada **sigue
 * cumpliendo los CHECK de la tabla** —el que exige `snapshot->>'id' = id` y el
 * que exige `kind = 'news'` cuando hay `story_at`—. Una poda que dejara un
 * snapshot inválido no fallaría en TypeScript: fallaría en producción, de noche
 * y a mitad de un ciclo.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Ejecutor } from "../src/db/cliente.ts";
import { splitStatements } from "../src/lib/sql.ts";
import { podar, simularPoda } from "../src/db/retencion.ts";

type LocalDatabase = {
  query(text: string, values?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
  close(): Promise<void>;
};
const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const AHORA = "2026-10-01T10:00:00.000Z";
const CORTE = "2026-09-01T10:00:00.000Z"; // 30 días
const VIEJO = "2026-08-01T10:00:00.000Z";
const RECIENTE = "2026-09-20T10:00:00.000Z";

async function main(): Promise<void> {
  const checks: string[] = [];
  const runtimeArgument = process.argv.find((arg) => arg.startsWith("--runtime="))?.slice("--runtime=".length);
  const runtime = resolve(repo, runtimeArgument ?? ".cache/pglite/package/dist/index.js");
  const { PGlite } = await import(pathToFileURL(runtime).href) as { PGlite: new () => LocalDatabase };
  const db = new PGlite();
  const sql: Ejecutor = async (parts, ...values) => {
    const statement = parts.map((part, index) => index < values.length ? `${part}$${index + 1}` : part).join("");
    return (await db.query(statement, values)).rows;
  };

  try {
    // Todas, y en el mismo orden alfabético que aplica el migrador: la vista de
    // `20260910_run_cadence.sql` lee `alert_deliveries`, así que aplicar solo
    // las de la cola dejaba el esquema a medias y el script fallaba por algo que
    // en producción no pasa nunca.
    const archivos = (await readdir(join(repo, "neon/migrations"))).filter((f) => f.endsWith(".sql")).sort();
    for (const archivo of archivos) {
      const migration = await readFile(join(repo, "neon/migrations", archivo), "utf8");
      for (const statement of splitStatements(migration)) await db.query(statement);
    }

    const fila = async (id: string, reason: string | null, state: string, processed: string | null,
      ultimaCaptura: string, story = false) => {
      const snapshot = JSON.stringify({ id, kind: "news", source: "rss", title: `Titular largo de ${id}`,
        summary: "Una entradilla que ocupa espacio y que nadie va a volver a leer nunca." });
      await db.query(
        `insert into capture_queue (id, snapshot, source_key, publisher, state, story_at,
           first_captured_at, last_captured_at, reason, processed_at, score)
         values ($1, $2::jsonb, 'rss:x', 'x', $3, $4, $5, $6, $7, $8, $9::jsonb)`,
        [id, snapshot, state, story ? VIEJO : null, VIEJO, ultimaCaptura, reason, processed,
          state === "scored" ? JSON.stringify({ importance_score: 5 }) : null]);
    };

    await fila("podable", "rules_no_match", "discarded", VIEJO, VIEJO);
    await fila("podable-story", "rules_low_signal", "discarded", VIEJO, VIEJO, true);
    await fila("duplicada", "duplicate_story", "discarded", VIEJO, VIEJO);
    await fila("reciente", "rules_no_match", "discarded", RECIENTE, RECIENTE);
    await fila("reinyectada", "rules_no_match", "discarded", VIEJO, RECIENTE);
    await fila("puntuada", null, "scored", VIEJO, VIEJO);

    await db.query(`insert into monitor_runs (id, started_at, record) values
      ('11111111-1111-1111-1111-111111111111', $1, $2::jsonb),
      ('22222222-2222-2222-2222-222222222222', $3, $4::jsonb)`, [
      VIEJO, JSON.stringify({ id: "11111111-1111-1111-1111-111111111111", profile: "fast", trigger: "external", status: "success" }),
      RECIENTE, JSON.stringify({ id: "22222222-2222-2222-2222-222222222222", profile: "full", trigger: "external", status: "success" }),
    ]);

    // El simulacro cuenta exactamente lo que la poda va a tocar, y no escribe.
    const previsto = await simularPoda(sql, CORTE);
    assert.equal(previsto.snapshotsPodados, 2, "solo las dos descartadas viejas y no reinyectadas");
    assert.equal(previsto.ejecucionesBorradas, 1);
    assert.ok(previsto.bytesLiberados > 0);
    const intacto = await db.query(`select count(*)::int as n from capture_queue where jsonb_exists(snapshot, 'podado_en')`);
    assert.equal(intacto.rows[0]!["n"], 0, "el simulacro no escribe");
    checks.push("simulacro_cuenta_sin_escribir");

    const hecho = await podar(sql, CORTE, AHORA);
    assert.deepEqual(hecho, previsto, "lo aplicado coincide con lo simulado");
    checks.push("aplicado_coincide_con_simulado");

    // Ninguna fila desaparece: la fila es la memoria de deduplicación.
    const total = await db.query(`select count(*)::int as n from capture_queue`);
    assert.equal(total.rows[0]!["n"], 6, "no se borra ninguna noticia");
    checks.push("ninguna_fila_borrada");

    const podada = (await db.query(`select snapshot from capture_queue where id = 'podable-story'`)).rows[0]!["snapshot"] as Record<string, unknown>;
    assert.equal(podada["id"], "podable-story");
    assert.equal(podada["kind"], "news", "el CHECK de story_at exige conservar kind");
    assert.equal(podada["podado_en"], AHORA);
    assert.equal(podada["summary"], undefined, "la entradilla es lo que se va");
    assert.ok(String(podada["title"]).startsWith("Titular largo"));
    checks.push("esqueleto_conserva_id_kind_y_titular");

    for (const id of ["duplicada", "reciente", "reinyectada", "puntuada"]) {
      const fila = (await db.query(`select snapshot from capture_queue where id = $1`, [id])).rows[0]!["snapshot"] as Record<string, unknown>;
      assert.ok(fila["summary"], `${id} no debía podarse`);
    }
    checks.push("respeta_duplicadas_recientes_reinyectadas_y_puntuadas");

    const runs = await db.query(`select id from monitor_runs`);
    assert.equal(runs.rows.length, 1, "solo se borra la telemetría anterior al corte");
    checks.push("telemetria_antigua_borrada");

    // Dos pasadas seguidas: la marca `podado_en` impide volver a tocar lo mismo.
    const repetida = await podar(sql, CORTE, AHORA);
    assert.equal(repetida.snapshotsPodados, 0);
    assert.equal(repetida.ejecucionesBorradas, 0);
    checks.push("idempotente");

    console.log(JSON.stringify({ code: "RETENTION_LOCAL_OK", checks }));
  } finally {
    await db.close();
  }
}

main().catch((error: unknown) => {
  console.error("RETENTION_LOCAL_FAILED", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
