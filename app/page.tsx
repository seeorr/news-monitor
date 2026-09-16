/**
 * Home — el panorama antes que el detalle.
 *
 * Dos columnas: lo importante a la izquierda, contexto a la derecha. El **bloque
 * de mercado no es un 2x2 de Nasdaq / S&P / US10Y / BTC**, porque de esos cuatro
 * solo se ingiere el bono a 10 años: se enseñan las tres series que existen y ya
 * (hueco G4).
 *
 * El régimen entra como **tarjeta del sidebar y no como franja del layout**. El
 * estado más probable de un día cualquiera es «señales mixtas» o «datos
 * insuficientes», y una franja que lo repite en la cabecera de las seis páginas
 * deja de informar a la segunda: se convierte en decoración y roba altura en
 * todas. Un dato que se consulta una vez al día vive en un sitio.
 */
import Link from "next/link";
import { Bloque, Cabecera } from "./_componentes/cabecera.tsx";
import { FilaWatchlist } from "./_componentes/fila-watchlist.tsx";
import { SinDatos } from "./_componentes/sin-datos.tsx";
import { TarjetaEvento } from "./_componentes/tarjeta-evento.tsx";
import { TarjetaMetrica } from "./_componentes/tarjeta-metrica.tsx";
import { Vacio } from "./_componentes/chips.tsx";
import { cargar } from "./_lib/cargar.ts";
import { claveFred, urlBaseDeDatos } from "./_lib/servidor.ts";
import { loImportante, ultimasSeries, ultimosMovimientos } from "../src/db/lectura.ts";
import { ultimoRegimen } from "../src/db/regimen.ts";
import type { Regimen } from "../src/sources/regimen.ts";
import { leerWatchlist } from "../src/db/watchlist.ts";
import { SERIES } from "../src/sources/fred.ts";
import { DATASETS } from "../src/sources/eurostat.ts";
import { fetchAgenda, type Cita } from "../src/sources/calendario.ts";

export const dynamic = "force-dynamic";

export default async function Home() {
  const ahora = new Date();

  const principal = await cargar(async (sql) => ({
    importantes: await loImportante(sql, { limite: 8 }),
    series: await ultimasSeries(sql, [...Object.keys(SERIES), ...Object.keys(DATASETS)]),
    movimientos: await ultimosMovimientos(sql),
    regimen: await ultimoRegimen(sql),
  }));

  const url = urlBaseDeDatos();
  const vigilados = url ? await leerWatchlist(url).catch(() => null) : null;
  const citas = await proximasCitas();

  return (
    <>
      <Cabecera
        titulo="Lo importante"
        descripcion="Ordenado por la nota del paso 3, no por hora de llegada. Lo reciente no es lo importante."
      />

      <div className="grid gap-6 lg:grid-cols-[1.7fr_1fr]">
        <div>
          {!principal.ok ? (
            <SinDatos motivo={principal.motivo} />
          ) : principal.datos.importantes.length === 0 ? (
            <Vacio
              titulo="Todavía no hay nada puntuado"
              porque="La nota la pone el paso 3 de la cascada, y solo la recibe lo que pasa el filtro por reglas. Si el ciclo aún no ha corrido con ANTHROPIC_API_KEY, no hay nada que ordenar."
              siguiente={
                <>
                  Lo ingerido sin puntuar está en{" "}
                  <Link href="/news" className="text-accent-text underline underline-offset-2">
                    News
                  </Link>
                  .
                </>
              }
            />
          ) : (
            <div className="flex flex-col gap-2.5">
              {principal.datos.importantes.map((e) => (
                <TarjetaEvento key={e.id} evento={e} ahora={ahora} />
              ))}
            </div>
          )}
        </div>

        <aside>
          <Bloque titulo="Macro" nota="lo que se ingiere de FRED y Eurostat">
            {principal.ok && principal.datos.series.length > 0 ? (
              <div className="flex flex-col gap-2">
                {principal.datos.series.map((s) => (
                  <TarjetaMetrica key={s.series_id} serie={s} />
                ))}
              </div>
            ) : (
              <p className="text-secundario text-txt-3">
                Sin observaciones todavía. Las escribe el ciclo, no esta pantalla.
              </p>
            )}
          </Bloque>

          <Bloque titulo="Régimen" nota="una fotografía al día">
            <TarjetaRegimen regimen={principal.ok ? principal.datos.regimen : null} />
          </Bloque>

          <Bloque titulo="Watchlist" nota={vigilados ? `${vigilados.length}` : undefined}>
            {vigilados === null ? (
              <p className="text-secundario text-txt-3">No se ha podido leer la watchlist.</p>
            ) : vigilados.length === 0 ? (
              <Vacio
                titulo="Watchlist vacía"
                porque="Sin valores, EDGAR y los precios no tienen a quién vigilar: las dos fuentes corren y no devuelven nada."
                siguiente={
                  <Link href="/watchlist" className="text-accent-text underline underline-offset-2">
                    Añadir el primer valor
                  </Link>
                }
              />
            ) : (
              <>
                <div className="rounded-tarjeta border border-linea bg-card px-3.5 py-1">
                  {vigilados.slice(0, 8).map((v) => (
                    <FilaWatchlist
                      key={v.ticker}
                      valor={v}
                      movimiento={
                        principal.ok
                          ? principal.datos.movimientos.find((m) => m.ticker === v.ticker)
                          : undefined
                      }
                    />
                  ))}
                </div>
                <Link
                  href="/watchlist"
                  className="mt-2 inline-block text-secundario text-accent-text underline underline-offset-2"
                >
                  + Añadir ticker
                </Link>
              </>
            )}
          </Bloque>

          <Bloque titulo="Agenda" nota="próximos 7 días">
            <AgendaCorta citas={citas} />
          </Bloque>
        </aside>
      </div>
    </>
  );
}

const ESTADO_REGIMEN: Record<Regimen["state"], { texto: string; color: string }> = {
  risk_on: { texto: "Favorable al riesgo", color: "bg-success-bg text-success-text border-success-border" },
  risk_off: { texto: "Aversión al riesgo", color: "bg-danger-bg text-danger-text border-danger-border" },
  mixed: { texto: "Señales mixtas", color: "bg-warning-bg text-warning-text border-warning-border" },
  insufficient_data: { texto: "Datos insuficientes", color: "bg-muted-bg text-muted-text border-muted-border" },
};

/**
 * El estado, la fecha del cálculo y un enlace. Ni los votos ni las señales: eso
 * es `/regime`, y repetir aquí media tabla sería mantener dos pantallas que
 * dicen lo mismo hasta el día en que dejan de decirlo.
 */
function TarjetaRegimen({ regimen }: { regimen: Regimen | null }) {
  if (regimen === null) {
    return (
      <p className="text-secundario text-txt-3">
        Sin fotografía todavía. La escribe el ciclo diario del régimen, no esta pantalla.
      </p>
    );
  }
  const estado = ESTADO_REGIMEN[regimen.state];
  return (
    <Link
      href="/regime"
      className="block rounded-tarjeta border border-linea bg-card px-3.5 py-3 hover:bg-raised"
    >
      <span
        className={`inline-flex items-center rounded-chip border px-2 py-0.5 text-meta font-medium ${estado.color}`}
      >
        {estado.texto}
      </span>
      <p className="cifra mt-1.5 text-meta text-txt-3">
        {regimen.asOf.slice(0, 10)} · {regimen.version}
      </p>
      <p className="mt-1 text-secundario text-txt-2">
        Regla descriptiva, no una predicción. Ver las señales →
      </p>
    </Link>
  );
}

/**
 * La agenda se pide a FRED en vivo, con `fetchAgenda()`, que es la misma función
 * que usa `npm run agenda`. La alternativa —partir por ` · ` y por `: ` el
 * `summary` del evento de agenda que hay en la base— funciona hasta que un
 * título de publicación lleve dos puntos.
 *
 * Si falla o falta la clave, devuelve null y la pantalla lo dice. Un bloque de
 * agenda que se cae no puede llevarse por delante el Home entero.
 */
async function proximasCitas(): Promise<Cita[] | null> {
  const clave = claveFred();
  if (!clave) return null;
  const desde = new Date().toISOString().slice(0, 10);
  try {
    return await fetchAgenda(clave, { desde, dias: 7 });
  } catch {
    return null;
  }
}

function AgendaCorta({ citas }: { citas: Cita[] | null }) {
  if (citas === null) {
    return (
      <p className="text-secundario text-txt-3">
        Sin agenda: falta <code>FRED_API_KEY</code> o FRED no ha respondido.
      </p>
    );
  }
  if (citas.length === 0) {
    return (
      <p className="text-secundario text-txt-3">
        Ninguna publicación relevante en los próximos 7 días.
      </p>
    );
  }
  return (
    <ol className="rounded-tarjeta border border-linea bg-card px-3.5 py-1">
      {citas.slice(0, 8).map((c) => (
        <li
          key={`${c.date}-${c.releaseId}`}
          className="flex items-baseline gap-2 border-b border-linea py-2 text-secundario last:border-b-0"
        >
          <span className="cifra w-[5.5rem] shrink-0 text-meta text-txt-3">{c.date}</span>
          <span>
            {c.country} {c.title}
          </span>
        </li>
      ))}
    </ol>
  );
}
