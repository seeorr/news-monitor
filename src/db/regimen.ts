import type { Ejecutor } from "./cliente.ts";
import type { Regimen } from "../sources/regimen.ts";

export async function guardarRegimen(sql: Ejecutor, r: Regimen): Promise<void> {
  await sql`
    insert into market_regimes (day, as_of, version, state, payload)
    values (${r.asOf.slice(0, 10)}::date, ${r.asOf}::timestamptz, ${r.version}, ${r.state}, ${JSON.stringify(r)}::jsonb)
    on conflict (day) do update set
      as_of = excluded.as_of, version = excluded.version,
      state = excluded.state, payload = excluded.payload
    where market_regimes.as_of < excluded.as_of
  `;
}

export async function ultimoRegimen(sql: Ejecutor): Promise<Regimen | null> {
  const filas = await sql`select payload from market_regimes order by day desc limit 1` as Array<{payload: Regimen}>;
  return filas[0]?.payload ?? null;
}
