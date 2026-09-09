/**
 * Las insignias de la sección 3: importancia, sentimiento, impacto, obsoleto.
 *
 * La regla que comparten las cuatro: **si el dato no existe, no se pintan**. No
 * hay un 5 de relleno ni un guion mudo. Un evento sin nota es un evento que
 * nunca pasó por el paso 3 de la cascada, y eso es una verdad que la pantalla
 * puede decir callándose.
 */
import { SENTIMENT_LABEL, TRAMO_LABEL, tramo } from "../_lib/formato.ts";

const PILDORA =
  "inline-flex items-center gap-1 rounded-chip border px-1.5 py-0.5 text-meta font-medium whitespace-nowrap";

/** 9-10 rojo · 7-8 ámbar · 4-6 ámbar suave · 0-3 gris. */
const COLOR_TRAMO: Record<string, string> = {
  critico: "bg-danger-bg text-danger-text border-danger-border",
  importante: "bg-warning-bg text-warning-text border-warning-border",
  interesante: "bg-warning-bg/50 text-warning-text border-warning-border/60",
  ruido: "bg-muted-bg text-muted-text border-muted-border",
};

export function InsigniaImportancia({ nota }: { nota: number | null }) {
  if (nota === null) return null;
  const t = tramo(nota);
  return (
    <span className={`${PILDORA} ${COLOR_TRAMO[t]}`} title={`Importancia ${nota} sobre 10`}>
      <span className="cifra">{nota}/10</span>
      <span className="opacity-70">{TRAMO_LABEL[t]}</span>
    </span>
  );
}

const COLOR_SENTIMIENTO: Record<string, string> = {
  bullish: "bg-success-bg text-success-text border-success-border",
  bearish: "bg-danger-bg text-danger-text border-danger-border",
  neutral: "bg-accent-bg text-accent-text border-accent-border",
};

export function InsigniaSentimiento({ sentimiento }: { sentimiento: string | null }) {
  if (sentimiento === null) return null;
  const color = COLOR_SENTIMIENTO[sentimiento] ?? COLOR_SENTIMIENTO["neutral"]!;
  return <span className={`${PILDORA} ${color}`}>{SENTIMENT_LABEL[sentimiento] ?? sentimiento}</span>;
}

/**
 * `market_impact_score` existe, es 0-10 y hasta ahora no lo enseñaba nadie: la
 * alerta de Telegram solo imprime la importancia. Cuatro tramos junto a la
 * insignia de importancia lo aprovechan sin pedirle nada al backend.
 */
export function MedidorImpacto({ nota }: { nota: number | null }) {
  if (nota === null) return null;
  const tramos = Math.max(1, Math.min(4, Math.ceil(nota / 2.5)));
  return (
    <span
      className="inline-flex items-center gap-1"
      title={`Impacto de mercado ${nota} sobre 10`}
      aria-label={`Impacto de mercado ${nota} sobre 10`}
    >
      <span className="text-meta text-txt-3">Impacto</span>
      <span className="flex gap-0.5" aria-hidden>
        {[1, 2, 3, 4].map((i) => (
          <span
            key={i}
            className={`h-2.5 w-1 rounded-[1px] ${
              i <= tramos ? "bg-accent" : "bg-muted-border"
            }`}
          />
        ))}
      </span>
    </span>
  );
}

/**
 * El dato es el último válido conocido, no uno fresco. La pantalla lo dice
 * igual que lo dice la alerta: un dato viejo pintado como uno fresco es la clase
 * de mentira que este sistema no se permite.
 */
export function InsigniaObsoleto({ obsoleto }: { obsoleto: boolean }) {
  if (!obsoleto) return null;
  return (
    <span className={`${PILDORA} bg-stale-bg text-stale-text border-stale-border`}>
      último valor conocido
    </span>
  );
}

/** Se envió a Telegram. Con el distintivo del paso 4 cuando corrió el modelo caro. */
export function InsigniaEnviada({ profundo }: { profundo: boolean | null }) {
  return (
    <span className={`${PILDORA} bg-accent-bg text-accent-text border-accent-border`}>
      Enviada{profundo ? " · análisis profundo" : ""}
    </span>
  );
}
