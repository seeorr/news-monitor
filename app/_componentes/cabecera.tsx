/** Cabecera de página: título, cuenta y una línea que dice qué se está mirando. */
export function Cabecera({
  titulo,
  cuenta,
  descripcion,
  acciones,
}: {
  titulo: string;
  cuenta?: string;
  descripcion?: string;
  acciones?: React.ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-titulo font-medium">
          {titulo}
          {cuenta ? <span className="cifra ml-2 text-cuerpo text-txt-3">{cuenta}</span> : null}
        </h1>
        {descripcion ? <p className="mt-0.5 text-secundario text-txt-2">{descripcion}</p> : null}
      </div>
      {acciones ? <div className="flex items-center gap-2">{acciones}</div> : null}
    </div>
  );
}

/** Un bloque del sidebar. */
export function Bloque({
  titulo,
  nota,
  children,
}: {
  titulo: string;
  nota?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-5">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-secundario font-medium">{titulo}</h2>
        {nota ? <span className="text-meta text-txt-3">{nota}</span> : null}
      </div>
      {children}
    </section>
  );
}
