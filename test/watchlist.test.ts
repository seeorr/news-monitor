import { describe, expect, it } from "vitest";
import { actualizar, anadir, desdeEntorno, type Ejecutor } from "../src/db/watchlist.ts";
import { interruptor, opcion } from "../src/watchlist.ts";

/**
 * Un cliente SQL de mentira que solo apunta lo que se le pide.
 *
 * Lo que se comprueba aquí es **la consulta que sale de casa**: su texto y sus
 * parámetros. No se comprueba lo que Postgres hace con ella, porque para eso
 * haría falta un Postgres, y el único que hay es el de producción. El fallo que
 * estas pruebas cazan —un campo que se pisa a sí mismo con su valor por
 * defecto— vive entero en el texto y en los parámetros.
 */
function espia() {
  const consultas: Array<{ sql: string; valores: unknown[] }> = [];
  const ejecutor: Ejecutor = async (strings, ...valores) => {
    // Cada hueco de la plantilla se marca con "?" para poder leer la consulta.
    consultas.push({ sql: strings.join("?"), valores });
    return [];
  };
  return { consultas, ejecutor };
}

const URL_FALSA = "postgres://nadie@ninguna-parte/db";

describe("alta en la watchlist", () => {
  it("normaliza el ticker a mayusculas antes de escribirlo", async () => {
    const { consultas, ejecutor } = espia();
    await anadir(URL_FALSA, { ticker: "acme" }, ejecutor);
    expect(consultas[0]?.valores[0]).toBe("ACME");
  });

  // El fallo: reañadir un valor para completarle el nombre le devolvía el umbral
  // a 3 en silencio. Quien lo hubiera puesto en 8 pasaba a recibir avisos de
  // cualquier sesión corriente sin haber tocado nada.
  it("un alta sin umbral no manda ningun umbral", async () => {
    const { consultas, ejecutor } = espia();
    await anadir(URL_FALSA, { ticker: "ACME", nombre: "Acme Corp" }, ejecutor);

    const { sql, valores } = consultas[0]!;
    expect(valores[4]).toBeNull();
    expect(valores[5]).toBeNull();
    expect(sql).toContain("umbral_movimiento = coalesce(?::double precision, watchlist.umbral_movimiento)");
    expect(sql).not.toContain("umbral_movimiento = excluded.umbral_movimiento");
  });

  // El 3 de la fila nueva lo pone la consulta, no la persona: sin esto, un alta
  // limpia se iría a null contra una columna `not null`.
  it("una fila nueva sin umbral cae al 3 por defecto", async () => {
    const { consultas, ejecutor } = espia();
    await anadir(URL_FALSA, { ticker: "GLOBX" }, ejecutor);
    expect(consultas[0]?.sql).toContain("coalesce(?::double precision, 3)");
  });

  it("el umbral explicito si viaja, y viaja a los dos sitios", async () => {
    const { consultas, ejecutor } = espia();
    await anadir(URL_FALSA, { ticker: "GLOBX", umbral: 8 }, ejecutor);

    const { valores } = consultas[0]!;
    expect(valores[4]).toBe(8);
    expect(valores[5]).toBe(8);
  });

  it("sigue sin pisar nombre, CIK ni simbolo cuando llegan vacios", async () => {
    const { consultas, ejecutor } = espia();
    await anadir(URL_FALSA, { ticker: "ACME" }, ejecutor);

    const { sql, valores } = consultas[0]!;
    expect(valores.slice(1, 4)).toEqual([null, null, null]);
    expect(sql).toContain("nombre = coalesce(excluded.nombre, watchlist.nombre)");
    expect(sql).toContain("cik = coalesce(excluded.cik, watchlist.cik)");
    expect(sql).toContain("quote_symbol = coalesce(excluded.quote_symbol, watchlist.quote_symbol)");
  });
});

describe("watchlist de respaldo", () => {
  it("solo mira los documentos de quien esta en la lista de la SEC", () => {
    const filas = desdeEntorno(["acme", "globx"], ["acme"]);
    const acme = filas.find((v) => v.ticker === "ACME");
    const globx = filas.find((v) => v.ticker === "GLOBX");
    expect(acme?.vigilarFilings).toBe(true);
    expect(globx?.vigilarFilings).toBe(false);
    expect(globx?.vigilarPrecio).toBe(true);
  });

  it("hereda el 3 por defecto, que es lo mismo que dice la tabla", () => {
    expect(desdeEntorno(["ACME"], []).map((v) => v.umbralMovimiento)).toEqual([3]);
  });
});

/**
 * Editar el umbral es un `update` de esa columna y **no un alta repetida**. La
 * diferencia importa: un `insert ... on conflict` obliga a mandar la fila entera
 * para tocar un solo valor, y ese es el camino por el que el umbral se perdia.
 */
describe("cambios sobre una fila que ya existe", () => {
  it("lo que no llega no se toca", async () => {
    const { consultas, ejecutor } = espia();
    await actualizar(URL_FALSA, "ACME", { umbral: 8 }, ejecutor);

    const { sql, valores } = consultas[0]!;
    expect(sql).toContain("update watchlist set");
    expect(sql).toContain("umbral_movimiento = coalesce(?::double precision, umbral_movimiento)");
    expect(sql).toContain("vigilar_filings   = coalesce(?::boolean, vigilar_filings)");
    expect(sql).toContain("vigilar_precio    = coalesce(?::boolean, vigilar_precio)");
    expect(valores).toEqual([8, null, null, "ACME"]);
  });

  it("normaliza el ticker igual que el alta", async () => {
    const { consultas, ejecutor } = espia();
    await actualizar(URL_FALSA, "globx", { vigilarPrecio: false }, ejecutor);
    expect(consultas[0]?.valores.at(-1)).toBe("GLOBX");
  });

  // Un `false` es un valor, no una ausencia: apagar un interruptor tiene que
  // viajar, y con `??` en vez de `||` no se convierte en null por el camino.
  it("apagar un interruptor viaja como false y no como null", async () => {
    const { consultas, ejecutor } = espia();
    await actualizar(URL_FALSA, "ACME", { vigilarFilings: false }, ejecutor);
    expect(consultas[0]?.valores[1]).toBe(false);
  });

  it("distingue cambiado de no estaba", async () => {
    const vacio: Ejecutor = async () => [];
    expect(await actualizar(URL_FALSA, "ACME", { umbral: 4 }, vacio)).toBe(false);
    const conFila: Ejecutor = async () => [{ ticker: "ACME" }];
    expect(await actualizar(URL_FALSA, "ACME", { umbral: 4 }, conFila)).toBe(true);
  });
});

/**
 * Los argumentos del comando `set`.
 *
 * Es lo unico de ese comando que puede fallar en silencio. `actualizar()` ya
 * tiene sus pruebas; lo que no las tenia es la traduccion de banderas a los tres
 * estados, y ahi vive el fallo caro: apagar la vigilancia de un valor sin
 * haberlo pedido.
 */
describe("argumentos de set", () => {
  const argv = (...args: string[]) => ["node", "watchlist.ts", "set", "ACME", ...args];

  it("no pedir nada no es lo mismo que apagar", () => {
    expect(interruptor("documentos", argv("--umbral", "5"))).toBeNull();
    expect(interruptor("precio", argv("--umbral", "5"))).toBeNull();
  });

  it("enciende y apaga cuando se lo piden", () => {
    expect(interruptor("documentos", argv("--con-documentos"))).toBe(true);
    expect(interruptor("documentos", argv("--sin-documentos"))).toBe(false);
  });

  it("un interruptor no toca al otro", () => {
    const a = argv("--sin-documentos");
    expect(interruptor("documentos", a)).toBe(false);
    expect(interruptor("precio", a)).toBeNull();
  });

  // Pedir las dos cosas a la vez no es una preferencia ambigua que resolver a
  // ojo: es que quien lo escribio no sabe lo que quiere. Mejor parar.
  it("con y sin a la vez es un error, no un empate", () => {
    expect(() => interruptor("precio", argv("--con-precio", "--sin-precio"))).toThrow();
  });

  it("una opcion sin valor detras devuelve null y no la bandera siguiente", () => {
    expect(opcion("umbral", argv("--umbral"))).toBeNull();
  });

  it("lee el valor de la opcion", () => {
    expect(opcion("umbral", argv("--umbral", "8"))).toBe("8");
  });
});
