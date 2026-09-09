/**
 * El shell de la sección 4: barra superior fija y cuerpo.
 *
 * **No hay franja de régimen de mercado** bajo la barra, y no es un olvido: no
 * existe el dato (hueco G3). Un banner con un régimen inventado en la cabecera
 * de todas las páginas contaminaría la app entera, que es justo lo contrario de
 * lo que hace un banner de contexto. Cuando el régimen exista, se añade aquí sin
 * tocar nada más.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { Navegacion } from "./_componentes/navegacion.tsx";
import "./globals.css";

export const metadata: Metadata = {
  title: "News Monitor",
  description: "Market intelligence personal: filtra, prioriza, contextualiza y explica.",
  // El dashboard enseña una cartera. No tiene nada que hacer en un buscador.
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className="min-h-dvh">
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
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-4 py-5">{children}</main>
      </body>
    </html>
  );
}
