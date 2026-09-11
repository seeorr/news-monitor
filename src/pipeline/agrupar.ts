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
import type { NormalizedEvent } from "../schema/event.ts";
import { rateFact, sameMacroFact } from "./critical-macro.ts";

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
  // La equivalencia de hecho macro NO exime del control de negación, y esta
  // línea va antes que ella a propósito. "El BCE sube los tipos 25 pb" y "El
  // BCE no sube los tipos 25 pb" producen el mismo `RateFact` —el importe y el
  // nivel se leen del mismo texto y el "no" no cambia ninguno de los dos—, así
  // que el desmentido entraba como duplicado de la subida: dejaba de contar
  // como noticia nueva y podía no llegar nunca. Medido en `dedup-pares.json`.
  if (traits(a).negation !== traits(b).negation) return false;
  if (sameMacroFact(a, b)) return true;
  return a.kind === "news" && b.kind === "news" && compatibles(a, b) &&
    similitud(firma(a.title), firma(b.title)) >= threshold;
}

/** Relación conservadora: mismo sujeto explícito y tema, pero un hecho cambió.
 * No confunde esta relación con equivalencia ni impide puntuar la actualización. */
export function relatedUpdate(a: NormalizedEvent, b: NormalizedEvent): boolean {
  const x = rateFact(a), y = rateFact(b);
  if (x && y && x.bank === y.bank && x.day === y.day && !sameMacroFact(a, b)) return true;
  const subject = storySubject(a.title);
  return a.kind === "news" && b.kind === "news" && Boolean(subject) && subject === storySubject(b.title) &&
    !sameStory(a, b) && Math.abs(Date.parse(a.publication_at ?? a.observed_at) - Date.parse(b.publication_at ?? b.observed_at)) <= 24 * 3600_000 &&
    similitud(firma(a.title), firma(b.title)) >= 0.5;
}
export function storySubject(title: string): string | null {
  return title.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "")
    .match(/^(.{2,65}?)\s+(?:acquires?|buys?|sells?|raises?|cuts?|reports?|signs?|wins?|files?|denies|announces?|adquiere|compra|vende|eleva|recorta|publica|firma|gana|presenta|niega|anuncia)\b/u)?.[1]
    ?.replace(/^the\s+/, "").replace(/federal reserve/g, "fed").trim() ?? null;
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
    if (event.kind !== "news" && !rateFact(event)) {
      grupos.push({ representante: event, firma: new Set(), duplicados: [] });
      continue;
    }

    const f = firma(event.title);
    const grupo = grupos.find((g) => sameStory(g.representante, event, umbral));

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
  const left = traits(a), right = traits(b);
  return left.negation === right.negation &&
    (!left.subject || !right.subject || left.subject === right.subject) &&
    (!Number.isFinite(left.time) || !Number.isFinite(right.time) || Math.abs(left.time - right.time) <= 24 * 3600_000) &&
    left.period === right.period && left.numbers === right.numbers;
}

// El agrupador compara muchos pares; cada regex se calcula una vez por snapshot.
// Se comprueba el contenido para no devolver datos antiguos si un caller muta e.
const traitCache = new WeakMap<NormalizedEvent, { title:string; summary:string|null; date:string; negation:boolean; subject:string|null; time:number; period:string; numbers:string }>();
function traits(e: NormalizedEvent) {
  const date = e.publication_at ?? e.observed_at;
  const cached = traitCache.get(e);
  if (cached && cached.title === e.title && cached.summary === e.summary && cached.date === date) return cached;
  const normalize = (s: string) => s.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "");
  // No todas las negaciones llevan partícula negativa: "descarta subir los
  // tipos" es justo lo contrario de "sube los tipos" y, sin estas palabras, los
  // dos titulares se parecían lo bastante como para fundirse. Se añaden solo
  // verbos que invierten el hecho o lo dejan sin ocurrir; ninguno de matiz.
  const negation = /\b(?:not|no|never|denies|denied|niega|niegan|desmiente|desmienten|sin|cancelled|cancela|rejected|rechaza|rechazan|rules? out|ruled out|descarta|descartan|fails? to|failed to|aplaza|aplazan|posponen?|postpones?|postponed|delays?|delayed)\b/u;
  const period = (e: NormalizedEvent) => normalize(e.title).match(/\b(?:january|february|march|april|may|june|july|august|september|october|november|december|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|octubre|noviembre|diciembre|q[1-4])\b/gu)?.sort().join("|") ?? "";
  const numbers = (e: NormalizedEvent) => {
    const text = normalize(`${e.title} ${e.summary ?? ""}`).replace(/%/g, " percent ");
    const values = [...text.matchAll(/\d+(?:[.,]\d+)*/g)].map((m) => m[0]);
    const magnitudes = [...text.matchAll(/\b(?:million|billion|trillion|millones|billones|miles|basis points|puntos basicos|percent|por ciento)\b/g)].map((m) => m[0]);
    // La cifra no siempre va en dígitos: la prensa anglosajona titula "cuts
    // rates by a quarter point" donde el comunicado dice "25 basis points". Sin
    // esto, un cuarto de punto y medio punto eran la misma noticia, que es el
    // mismo error que 25 contra 50 puntos básicos dicho con otras palabras.
    const fracciones = [...text.matchAll(/\b(?:quarter|half|full|cuarto|medio)[\s-](?:point|points|punto|puntos)\b/g)].map((m) => m[0].replace(/[\s-]+/g, " "));
    return [...new Set(values)].sort().join("|") + ";" + [...new Set(magnitudes)].sort().join("|") +
      ";" + [...new Set(fracciones)].sort().join("|");
  };
  const value = {title:e.title,summary:e.summary,date,negation:negation.test(normalize(e.title)),subject:storySubject(e.title),time:Date.parse(date),period:period(e),numbers:numbers(e)};
  traitCache.set(e,value); return value;
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
