import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  COOKIE_SESION,
  LONGITUD_MINIMA_SECRETO,
  VARIABLE_SECRETO,
  decidir,
  secretoUtilizable,
} from "../app/_lib/sesion.ts";

/**
 * **Un solo secreto efectivo para las tres puertas.**
 *
 * El proxy verifica la cookie, el login la firma y `haySesion()` la vuelve a
 * verificar dentro de cada escritura. Los tres leen la misma variable de
 * entorno, así que los tres tienen que leerla **igual**. Si uno recorta y otro
 * no, un valor pegado en Vercel con un salto de línea al final deriva dos claves
 * HMAC distintas: se entra, se firma con una, se verifica con la otra, y el
 * resultado es un bucle de acceso que en local no se reproduce nunca porque en
 * local el `.env` no lleva el salto.
 *
 * Estas pruebas recorren el camino entero —variable de entorno, `entrar()`,
 * cookie, `decidir()`, `haySesion()`— con el valor sucio que llega de un panel
 * de despliegue, que es el único sitio donde el fallo aparece.
 */

/** Un tarro de cookies que se comporta como el de Next: lo que se escribe se lee. */
const tarro = vi.hoisted(() => ({ valor: null as string | null }));

/** `redirect()` de Next corta la ejecución lanzando. Aquí se imita para poder mirarlo. */
class Redirigido extends Error {
  constructor(readonly destino: string) {
    super(`redirect:${destino}`);
  }
}

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (nombre: string) =>
      nombre === COOKIE_SESION && tarro.valor !== null
        ? { name: nombre, value: tarro.valor }
        : undefined,
    set: (nombre: string, valor: string) => {
      if (nombre === COOKIE_SESION) tarro.valor = valor;
    },
    delete: (nombre: string) => {
      if (nombre === COOKIE_SESION) tarro.valor = null;
    },
  }),
  headers: async () => new Headers({ "x-forwarded-for": "203.0.113.7" }),
}));

// El login cuenta intentos en Neon; aquí basta la misma semántica en memoria.
vi.mock("../src/db/intentos-acceso.ts", async (original) => {
  const real = await original<typeof import("../src/db/intentos-acceso.ts")>();
  return { ...real, almacenNeon: (_sql: unknown, politica: import("../src/db/intentos-acceso.ts").PoliticaIntentos) => real.almacenEnMemoria(politica) };
});

vi.mock("next/navigation", () => ({
  redirect: (destino: string) => {
    throw new Redirigido(destino);
  },
}));

const { entrar } = await import("../app/acceso/acciones.ts");
const { haySesion, secretoDeAcceso } = await import("../app/_lib/guardia.ts");
const { ESTADO_INICIAL } = await import("../app/acceso/estado.ts");

/** Sorteado en cada ejecución: un secreto escrito en un repositorio público es una credencial por defecto. */
const secreto = () => `${crypto.randomUUID()}${crypto.randomUUID()}`;

function formulario(campos: Record<string, string>): FormData {
  const datos = new FormData();
  for (const [k, v] of Object.entries(campos)) datos.set(k, v);
  return datos;
}

/** Entra de verdad, por la acción de servidor, y devuelve la cookie que quedó puesta. */
async function entrarCon(clave: string): Promise<string | null> {
  try {
    await entrar(ESTADO_INICIAL, formulario({ clave, destino: "/watchlist" }));
  } catch (error: unknown) {
    if (!(error instanceof Redirigido)) throw error;
  }
  return tarro.valor;
}

beforeEach(() => {
  tarro.valor = null;
  delete process.env[VARIABLE_SECRETO];
  process.env["DATABASE_URL"] = "postgres://nadie@ninguna-parte/db";
});

afterEach(() => {
  delete process.env[VARIABLE_SECRETO];
  delete process.env["DATABASE_URL"];
});

describe("el secreto que llega con un salto de línea pegado", () => {
  it("firma y verifica con el mismo valor en el login, en el proxy y en la acción", async () => {
    const limpio = secreto();
    // Exactamente lo que deja el panel de Vercel al pegar el valor con el ratón.
    process.env[VARIABLE_SECRETO] = `${limpio}\n`;

    // Se teclea la clave tal y como la conoce quien la puso: sin el salto.
    const cookie = await entrarCon(limpio);
    expect(cookie, "el login no ha llegado a emitir cookie").not.toBeNull();

    // El proxy lee la variable **cruda**, que es lo que le da el runtime.
    expect(
      await decidir({
        pathname: "/watchlist",
        metodo: "GET",
        cookie,
        secreto: process.env[VARIABLE_SECRETO] ?? null,
      }),
    ).toEqual({ tipo: "pasa" });

    // Y la escritura vuelve a comprobarla por su cuenta.
    expect(await haySesion()).toBe(true);
  });

  it("el proxy no manda al acceso una cookie que el propio login acaba de emitir", async () => {
    const limpio = secreto();
    process.env[VARIABLE_SECRETO] = `  ${limpio}  `;

    const cookie = await entrarCon(limpio);
    const decision = await decidir({
      pathname: "/",
      metodo: "GET",
      cookie,
      secreto: process.env[VARIABLE_SECRETO] ?? null,
    });

    // El bucle: entra bien, y en la siguiente navegación vuelve al formulario.
    expect(decision.tipo).not.toBe("a-acceso");
  });
});

describe("cuándo se considera configurado el despliegue", () => {
  /**
   * `LONGITUD_MINIMA_SECRETO` medida sobre el valor crudo o sobre el recortado
   * da respuestas distintas justo en el borde, y entonces el proxy sirve el
   * formulario mientras el login deniega siempre: una pantalla que no puede
   * aceptar nada, que es el caso que `decidir()` dice que quiere evitar.
   */
  it("el borde exacto se mide igual en las dos puertas", async () => {
    const justo = "a".repeat(LONGITUD_MINIMA_SECRETO - 1);
    process.env[VARIABLE_SECRETO] = `${justo}\n`;

    // Crudo mide el mínimo; recortado se queda uno por debajo. Tiene que mandar
    // el recortado, que es el que se teclea.
    expect(secretoUtilizable(process.env[VARIABLE_SECRETO])).toBe(false);
    expect(secretoDeAcceso()).toBe(justo);

    expect(
      await decidir({
        pathname: "/",
        metodo: "GET",
        cookie: null,
        secreto: process.env[VARIABLE_SECRETO] ?? null,
      }),
    ).toEqual({ tipo: "sin-configurar" });

    // Y el login tampoco abre: las dos puertas dicen lo mismo.
    expect(await entrarCon(justo)).toBeNull();
  });

  it("una variable de solo espacios es una variable ausente", async () => {
    process.env[VARIABLE_SECRETO] = "               \n\t  ";
    expect(secretoDeAcceso()).toBeNull();
    expect(
      await decidir({
        pathname: "/acceso",
        metodo: "GET",
        cookie: null,
        secreto: process.env[VARIABLE_SECRETO] ?? null,
      }),
    ).toEqual({ tipo: "sin-configurar" });
  });
});
