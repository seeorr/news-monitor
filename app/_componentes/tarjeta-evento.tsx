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
import { ChipActivo, ChipFuente, ChipTipo } from "./chips.tsx";
import {
  InsigniaEnviada,
  InsigniaImportancia,
  InsigniaObsoleto,
  InsigniaSentimiento,
  MedidorImpacto,
} from "./insignias.tsx";
import { SIN_CONSENSO, cifras, fechaYHora, observado } from "../_lib/formato.ts";
import type { FilaEvento } from "../../src/db/lectura.ts";

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
        `alerts.body` se enseña tal cual, en preformateado. Parsear su prosa para
        reconstruir secciones se rompería en silencio la primera vez que cambie
        `formatAlert()`, y los catalizadores, riesgos y activos afectados del
        análisis profundo no están en ninguna columna: viven dentro de este texto
        o no viven (hueco G2).
      */}
      {evento.body ? (
        <div className="mt-3 rounded-chip border border-linea bg-raised p-3">
          <p className="mb-2 text-meta text-txt-3">Alerta enviada, tal cual salió a Telegram</p>
          <div className="cuerpo-alerta">{evento.body}</div>
        </div>
      ) : evento.one_liner ? (
        <p className="mt-3 text-secundario">
          <span className="text-txt-3">Resumen del scoring: </span>
          {evento.one_liner}
        </p>
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
