/**
 * `/alerts` — el histórico de lo que de verdad salió a Telegram.
 *
 * Va primero de todas las páginas, y no el Home, porque es la única cuyos datos
 * están completos: `alerts` no deja ninguna columna a null. Sirve para validar
 * todos los componentes contra filas reales antes de que ninguna decisión visual
 * se haya repetido en siete sitios.
 */
import { Cabecera } from "../_componentes/cabecera.tsx";
import { Filtros, Importancia, Rango } from "../_componentes/filtros.tsx";
import { SinDatos } from "../_componentes/sin-datos.tsx";
import { TarjetaEvento } from "../_componentes/tarjeta-evento.tsx";
import { Vacio } from "../_componentes/chips.tsx";
import { cargar } from "../_lib/cargar.ts";
import { desdeFecha, hastaFecha, numero, texto, type Parametros } from "../_lib/parametros.ts";
import { historialAlertas } from "../../src/db/lectura.ts";

// Cada carga consulta la base: lo que enseña cambia cada quince minutos y una
// página cacheada diría que no ha pasado nada cuando sí ha pasado.
export const dynamic = "force-dynamic";

export default async function Alertas({ searchParams }: { searchParams: Promise<Parametros> }) {
  const p = await searchParams;
  const ahora = new Date();

  const resultado = await cargar((sql) =>
    historialAlertas(sql, {
      importanciaMin: numero(p, "min"),
      desde: desdeFecha(p, "desde"),
      hasta: hastaFecha(p, "hasta"),
      limite: 100,
    }),
  );

  return (
    <>
      <Cabecera
        titulo="Alertas"
        cuenta={resultado.ok ? `${resultado.datos.length}` : undefined}
        descripcion="Lo que se envió a Telegram, de lo más reciente a lo más antiguo."
      />

      <Filtros
        accion="/alerts"
        campos={
          <>
            <Importancia valor={texto(p, "min")} />
            <Rango desde={texto(p, "desde")} hasta={texto(p, "hasta")} />
          </>
        }
      />

      {!resultado.ok ? (
        <SinDatos motivo={resultado.motivo} />
      ) : resultado.datos.length === 0 ? (
        <Vacio
          titulo="Ninguna alerta en este rango"
          porque="Con el umbral en 7, la mayoría de lo que se ingiere se puntúa y no se anuncia. Que no haya alertas es el funcionamiento normal, no un fallo."
          siguiente={
            <>
              Para ver todo lo ingerido, incluida la parte que no llegó al umbral, está{" "}
              <a href="/news" className="text-accent-text underline underline-offset-2">
                News
              </a>
              .
            </>
          }
        />
      ) : (
        <div className="flex flex-col gap-2.5">
          {resultado.datos.map((e) => (
            <TarjetaEvento key={e.id} evento={e} ahora={ahora} />
          ))}
        </div>
      )}
    </>
  );
}
