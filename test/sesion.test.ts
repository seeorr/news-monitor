import { describe, expect, it } from "vitest";
import {
  DURACION_SESION_MS,
  contrasenaValida,
  decidir,
  destinoSeguro,
  emitirSesion,
  esRutaPublica,
  secretoUtilizable,
  verificarSesion,
} from "../app/_lib/sesion.ts";

/**
 * Los secretos de estas pruebas se sortean en cada ejecución.
 *
 * No es una floritura: un secreto escrito en el repositorio —aunque sea
 * de mentira, aunque diga "cambiar esto"— es una credencial por defecto en un
 * repositorio público, y esas acaban probadas contra el despliegue de verdad.
 * Sorteándolo se prueba lo mismo y no queda nada que probar contra nada.
 */
const secreto = () => `${crypto.randomUUID()}${crypto.randomUUID()}`;

const AHORA = new Date("2026-09-10T09:00:00Z");

describe("la cookie de sesión", () => {
  it("verifica con el secreto que la firmó", async () => {
    const s = secreto();
    const { valor } = await emitirSesion(s, AHORA);
    expect((await verificarSesion(valor, s, AHORA)).valido).toBe(true);
  });

  it("no verifica con otro secreto", async () => {
    const { valor } = await emitirSesion(secreto(), AHORA);
    const otra = await verificarSesion(valor, secreto(), AHORA);
    expect(otra).toEqual({ valido: false, motivo: "firma" });
  });

  it("no verifica si se le toca un solo carácter a la firma", async () => {
    const s = secreto();
    const { valor } = await emitirSesion(s, AHORA);
    const [version, caducidad, firma] = valor.split(".") as [string, string, string];
    const tocada = `${firma.slice(0, -1)}${firma.endsWith("0") ? "1" : "0"}`;

    const r = await verificarSesion(`${version}.${caducidad}.${tocada}`, s, AHORA);
    expect(r).toEqual({ valido: false, motivo: "firma" });
  });

  /**
   * El test que justifica el formato: si la caducidad no viajara **dentro** de
   * lo firmado, esta línea alargaría la sesión un año con sólo editar la cookie
   * en el navegador, y el servidor no tendría cómo notarlo.
   */
  it("no deja estirar la caducidad sin volver a firmar", async () => {
    const s = secreto();
    const { valor } = await emitirSesion(s, AHORA);
    const [version, caducidad, firma] = valor.split(".") as [string, string, string];
    const dentroDeUnAno = String(Number(caducidad) + 365 * 24 * 3600);

    const r = await verificarSesion(`${version}.${dentroDeUnAno}.${firma}`, s, AHORA);
    expect(r).toEqual({ valido: false, motivo: "firma" });
  });

  it("caduca por su cuenta aunque la firma siga siendo buena", async () => {
    const s = secreto();
    const { valor } = await emitirSesion(s, AHORA);
    const tarde = new Date(AHORA.getTime() + DURACION_SESION_MS + 1000);

    expect(await verificarSesion(valor, s, tarde)).toEqual({ valido: false, motivo: "caducada" });
  });

  it("una cookie ausente o con cualquier otra forma no verifica", async () => {
    const s = secreto();
    expect(await verificarSesion(null, s, AHORA)).toEqual({ valido: false, motivo: "ausente" });
    expect(await verificarSesion("", s, AHORA)).toEqual({ valido: false, motivo: "ausente" });
    expect(await verificarSesion("cualquier-cosa", s, AHORA)).toEqual({
      valido: false,
      motivo: "malformada",
    });
    expect(await verificarSesion("v2.1780000000.aa", s, AHORA)).toEqual({
      valido: false,
      motivo: "malformada",
    });
  });
});

describe("la clave", () => {
  it("acepta la buena y rechaza cualquier otra, mida lo que mida", async () => {
    const s = secreto();
    expect(await contrasenaValida(s, s)).toBe(true);
    expect(await contrasenaValida(`${s}x`, s)).toBe(false);
    expect(await contrasenaValida(s.slice(0, -1), s)).toBe(false);
    expect(await contrasenaValida("", s)).toBe(false);
    expect(await contrasenaValida(secreto(), s)).toBe(false);
  });

  it("un secreto corto o ausente no es un secreto", () => {
    expect(secretoUtilizable(null)).toBe(false);
    expect(secretoUtilizable("")).toBe(false);
    expect(secretoUtilizable("corto")).toBe(false);
    expect(secretoUtilizable(secreto())).toBe(true);
  });
});

describe("qué es público", () => {
  it("sólo la pantalla de acceso", () => {
    expect(esRutaPublica("/acceso")).toBe(true);
    expect(esRutaPublica("/acceso/")).toBe(true);

    for (const ruta of ["/", "/alerts", "/news", "/watchlist", "/calendar", "/settings"]) {
      expect(esRutaPublica(ruta)).toBe(false);
    }
    // Una ruta que todavía no existe nace privada: la lista blanca es la
    // excepción, no la regla.
    expect(esRutaPublica("/informes/2026-09")).toBe(false);
    expect(esRutaPublica("/accesorios")).toBe(false);
  });
});

describe("a dónde se vuelve después de entrar", () => {
  it("sólo a rutas de esta aplicación", () => {
    expect(destinoSeguro("/watchlist")).toBe("/watchlist");
    expect(destinoSeguro("/calendar?q=1")).toBe("/calendar?q=1");
  });

  it("no se convierte en un redirector abierto", () => {
    expect(destinoSeguro("//otro.example/phishing")).toBe("/");
    expect(destinoSeguro("https://otro.example")).toBe("/");
    expect(destinoSeguro("/\\otro.example")).toBe("/");
    expect(destinoSeguro("/watchlist\nLocation: https://otro.example")).toBe("/");
    expect(destinoSeguro(null)).toBe("/");
    // Volver al acceso desde el acceso es un bucle.
    expect(destinoSeguro("/acceso")).toBe("/");
    expect(destinoSeguro("/acceso?destino=/acceso")).toBe("/");
  });
});

describe("la decisión de la puerta", () => {
  const base = { metodo: "GET", cookie: null, ahora: AHORA };

  it("sin secreto configurado no se sirve nada, ni siquiera el acceso", async () => {
    for (const pathname of ["/", "/watchlist", "/acceso"]) {
      expect(await decidir({ ...base, pathname, secreto: null })).toEqual({ tipo: "sin-configurar" });
    }
    // Un secreto demasiado corto cuenta como no configurado: fallar cerrado es
    // mejor que servirse con una clave que se adivina.
    expect(await decidir({ ...base, pathname: "/", secreto: "corto" })).toEqual({
      tipo: "sin-configurar",
    });
  });

  it("la pantalla de acceso pasa sin cookie", async () => {
    expect(await decidir({ ...base, pathname: "/acceso", secreto: secreto() })).toEqual({
      tipo: "pasa",
    });
  });

  it("cualquier página privada sin cookie manda al acceso, con su destino", async () => {
    const s = secreto();
    expect(await decidir({ ...base, pathname: "/watchlist", secreto: s })).toEqual({
      tipo: "a-acceso",
      destino: "/watchlist",
      caducada: false,
    });
    // Incluida una que hoy no existe.
    expect(await decidir({ ...base, pathname: "/informes/2026-09", secreto: s })).toEqual({
      tipo: "a-acceso",
      destino: "/informes/2026-09",
      caducada: false,
    });
  });

  it("con cookie válida se pasa, y se pasa también a escribir", async () => {
    const s = secreto();
    const { valor } = await emitirSesion(s, AHORA);
    expect(await decidir({ ...base, pathname: "/watchlist", cookie: valor, secreto: s })).toEqual({
      tipo: "pasa",
    });
    expect(
      await decidir({ ...base, pathname: "/watchlist", metodo: "POST", cookie: valor, secreto: s }),
    ).toEqual({ tipo: "pasa" });
  });

  /**
   * Una acción de servidor es un POST a la ruta de su página. Se bloquea, y se
   * bloquea **sin redirigir**: la respuesta la lee React, y devolverle el HTML
   * de la pantalla de acceso es lo que hace que un formulario se rompa sin decir
   * si guardó o no.
   */
  it("una escritura sin cookie se bloquea y no se redirige", async () => {
    const s = secreto();
    for (const metodo of ["POST", "PUT", "DELETE"]) {
      expect(await decidir({ ...base, pathname: "/watchlist", metodo, secreto: s })).toEqual({
        tipo: "bloquea-escritura",
      });
    }
  });

  it("una cookie caducada manda al acceso diciendo que caducó", async () => {
    const s = secreto();
    const { valor } = await emitirSesion(s, AHORA);
    const tarde = new Date(AHORA.getTime() + DURACION_SESION_MS + 1000);

    expect(
      await decidir({ pathname: "/news", metodo: "GET", cookie: valor, secreto: s, ahora: tarde }),
    ).toEqual({ tipo: "a-acceso", destino: "/news", caducada: true });
  });

  it("una cookie firmada con otro secreto es una cookie sin sesión", async () => {
    const { valor } = await emitirSesion(secreto(), AHORA);
    expect(await decidir({ ...base, pathname: "/", cookie: valor, secreto: secreto() })).toEqual({
      tipo: "a-acceso",
      destino: "/",
      caducada: false,
    });
  });
});
