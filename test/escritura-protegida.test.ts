import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COOKIE_SESION, emitirSesion } from "../app/_lib/sesion.ts";
import { ESTADO_INICIAL } from "../app/watchlist/estado.ts";

/**
 * La prueba que de verdad importa: **una escritura sin sesión válida no
 * escribe.**
 *
 * Y se hace contra las acciones de verdad, no contra una copia suya. Que
 * `proxy.ts` bloquee el POST es la puerta; esto comprueba lo otro, que es lo que
 * se olvida: que si alguien rodea la puerta —un `matcher` que cambia, una acción
 * que se muda de página, un despliegue donde el proxy no llegó a correr— la
 * escritura sigue sin ocurrir.
 *
 * Se sustituyen las cuatro dependencias de servidor que no existen fuera de una
 * petición de Next (`next/headers`, `next/cache`) o que saldrían a la red
 * (EDGAR, Yahoo). Las de la base de datos se sustituyen por espías: **si el
 * espía no se llama, no se ha escrito**, que es exactamente la afirmación.
 */
const falso = vi.hoisted(() => ({
  anadir: vi.fn(async (_url: string, _valor: Record<string, unknown>) => undefined),
  quitar: vi.fn(async (_url: string, _ticker: string) => true),
  actualizar: vi.fn(async (_url: string, _ticker: string, _cambios: Record<string, unknown>) => true),
  revalidar: vi.fn((_ruta: string) => undefined),
  cookie: { valor: null as string | null },
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (nombre: string) =>
      nombre === COOKIE_SESION && falso.cookie.valor !== null
        ? { name: nombre, value: falso.cookie.valor }
        : undefined,
  }),
}));
vi.mock("next/cache", () => ({ revalidatePath: falso.revalidar }));
vi.mock("../src/db/watchlist.ts", () => ({
  anadir: falso.anadir,
  quitar: falso.quitar,
  actualizar: falso.actualizar,
}));
vi.mock("../src/sources/sec-edgar.ts", () => ({
  resolveTickers: vi.fn(async () => ({ companies: [], missing: [] })),
}));
vi.mock("../src/sources/mercado.ts", () => ({
  fetchCotizacion: vi.fn(async () => ({ symbol: "ACME", currency: "USD" })),
}));

const { anadirTicker, cambiarUmbral, cambiarVigilancia, quitarTicker } = await import(
  "../app/watchlist/acciones.ts"
);

const SECRETO = `${crypto.randomUUID()}${crypto.randomUUID()}`;
const URL_FALSA = "postgres://nadie@ninguna-parte/db";

function formulario(campos: Record<string, string>): FormData {
  const datos = new FormData();
  for (const [k, v] of Object.entries(campos)) datos.set(k, v);
  return datos;
}

/** Las cuatro escrituras que existen, con el formulario más pequeño que cada una acepta. */
const ESCRITURAS = [
  ["anadirTicker", anadirTicker, formulario({ ticker: "ACME" })],
  ["quitarTicker", quitarTicker, formulario({ ticker: "ACME" })],
  ["cambiarUmbral", cambiarUmbral, formulario({ ticker: "ACME", umbral: "5" })],
  ["cambiarVigilancia", cambiarVigilancia, formulario({ ticker: "ACME", campo: "precio", valor: "1" })],
] as const;

function nadieHaEscrito() {
  expect(falso.anadir).not.toHaveBeenCalled();
  expect(falso.quitar).not.toHaveBeenCalled();
  expect(falso.actualizar).not.toHaveBeenCalled();
  // Ni siquiera se invalida la caché: no ha pasado nada que contar.
  expect(falso.revalidar).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  falso.cookie.valor = null;
  process.env["DASHBOARD_PASSWORD"] = SECRETO;
  process.env["DATABASE_URL"] = URL_FALSA;
  delete process.env["SEC_USER_AGENT"];
});

afterEach(() => {
  delete process.env["DASHBOARD_PASSWORD"];
  delete process.env["DATABASE_URL"];
});

describe("las escrituras de la watchlist", () => {
  it("ninguna escribe sin cookie de sesión", async () => {
    for (const [nombre, accion, datos] of ESCRITURAS) {
      const estado = await accion(ESTADO_INICIAL, datos);
      expect(estado.tipo, nombre).toBe("error");
    }
    nadieHaEscrito();
  });

  it("ninguna escribe con una cookie firmada por otro secreto", async () => {
    const otro = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    falso.cookie.valor = (await emitirSesion(otro)).valor;

    for (const [nombre, accion, datos] of ESCRITURAS) {
      expect((await accion(ESTADO_INICIAL, datos)).tipo, nombre).toBe("error");
    }
    nadieHaEscrito();
  });

  it("ninguna escribe con una cookie caducada", async () => {
    const ayer = new Date(Date.now() - 48 * 60 * 60 * 1000);
    falso.cookie.valor = (await emitirSesion(SECRETO, ayer)).valor;

    for (const [nombre, accion, datos] of ESCRITURAS) {
      expect((await accion(ESTADO_INICIAL, datos)).tipo, nombre).toBe("error");
    }
    nadieHaEscrito();
  });

  /**
   * El caso del despliegue al que se le olvidó la variable. Sin secreto no hay
   * forma de distinguir a nadie, así que no se le abre a nadie: ni con cookie,
   * porque ninguna cookie puede verificar contra un secreto que no existe.
   */
  it("ninguna escribe si no hay secreto configurado", async () => {
    falso.cookie.valor = (await emitirSesion(SECRETO)).valor;
    delete process.env["DASHBOARD_PASSWORD"];

    for (const [nombre, accion, datos] of ESCRITURAS) {
      expect((await accion(ESTADO_INICIAL, datos)).tipo, nombre).toBe("error");
    }
    nadieHaEscrito();
  });

  /**
   * El contrapeso, y no es de adorno: sin él, las cuatro pruebas de arriba
   * pasarían igual si las acciones estuvieran rotas y no escribieran nunca.
   */
  it("con una cookie válida sí escribe", async () => {
    falso.cookie.valor = (await emitirSesion(SECRETO)).valor;

    const estado = await anadirTicker(ESTADO_INICIAL, formulario({ ticker: "ACME" }));

    expect(estado.tipo).toBe("ok");
    expect(falso.anadir).toHaveBeenCalledTimes(1);
    expect(falso.anadir.mock.calls[0]?.[1]).toMatchObject({ ticker: "ACME" });
  });
});
