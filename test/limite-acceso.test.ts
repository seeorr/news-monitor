import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COOKIE_SESION, MENSAJE_ACCESO_DENEGADO, VARIABLE_SECRETO } from "../app/_lib/sesion.ts";
import { POLITICA_INTENTOS, claveCliente, cuboDeIp, ipDeCabeceras } from "../app/_lib/limite.ts";
import type { AlmacenIntentos } from "../src/db/intentos-acceso.ts";
import type { Ejecutor } from "../src/db/cliente.ts";

/**
 * El límite de intentos, por la acción de verdad: `entrar()`.
 *
 * Se sustituyen solo las fronteras que no existen fuera de Next (`next/headers`,
 * `next/navigation`) y la base, por la misma semántica en memoria. La cuenta
 * atómica en PostgreSQL se comprueba aparte, con `scripts/verificar-acceso-postgres.ts`.
 */
const entorno = vi.hoisted(() => ({
  cookie: null as string | null,
  ip: "203.0.113.7",
  almacen: null as unknown,
  roto: false,
}));

class Redirigido extends Error {
  constructor(readonly destino: string) { super(`redirect:${destino}`); }
}

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (nombre: string) => nombre === COOKIE_SESION && entorno.cookie ? { name: nombre, value: entorno.cookie } : undefined,
    set: (nombre: string, valor: string) => { if (nombre === COOKIE_SESION) entorno.cookie = valor; },
    delete: () => { entorno.cookie = null; },
  }),
  headers: async () => new Headers({ "x-forwarded-for": `${entorno.ip}, 10.0.0.1` }),
}));
vi.mock("next/navigation", () => ({ redirect: (destino: string) => { throw new Redirigido(destino); } }));
vi.mock("../src/db/intentos-acceso.ts", async (original) => {
  const real = await original<typeof import("../src/db/intentos-acceso.ts")>();
  return {
    ...real,
    almacenNeon: () => {
      const almacen = entorno.almacen as AlmacenIntentos;
      if (!entorno.roto) return almacen;
      return { ...almacen, registrarIntento: async () => { throw new Error("neon caído"); } };
    },
  };
});

const { entrar } = await import("../app/acceso/acciones.ts");
const { ESTADO_INICIAL } = await import("../app/acceso/estado.ts");
const { almacenEnMemoria } = await import("../src/db/intentos-acceso.ts");
const { almacenNeon: almacenNeonReal } = await vi.importActual<typeof import("../src/db/intentos-acceso.ts")>("../src/db/intentos-acceso.ts");

/** Sorteado en cada ejecución: un secreto escrito en un repositorio público es una credencial por defecto. */
const SECRETO = `${crypto.randomUUID()}${crypto.randomUUID()}`;

async function intentar(clave: string): Promise<{ entra: boolean; estado?: unknown }> {
  entorno.cookie = null;
  const datos = new FormData();
  datos.set("clave", clave);
  datos.set("destino", "/");
  try {
    return { entra: false, estado: await entrar(ESTADO_INICIAL, datos) };
  } catch (error: unknown) {
    if (error instanceof Redirigido) return { entra: true };
    throw error;
  }
}

beforeEach(() => {
  entorno.ip = "203.0.113.7";
  entorno.roto = false;
  entorno.almacen = almacenEnMemoria(POLITICA_INTENTOS);
  process.env[VARIABLE_SECRETO] = SECRETO;
  process.env["DATABASE_URL"] = "postgres://nadie@ninguna-parte/db";
});

afterEach(() => {
  delete process.env[VARIABLE_SECRETO];
  delete process.env["DATABASE_URL"];
  vi.useRealTimers();
});

describe("límite de intentos del acceso al dashboard", () => {
  it("cuatro fallos no bloquean, y un acierto pone la cuenta a cero", async () => {
    for (let i = 0; i < 4; i++) expect((await intentar("no-es-la-clave")).entra).toBe(false);
    expect((await intentar(SECRETO)).entra).toBe(true);
    // Si el acierto no limpiara, estos cuatro harían ocho y el siguiente no entraría.
    for (let i = 0; i < 4; i++) expect((await intentar("no-es-la-clave")).entra).toBe(false);
    expect((await intentar(SECRETO)).entra).toBe(true);
  });

  it("el quinto fallo bloquea esa IP: ni la clave buena entra, y el mensaje es el mismo", async () => {
    let denegado: unknown;
    for (let i = 0; i < 5; i++) denegado = (await intentar("no-es-la-clave")).estado;
    const bloqueado = await intentar(SECRETO);
    expect(bloqueado.entra).toBe(false);
    expect(bloqueado.estado).toEqual(denegado);
    expect(bloqueado.estado).toEqual({ tipo: "error", mensaje: MENSAJE_ACCESO_DENEGADO });
    expect(entorno.cookie).toBeNull();
  });

  it("mientras dura el bloqueo no se cuentan más intentos ni se alarga", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-14T18:00:00Z"));
    const almacen = entorno.almacen as AlmacenIntentos;
    for (let i = 0; i < 5; i++) await intentar("no-es-la-clave");
    const hasta = await almacen.bloqueadoHasta(await claveCliente(entorno.ip, SECRETO), new Date());
    vi.setSystemTime(new Date("2026-09-14T18:10:00Z"));
    const denegado = await almacen.registrarIntento(await claveCliente(entorno.ip, SECRETO), new Date());
    expect(denegado).toEqual({ permitido: false, fallos: null, bloqueadoHasta: hasta });
    await intentar(SECRETO);
    expect(await almacen.bloqueadoHasta(await claveCliente(entorno.ip, SECRETO), new Date())).toEqual(hasta);
  });

  it("una ráfaga en paralelo solo evalúa cinco claves: el intento se cuenta antes de mirar la clave", async () => {
    const lentas = entorno.almacen as AlmacenIntentos;
    // Cada consulta cede el turno, como una base de verdad: sin contar por
    // adelantado, las cincuenta pasaban la comprobación antes de anotar nada.
    entorno.almacen = {
      bloqueadoHasta: async (...a: Parameters<AlmacenIntentos["bloqueadoHasta"]>) => { await new Promise((r) => setTimeout(r, 1)); return lentas.bloqueadoHasta(...a); },
      registrarIntento: async (...a: Parameters<AlmacenIntentos["registrarIntento"]>) => lentas.registrarIntento(...a),
      limpiar: async (...a: Parameters<AlmacenIntentos["limpiar"]>) => lentas.limpiar(...a),
    } satisfies AlmacenIntentos;
    const evaluada = vi.spyOn(await import("../app/_lib/sesion.ts"), "contrasenaValida");
    await Promise.all(Array.from({ length: 50 }, () => intentar("no-es-la-clave")));
    expect((await intentar(SECRETO)).entra).toBe(false);
    expect(evaluada.mock.calls).toHaveLength(5);
    evaluada.mockRestore();
  });

  it("otra IP no queda bloqueada: nadie puede dejar fuera al dueño desde otra conexión", async () => {
    for (let i = 0; i < 5; i++) await intentar("no-es-la-clave");
    entorno.ip = "198.51.100.20";
    expect((await intentar(SECRETO)).entra).toBe(true);
  });

  it("el bloqueo vence a los 15 minutos", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-14T18:00:00Z"));
    for (let i = 0; i < 5; i++) await intentar("no-es-la-clave");
    vi.setSystemTime(new Date("2026-09-14T18:14:59Z"));
    expect((await intentar(SECRETO)).entra).toBe(false);
    vi.setSystemTime(new Date("2026-09-14T18:15:01Z"));
    expect((await intentar(SECRETO)).entra).toBe(true);
  });

  it("sin DATABASE_URL o con Neon caído no se entra: falla cerrado", async () => {
    delete process.env["DATABASE_URL"];
    expect((await intentar(SECRETO)).entra).toBe(false);
    process.env["DATABASE_URL"] = "postgres://nadie@ninguna-parte/db";
    entorno.roto = true;
    expect((await intentar(SECRETO)).entra).toBe(false);
  });
});

describe("a quién se cuenta", () => {
  it("la clave de cliente es un HMAC: no contiene la IP y cambia con el secreto", async () => {
    const a = await claveCliente("203.0.113.7", SECRETO);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toContain("203.0.113.7");
    expect(await claveCliente("203.0.113.7", SECRETO)).toBe(a);
    expect(await claveCliente("203.0.113.8", SECRETO)).not.toBe(a);
    expect(await claveCliente("203.0.113.7", `${SECRETO}x`)).not.toBe(a);
  });

  it("una IPv6 se cuenta por su /64: cambiar la dirección dentro del prefijo no da intentos nuevos", async () => {
    expect(cuboDeIp("198.51.100.4")).toBe("198.51.100.4");
    expect(cuboDeIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd")).toBe("2001:0db8:0001:0002::/64");
    expect(cuboDeIp("2001:DB8:1:2::1")).toBe("2001:0db8:0001:0002::/64");
    expect(cuboDeIp("2001:db8::1")).toBe("2001:0db8:0000:0000::/64");
    expect(cuboDeIp("::1")).toBe("0000:0000:0000:0000::/64");
    expect(cuboDeIp("::ffff:198.51.100.4")).toBe("198.51.100.4");
    expect(cuboDeIp("1:2:3")).toBe("desconocida");
    expect(cuboDeIp("1::2::3")).toBe("desconocida");
    expect(await claveCliente("2001:db8:1:2::1", SECRETO)).toBe(await claveCliente("2001:db8:1:2:ffff::9", SECRETO));
    expect(await claveCliente("2001:db8:1:2::1", SECRETO)).not.toBe(await claveCliente("2001:db8:1:3::1", SECRETO));
  });

  it("toma la primera IP de x-forwarded-for y manda la basura al cubo común", () => {
    expect(ipDeCabeceras(new Headers({ "x-forwarded-for": "198.51.100.4, 10.0.0.1" }))).toBe("198.51.100.4");
    expect(ipDeCabeceras(new Headers({ "x-forwarded-for": "2001:db8::1" }))).toBe("2001:db8::1");
    expect(ipDeCabeceras(new Headers({ "x-real-ip": "198.51.100.9" }))).toBe("198.51.100.9");
    expect(ipDeCabeceras(new Headers({ "x-forwarded-for": "<script>alert(1)</script>" }))).toBe("desconocida");
    expect(ipDeCabeceras(new Headers())).toBe("desconocida");
  });

  it("Neon: consultas parametrizadas, cuenta en un solo insert y ninguna IP en los parámetros", async () => {
    const consultas: string[] = [], parametros: unknown[][] = [];
    const sql: Ejecutor = async (partes, ...valores) => {
      const texto = partes.join("?");
      consultas.push(texto); parametros.push(valores);
      return texto.includes("insert into") ? [{ failures: 5, blocked_until: "2026-09-14T18:20:00.000Z" }] : [];
    };
    const resultado = await almacenNeonReal(sql, POLITICA_INTENTOS).registrarIntento("clave-hmac", new Date("2026-09-14T18:05:00Z"));
    expect(resultado).toEqual({ permitido: true, fallos: 5, bloqueadoHasta: new Date("2026-09-14T18:20:00.000Z") });
    expect(consultas[1]).toMatch(/on conflict \(client_key\) do update/);
    // Con un bloqueo vigente el upsert no toca la fila: la condición va en el propio `do update`.
    expect(consultas[1]).toMatch(/where a\.blocked_until is null or a\.blocked_until <= /);
    expect(parametros[1]).toContain("clave-hmac");
    expect(JSON.stringify(parametros)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});
