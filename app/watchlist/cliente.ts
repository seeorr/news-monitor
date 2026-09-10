"use client";

/**
 * Qué pasa cuando la sesión caduca con un formulario a medio rellenar.
 *
 * **Decidido: se avisa y no se pierde lo escrito.** El caso es real —doce horas
 * de sesión y una pestaña abierta desde ayer— y sin esto se ve fatal: el proxy
 * corta el POST con un 403, React no consigue leer esa respuesta como resultado
 * de una acción, la promesa se rompe y lo que sube es un error de página
 * completa. El formulario desaparece con lo escrito dentro y no queda claro si
 * se guardó o no, que es la peor de las dos formas de fallar.
 *
 * Aquí se envuelve la acción en el cliente para que ese fallo se convierta en lo
 * que es: un estado de error del propio formulario. El componente no se
 * desmonta, el campo conserva lo tecleado y el mensaje dice **que no se ha
 * guardado nada**. La alternativa —dejar pasar el POST y contestar bonito desde
 * dentro— exige que el proxy no bloquee las escrituras, y eso es rebajar la
 * puerta para mejorar un mensaje.
 *
 * Se traga cualquier fallo de la acción, no sólo el de sesión, y por eso el
 * texto dice "puede que": desde el navegador un 403 y un túnel que se cae se
 * parecen demasiado como para afirmar cuál de los dos fue. Lo que sí se puede
 * afirmar es que no se escribió, y es lo que se afirma.
 *
 * El precio: estas cuatro acciones dejan de funcionar sin JavaScript, porque ya
 * no es la acción de servidor la que va directa al `<form>`. Sin JavaScript el
 * navegador sigue el 303 del proxy y acaba en la pantalla de acceso, que es
 * exactamente lo que tiene que pasar.
 */
import { MENSAJE_SESION_CADUCADA } from "../_lib/sesion.ts";
import type { Estado } from "./estado.ts";

type Accion = (previo: Estado, datos: FormData) => Promise<Estado>;

export function conAvisoDeSesion(accion: Accion): Accion {
  return async (previo, datos) => {
    try {
      return await accion(previo, datos);
    } catch {
      return { tipo: "error", mensaje: MENSAJE_SESION_CADUCADA, avisos: [] };
    }
  };
}
