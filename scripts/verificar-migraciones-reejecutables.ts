/**
 * PostgreSQL real local (WASM): el migrador reejecuta TODOS los archivos en cada
 * arranque, así que aplicarlos dos veces no puede cambiar ninguna restricción.
 *
 * Existe por el 14-09: `20260910_news_control.sql` recreaba el check de motivos
 * con la lista antigua. Sobre una tabla vacía no falla nada, pero **la definición
 * cambia**, y eso es lo que se compara aquí: todas las restricciones de todas las
 * tablas, antes y después de la segunda pasada. Sin .env, red ni Neon.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { splitStatements } from "../src/lib/sql.ts";

const { PGlite } = await import(pathToFileURL(resolve(".cache/pglite/package/dist/index.js")).href);
const db = new PGlite();
const archivos = (await readdir("neon/migrations")).filter((nombre) => nombre.endsWith(".sql")).sort();

async function pasada(): Promise<void> {
  for (const archivo of archivos) {
    for (const sentencia of splitStatements(await readFile(`neon/migrations/${archivo}`, "utf8"))) {
      try { await db.query(sentencia); }
      catch (error) { throw new Error(`${archivo}: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
}

async function restricciones(): Promise<Map<string, string>> {
  const filas = (await db.query(`select c.conrelid::regclass::text as tabla, c.conname, pg_get_constraintdef(c.oid) as def
    from pg_constraint c join pg_namespace n on n.oid = c.connamespace where n.nspname = 'public'`)).rows as
    { tabla: string; conname: string; def: string }[];
  return new Map(filas.map((fila) => [`${fila.tabla}.${fila.conname}`, fila.def]));
}

await pasada();
const primera = await restricciones();
await pasada();
const segunda = await restricciones();

const cambiadas = [...primera].filter(([nombre, def]) => segunda.get(nombre) !== def).map(([nombre]) => nombre);
const nuevas = [...segunda.keys()].filter((nombre) => !primera.has(nombre));
assert.deepEqual({ cambiadas, nuevas }, { cambiadas: [], nuevas: [] });
assert.match(segunda.get("capture_queue.capture_queue_reason_check") ?? "", /excluded_at_activation/);

console.log(JSON.stringify({ ok: true, archivos: archivos.length, restricciones: segunda.size,
  checks: ["dos_pasadas_sin_cambiar_ninguna_restriccion", "motivos_vigentes_tras_reejecutar"] }));
