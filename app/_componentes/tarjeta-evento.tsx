/**
 * La tarjeta de un evento, con el orden de filas fijo de la sección 3:
 *
 *   Fila 1: importancia + sentimiento + impacto + fuente (a la derecha)
 *   Fila 2: titular
 *   Fila 3: resumen, dos líneas como mucho
 *   Fila 4: chip de activo, cuando de verdad hay un activo
 *
 * El detalle se abre **en línea** y no navegando a otra página, con un `details`
 * nativo: se pliega con teclado, funciona sin JavaScript y no cuesta un
 * componente de cliente. Esta app es una lista larga de tarjetas; que abrir una
 * no obligue a volver es la diferencia entre revisarla y abandonarla.
 */
import { ChipActivo, ChipActivoAfectado, ChipFuente, ChipTipo } from "./chips.tsx";
import {
  InsigniaEnviada,
  InsigniaImportancia,
  InsigniaObsoleto,
  InsigniaSentimiento,
  MedidorImpacto,
} from "./insignias.tsx";
import { SIN_CONSENSO, cifras, fechaYHora, observado, puntos } from "../_lib/formato.ts";
import type { AnalisisProfundo, FilaEvento } from "../../src/db/lectura.ts";
import { factualText, prosaDelAnalisis, supportedAssets } from "../../src/notify/news-formats.ts";

/**
 * En lugar de un texto guardado que cita una cifra que no está en la fuente. No se
 * borra nada de la base: se deja de enseñar, con el mismo control que Telegram.
 * Afecta sobre todo a lo guardado antes del 14-09, cuando al guardar se aplicaba
 * un control más permisivo.
 */
export const ANALISIS_RETIRADO =
  "Análisis no mostrado: cita una cifra que no está en la fuente. Lo verificable es el titular y la fuente.";
export const RESUMEN_RETIRADO =
  "Resumen no mostrado: cita una cifra que no está en la fuente. Lee el titular y la fuente.";

export function TarjetaEvento({
  evento,
  ahora,
  abierta = false,
}: {
  evento: FilaEvento;
  ahora: Date;
  abierta?: boolean;
}) {
  return (
    <details
      open={abierta}
      className="group rounded-tarjeta border border-linea bg-card open:border-linea-fuerte"
    >
      <summary className="cursor-pointer list-none px-4 py-3.5 marker:hidden [&::-webkit-details-marker]:hidden">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
          <InsigniaImportancia nota={evento.importance_score} />
          <InsigniaSentimiento sentimiento={evento.sentiment} />
          <MedidorImpacto nota={evento.market_impact_score} />
          <InsigniaObsoleto obsoleto={evento.stale} />
          {evento.sent_at !== null ? <InsigniaEnviada profundo={evento.deep_analysis} /> : null}
          <span className="ml-auto">
            <ChipFuente evento={evento} ahora={ahora} />
          </span>
        </div>

        <h3 className="mt-2 text-cuerpo font-medium">
          {evento.country ? <span className="mr-1.5">{evento.country}</span> : null}
          {evento.title}
        </h3>

        {evento.summary ? (
          <p className="mt-1 line-clamp-2 text-secundario text-txt-2">{evento.summary}</p>
        ) : null}

        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <ChipTipo kind={evento.kind} />
          <ChipActivo evento={evento} />
        </div>
      </summary>

      <Detalle evento={evento} />
    </details>
  );
}

function Detalle({ evento }: { evento: FilaEvento }) {
  const linea = cifras(evento);
  return (
    <div className="border-t border-linea px-4 py-3.5">
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-secundario">
        {evento.news_level ? <>
          <dt className="text-txt-3">Nivel asignado</dt>
          <dd>{{important: "Importante", brief: "Aviso breve", digest: "Resumen", dashboard: "Dashboard", none: "Sin aviso"}[evento.news_level] ?? "Sin clasificar"}</dd>
        </> : null}
        <dt className="text-txt-3">Fecha del dato</dt>
        <dd className="cifra">{observado(evento.observed_at)}</dd>
        <dt className="text-txt-3">Visto</dt>
        <dd className="cifra">{fechaYHora(evento.first_seen_at)}</dd>
        {evento.sent_at !== null ? (
          <>
            <dt className="text-txt-3">Enviada</dt>
            <dd className="cifra">{fechaYHora(evento.sent_at)}</dd>
          </>
        ) : null}
      </dl>

      {linea.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1">
          {linea.map((c) => (
            <span key={c.etiqueta} className="text-secundario">
              <span className="text-txt-3">{c.etiqueta}: </span>
              <span className="cifra font-medium">{c.valor}</span>
            </span>
          ))}
        </div>
      ) : null}

      {/*
        El consenso solo se menciona donde tendría sentido haberlo: en un dato
        macro. Y se dice por qué no está, en vez de dejar un guion mudo que
        parece un descuido.
      */}
      {evento.kind === "macro_release" && evento.consensus === null ? (
        <p className="mt-2 text-meta text-txt-3">Consenso: {SIN_CONSENSO}.</p>
      ) : null}

      {evento.summary ? (
        <p className="mt-3 text-secundario text-txt-2">{evento.summary}</p>
      ) : null}

      {/*
        El análisis del paso 4, si lo hay. La inmensa mayoría de eventos no lo
        tiene —solo corre por encima del umbral, y las alertas anteriores al 9 de
        septiembre lo perdieron al formatearlo—, así que el componente entero
        desaparece en vez de dejar cinco titulillos sin nada debajo.
      */}
      {evento.analysis ? (
        factualText(evento, prosaDelAnalisis(evento.analysis))
          ? <Analisis analisis={evento.analysis} evento={evento} />
          : <p className="mt-3 text-meta text-txt-3">{ANALISIS_RETIRADO}</p>
      ) : null}

      {/*
        `alerts.body` se sigue enseñando tal cual, en preformateado, y **debajo**
        del análisis: es el registro literal de lo que salió a Telegram, no un
        resumen de lo de arriba, y por eso no lo sustituye ninguna sección. Lo que
        ya no hace falta es sacarle los catalizadores y los riesgos parseando su
        prosa, que se habría roto en silencio en cuanto cambiara `formatAlert()`.
      */}
      {evento.body ? (
        <div className="mt-3 rounded-chip border border-linea bg-raised p-3">
          <p className="mb-2 text-meta text-txt-3">Alerta enviada, tal cual salió a Telegram</p>
          <div className="cuerpo-alerta">{evento.body}</div>
        </div>
      ) : evento.one_liner ? (
        factualText(evento, evento.one_liner) ? (
          <p className="mt-3 text-secundario">
            <span className="text-txt-3">Resumen del scoring: </span>
            {evento.one_liner}
          </p>
        ) : <p className="mt-3 text-meta text-txt-3">{RESUMEN_RETIRADO}</p>
      ) : null}

      {evento.source_url ? (
        <a
          href={evento.source_url}
          target="_blank"
          rel="noreferrer noopener"
          className="mt-3 inline-flex items-center gap-1 text-secundario text-accent-text underline underline-offset-2"
        >
          Ver la fuente ↗
        </a>
      ) : null}
    </div>
  );
}

/**
 * Las cinco secciones del análisis profundo (`alerts.analysis`).
 *
 * Cada una se pinta **solo si tiene contenido**. No es defensa contra un dato
 * roto: el modelo devuelve listas y alguna vez las devuelve vacías, y un
 * "Riesgos" con nada debajo dice que el sistema ha perdido algo, cuando lo que
 * pasó es que no había nada que decir. Es el principio del backend en pantalla:
 * un hueco declarado —aquí, callándose— antes que un cero de relleno.
 *
 * Van encima de `alerts.body` y no en su lugar. Esto es la lectura del evento;
 * `body` es el registro de lo que se envió, y los dos son ciertos.
 */
function Analisis({ analisis, evento }: { analisis: AnalisisProfundo; evento: FilaEvento }) {
  const porque = analisis.why_it_matters.trim();
  // Solo símbolos que están en la fuente, como en Telegram: lo guardado antes del
  // 14-09 no pasaba por este filtro.
  const activos = supportedAssets(evento, analisis.affected_assets.filter((a) => a.symbol.trim() !== ""));
  const catalizadores = puntos(analisis.catalysts);
  const riesgos = puntos(analisis.risks);
  const vigilar = puntos(analisis.what_to_watch);

  return (
    <div className="mt-3 space-y-3">
      {porque !== "" ? (
        <section>
          <Titulillo>Por qué importa</Titulillo>
          <p className="mt-1 text-secundario text-txt-2">{porque}</p>
        </section>
      ) : null}

      {activos.length > 0 ? (
        <section>
          <Titulillo>Activos afectados</Titulillo>
          <div className="mt-1 flex flex-wrap gap-1.5">
            {/*
              La clave es la posición y no el símbolo: nada impide que el modelo
              nombre dos veces el mismo activo, la lista es estática y no se
              reordena nunca.
            */}
            {activos.map((a, i) => (
              <ChipActivoAfectado key={i} activo={a} />
            ))}
          </div>
        </section>
      ) : null}

      <Lista titulo="Catalizadores" items={catalizadores} />
      <Lista titulo="Riesgos" items={riesgos} />
      <Lista titulo="Qué vigilar" items={vigilar} />
    </div>
  );
}

function Lista({ titulo, items }: { titulo: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <section>
      <Titulillo>{titulo}</Titulillo>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-secundario text-txt-2">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </section>
  );
}

function Titulillo({ children }: { children: React.ReactNode }) {
  return <h4 className="text-meta font-medium text-txt-3">{children}</h4>;
}
