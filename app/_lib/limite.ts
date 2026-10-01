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
 * A quién se cuenta: una IPv4 entera, pero una IPv6 por su prefijo /64.
 *
 * Una conexión doméstica o un VPS normal reciben un /64 entero —dieciocho
 * trillones de direcciones— y quien controla ese prefijo elige la de cada
 * petición. Contar por dirección suelta le daba cinco intentos nuevos en cada
 * una: el límite no frenaba nada por IPv6. El /64 es la unidad que un
 * proveedor asigna a un cliente, así que es la que se cuenta.
 *
 * Una IPv4 mapeada (`::ffff:198.51.100.4`) es esa IPv4, y se cuenta como tal.
 * Lo que no se pueda expandir va al cubo común.
 */
export function cuboDeIp(ip: string): string {
  if (!ip.includes(":")) return ip;
  const mapeada = /^(?:0{0,4}:){0,5}:?ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapeada) return mapeada[1]!;
  const partes = ip.toLowerCase().split("::");
  if (partes.length > 2) return "desconocida";
  const trozos = (texto: string | undefined) => (texto ? texto.split(":") : []);
  const izquierda = trozos(partes[0]), derecha = trozos(partes[1]);
  const faltan = 8 - izquierda.length - derecha.length;
  if (partes.length === 1 ? faltan !== 0 : faltan < 1) return "desconocida";
  const grupos = [...izquierda, ...Array<string>(partes.length === 1 ? 0 : faltan).fill("0"), ...derecha];
  if (!grupos.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return "desconocida";
  return `${grupos.slice(0, 4).map((g) => g.padStart(4, "0")).join(":")}::/64`;
}

/**
 * Lo que se guarda en lugar de la IP (de su cubo, ver `cuboDeIp`): HMAC-SHA256
 * con una clave derivada del secreto. Sin clave, un hash de IPv4 se invierte
 * probando las 4.300 millones.
 * La etiqueta separa este uso del de la firma de sesión.
 */
export async function claveCliente(ip: string, secreto: string): Promise<string> {
  const subtle = globalThis.crypto.subtle;
  const clave = await subtle.importKey("raw", CODIFICADOR.encode(`${ETIQUETA}:${secreto}`),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const firma = await subtle.sign("HMAC", clave, CODIFICADOR.encode(cuboDeIp(ip)));
  return Array.from(new Uint8Array(firma), (b) => b.toString(16).padStart(2, "0")).join("");
}
