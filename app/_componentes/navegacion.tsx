"use client";

/**
 * La navegación de la sección 4.
 *
 * Es el único componente de cliente del layout, y solo porque saber cuál es la
 * página actual exige leer la ruta en el navegador.
 *
 * `/markets`, `/earnings` y `/regime` **no están**. Un enlace a una página que
 * no puede tener contenido es peor que no tenerlo: promete un dato que el
 * sistema no produce. Se añaden cuando el backend los produzca (huecos G3, G4 y
 * G5), no antes.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";

const PAGINAS = [
  { href: "/", texto: "Home" },
  { href: "/news", texto: "News" },
  { href: "/calendar", texto: "Calendar" },
  { href: "/watchlist", texto: "Watchlist" },
  { href: "/alerts", texto: "Alerts" },
] as const;

export function Navegacion() {
  const ruta = usePathname();
  return (
    <nav className="flex flex-wrap items-center gap-0.5" aria-label="Secciones">
      {PAGINAS.map((p) => {
        const activa = p.href === "/" ? ruta === "/" : ruta.startsWith(p.href);
        return (
          <Link
            key={p.href}
            href={p.href}
            aria-current={activa ? "page" : undefined}
            className={`rounded-chip px-2.5 py-1 text-secundario transition-colors ${
              activa
                ? "bg-accent-bg font-medium text-accent-text"
                : "text-txt-2 hover:bg-raised hover:text-txt"
            }`}
          >
            {p.texto}
          </Link>
        );
      })}
    </nav>
  );
}
