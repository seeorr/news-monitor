"use server";

/**
 * Entrar y salir. Son las dos únicas escrituras de cookie de la aplicación.
 */
import { cookies, headers } from "next/headers";
import { redirect } from "next/navigation";
import { almacenNeon } from "../../src/db/intentos-acceso.ts";
import { cliente } from "../../src/db/lectura.ts";
import { POLITICA_INTENTOS, claveCliente, ipDeCabeceras } from "../_lib/limite.ts";
import { urlBaseDeDatos } from "../_lib/servidor.ts";
import {
  COOKIE_SESION,
  MENSAJE_ACCESO_DENEGADO,
  RUTA_ACCESO,
  contrasenaValida,
  destinoSeguro,
  emitirSesion,
  secretoUtilizable,
} from "../_lib/sesion.ts";
import { secretoDeAcceso } from "../_lib/guardia.ts";
import type { EstadoAcceso } from "./estado.ts";

const DENEGADO: EstadoAcceso = { tipo: "error", mensaje: MENSAJE_ACCESO_DENEGADO };

/**
 * Los atributos de la cookie, en un sitio y no repartidos.
 *
 * `httpOnly` para que ningún script la lea —una sesión que vive en JavaScript la
 * roba cualquier inyección—; `secure` para que no viaje en claro; `sameSite:
 * "lax"` porque es lo que impide que un POST desde otro sitio la arrastre, que
 * es exactamente la forma de escribir en la watchlist de alguien sin haber
 * entrado nunca. `lax` y no `strict` porque `strict` rompe llegar desde un
 * enlace externo y no compra nada más aquí.
 *
 * `secure` también en local: los navegadores aceptan cookies `Secure` sobre
 * `http://localhost`, así que no hay que hacer una excepción por desarrollo, y
 * una excepción por desarrollo es cómo acaban las cookies sin `Secure` en
 * producción.
 */
const ATRIBUTOS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
} as const;

export async function entrar(_previo: EstadoAcceso, datos: FormData): Promise<EstadoAcceso> {
  const secreto = secretoDeAcceso();
  // Sin secreto no se entra. El proxy ya devuelve 503 antes de llegar aquí, pero
  // esta rama es lo que hace que la afirmación sea cierta y no una consecuencia
  // de la configuración del `matcher`.
  if (!secretoUtilizable(secreto)) return DENEGADO;

  // Límite de intentos. Sin base no hay dónde contar, y sin cuenta la puerta
  // vuelve a depender solo del tamaño del secreto: se falla cerrado, igual que
  // sin secreto. Con Neon caído, lo mismo; el dashboard tampoco podría enseñar nada.
  const url = urlBaseDeDatos();
  if (!url) return DENEGADO;
  const intentos = almacenNeon(cliente(url), POLITICA_INTENTOS);
  const clave = await claveCliente(ipDeCabeceras(await headers()), secreto);
  try {
    // Bloqueada: no se mira la clave. Mirarla diría, por el tiempo o por el
    // resultado, si la de este intento era buena, y alargaría nada.
    if (await intentos.bloqueadoHasta(clave, new Date())) return DENEGADO;
    if (!(await contrasenaValida(String(datos.get("clave") ?? ""), secreto))) {
      await intentos.registrarFallo(clave, new Date());
      return DENEGADO;
    }
    await intentos.limpiar(clave);
  } catch {
    return DENEGADO;
  }

  const { valor, expira } = await emitirSesion(secreto);
  // `expires` acompaña a la caducidad que ya va firmada dentro del valor: el
  // navegador se deshace de la cookie a su hora y el servidor la rechaza aunque
  // no lo haga.
  (await cookies()).set(COOKIE_SESION, valor, { ...ATRIBUTOS, expires: expira });

  redirect(destinoSeguro(String(datos.get("destino") ?? "")));
}

/**
 * Salir borra la cookie del navegador de verdad —`Set-Cookie` con caducidad en
 * el pasado, que es lo que hace `delete`—, y ahí termina lo que se puede
 * prometer: la firma no se guarda en ninguna parte, así que una copia que
 * alguien hubiera hecho antes sigue siendo válida hasta su hora. Para invalidar
 * **todas** las sesiones vivas a la vez se cambia la variable de entorno: cambia
 * la clave derivada y ninguna firma anterior verifica. Está escrito en el README.
 */
export async function salir(): Promise<void> {
  (await cookies()).delete(COOKIE_SESION);
  redirect(RUTA_ACCESO);
}
