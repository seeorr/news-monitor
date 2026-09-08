/**
 * Pasos 3 y 4 de la cascada (§5).
 *
 *   Paso 3 — scoring con modelo barato. JSON corto, prompt corto. Todo lo que
 *            pasó el filtro por reglas pasa por aquí.
 *   Paso 4 — SOLO si importance_score >= umbral. Modelo capaz, análisis con matiz.
 *
 * La mayoría de eventos muere en los pasos 1 y 2, así que el paso 4 se ejecuta
 * pocas veces. Ese es todo el ahorro.
 *
 * Los dos pasos devuelven JSON validado contra un esquema Zod: `messages.parse`
 * fuerza el formato en el servidor, así que no hay que parsear texto ni rezar.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { checkFabrication } from "../lib/fabrication.ts";
import type { NormalizedEvent } from "../schema/event.ts";

export const Scoring = z.object({
  importance_score: z.number().min(0).max(10),
  sentiment: z.enum(["bullish", "bearish", "neutral"]),
  market_impact_score: z.number().min(0).max(10),
  needs_alert: z.boolean(),
  one_liner: z.string().max(200),
});
export type Scoring = z.infer<typeof Scoring>;

export const Analysis = z.object({
  why_it_matters: z.string(),
  catalysts: z.array(z.string()),
  risks: z.array(z.string()),
  affected_assets: z.array(
    z.object({
      symbol: z.string(),
      direction: z.enum(["up", "down", "unclear"]),
      confidence: z.number().min(0).max(3),
    }),
  ),
  what_to_watch: z.array(z.string()),
});
export type Analysis = z.infer<typeof Analysis>;

const RULES = `Eres un analista de mercados. Reglas innegociables:
- NUNCA inventes cifras. Usa solo los números que aparecen en los DATOS.
- Si no sabes algo, dilo. Un hueco declarado vale; una cifra inventada no.
- No des consejo de inversión. Describes mecanismos, no recomiendas operaciones.
- Sé breve. Frases cortas.`;

/** Los datos que ve el modelo. Es también el universo de cifras que puede citar. */
export function eventFacts(event: NormalizedEvent): string {
  const l = [
    `Indicador: ${event.title}`,
    `Pais/region: ${event.country ?? "n/d"}`,
    `Fecha del dato: ${event.observed_at}`,
    `Actual: ${fmt(event.actual)}${event.unit ?? ""}`,
    `Anterior: ${fmt(event.previous)}${event.unit ?? ""}`,
    `Consenso: ${event.consensus === null ? "no disponible (fuente gratuita no lo publica)" : fmt(event.consensus) + (event.unit ?? "")}`,
  ];
  if (event.surprise) {
    l.push(`Sorpresa: ${fmt(event.surprise.value)} ${event.surprise.unit} (frente a: ${event.surprise.basis})`);
  } else {
    l.push("Sorpresa: no calculable con los datos disponibles");
  }
  if (event.stale) l.push("AVISO: dato obsoleto, es el ultimo valido conocido.");
  return l.join("\n");
}

function fmt(n: number | null): string {
  return n === null ? "n/d" : String(n);
}

/** Universo numérico permitido para el control anti-fabricación. */
export function allowedNumbers(event: NormalizedEvent): Array<number | null> {
  return [event.actual, event.previous, event.consensus, event.surprise?.value ?? null];
}

export interface CascadeDeps {
  client: Anthropic;
  modelScoring: string;
  modelAnalysis: string;
}

/** Paso 3. Barato, corto, sobre todo lo que pasó el filtro. */
export async function scoreEvent(event: NormalizedEvent, deps: CascadeDeps): Promise<Scoring> {
  const res = await deps.client.messages.parse({
    model: deps.modelScoring,
    max_tokens: 1024,
    system: RULES,
    messages: [
      {
        role: "user",
        content: `Puntua la relevancia de mercado de este dato macro.\n\nDATOS:\n${eventFacts(event)}`,
      },
    ],
    output_config: { format: zodOutputFormat(Scoring) },
  });

  if (res.stop_reason === "refusal") {
    throw new Error(`El modelo rechazo puntuar el evento ${event.id}`);
  }
  const parsed = res.parsed_output;
  if (!parsed) throw new Error(`Scoring sin salida valida para ${event.id}`);
  return parsed;
}

/** Paso 4. Solo para lo que de verdad importa. */
export async function analyzeEvent(event: NormalizedEvent, deps: CascadeDeps): Promise<Analysis> {
  const res = await deps.client.messages.parse({
    model: deps.modelAnalysis,
    max_tokens: 8000,
    system: RULES,
    messages: [
      {
        role: "user",
        content:
          `Explica por que importa este dato, que lo puede amplificar o revertir, ` +
          `que activos se ven afectados y que hay que vigilar ahora.\n\nDATOS:\n${eventFacts(event)}`,
      },
    ],
    output_config: { format: zodOutputFormat(Analysis), effort: "medium" },
  });

  if (res.stop_reason === "refusal") {
    throw new Error(`El modelo rechazo analizar el evento ${event.id}`);
  }
  const parsed = res.parsed_output;
  if (!parsed) throw new Error(`Analisis sin salida valida para ${event.id}`);

  // El control anti-fabricación corre sobre la prosa, no sobre los campos
  // estructurados: es ahí donde un modelo se inventa un "subió un 4 %".
  const prose = [parsed.why_it_matters, ...parsed.catalysts, ...parsed.risks].join(" ");
  const check = checkFabrication(prose, allowedNumbers(event));
  if (!check.ok) {
    throw new Error(
      `Analisis descartado por fabricacion en ${event.id}: ${check.violations.join("; ")}`,
    );
  }
  return parsed;
}
