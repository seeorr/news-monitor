/**
 * La misma historia contada por cinco sitios es una historia, no cinco.
 *
 * En cuanto entraron los feeds de prensa apareció el problema evidente: CNBC y
 * Yahoo publican la misma noticia con el titular casi calcado, y el ciclo la
 * puntuaba dos veces, la analizaba dos veces y la anunciaba dos veces. Cuesta
 * dinero y, sobre todo, cuesta credibilidad: dos avisos seguidos de lo mismo y
 * el monitor pasa a ser ruido.
 *
 * El parecido se mide por palabras, no por modelo. Un LLM decidiendo si dos
 * titulares son la misma noticia sería pagar por algo que Jaccard resuelve, y
 * además sin poder explicar por qué agrupó lo que agrupó.
 */
import type { NormalizedEvent } from "../../../src/schema/event.ts";

/**
 * Calibrado con los titulares reales del 8 de septiembre, no elegido a ojo.
 *
 * Con 0,5 se fundían "Best CD rates today" y "Best high-yield savings rates
 * today": dos productos distintos con las mismas palabras. Con 0,6 solo se funde
 * lo que de verdad es la misma noticia. Ante la duda, mejor dos avisos que
 * callar uno: un falso duplicado se pierde para siempre.
 */
const UMBRAL_DEFECTO = 0.6;

export interface Grupo {
  /** El que se puntúa, se analiza y se anuncia. */
  representante: NormalizedEvent;
  /** Los demás. Se registran como vistos para que no vuelvan mañana. */
  duplicados: NormalizedEvent[];
}

/**
 * Palabras que aparecen en todos los titulares y no distinguen nada. Sin
 * quitarlas, "the fed says" y "the company says" se parecen más de lo que son.
 */
const VACIAS = new Set([
  "the", "and", "for", "with", "from", "that", "this", "its", "his", "her", "are", "was",
  "will", "has", "have", "not", "but", "you", "your", "after", "over", "into", "than",
  "los", "las", "del", "para", "con", "por", "que", "una", "unos", "unas", "sus", "como",
  "mas", "sobre", "entre", "desde", "hasta", "tras", "sin", "ante", "este", "esta", "esto",
  "says", "said", "dice", "dijo", "según", "segun", "new", "nuevo", "nueva",
]);

/**
 * Palabras significativas de un titular, sin acentos ni puntuación.
 *
 * Se conservan los números: "recorta 25 puntos" y "recorta 50 puntos" no son la
 * misma noticia, y son justo las dos que más se parecen palabra a palabra.
 */
export function firma(title: string): Set<string> {
  const limpio = title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // marcas de acento
    .replace(/[^a-z0-9\s]/g, " ");

  const tokens = limpio
    .split(/\s+/)
    .filter((t) => t !== "" && !VACIAS.has(t))
    .filter((t) => t.length > 2 || /^\d+$/.test(t));

  return new Set(tokens);
}

/** Jaccard: proporción de palabras compartidas sobre el total de palabras distintas. */
export function similitud(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let comunes = 0;
  for (const t of a) if (b.has(t)) comunes++;
  return comunes / (a.size + b.size - comunes);
}

/** Mismo criterio para grupos visibles y copias que llegan en otra captura. */
export function sameStory(a: NormalizedEvent, b: NormalizedEvent, threshold = UMBRAL_DEFECTO): boolean {
  return a.kind === "news" && b.kind === "news" && compatibles(a, b) &&
    similitud(firma(a.title), firma(b.title)) >= threshold;
}

/**
 * Agrupa noticias que cuentan lo mismo.
 *
 * Solo se agrupan las **noticias**. Un dato macro es único por definición y dos
 * documentos ante la SEC con el mismo título son dos documentos distintos: ahí
 * el identificador ya lo dice todo y agrupar sería perder uno.
 *
 * El representante es el más fiable, no el primero que llegó: gana la fuente
 * oficial y, en igualdad, el que trae más contexto. El orden de entrada no
 * decide nada, para que dos ejecuciones con los mismos datos den lo mismo.
 */
export function agrupar(events: NormalizedEvent[], opts: { umbral?: number } = {}): Grupo[] {
  const umbral = opts.umbral ?? UMBRAL_DEFECTO;
  const grupos: Array<{ representante: NormalizedEvent; firma: Set<string>; duplicados: NormalizedEvent[] }> = [];

  for (const event of events) {
    if (event.kind !== "news") {
      grupos.push({ representante: event, firma: new Set(), duplicados: [] });
      continue;
    }

    const f = firma(event.title);
    const grupo = grupos.find((g) => g.firma.size > 0 && compatibles(g.representante, event) && similitud(g.firma, f) >= umbral);

    if (!grupo) {
      grupos.push({ representante: event, firma: f, duplicados: [] });
      continue;
    }

    if (mejor(event, grupo.representante)) {
      grupo.duplicados.push(grupo.representante);
      grupo.representante = event;
      grupo.firma = f;
    } else {
      grupo.duplicados.push(event);
    }
  }

  return grupos.map(({ representante, duplicados }) => ({ representante, duplicados }));
}

/** Dos publicaciones periódicas con el mismo título no son una noticia.
 * Tampoco lo son un recorte de 25 y otro de 50 puntos con la misma prosa. */
function compatibles(a: NormalizedEvent, b: NormalizedEvent): boolean {
  const t1 = Date.parse(a.publication_at ?? a.observed_at);
  const t2 = Date.parse(b.publication_at ?? b.observed_at);
  if (Number.isFinite(t1) && Number.isFinite(t2) && Math.abs(t1 - t2) > 24 * 3600_000) return false;
  const numbers = (e: NormalizedEvent) => [...e.title.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0]).sort().join("|");
  const n1 = numbers(a), n2 = numbers(b);
  return !n1 || !n2 || n1 === n2;
}

/** ¿Es `candidato` mejor portavoz de la historia que `actual`? */
function mejor(candidato: NormalizedEvent, actual: NormalizedEvent): boolean {
  if (candidato.official !== actual.official) return candidato.official;
  const largo = (e: NormalizedEvent) => (e.summary ?? "").length;
  if (largo(candidato) !== largo(actual)) return largo(candidato) > largo(actual);
  return candidato.id < actual.id; // Desempate estable: nada depende del orden de llegada.
}

/** Quién más lo cuenta, para decirlo en la alerta. Sin repetir la fuente del representante. */
export function tambienLoCuentan(grupo: Grupo): string[] {
  const fuentes = grupo.duplicados
    .map((e) => e.series_id ?? e.source)
    .filter((s) => s !== (grupo.representante.series_id ?? grupo.representante.source));
  return [...new Set(fuentes)];
}
