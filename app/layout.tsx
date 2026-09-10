/**
 * El shell de la sección 4: barra superior fija y cuerpo.
 *
 * **No hay franja de régimen de mercado** bajo la barra, y no es un olvido: no
 * existe el dato (hueco G3). Un banner con un régimen inventado en la cabecera
 * de todas las páginas contaminaría la app entera, que es justo lo contrario de
 * lo que hace un banner de contexto. Cuando el régimen exista, se añade aquí sin
 * tocar nada más.
 *
 * La barra sólo se pinta **si hay sesión**, y por eso el layout lee la cookie.
 * No es la comprobación de seguridad —de eso se encargan `proxy.ts` y la
 * comprobación de dentro de cada acción— sino de discreción: la pantalla de
 * acceso es la única página pública que hay, y con la barra puesta le enseñaría
 * el nombre del proyecto y sus seis secciones a quien todavía no ha entrado.
 * Leer la cookie convierte todas las rutas en dinámicas, que es lo que ya eran:
 * aquí no hay nada que se pueda prerenderizar ni cachear sin enseñárselo a
 * alguien.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Navegacion } from "./_componentes/navegacion.tsx";
import { salir } from "./acceso/acciones.ts";
import { haySesion } from "./_lib/guardia.ts";
import "./globals.css";

export const metadata: Metadata = {
  title: "News Monitor",
  description: "Market intelligence personal: filtra, prioriza, contextualiza y explica.",
  // El dashboard enseña una cartera. No tiene nada que hacer en un buscador.
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const dentro = await haySesion();

  return (
    <html lang="es">
      <body className="min-h-dvh">
        {dentro ? <Barra /> : null}

        {/*
          Sin sesión sólo cabe el formulario de acceso, y una columna de 1152 px
          para un campo y un botón se lee como una página a medio cargar.
        */}
        <main className={dentro ? "mx-auto max-w-6xl px-4 py-5" : "mx-auto max-w-sm px-4 py-16"}>
          {children}
        </main>
      </body>
    </html>
  );
}

function Barra() {
  return (
    <header className="sticky top-0 z-10 border-b border-linea bg-page/90 backdrop-blur">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
        <Link href="/" className="text-cuerpo font-medium whitespace-nowrap">
          News Monitor
        </Link>
        <div className="order-3 w-full sm:order-none sm:w-auto sm:flex-1">
          <Navegacion />
        </div>
        <Link
          href="/settings"
          className="ml-auto rounded-chip px-2.5 py-1 text-secundario text-txt-2 hover:bg-raised hover:text-txt"
        >
          Ajustes
        </Link>
        {/*
          Un formulario y no un enlace: salir borra una cookie, y borrar algo con
          un GET es lo que hace que el prefetch del navegador te eche solo.
        */}
        <form action={salir}>
          <button
            type="submit"
            className="rounded-chip px-2.5 py-1 text-secundario text-txt-2 hover:bg-raised hover:text-txt"
          >
            Salir
          </button>
        </form>
      </div>
    </header>
  );
}
