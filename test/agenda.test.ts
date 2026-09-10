import { describe, expect, it } from "vitest";
import fixture from "./fixtures/fred-agenda.json" with { type: "json" };
import {
  agendaEvent,
  formatAgenda,
  parseAgenda,
  sumarDias,
  RELEASES,
} from "../src/sources/calendario.ts";
import { NormalizedEvent } from "../src/schema/event.ts";
import { parseAgendaArgs, runAgendaCli } from "../src/agenda.ts";
import { memorySeenStore, type EstadoEntrega } from "../src/pipeline/seen.ts";

/** La ventana real de la respuesta guardada: 8 al 18 de septiembre de 2026. */
const opts = { desde: "2026-09-08", dias: 10 };
const citas = parseAgenda(fixture, opts);

describe("agenda macro", () => {
  it("saca las citas de verdad de la ventana", () => {
    const porFecha = citas.map((c) => `${c.date} ${c.title}`);
    expect(porFecha).toContain("2026-09-11 IPC de Estados Unidos");
    expect(porFecha).toContain("2026-09-10 Precios de producción (PPI)");
    expect(porFecha).toContain("2026-09-16 Ventas minoristas");
  });

  // Las peticiones de desempleo son semanales: dos jueves en once días.
  it("no se come las citas que se repiten cada semana", () => {
    const paro = citas.filter((c) => c.releaseId === 180).map((c) => c.date);
    expect(paro).toEqual(["2026-09-10", "2026-09-17"]);
  });

  // El caso que estropea una agenda: FRED marca el comunicado del FOMC y los
  // tipos del BCE como publicación de TODOS los días. Anunciarlos a diario es
  // peor que no tener agenda. Sus decisiones ya entran por los feeds de prensa.
  it("descarta lo que aparece casi a diario: no es una cita, es una serie", () => {
    expect(citas.some((c) => c.releaseId === 101)).toBe(false);
    expect(citas.some((c) => c.releaseId === 484)).toBe(false);
  });

  it("ignora las publicaciones que no están en el registro", () => {
    for (const c of citas) expect(RELEASES[c.releaseId]).toBeDefined();
  });

  it("devuelve las citas ordenadas por fecha", () => {
    const fechas = citas.map((c) => c.date);
    expect([...fechas].sort()).toEqual(fechas);
  });

  it("no inventa citas fuera de la ventana", () => {
    for (const c of citas) {
      expect(c.date >= opts.desde).toBe(true);
      expect(c.date <= "2026-09-18").toBe(true);
    }
  });
});

describe("mensaje de la agenda", () => {
  const texto = formatAgenda(citas, opts);

  it("agrupa por día y solo enseña los días con algo", () => {
    expect(texto).toContain("vie 11 sep — 🇺🇸 IPC de Estados Unidos");
    expect(texto).not.toContain("nada previsto");
  });

  // FRED publica el día, no la hora. Decirlo evita la pregunta y evita que
  // alguien —modelo o persona— rellene el hueco con una hora plausible.
  it("declara que no hay hora en vez de inventarse una", () => {
    expect(texto).toContain("FRED publica la fecha, no la hora");
    expect(texto).not.toMatch(/\d{1,2}:\d{2}/);
  });

  it("dice claramente cuando no hay nada", () => {
    expect(formatAgenda([], opts)).toContain("Sin publicaciones relevantes");
  });
});

describe("la agenda como evento", () => {
  const event = agendaEvent(citas, { ...opts, retrievedAt: "2026-09-08T06:30:00.000Z" });

  it("cumple el contrato y se identifica por su día", () => {
    expect(() => NormalizedEvent.parse(event)).not.toThrow();
    expect(event.id).toBe("fred:agenda:2026-09-08");
    expect(event.kind).toBe("calendar");
  });

  it("no lleva cifras: es una lista de fechas", () => {
    expect(event.actual).toBeNull();
    expect(event.surprises).toEqual([]);
  });
});

describe("aritmética de días", () => {
  it("suma días sin que el cambio de hora la despiste", () => {
    expect(sumarDias("2026-09-08", 7)).toBe("2026-09-15");
    expect(sumarDias("2026-10-24", 7)).toBe("2026-10-31"); // cambio de hora en Europa
    expect(sumarDias("2026-12-28", 7)).toBe("2027-01-04"); // cambio de año
  });
});

/**
 * La entrega de la agenda, exactamente una vez.
 *
 * Arrastraba el mismo defecto que la alerta: se mandaba a Telegram y **después**
 * se registraba, así que morir entre los dos pasos hacía que el reintento de
 * GitHub mandara la misma lista otra vez. La regla que se fija aquí es la misma:
 * dos ejecuciones contra el mismo estado no producen dos mensajes.
 */
describe("entrega de la agenda", () => {
  const ahora = new Date("2026-09-08T06:30:00.000Z");
  const idDeHoy = agendaEvent(citas, { desde: "2026-09-08", dias: 7, retrievedAt: "x" }).id;

  interface Escenario {
    seen: ReturnType<typeof memorySeenStore>;
    envios: string[];
    orden: string[];
    lineas: string[];
    correr: (args?: string[], romperRegistro?: boolean) => Promise<number>;
  }

  /** Un estado compartido por varias ejecuciones, como el de un cron que repite. */
  function escenario(estado: EstadoEntrega = "sent"): Escenario {
    const seen = memorySeenStore();
    const envios: string[] = [];
    const orden: string[] = [];
    const lineas: string[] = [];
    const claimAlert = seen.claimAlert.bind(seen);
    seen.claimAlert = async (id, reclamo) => {
      orden.push("claim");
      return claimAlert(id, reclamo);
    };
    return {
      seen, envios, orden, lineas,
      correr: (args = [], romperRegistro = false) => {
        const guardar = seen.saveAlert.bind(seen);
        return runAgendaCli(args, {
          dias: 7,
          citas: async () => citas,
          seen: {
            ...seen,
            // Matar el proceso justo entre el envío y el registro es el caso que
            // este módulo existe para sobrevivir.
            saveAlert: romperRegistro
              ? async () => { throw new Error("neon_caido"); }
              : guardar,
          },
          send: async (body) => {
            orden.push("send");
            envios.push(body);
            if (estado === "uncertain") throw new Error("socket_cortado");
            return estado;
          },
          now: ahora,
          token: () => "t" + orden.length,
          log: (line) => lineas.push(line),
        });
      },
    };
  }

  it("reclama antes de enviar, y cierra después", async () => {
    const e = escenario();
    expect(await e.correr()).toBe(0);
    expect(e.orden).toEqual(["claim", "send"]);
    expect(e.seen.entregas.get(idDeHoy)?.estado).toBe("sent");
    expect(e.seen.alerts).toHaveLength(1);
  });

  // El caso que importa: el proceso muere después de que Telegram acepte.
  it("no reenvía la agenda si el registro se cayó tras el envío", async () => {
    const e = escenario();
    expect(await e.correr([], true)).toBe(1);
    expect(e.envios).toHaveLength(1);
    // Sin cerrar, y nadie la libera: es preferible a repetirla.
    expect(e.seen.entregas.get(idDeHoy)?.estado).toBe("sending");

    expect(await e.correr()).toBe(1); // La vuelta siguiente encuentra el reclamo.
    expect(e.envios).toHaveLength(1);
  });

  it("una entrega en duda no se reintenta sola", async () => {
    const e = escenario("uncertain");
    expect(await e.correr()).toBe(1);
    expect(e.seen.entregas.get(idDeHoy)?.estado).toBe("uncertain");
    expect(e.seen.alerts).toHaveLength(0); // `alerts` es lo que de verdad salió.

    expect(await e.correr()).toBe(1);
    expect(e.envios).toHaveLength(1);
  });

  it("el rechazo se cierra como rechazo y no imprime el detalle de Telegram", async () => {
    const e = escenario("rejected");
    expect(await e.correr()).toBe(1);
    expect(e.seen.entregas.get(idDeHoy)?.estado).toBe("rejected");
    expect(e.lineas.join("\n")).toContain("rejected");
  });

  it("--force reenvía cuando una persona lo decide", async () => {
    const e = escenario();
    expect(await e.correr()).toBe(0);
    expect(await e.correr(["--force"])).toBe(0);
    expect(e.envios).toHaveLength(2);
  });

  // Un --dry que reclamara dejaría la entrega del día en vuelo, y la ejecución de
  // verdad se encontraría la puerta cerrada por su propio ensayo.
  it("--dry no reclama, no marca y no envía", async () => {
    const e = escenario();
    expect(await e.correr(["--dry"])).toBe(0);
    expect(e.orden).toEqual([]);
    expect(e.seen.entregas.size).toBe(0);
    expect(await e.seen.has(idDeHoy)).toBe(false);
  });

  it("la agenda de un día que ya se envió no se reclama siquiera", async () => {
    const seen = memorySeenStore([idDeHoy]);
    const envios: string[] = [];
    const code = await runAgendaCli([], {
      dias: 7, citas: async () => citas, seen,
      send: async (body) => { envios.push(body); return "sent"; },
      now: ahora, token: () => "t", log: () => {},
    });
    expect(code).toBe(0);
    expect(envios).toEqual([]);
    expect(seen.entregas.size).toBe(0);
  });

  it("sin credenciales de Telegram compone y no reclama", async () => {
    const seen = memorySeenStore();
    const code = await runAgendaCli([], {
      dias: 7, citas: async () => citas, seen,
      now: ahora, token: () => "t", log: () => {},
    });
    expect(code).toBe(1);
    expect(seen.entregas.size).toBe(0);
  });

  it("sin FRED no hay calendario, y se dice", async () => {
    const lineas: string[] = [];
    const code = await runAgendaCli([], {
      dias: 7, seen: memorySeenStore(), now: ahora, token: () => "t",
      log: (l) => lineas.push(l),
    });
    expect(code).toBe(1);
    expect(lineas.join("\n")).toContain("FRED_API_KEY");
  });

  it("una bandera que no existe no se traga en silencio", () => {
    expect(() => parseAgendaArgs(["--send"])).toThrow("invalid_flags");
    expect(parseAgendaArgs(["--dry", "--force"])).toEqual({ dry: true, force: true });
  });
});
