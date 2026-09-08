/**
 * Aplica las migraciones de `neon/migrations` en orden alfabético.
 *
 * No lleva registro de lo aplicado: cada migración es idempotente y se ejecuta
 * entera en cada arranque. Es el patrón de Finance Hub y para un esquema de este
 * tamaño no hace falta más.
 *
 * Usa `postgres` (TCP) en vez del driver HTTP porque el HTTP no admite varias
 * sentencias en una sola llamada.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
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

  const sql = postgres(url, { max: 1, ssl: "require" });
  try {
    for (const file of files) {
      await sql.unsafe(await readFile(join(directory, file), "utf8"));
      console.log(`✓ ${file}`);
    }
    console.log(`\n${files.length} migración(es) aplicadas.`);
  } finally {
    await sql.end();
  }
}

main().catch((error: unknown) => {
  console.error("✕ Migración fallida:", error instanceof Error ? error.message : error);
  process.exit(1);
});
