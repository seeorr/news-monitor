import type { Grupo } from "./agrupar.ts";

/**
 * Reparte el cupo escaso del scoring antes de recortarlo. Los datos primarios
 * van primero aunque observed_at sea el periodo macro, no su publicación.
 * Después, una noticia por feed y ronda: publicar más deprisa no da derecho
 * a consumir todas las plazas de los demás. Dentro de cada cola manda recencia.
 * No modifica grupos ni marca como vistos los que queden fuera del cupo.
 */
export function priorizarGrupos(grupos: readonly Grupo[]): Grupo[] {
  const oficiales = grupos.filter((g) => g.representante.official).sort(porRecencia);
  const colas = new Map<string, Grupo[]>();
  for (const grupo of grupos) {
    const event = grupo.representante;
    if (event.official) continue;
    // series_id de mercado identifica una empresa, no un feed: Yahoo comparte
    // una sola cola. En RSS sí identifica al editor que compite por cobertura.
    const fuente = event.source === "rss" ? `rss:${event.series_id ?? "desconocido"}` : event.source;
    const cola = colas.get(fuente) ?? [];
    cola.push(grupo);
    colas.set(fuente, cola);
  }
  for (const cola of colas.values()) cola.sort(porRecencia);

  const out = [...oficiales];
  while (colas.size > 0) {
    // Cada ronda empieza por la cabecera más reciente, con desempate estable.
    const ronda = [...colas.entries()].sort((a, b) => porRecencia(a[1][0]!, b[1][0]!));
    for (const [fuente, cola] of ronda) {
      out.push(cola.shift()!);
      if (cola.length === 0) colas.delete(fuente);
    }
  }
  return out;
}

function porRecencia(a: Grupo, b: Grupo): number {
  const instant = (g: Grupo) => {
    const value = Date.parse(g.representante.observed_at);
    return Number.isFinite(value) ? value : 0;
  };
  return instant(b) - instant(a) || a.representante.id.localeCompare(b.representante.id);
}
