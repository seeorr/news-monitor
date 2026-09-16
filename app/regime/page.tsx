/**
 * `/regime` — el régimen descriptivo US, con sus entradas a la vista.
 *
 * La página no calcula nada. Lee la fotografía que `npm run regimen` dejó en
 * `market_regimes` y la pinta columna por columna: el estado, la versión de la
 * regla con la que se calculó, cada señal con su valor, su fecha, su voto y la
 * frase que explica ese voto.
 *
 * Lo que **no** hace, y son decisiones, no olvidos:
 *
 * - **No redacta la explicación del voto.** `detail` viene escrito del backend y
 *   se enseña tal cual. Si la pantalla redactara la suya, dos textos dirían la
 *   misma regla de dos formas y llegaría el día en que dejan de coincidir.
 * - **No decide con dos votos de tres.** La unanimidad es del backend.
 *   `insufficient_data` se pinta como un estado de primera, con la misma
 *   tipografía que los otros tres y diciendo cuál falta: no es un error de carga.
 * - **No pinta una confianza en porcentaje.** La confianza que hay es cuántos
 *   votaron y cuántos faltaron, y eso ya está en la tabla.
 * - **No dibuja el histórico.** Hay una fila por día desde el 9 de septiembre.
 *   Una línea de unos pocos puntos promete una tendencia que no existe.
 */
import Link from "next/link";
import { Cabecera } from "../_componentes/cabecera.tsx";
import { SinDatos } from "../_componentes/sin-datos.tsx";
import { Vacio } from "../_componentes/chips.tsx";
import { cargar } from "../_lib/cargar.ts";
import { es } from "../_lib/formato.ts";
import { ultimoRegimen } from "../../src/db/regimen.ts";
import { CONTEXTO, type Regimen, type SenalRegimen } from "../../src/sources/regimen.ts";

export const dynamic = "force-dynamic";

const ESTADO: Record<Regimen["state"], { texto: string; color: string }> = {
  risk_on: { texto: "Favorable al riesgo", color: "bg-success-bg text-success-text border-success-border" },
  risk_off: { texto: "Aversión al riesgo", color: "bg-danger-bg text-danger-text border-danger-border" },
  mixed: { texto: "Señales mixtas", color: "bg-warning-bg text-warning-text border-warning-border" },
  insufficient_data: { texto: "Datos insuficientes", color: "bg-muted-bg text-muted-text border-muted-border" },
};

const VOTO: Record<string, { texto: string; color: string }> = {
  "1": { texto: "Favorable", color: "text-success-text" },
  "0": { texto: "Mixto", color: "text-txt-2" },
  "-1": { texto: "Adverso", color: "text-danger-text" },
};

export default async function PaginaRegimen() {
  const foto = await cargar((sql) => ultimoRegimen(sql));

  if (!foto.ok) {
    return (
      <>
        <CabeceraRegimen />
        <SinDatos motivo={foto.motivo} />
      </>
    );
  }
  if (foto.datos === null) {
    return (
      <>
        <CabeceraRegimen />
        <Vacio
          titulo="Todavía no hay ninguna fotografía"
          porque="El régimen lo escribe el ciclo diario, con su versión de regla. Hasta que corra con FRED_API_KEY y DATABASE_URL no hay nada que leer: esta pantalla no calcula el régimen, lo enseña."
        />
      </>
    );
  }

  const r = foto.datos;
  const votantes = r.signals.filter((s) => !CONTEXTO.has(s.id));
  const contexto = r.signals.filter((s) => CONTEXTO.has(s.id));
  const faltan = votantes.filter((s) => s.vote === null);

  return (
    <>
      <CabeceraRegimen />

      <section className="mb-5 rounded-tarjeta border border-linea bg-card px-4 py-4">
        <div className="flex flex-wrap items-center gap-2.5">
          <span
            className={`inline-flex items-center rounded-chip border px-2.5 py-1 text-cuerpo font-medium ${ESTADO[r.state].color}`}
          >
            {ESTADO[r.state].texto}
          </span>
          <span className="cifra text-secundario text-txt-3">
            calculado el <time dateTime={r.asOf}>{r.asOf.slice(0, 10)}</time> · regla {r.version}
          </span>
        </div>

        <p className="mt-2.5 text-secundario text-txt-2">
          Regla descriptiva, no una predicción. Hay estado solo cuando los tres votos coinciden; en
          cuanto uno falta, el estado es «datos insuficientes» y se dice cuál.
        </p>

        {faltan.length > 0 ? (
          <p className="mt-2 text-secundario text-txt-2">
            Ahora falta el voto de{" "}
            <span className="font-medium text-txt">{faltan.map((s) => s.label).join(", ")}</span>:{" "}
            {faltan[0]?.detail}
          </p>
        ) : null}
      </section>

      <TablaSenales titulo="Votan" nota="los tres, por unanimidad" senales={votantes} />
      <TablaSenales titulo="Contexto" nota="acompañan y no clasifican" senales={contexto} />

      <section className="mt-5 text-secundario text-txt-3">
        <p>
          El día que la liquidez vote, eso es una versión nueva de la regla (
          <span className="cifra">riesgo-us-v2</span>), no un retoque: las fotografías viejas se
          quedan con la suya y el histórico sigue siendo legible. Por eso la versión se guarda con
          cada día.
        </p>
        <p className="mt-2">
          Solo cubre Estados Unidos: no hay régimen europeo porque las series que lo harían no entran
          por ninguna fuente comprobada. Cada señal enlaza a su página en FRED, que es donde está la
          metodología.{" "}
          <Link href="/" className="text-accent-text underline underline-offset-2">
            Volver al panorama
          </Link>
          .
        </p>
      </section>
    </>
  );
}

function CabeceraRegimen() {
  return (
    <Cabecera
      titulo="Régimen"
      descripcion="Una fotografía al día de las condiciones de mercado US, con las entradas que la producen."
    />
  );
}

/**
 * Las que votan y las que no van en dos tablas, etiquetadas como tales. Mezclarlas
 * con una columna que dijera «no vota» invita a leer cinco señales como cinco
 * opiniones del mismo peso, que es justo lo que la regla no dice.
 */
function TablaSenales({
  titulo,
  nota,
  senales,
}: {
  titulo: string;
  nota: string;
  senales: SenalRegimen[];
}) {
  if (senales.length === 0) return null;
  return (
    <section className="mb-5">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-secundario font-medium">{titulo}</h2>
        <span className="text-meta text-txt-3">{nota}</span>
      </div>
      {/* La tabla scrollea dentro de su contenedor; la página nunca en horizontal. */}
      <div className="overflow-x-auto rounded-tarjeta border border-linea bg-card">
        <table className="w-full min-w-[34rem] text-secundario">
          <thead>
            <tr className="border-b border-linea text-meta text-txt-3">
              <th className="py-2 pl-3.5 text-left font-normal">Serie</th>
              <th className="py-2 text-right font-normal">Último</th>
              <th className="py-2 pl-3 text-left font-normal">Fecha</th>
              <th className="py-2 pl-3 text-left font-normal">Voto</th>
              <th className="py-2 pr-3.5 pl-3 text-left font-normal">Por qué</th>
            </tr>
          </thead>
          <tbody>
            {senales.map((s) => (
              <tr key={s.id} className="border-b border-linea align-top last:border-b-0">
                <td className="py-2 pl-3.5">
                  <a
                    href={s.sourceUrl}
                    className="text-accent-text underline underline-offset-2"
                    rel="noreferrer"
                    target="_blank"
                  >
                    {s.label}
                  </a>
                </td>
                <td className="cifra py-2 text-right whitespace-nowrap">
                  <Valor senal={s} />
                </td>
                <td className="cifra py-2 pl-3 whitespace-nowrap text-txt-3">
                  {s.date ?? "—"}
                  {s.stale && s.date ? (
                    <span className="ml-1.5 rounded-chip bg-muted-bg px-1.5 py-0.5 text-meta text-muted-text">
                      antiguo
                    </span>
                  ) : null}
                </td>
                <td className="py-2 pl-3 whitespace-nowrap">
                  <Voto senal={s} />
                </td>
                <td className="py-2 pr-3.5 pl-3 text-txt-2">{s.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/** Sin dato no se pinta un cero: es la misma regla que las insignias. */
function Valor({ senal }: { senal: SenalRegimen }) {
  if (senal.value === null) return <span className="text-txt-3">—</span>;
  return (
    <>
      <span className="font-medium">{es(senal.value, 2)}</span>
      <span className="ml-1 text-meta text-txt-3">{senal.unit}</span>
    </>
  );
}

/**
 * El voto que emitió esa señal, no el estado global. Una señal de contexto no
 * vota nunca y lo dice; una que votaría pero llegó antigua o vacía, también.
 */
function Voto({ senal }: { senal: SenalRegimen }) {
  if (CONTEXTO.has(senal.id)) {
    return <span className="text-meta text-txt-3">contexto</span>;
  }
  const voto = senal.vote === null ? null : VOTO[String(senal.vote)];
  if (!voto) return <span className="text-meta text-txt-3">no vota</span>;
  return <span className={`font-medium ${voto.color}`}>{voto.texto}</span>;
}
