/**
 * `/calendar` — qué se publica y cuándo.
 *
 * Los datos salen de `fetchAgenda()`, la misma función que usa `npm run agenda`:
 * devuelve `Cita[]` ya limpio y con la regla que descarta las publicaciones casi
 * diarias aplicada. La alternativa era partir por ` · ` y por `: ` el `summary`
 * del evento de agenda que hay en la base, y eso funciona hasta que un título de
 * publicación lleve dos puntos.
 *
 * Lo que **no** se pinta aquí, y por qué:
 *
 * - **Hora**: FRED publica la fecha, no la hora. La columna no se pone.
 * - **Anterior / consenso / sorpresa por cita**: son fechas futuras, no hay
 *   cifras que asociarles. Cuando una publicación ya ha salido y coincide con una
 *   de las series que se ingieren, se cruza por `series_id` y se enseña su dato;
 *   son dos publicaciones de las ocho de `RELEASES`.
 * - **Impacto o sentimiento**: nadie puntúa una cita futura. La agenda no pasa
 *   por la cascada a propósito: no hay nada que interpretar en una lista de fechas.
 */
import { Cabecera } from "../_componentes/cabecera.tsx";
import { SinDatos } from "../_componentes/sin-datos.tsx";
import { Vacio } from "../_componentes/chips.tsx";
import { cargar } from "../_lib/cargar.ts";
import { claveFred } from "../_lib/servidor.ts";
import { es } from "../_lib/formato.ts";
import { numero, type Parametros } from "../_lib/parametros.ts";
import { ultimasSeries, type FilaEvento } from "../../src/db/lectura.ts";
import { SERIES } from "../../src/sources/fred.ts";
import { fetchAgenda, type Cita } from "../../src/sources/calendario.ts";
import { sorpresas } from "../../src/notify/telegram.ts";

export const dynamic = "force-dynamic";

/**
 * Qué serie de las que se ingieren corresponde a cada publicación de `RELEASES`.
 *
 * Es una constante del frontend y se declara como tal: no es un campo que exista
 * en ninguna tabla. Solo dos de las ocho publicaciones tienen serie ingerida, y
 * las demás se quedan sin cifra porque no la hay.
 */
const SERIE_DE_RELEASE: Record<number, string> = {
  10: "CPIAUCSL", // IPC de Estados Unidos
  50: "UNRATE", // Informe de empleo
};

export default async function Calendario({
  searchParams,
}: {
  searchParams: Promise<Parametros>;
}) {
  const p = await searchParams;
  const dias = [1, 7, 14].includes(numero(p, "dias") ?? 7) ? (numero(p, "dias") ?? 7) : 7;
  const desde = new Date().toISOString().slice(0, 10);

  const clave = claveFred();
  const citas = clave
    ? await fetchAgenda(clave, { desde, dias }).catch((e: unknown) => e as Error)
    : null;
  const series = await cargar((sql) => ultimasSeries(sql, Object.keys(SERIES)));
  const porSerie = new Map<string, FilaEvento>(
    series.ok ? series.datos.map((s) => [s.series_id ?? "", s]) : [],
  );

  return (
    <>
      <Cabecera
        titulo="Agenda"
        descripcion="Lo que FRED tiene anunciado. Sin hora, porque FRED publica la fecha y la hora no se inventa."
        acciones={
          <div className="flex gap-1">
            {[
              { d: 1, texto: "Hoy" },
              { d: 7, texto: "7 días" },
              { d: 14, texto: "14 días" },
            ].map((o) => (
              <a
                key={o.d}
                href={`/calendar?dias=${o.d}`}
                className={`rounded-chip px-2.5 py-1 text-secundario ${
                  dias === o.d
                    ? "bg-accent-bg font-medium text-accent-text"
                    : "text-txt-2 hover:bg-raised"
                }`}
              >
                {o.texto}
              </a>
            ))}
          </div>
        }
      />

      {clave === null ? (
        <SinDatos
          motivo={{
            tipo: "credencial",
            variable: "FRED_API_KEY",
            para: "pedir las fechas de publicación. La agenda se consulta en vivo, no sale de la base",
            donde: "https://fredaccount.stlouisfed.org/apikeys",
          }}
        />
      ) : citas instanceof Error ? (
        <SinDatos motivo={{ tipo: "error", mensaje: citas.message }} />
      ) : citas === null || citas.length === 0 ? (
        <Vacio
          titulo="Ninguna publicación en la ventana"
          porque="La agenda solo lista las ocho publicaciones que mueven el mercado, y descarta las que FRED marca como diarias. Que no haya nada en los próximos días es normal."
        />
      ) : (
        <PorDias citas={citas} porSerie={porSerie} />
      )}
    </>
  );
}

/**
 * Solo aparecen los días con algo. Una lista con cinco "nada previsto" se deja
 * de leer a la tercera vez.
 */
function PorDias({
  citas,
  porSerie,
}: {
  citas: Cita[];
  porSerie: Map<string, FilaEvento>;
}) {
  const dias = new Map<string, Cita[]>();
  for (const c of citas) {
    const lista = dias.get(c.date) ?? [];
    lista.push(c);
    dias.set(c.date, lista);
  }

  return (
    <div className="flex flex-col gap-4">
      {[...dias.entries()].map(([dia, delDia]) => (
        <section key={dia}>
          <h2 className="cifra mb-1.5 text-secundario font-medium text-txt-2">{dia}</h2>
          {/* La tabla scrollea dentro de su contenedor; la página nunca en horizontal. */}
          <div className="overflow-x-auto rounded-tarjeta border border-linea bg-card">
            <table className="w-full min-w-[32rem] text-secundario">
              <tbody>
                {delDia.map((c) => {
                  const serie = porSerie.get(SERIE_DE_RELEASE[c.releaseId] ?? "");
                  return (
                    <tr key={`${c.date}-${c.releaseId}`} className="border-b border-linea last:border-b-0">
                      <td className="w-8 py-2 pl-3.5 align-top">{c.country}</td>
                      <td className="py-2 align-top">{c.title}</td>
                      <td className="py-2 pr-3.5 text-right align-top">
                        {serie ? <UltimoDato serie={serie} /> : <span className="text-meta text-txt-3">—</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      ))}
    </div>
  );
}

/** El último dato publicado de esa serie. No es una previsión: es lo que salió la vez anterior. */
function UltimoDato({ serie }: { serie: FilaEvento }) {
  return (
    <span className="text-meta text-txt-3">
      anterior{" "}
      <span className="cifra font-medium text-txt-2">
        {serie.actual === null ? "—" : `${es(serie.actual)}${serie.unit ?? ""}`}
      </span>
      {sorpresas(serie.surprises) !== null ? (
        <span className="cifra ml-1">{sorpresas(serie.surprises)}</span>
      ) : null}
    </span>
  );
}
