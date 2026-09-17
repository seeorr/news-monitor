/**
 * Retención: hacer sitio sin destruir la evidencia.
 *
 * El 17-09 la base iba por 48 MB de los 500 del plan gratuito, con nueve días de
 * vida y ~5,4 MB al día. A ese ritmo el disco se llena hacia diciembre, y el
 * modo de fallo de Neon lleno es el que obliga a escribir esto con tiempo:
 * **cuando no queda sitio fallan también los `DELETE`**. No se puede vaciar una
 * tabla para salir del apuro; hay que pagar o resetear la rama. Una política de
 * retención escrita el día que ya no cabe no se puede ejecutar.
 *
 * Dos decisiones que no son detalles:
 *
 * 1. **No se borra ni una fila de `capture_queue`.** La fila ES la memoria de
 *    deduplicación: sin ella, la misma noticia vuelve a entrar en la siguiente
 *    captura —Yahoo reinyecta titulares de días anteriores—, se vuelve a puntuar
 *    gastando cupo de IA y acaba saliendo más tarde todavía. Lo que pesa es el
 *    `snapshot`, no la fila, así que se poda el cuerpo y se conserva el
 *    esqueleto: `id`, `kind`, la fuente y el titular recortado, más la marca de
 *    cuándo se podó, para que nadie confunda una fila podada con una incompleta.
 *
 * 2. **Se dejan fuera los descartes que alguien vuelve a leer.** `storyContext`
 *    consulta descartadas por `duplicate_story` y `legacy_processed` dentro de
 *    una ventana de ±14 días alrededor del hecho macro; podarlas dejaría a la
 *    agrupación sin el texto que compara. Son pocas —14 filas el 17-09— y no
 *    mueven la aguja.
 *
 * Las revisiones de fuente no se ven afectadas: comparan la columna
 * `fingerprint`, que es otra cosa y no se toca.
 *
 * Lo que este módulo NO promete: que el número que factura Neon baje de golpe.
 * Neon cobra el almacén lógico **más su historial**, así que podar libera
 * espacio lógico y el efecto aparece según el historial rota. Generar menos
 * datos es el otro lado del problema, y ese no se arregla aquí.
 */
import type { Ejecutor } from "./cliente.ts";

export interface Poda {
  /** Filas de `capture_queue` cuyo snapshot se reduce al esqueleto. */
  snapshotsPodados: number;
  /** Filas de telemetría `monitor_runs` que se borran. */
  ejecucionesBorradas: number;
  /** Bytes que ocupan esos snapshots antes de podarlos. */
  bytesLiberados: number;
}

/**
 * La condición, escrita UNA vez y compartida por el modo seco y el real.
 *
 * Si el simulacro y la poda usaran dos copias, el día que una cambiara el modo
 * seco dejaría de servir para decidir, que es justo para lo que existe.
 *
 * `last_captured_at` entra además de `processed_at` a propósito: una noticia que
 * la fuente sigue reinyectando hoy no es antigua aunque se descartara hace un
 * mes, y podarla borraría el texto de algo que está volviendo a entrar.
 *
 * Se usa `jsonb_exists` y no el operador `?` porque `?` es también el marcador
 * de valor de esta plantilla: mezclarlos sería un error silencioso.
 */
const PODABLE = `state = 'discarded'
  and reason is not null
  and reason <> all(array['duplicate_story', 'legacy_processed'])
  and not jsonb_exists(snapshot, 'podado_en')
  and processed_at < ?::timestamptz
  and last_captured_at < ?::timestamptz`;

/**
 * Ejecuta una sentencia con marcadores `?`, usando el mismo `Ejecutor` de
 * siempre. El resto del proyecto escribe SQL con plantillas etiquetadas; aquí
 * hace falta componer el texto para no repetir la condición, y esta es la forma
 * de hacerlo sin construir SQL a mano con los valores dentro.
 */
async function ejecutar(sql: Ejecutor, texto: string, ...valores: unknown[]): Promise<unknown[]> {
  const partes = texto.split("?");
  // Descuadrar marcadores y valores mandaría a la base una consulta con un
  // parámetro de menos, que es la forma silenciosa de borrar de más.
  if (partes.length - 1 !== valores.length) throw new Error("retencion_marcadores_descuadrados");
  const filas = await sql(Object.assign(partes, { raw: [...partes] }) as unknown as TemplateStringsArray, ...valores);
  return Array.isArray(filas) ? filas : [];
}

/** Qué haría la poda sin hacerla. Misma condición, exactamente, que `podar()`. */
export async function simularPoda(sql: Ejecutor, corte: string): Promise<Poda> {
  const [cola] = (await ejecutar(sql,
    `select count(*)::int as filas, coalesce(sum(pg_column_size(snapshot)), 0)::bigint as bytes
     from capture_queue where ${PODABLE}`, corte, corte)) as Array<{ filas: number; bytes: string | number }>;
  const [runs] = (await ejecutar(sql,
    `select count(*)::int as filas from monitor_runs where started_at < ?::timestamptz`,
    corte)) as Array<{ filas: number }>;
  return {
    snapshotsPodados: Number(cola?.filas ?? 0),
    ejecucionesBorradas: Number(runs?.filas ?? 0),
    bytesLiberados: Number(cola?.bytes ?? 0),
  };
}

/**
 * Poda de verdad, y devuelve lo mismo que el simulacro para poder compararlos.
 *
 * El esqueleto conserva `kind` tal cual —un CHECK de la tabla exige que las
 * filas con `story_at` lo tengan en `news`— y el `id`, que otro CHECK obliga a
 * que coincida con la clave. El titular se recorta a 120 caracteres: deja un
 * rastro legible para una auditoría sin arrastrar la entradilla, que es lo que
 * de verdad pesa.
 */
export async function podar(sql: Ejecutor, corte: string, ahora: string): Promise<Poda> {
  const previsto = await simularPoda(sql, corte);
  await ejecutar(sql,
    `update capture_queue set snapshot = jsonb_build_object(
       'id', id,
       'kind', snapshot->>'kind',
       'source', snapshot->>'source',
       'title', left(coalesce(snapshot->>'title', ''), 120),
       'podado_en', ?::text
     ) where ${PODABLE}`, ahora, corte, corte);
  await ejecutar(sql, `delete from monitor_runs where started_at < ?::timestamptz`, corte);
  return previsto;
}
