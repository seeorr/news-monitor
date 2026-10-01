/** PostgreSQL real local (WASM): migración de intentos de acceso y su cuenta atómica. Sin .env, red ni Neon. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { splitStatements } from "../src/lib/sql.ts";
import { almacenNeon } from "../src/db/intentos-acceso.ts";
import type { Ejecutor } from "../src/db/cliente.ts";

const { PGlite } = await import(pathToFileURL(resolve(".cache/pglite/package/dist/index.js")).href);
const db = new PGlite();
const sql: Ejecutor = async (parts, ...values) =>
  (await db.query(parts.map((p, i) => (i < values.length ? `${p}$${i + 1}` : p)).join(""), values)).rows;
const checks: string[] = [];

// Dos veces: el migrador reejecuta todos los SQL en cada arranque.
for (let vez = 0; vez < 2; vez++) {
  for (const sentencia of splitStatements(await readFile("neon/migrations/20260914_intentos_de_acceso.sql", "utf8"))) {
    await db.query(sentencia);
  }
}
checks.push("migracion_idempotente");

const politica = { maxFallos: 5, ventanaMs: 15 * 60_000, bloqueoMs: 15 * 60_000 };
const intentos = almacenNeon(sql, politica);
const t0 = new Date("2026-09-14T18:00:00Z");
const minuto = (m: number) => new Date(t0.getTime() + m * 60_000);

for (let i = 1; i <= 4; i++) {
  const intento = await intentos.registrarIntento("k", minuto(i));
  assert.equal(intento.permitido, true);
  assert.equal(intento.bloqueadoHasta, null);
}
assert.equal(await intentos.bloqueadoHasta("k", minuto(4)), null);
checks.push("cuatro_intentos_no_bloquean");

// El quinto todavía se evalúa: es el fallo que bloquea.
const quinto = await intentos.registrarIntento("k", minuto(5));
assert.equal(quinto.permitido, true);
assert.equal(quinto.fallos, 5);
assert.equal(quinto.bloqueadoHasta?.toISOString(), minuto(20).toISOString());
assert.equal((await intentos.bloqueadoHasta("k", minuto(19)))?.toISOString(), minuto(20).toISOString());
checks.push("quinto_se_evalua_y_bloquea_15_min");

const bloqueado = await intentos.registrarIntento("k", minuto(10));
assert.equal(bloqueado.permitido, false);
assert.equal(bloqueado.fallos, null);
assert.equal(bloqueado.bloqueadoHasta?.toISOString(), minuto(20).toISOString());
assert.equal((await db.query("select failures from dashboard_login_attempts where client_key = 'k'")).rows[0].failures, 5);
checks.push("bloqueada_no_cuenta_ni_alarga");

assert.equal(await intentos.bloqueadoHasta("k", minuto(21)), null);
checks.push("el_bloqueo_vence");

assert.equal(await intentos.bloqueadoHasta("otra", minuto(5)), null);
checks.push("otra_clave_independiente");

assert.equal((await intentos.registrarIntento("k", minuto(40))).fallos, 1);
checks.push("ventana_vencida_reinicia_la_cuenta");

await intentos.limpiar("k");
assert.equal((await db.query("select count(*)::int as n from dashboard_login_attempts where client_key = 'k'")).rows[0].n, 0);
checks.push("acierto_limpia");

// La razón de contar por adelantado: de una ráfaga en paralelo solo cinco
// intentos reciben permiso para mirar la clave.
const rafaga = await Promise.all(Array.from({ length: 12 }, () => intentos.registrarIntento("r", minuto(50))));
assert.equal(rafaga.filter((r) => r.permitido).length, 5);
assert.equal((await db.query("select failures from dashboard_login_attempts where client_key = 'r'")).rows[0].failures, 5);
checks.push("rafaga_solo_evalua_cinco");

await intentos.registrarIntento("vieja", minuto(0));
await intentos.registrarIntento("nueva", new Date(t0.getTime() + 25 * 60 * 60_000));
assert.equal((await db.query("select count(*)::int as n from dashboard_login_attempts where client_key = 'vieja'")).rows[0].n, 0);
checks.push("filas_de_mas_de_un_dia_se_limpian");

console.log(JSON.stringify({ ok: true, checks }));
