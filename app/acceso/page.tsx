/**
 * `/acceso` — la única página pública de la aplicación.
 *
 * **Decidido: no delata lo que hay detrás.** Ni el nombre del proyecto, ni una
 * lista de secciones, ni "panel de inversión". El título de la pestaña es
 * "Acceso" y el `layout` no pinta la barra de navegación cuando no hay sesión,
 * así que esta pantalla no enseña ni un ticker ni una etiqueta. El motivo es
 * concreto: el dominio de un despliegue acaba en los registros públicos de
 * certificados y en la cabecera `Referer` de cualquier enlace que se pulse desde
 * aquí, y quien llegue de rebote no tiene por qué enterarse de que este dominio
 * guarda la cartera de alguien.
 *
 * Lo que **no** se hace es fingir que no existe: nada de un 404 falso. Sería
 * teatro —el bundle del navegador y las rutas siguen ahí para quien mire— y le
 * complicaría la vida al único que la usa. Discreción, no ocultación.
 */
import type { Metadata } from "next";
import { FormularioAcceso } from "./formulario.tsx";
import { destinoSeguro } from "../_lib/sesion.ts";

export const metadata: Metadata = {
  title: "Acceso",
  robots: { index: false, follow: false },
};

export const dynamic = "force-dynamic";

export default async function Acceso({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const parametros = await searchParams;
  const destino = parametros["destino"];
  const caducada = parametros["caducada"];

  return (
    <FormularioAcceso
      // Vuelve a pasar por el filtro aunque el proxy ya lo hubiera filtrado: lo
      // que llega aquí es texto de la URL, y la URL la escribe cualquiera.
      destino={destinoSeguro(typeof destino === "string" ? destino : null)}
      caducada={caducada === "1"}
    />
  );
}
