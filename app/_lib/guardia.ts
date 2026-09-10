/**
 * La comprobación de sesión desde dentro de la aplicación.
 *
 * Existe aparte del proxy por la razón que da la propia documentación de Next:
 * **una acción de servidor no es una ruta**, es un POST a la ruta de la página
 * donde se usa. Si la comprobación vive sólo en el render, un POST bien formado
 * escribe igual; si vive sólo en el proxy, cualquier cambio de `matcher` o
 * cualquier acción que se mueva de página se queda sin puerta y nada avisa.
 *
 * Es de servidor y sólo de servidor: importa `next/headers`. Ningún archivo con
 * `"use client"` puede importarlo.
 */
import { cookies } from "next/headers";
import { COOKIE_SESION, VARIABLE_SECRETO, secretoEfectivo, secretoUtilizable, verificarSesion } from "./sesion.ts";

/**
 * El secreto, del entorno y de ningún otro sitio.
 *
 * La normalización **no se repite aquí**: la hace `secretoEfectivo()`, en el
 * módulo puro, que es el mismo que usa el proxy. Tenerla escrita dos veces fue
 * justo el fallo —una puerta recortaba y la otra no—, y dos copias de una regla
 * son dos copias que un día dicen cosas distintas.
 */
export function secretoDeAcceso(): string | null {
  return secretoEfectivo(process.env[VARIABLE_SECRETO]);
}

/**
 * ¿Hay sesión válida en esta petición?
 *
 * Falla cerrada en los dos casos que importan: sin secreto configurado responde
 * que no —igual que el proxy—, y ante una cookie que no verifica responde que no
 * sin distinguir por qué. Quien llama no necesita el motivo para decidir.
 */
export async function haySesion(): Promise<boolean> {
  const secreto = secretoDeAcceso();
  if (!secretoUtilizable(secreto)) return false;
  const cookie = (await cookies()).get(COOKIE_SESION)?.value ?? null;
  return (await verificarSesion(cookie, secreto)).valido;
}
