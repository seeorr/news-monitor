/**
 * `/watchlist` — qué se vigila y con qué sensibilidad.
 *
 * Es, con `/settings`, la única página que escribe, y va antes que el Home en el
 * orden de construcción porque el alta de un valor es un requisito propio y no
 * se deja para el final.
 *
 * **Los grupos por temática y el reordenar arrastrando no existen**: la tabla no
 * tiene columna `grupo` ni `orden` (hueco G8). Mientras tanto, orden alfabético
 * por ticker, que es como lo devuelve `leerWatchlist()`.
 */
import { Cabecera } from "../_componentes/cabecera.tsx";
import { SinDatos } from "../_componentes/sin-datos.tsx";
import { Vacio } from "../_componentes/chips.tsx";
import { Borrar, Interruptor, Umbral } from "./controles.tsx";
import { FormularioAlta } from "./formulario.tsx";
import { cargar } from "../_lib/cargar.ts";
import { urlBaseDeDatos } from "../_lib/servidor.ts";
import { conSigno } from "../_lib/formato.ts";
import { ultimosMovimientos } from "../../src/db/lectura.ts";
import { leerWatchlist, type Vigilado } from "../../src/db/watchlist.ts";

export const dynamic = "force-dynamic";

export default async function Watchlist() {
  const url = urlBaseDeDatos();
  const movimientos = await cargar((sql) => ultimosMovimientos(sql));
  const valores: Vigilado[] | null = url ? await leerWatchlist(url).catch(() => null) : null;

  return (
    <>
      <Cabecera
        titulo="Watchlist"
        cuenta={valores ? `${valores.length}` : undefined}
        descripcion="Quién tiene documentos que mirar y precio que vigilar. Vive en Neon, no en el repositorio."
      />

      <div className="mb-5">
        <FormularioAlta />
      </div>

      {!movimientos.ok && movimientos.motivo.tipo === "credencial" ? (
        <SinDatos motivo={movimientos.motivo} />
      ) : valores === null ? (
        <p className="text-secundario text-txt-3">No se ha podido leer la watchlist.</p>
      ) : valores.length === 0 ? (
        <Vacio
          titulo="Ningún valor vigilado"
          porque="Sin valores, dos de las cuatro fuentes corren y no devuelven nada: EDGAR no tiene documentos que buscar y Yahoo no tiene precios que comparar."
          siguiente="Se añade uno arriba escribiendo su ticker. El CIK y el nombre los resuelve la SEC sola."
        />
      ) : (
        <div className="flex flex-col gap-2.5">
          {valores.map((v) => (
            <Fila
              key={v.ticker}
              valor={v}
              movimiento={
                movimientos.ok ? movimientos.datos.find((m) => m.ticker === v.ticker) : undefined
              }
            />
          ))}
        </div>
      )}

      <p className="mt-5 text-meta text-txt-3">
        Si la tabla se queda vacía, el ciclo cae al respaldo de las variables{" "}
        <code>WATCHLIST</code> y <code>SEC_WATCHLIST</code>. Vaciarla no equivale a no vigilar nada.
      </p>
    </>
  );
}

function Fila({
  valor,
  movimiento,
}: {
  valor: Vigilado;
  movimiento: { observed_at: string; actual: number | null; unit: string | null } | undefined;
}) {
  return (
    <article className="rounded-tarjeta border border-linea bg-card px-4 py-3">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-cuerpo font-medium">
          {valor.ticker}
          {valor.nombre ? (
            <span className="ml-2 text-secundario font-normal text-txt-2">{valor.nombre}</span>
          ) : null}
        </h2>

        {/*
          Aquí no puede ir "% de hoy": el precio solo se persiste cuando supera el
          umbral del valor. Lo que hay es el último movimiento que sí llegó a ser
          evento, y cuando no lo hay se dice, en lugar de pintar un 0,0 %.
        */}
        <p className="text-secundario">
          {movimiento && movimiento.actual !== null ? (
            <>
              <span className="text-txt-3">último movimiento </span>
              <span
                className={`cifra font-medium ${
                  movimiento.actual > 0 ? "text-success-text" : "text-danger-text"
                }`}
              >
                {conSigno(movimiento.actual)}
                {movimiento.unit ?? "%"}
              </span>
              <span className="cifra ml-1.5 text-meta text-txt-3">{movimiento.observed_at}</span>
            </>
          ) : (
            <span className="text-meta text-txt-3">ninguna sesión ha superado su umbral</span>
          )}
        </p>
      </div>

      <p className="mt-1 text-meta text-txt-3">
        {valor.cik ? (
          <>CIK {valor.cik}</>
        ) : (
          <>sin CIK: la SEC no identifica una empresa por su ticker, así que no tendrá documentos</>
        )}
        {valor.quoteSymbol && valor.quoteSymbol !== valor.ticker ? (
          <>
            <span aria-hidden> · </span>cotiza como {valor.quoteSymbol}
          </>
        ) : null}
      </p>

      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-2">
        <Interruptor
          ticker={valor.ticker}
          campo="filings"
          activo={valor.vigilarFilings}
          texto="documentos"
        />
        <Interruptor
          ticker={valor.ticker}
          campo="precio"
          activo={valor.vigilarPrecio}
          texto="precio"
        />
        <Umbral ticker={valor.ticker} valor={valor.umbralMovimiento} />
        <span className="ml-auto">
          <Borrar ticker={valor.ticker} />
        </span>
      </div>
    </article>
  );
}
