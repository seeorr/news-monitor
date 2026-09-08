/**
 * Aplica las migraciones de `neon/migrations` en orden alfabético.
 *
 * No lleva registro de lo aplicado: cada migración es idempotente y se ejecuta
 * entera en cada arranque. Para un esquema de este tamaño no hace falta más.
 *
 * Va por **HTTPS**, con el mismo driver que la aplicación, y no por el puerto
 * 5432. Motivo: hay redes que bloquean el puerto de Postgres —la de casa, sin ir
 * más lejos— y no tiene sentido que el migrador exija una vía de acceso que la
 * app no necesita. El precio es que el endpoint HTTP admite una sentencia por
 * llamada, así que el archivo se trocea aquí.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { neon } from "@neondatabase/serverless";
import { splitStatements } from "../src/lib/sql.ts";
import { loadDotEnv } from "../src/config.ts";

async function main(): Promise<void> {
  loadDotEnv();
  const url = process.env["DATABASE_URL"];
  if (!url) {
    console.error("DATABASE_URL no está configurada.");
    console.error("Cógela del panel de Neon → Connection string (pooled) y ponla en .env");
    process.exit(1);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  const directory = resolve(here, "..", "neon", "migrations");
  const files = (await readdir(directory)).filter((n) => n.endsWith(".sql")).sort();
  if (files.length === 0) {
    console.error(`No hay migraciones en ${directory}`);
    process.exit(1);
  }

  const sql = neon(url);
  let total = 0;
  for (const file of files) {
    const sentencias = splitStatements(await readFile(join(directory, file), "utf8"));
    for (const sentencia of sentencias) await sql.query(sentencia);
    total += sentencias.length;
    console.log(`✓ ${file} (${sentencias.length} sentencias)`);
  }
  console.log(`\n${files.length} migración(es), ${total} sentencias aplicadas.`);
}

main().catch((error: unknown) => {
  const detalle =
    error instanceof AggregateError
      ? error.errors.map((e: unknown) => (e instanceof Error ? e.message : String(e))).join("; ")
      : error instanceof Error
        ? error.message
        : String(error);
  console.error("✕ Migración fallida:", detalle || "sin mensaje");
  process.exit(1);
});
