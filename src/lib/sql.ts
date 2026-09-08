/**
 * Troceado de archivos SQL en sentencias.
 *
 * Vive aparte del migrador para poder probarlo sin ejecutarlo: importar
 * `scripts/migrate.ts` lanzaria una migracion de verdad.
 */
/**
 * Trocea un archivo SQL en sentencias.
 *
 * Un `split(";")` pelado rompe en cuanto una migración lleve un punto y coma
 * dentro de una cadena, de un identificador entrecomillado o de un cuerpo de
 * función. Este recorre el texto y solo corta fuera de esos contextos.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let actual = "";
  let i = 0;

  while (i < sql.length) {
    const c = sql[i]!;
    const par = sql.slice(i, i + 2);

    if (par === "--") {
      const fin = sql.indexOf("\n", i);
      i = fin === -1 ? sql.length : fin;
      continue;
    }
    if (par === "/*") {
      const fin = sql.indexOf("*/", i + 2);
      i = fin === -1 ? sql.length : fin + 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const cierre = c;
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === cierre) {
          if (sql[j + 1] === cierre) j += 2; // '' y "" son el escape de SQL
          else break;
        } else j++;
      }
      actual += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "$") {
      // Cadena con etiqueta: $$...$$ o $cuerpo$...$cuerpo$
      const cierraEtiqueta = sql.indexOf("$", i + 1);
      const etiqueta = cierraEtiqueta === -1 ? null : sql.slice(i, cierraEtiqueta + 1);
      if (etiqueta && /^\$[A-Za-z_]*\$$/.test(etiqueta)) {
        const fin = sql.indexOf(etiqueta, cierraEtiqueta + 1);
        const hasta = fin === -1 ? sql.length : fin + etiqueta.length;
        actual += sql.slice(i, hasta);
        i = hasta;
        continue;
      }
    }
    if (c === ";") {
      if (actual.trim()) out.push(actual.trim());
      actual = "";
      i++;
      continue;
    }
    actual += c;
    i++;
  }

  if (actual.trim()) out.push(actual.trim());
  return out;
}
