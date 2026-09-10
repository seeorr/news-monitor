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
import { COOKIE_SESION, VARIABLE_SECRETO, secretoUtilizable, verificarSesion } from "./sesion.ts";

/**
 * El secreto, del entorno y de ningún otro sitio.
 *
 * Se recorta: Vercel guarda con frecuencia un salto de línea de más al pegar el
 * valor, y un secreto que sólo falla en producción por un carácter invisible es
 * el peor de los fallos posibles. Vacío y ausente son lo mismo.
 */
export function secretoDeAcceso(): string | null {
  const valor = process.env[VARIABLE_SECRETO];
  return valor && valor.trim() !== "" ? valor.trim() : null;
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
