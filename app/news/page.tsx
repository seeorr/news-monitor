/**
 * `/news` — todo lo ingerido, no solo lo anunciado.
 *
 * Una columna y sin sidebar: esta página es para profundizar, no para tener una
 * visión general. Esa la da el Home.
 *
 * La fila de filtros **solo ofrece los que funcionan**. No hay sector ni
 * horizonte (hueco G6) y `events.country` es un emoji heredado del feed, no del
 * contenido: vale como adorno en la tarjeta y **no** como faceta de filtrado,
 * así que tampoco se ofrece.
 */
import { Cabecera } from "../_componentes/cabecera.tsx";
import {
  Filtros,
  Fuente,
  Importancia,
  Rango,
  Sentimiento,
  SoloOficiales,
  Tipo,
} from "../_componentes/filtros.tsx";
import { SinDatos } from "../_componentes/sin-datos.tsx";
import { TarjetaEvento } from "../_componentes/tarjeta-evento.tsx";
import { Vacio } from "../_componentes/chips.tsx";
import { cargar } from "../_lib/cargar.ts";
import {
  activo,
  desdeFecha,
  hastaFecha,
  lista,
  numero,
  texto,
  type Parametros,
} from "../_lib/parametros.ts";
import { listarEventos } from "../../src/db/lectura.ts";

export const dynamic = "force-dynamic";

const POR_PAGINA = 50;

export default async function Noticias({ searchParams }: { searchParams: Promise<Parametros> }) {
  const p = await searchParams;
  const ahora = new Date();
  const pagina = Math.max(1, numero(p, "p") ?? 1);
  const conImportancia = numero(p, "min") !== undefined || texto(p, "sentiment") !== "";

  const resultado = await cargar((sql) =>
    listarEventos(sql, {
      kinds: lista(p, "kind"),
      sources: lista(p, "source"),
      soloOficiales: activo(p, "oficial"),
      importanciaMin: numero(p, "min"),
      sentimiento: texto(p, "sentiment") || undefined,
      desde: desdeFecha(p, "desde"),
      hasta: hastaFecha(p, "hasta"),
      limite: POR_PAGINA,
      offset: (pagina - 1) * POR_PAGINA,
    }),
  );

  return (
    <>
      <Cabecera
        titulo="News"
        cuenta={resultado.ok ? `${resultado.datos.length}` : undefined}
        descripcion="Todo lo que ha entrado, de lo más reciente a lo más antiguo. La mayoría no llegó a anunciarse."
      />

      <Filtros
        accion="/news"
        campos={
          <>
            <Tipo valor={texto(p, "kind")} />
            <Fuente valor={texto(p, "source")} />
            <Importancia valor={texto(p, "min")} />
            <Sentimiento valor={texto(p, "sentiment")} />
            <Rango desde={texto(p, "desde")} hasta={texto(p, "hasta")} />
            <SoloOficiales activo={activo(p, "oficial")} />
          </>
        }
      />

      {/*
        Filtrar por importancia o por sentimiento deja fuera, necesariamente, todo
        lo que nunca pasó por el paso 3. No es un efecto secundario que convenga
        esconder: es la mitad larga de lo que hay en la base.
      */}
      {conImportancia ? (
        <p className="mb-3 text-meta text-txt-3">
          Filtrar por importancia o sentimiento deja fuera lo que nunca se puntuó: lo que no pasó el
          filtro por reglas y los titulares que eran la misma historia ya contada.
        </p>
      ) : null}

      {!resultado.ok ? (
        <SinDatos motivo={resultado.motivo} />
      ) : resultado.datos.length === 0 ? (
        <Vacio
          titulo="Nada que enseñar con estos filtros"
          porque={
            pagina > 1
              ? "Esta página está más allá del final de la lista."
              : "O el ciclo todavía no ha escrito nada, o los filtros son más estrechos que los datos."
          }
        />
      ) : (
        <>
          <div className="flex flex-col gap-2.5">
            {resultado.datos.map((e) => (
              <TarjetaEvento key={e.id} evento={e} ahora={ahora} />
            ))}
          </div>
          <Paginacion
            pagina={pagina}
            hayMas={resultado.datos.length === POR_PAGINA}
            parametros={p}
          />
        </>
      )}
    </>
  );
}

/**
 * Paginación por enlaces, sin contar el total.
 *
 * Contar filas exigiría una segunda consulta de agregado en cada carga para
 * pintar un "de 1.240" que nadie usa: lo que se hace con esta lista es bajar
 * hasta que deja de interesar.
 */
function Paginacion({
  pagina,
  hayMas,
  parametros,
}: {
  pagina: number;
  hayMas: boolean;
  parametros: Parametros;
}) {
  const conPagina = (n: number) => {
    const q = new URLSearchParams();
    for (const [clave, valor] of Object.entries(parametros)) {
      if (clave === "p") continue;
      const v = Array.isArray(valor) ? valor[0] : valor;
      if (typeof v === "string" && v !== "") q.set(clave, v);
    }
    if (n > 1) q.set("p", String(n));
    const s = q.toString();
    return s === "" ? "/news" : `/news?${s}`;
  };

  if (pagina === 1 && !hayMas) return null;

  return (
    <nav className="mt-4 flex items-center justify-between text-secundario" aria-label="Paginación">
      {pagina > 1 ? (
        <a href={conPagina(pagina - 1)} className="text-accent-text underline underline-offset-2">
          ← anteriores
        </a>
      ) : (
        <span />
      )}
      <span className="cifra text-meta text-txt-3">página {pagina}</span>
      {hayMas ? (
        <a href={conPagina(pagina + 1)} className="text-accent-text underline underline-offset-2">
          siguientes →
        </a>
      ) : (
        <span />
      )}
    </nav>
  );
}
