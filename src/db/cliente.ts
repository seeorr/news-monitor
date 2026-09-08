/**
 * El cliente SQL, como tipo.
 *
 * `neon()` devuelve una plantilla etiquetada. Las capas de acceso a la base la
 * reciben por parámetro, con `neon(databaseUrl)` por defecto, para poder mirar
 * en un test la consulta que se manda sin una base delante. No es poco: los dos
 * fallos que han aparecido en este esquema —un campo que se pisa a sí mismo con
 * su valor por defecto, una puntuación que no se guardaba— vivían enteros en el
 * texto de la consulta y en sus parámetros.
 */
export type Ejecutor = (strings: TemplateStringsArray, ...valores: unknown[]) => Promise<unknown>;
