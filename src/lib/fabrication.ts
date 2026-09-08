/**
 * Control anti-fabricación.
 *
 * Portado de `portfolio-intelligence/codigo/packages/agent/src/fabrication.ts`,
 * adaptado a eventos de mercado. La idea es la misma y el motivo también: toda
 * cifra que el LLM escriba en prosa tiene que existir en los datos de entrada.
 * Sin otro LLM juzgando — extracción por regex y comprobación numérica.
 *
 * Es la implementación literal de la regla "no inventar datos" del spec.
 */

/**
 * Números de DEFINICIÓN, no datos: escalas de puntuación (0-10), meses del año,
 * trimestres y los puntos porcentuales de uso corriente. Mencionarlos no es
 * inventar una cifra.
 */
const STRUCTURAL_NUMBERS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 100];

/** Extrae números de un texto (admite coma decimal y %). Ignora fechas ISO. */
export function extractNumbers(text: string): number[] {
  const withoutDates = text.replace(/\d{4}-\d{2}-\d{2}/g, " ");
  const matches = withoutDates.match(/-?\d+(?:[.,]\d+)?/g) ?? [];
  return matches.map((m) => Number(m.replace(",", "."))).filter((n) => Number.isFinite(n));
}

/** ¿Está `n` respaldado por algún valor permitido? Admite ratio↔porcentaje y redondeo. */
function backed(n: number, allowed: number[]): boolean {
  const forms = (v: number) => [v, v * 100, Math.abs(v), Math.abs(v) * 100];
  for (const a of allowed) {
    for (const f of forms(a)) {
      if (Math.abs(f - n) <= 0.005 + Math.abs(f) * 1e-6) return true;
      if (Math.abs(Number(f.toFixed(1)) - n) <= 0.051) return true;
      if (Math.abs(Number(f.toFixed(2)) - n) <= 0.0051) return true;
    }
  }
  return false;
}

export interface FabricationCheck {
  ok: boolean;
  violations: string[];
}

/**
 * Revisa la prosa contra el universo de números permitidos.
 * `allowed` son los valores que el modelo recibió de verdad.
 */
export function checkFabrication(prose: string, allowed: Array<number | null>): FabricationCheck {
  const universe = [
    ...STRUCTURAL_NUMBERS,
    ...allowed.filter((v): v is number => v !== null && Number.isFinite(v)),
  ];
  const violations: string[] = [];
  for (const n of extractNumbers(prose)) {
    if (!backed(n, universe)) {
      violations.push(`la cifra ${n} no aparece en los datos de entrada`);
    }
  }
  return { ok: violations.length === 0, violations: [...new Set(violations)] };
}
