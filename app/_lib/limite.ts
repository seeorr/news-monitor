/**
 * El límite de intentos de la pantalla de acceso: la política y a quién se cuenta.
 *
 * Puro como `sesion.ts`: sin `process.env`, sin `next/*`, solo Web Crypto. La
 * cuenta vive en Neon (`src/db/intentos-acceso.ts`) porque en Vercel cada
 * petición puede caer en una instancia distinta.
 */
import type { PoliticaIntentos } from "../../src/db/intentos-acceso.ts";

/**
 * 5 fallos en 15 minutos desde una IP la bloquean 15 minutos (decisión de Alberto,
 * 14-09). Solo esa IP: un tope global permitiría cerrarle el acceso a su dueño.
 * Con un secreto de 16 caracteres o más, 5 intentos cada 15 minutos convierten
 * cualquier fuerza bruta en algo que no termina.
 */
export const POLITICA_INTENTOS: PoliticaIntentos = {
  maxFallos: 5,
  ventanaMs: 15 * 60 * 1000,
  bloqueoMs: 15 * 60 * 1000,
};

const CODIFICADOR = new TextEncoder();
const ETIQUETA = "news-monitor/intentos-de-acceso/v1";

/**
 * La IP de quien llama.
 *
 * En Vercel, `x-forwarded-for` lo escribe la plataforma y su primera entrada es el
 * cliente; lo que mande el navegador en esa cabecera se sobrescribe. Fuera de
 * Vercel (local) puede no venir: entonces todos comparten el cubo `desconocida`,
 * que como mucho bloquea a quien prueba claves en su propio portátil.
 *
 * Solo pasan caracteres de IP. Cualquier otra cosa es basura o un intento de
 * meter texto en la base, y cae en el cubo común.
 */
export function ipDeCabeceras(cabeceras: { get(nombre: string): string | null }): string {
  const reenviada = cabeceras.get("x-forwarded-for")?.split(",")[0]?.trim();
  const candidata = reenviada || cabeceras.get("x-real-ip")?.trim() || "";
  return /^[0-9A-Fa-f:.]{2,45}$/.test(candidata) ? candidata : "desconocida";
}

/**
 * Lo que se guarda en lugar de la IP: HMAC-SHA256 con una clave derivada del
 * secreto. Sin clave, un hash de IPv4 se invierte probando las 4.300 millones.
 * La etiqueta separa este uso del de la firma de sesión.
 */
export async function claveCliente(ip: string, secreto: string): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const clave = await subtle.importKey("raw", CODIFICADOR.encode(`${ETIQUETA}:${secreto}`),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const firma = await subtle.sign("HMAC", clave, CODIFICADOR.encode(ip));
  return Array.from(new Uint8Array(firma), (b) => b.toString(16).padStart(2, "0")).join("");
}
