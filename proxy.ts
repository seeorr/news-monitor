/**
 * La puerta del dashboard.
 *
 * Se llama `proxy.ts` y no `middleware.ts` porque Next 16 renombró el fichero;
 * es lo mismo de siempre, código que corre antes de que se resuelva la ruta.
 *
 * Aquí no se decide nada: la decisión entera vive en `app/_lib/sesion.ts`, que
 * es puro y está probado. Este archivo sólo traduce esa decisión a una respuesta
 * HTTP. Que la lógica no viva en el proxy es lo que permite que **la misma
 * comprobación** se haga también dentro de cada acción de servidor, y esa
 * duplicación no es un descuido: el proxy es la puerta, y la comprobación de
 * dentro es lo que impide rodearla. La propia documentación de Next lo dice sin
 * rodeos —un cambio de `matcher` o mover una acción de sitio deja el POST fuera
 * de cobertura sin que nada avise—, y una acción de servidor **es** un POST a la
 * ruta de su página.
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  COOKIE_SESION,
  LONGITUD_MINIMA_SECRETO,
  RUTA_ACCESO,
  VARIABLE_SECRETO,
  decidir,
} from "./app/_lib/sesion.ts";

/**
 * Lo que se sirve cuando falta la variable. No lleva ningún valor dentro y no
 * insinúa qué hay detrás: dice qué falta y dónde se pone, que es lo único que
 * le sirve a quien despliega. Cualquier otra respuesta —servir el dashboard,
 * servir un formulario que no puede aceptar nada— es peor.
 */
const SIN_CONFIGURAR = [
  "Este despliegue no está configurado y por eso no se sirve.",
  "",
  `Falta la variable de entorno ${VARIABLE_SECRETO} (mínimo ${LONGITUD_MINIMA_SECRETO} caracteres).`,
  "Se pone en Vercel → Settings → Environment Variables, y en local en el .env.",
  "Sin ella no hay forma de distinguir a quién se le abre, así que no se abre a nadie.",
].join("\n");

const SIN_CACHE = {
  "cache-control": "no-store, no-cache, must-revalidate",
  "content-type": "text/plain; charset=utf-8",
} as const;

export async function proxy(peticion: NextRequest): Promise<NextResponse> {
  const decision = await decidir({
    pathname: peticion.nextUrl.pathname,
    metodo: peticion.method,
    cookie: peticion.cookies.get(COOKIE_SESION)?.value ?? null,
    secreto: process.env[VARIABLE_SECRETO] ?? null,
  });

  if (decision.tipo === "pasa") return NextResponse.next();

  if (decision.tipo === "sin-configurar") {
    return new NextResponse(SIN_CONFIGURAR, { status: 503, headers: SIN_CACHE });
  }

  if (decision.tipo === "bloquea-escritura") {
    // Seco y sin cuerpo útil: lo lee React, no una persona. Quien lo cuenta es
    // el formulario, con `MENSAJE_SESION_CADUCADA`.
    return new NextResponse("Sesión no válida.", { status: 403, headers: SIN_CACHE });
  }

  const destino = peticion.nextUrl.clone();
  destino.pathname = RUTA_ACCESO;
  destino.search = "";
  destino.searchParams.set("destino", decision.destino);
  if (decision.caducada) destino.searchParams.set("caducada", "1");

  // 303 y no 307: lo que sigue es un GET de la pantalla de acceso, no un reintento
  // del método original.
  const respuesta = NextResponse.redirect(destino, 303);
  // Una cookie caducada o manipulada no vuelve a mandarse en cada navegación.
  respuesta.cookies.delete(COOKIE_SESION);
  respuesta.headers.set("cache-control", "no-store, no-cache, must-revalidate");
  return respuesta;
}

/**
 * Todo pasa por aquí menos los estáticos, que son los que sirven la propia
 * pantalla de acceso: sin esta exclusión el formulario se queda sin CSS y sin
 * JS. No hay riesgo en dejarlos fuera —son los bundles del navegador, no datos—
 * y las cargas de React de las páginas privadas viajan por la ruta de la página,
 * que sí entra.
 */
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon\\.ico).*)"],
};
