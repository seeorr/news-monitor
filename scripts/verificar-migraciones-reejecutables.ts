/**
 * PostgreSQL real local (WASM): el migrador reejecuta TODOS los archivos en cada
 * arranque, sobre una base que ya tiene datos. Esto reproduce exactamente eso.
 *
 * Existe por el 14-09: `20260910_news_control.sql` recreaba el check de motivos
 * con la lista antigua. Sobre una base **vacía** no falla nada —otra migración
 * posterior lo vuelve a ampliar y al final de cada pasada la definición es la
 * misma—, así que comparar restricciones no basta: la primera versión de este
 * script pasaba con el archivo roto. Lo que rompió producción fueron **las filas**
 * con el valor nuevo (`excluded_at_activation`) chocando con el check estrecho a
 * mitad de pasada.
 *
 * Por eso, tras la primera pasada se siembran filas con los valores más nuevos
 * que admite cada check reconstruido, y la segunda pasada tiene que terminar sin
 * error y sin cambiar ninguna restricción. Si se añade un valor a un check que
 * alguna migración reconstruye, se añade aquí también su fila. Sin .env, red ni Neon.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { splitStatements } from "../src/lib/sql.ts";

const { PGlite } = await import(pathToFileURL(resolve(".cache/pglite/package/dist/index.js")).href);
const db = new PGlite();
const archivos = (await readdir("neon/migrations")).filter((nombre) => nombre.endsWith(".sql")).sort();

async function pasada(etiqueta: string): Promise<void> {
  for (const archivo of archivos) {
    for (const sentencia of splitStatements(await readFile(`neon/migrations/${archivo}`, "utf8"))) {
      try { await db.query(sentencia); }
      catch (error) { throw new Error(`${etiqueta}, ${archivo}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
}

async function restricciones(): Promise<Map<string, string>> {
  const filas = (await db.query(`select c.conrelid::regclass::text as tabla, c.conname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public'`)).rows as
    { tabla: string; conname: string; def: string }[];
  return new Map(filas.map((fila) => [`${fila.tabla}.${fila.conname}`, fila.def]));
}

/** Las filas que en producción ya existen y que un check estrecho no tolera. */
async function sembrarValoresNuevos(): Promise<string[]> {
  await db.query(`insert into capture_queue (id, snapshot, source_key, publisher, state, first_captured_at, last_captured_at, reason, processed_at)
    values ('semilla-excluida', '{"id":"semilla-excluida","kind":"news"}', 'rss:semilla', 'semilla', 'discarded', now(), now(), 'excluded_at_activation', now())`);
  await db.query(`insert into alert_deliveries (event_id, state, claim_token, claimed_at, settled_at, attempts)
    values ('semilla-no-entregable', 'undeliverable', null, now(), now(), 1)`);
  await db.query(`insert into alert_deliveries (event_id, state, claim_token, claimed_at, settled_at, attempts, next_attempt_at)
    values ('semilla-aplazada', 'deferred', null, now(), now(), 1, now() + interval '1 hour')`);
  return ["capture_queue.reason=excluded_at_activation", "alert_deliveries.state=undeliverable", "alert_deliveries.state=deferred"];
}

await pasada("primera pasada");
const primera = await restricciones();
const sembradas = await sembrarValoresNuevos();
await pasada("segunda pasada, con datos");
const segunda = await restricciones();

const cambiadas = [...primera].filter(([nombre, def]) => segunda.get(nombre) !== def).map(([nombre]) => nombre);
const nuevas = [...segunda.keys()].filter((nombre) => !primera.has(nombre));
assert.deepEqual({ cambiadas, nuevas }, { cambiadas: [], nuevas: [] });
assert.match(segunda.get("capture_queue.capture_queue_reason_check") ?? "", /excluded_at_activation/);
const conservadas = (await db.query(`select (select count(*)::int from capture_queue where id like 'semilla-%')
  + (select count(*)::int from alert_deliveries where event_id like 'semilla-%') as n`)).rows[0] as { n: number };
assert.equal(conservadas.n, 3);

console.log(JSON.stringify({ ok: true, archivos: archivos.length, restricciones: segunda.size, sembradas,
  checks: ["segunda_pasada_con_datos_nuevos_sin_error", "ninguna_restriccion_cambia", "motivos_vigentes_tras_reejecutar", "filas_sembradas_intactas"] }));
