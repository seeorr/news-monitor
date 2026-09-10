/**
 * La sesión del dashboard: emitirla, verificarla y decidir quién pasa.
 *
 * Por qué existe este archivo y no se usa la protección de Vercel: en el plan
 * Hobby, Vercel Authentication deja **público el dominio de producción**. Este
 * dashboard enseña qué empresas se vigilan, con qué umbral y qué se ha
 * anunciado, que es dato personal. Si la puerta no está dentro de la aplicación,
 * no hay puerta.
 *
 * El módulo es **puro a propósito**: no lee `process.env`, no importa nada de
 * `next/*` y no toca cookies. Sólo Web Crypto, que existe igual en el runtime de
 * Node y en el edge. Eso es lo que permite que la decisión del proxy y la
 * comprobación de dentro de las acciones sean literalmente el mismo código, y
 * que se pueda probar sin levantar un navegador.
 */

const CODIFICADOR = new TextEncoder();

/** Nombre de la cookie. Sin prefijo `__Host-` porque `path` y `domain` ya se fijan aquí. */
export const COOKIE_SESION = "nm_sesion";

/**
 * Doce horas. Es un compromiso: más corto obliga a teclear la clave a media
 * mañana y a media tarde; más largo deja una sesión viva en un portátil que se
 * queda abierto. Se puede acortar sin tocar nada más: la caducidad viaja firmada
 * dentro de la cookie, así que cambiarla no invalida el formato.
 */
export const DURACION_SESION_MS = 12 * 60 * 60 * 1000;

export const RUTA_ACCESO = "/acceso";

/**
 * Longitud mínima del secreto. No es burocracia: la pantalla de acceso está en
 * una URL pública y no hay limitador de intentos gratuito en Hobby, así que lo
 * único que separa el dashboard de una fuerza bruta es el tamaño del secreto.
 * Por debajo de esto el sistema se considera **sin configurar** y no se sirve,
 * que es preferible a servirse con una clave de cinco letras.
 */
export const LONGITUD_MINIMA_SECRETO = 16;

/**
 * Lo que ve quien tenía un formulario a medio rellenar cuando la sesión murió.
 *
 * Dice "puede que" porque desde el navegador no se distingue una sesión caducada
 * de una caída de red, y afirmar la causa equivocada es peor que no afirmar
 * ninguna. Lo que sí afirma —y es lo que importa— es que **no se ha guardado**.
 */
export const MENSAJE_SESION_CADUCADA =
  "No se ha guardado nada: puede que la sesión haya caducado. Entra otra vez en /acceso, vuelve aquí y pulsa de nuevo; lo que has escrito sigue en el formulario.";

/**
 * El único mensaje de error de la pantalla de acceso.
 *
 * No dice si la clave era corta, ni si se parecía, ni cuántos intentos quedan.
 * Cada una de esas tres cosas es un byte de información que hoy no tiene quien
 * llama y que le acerca al secreto.
 */
export const MENSAJE_ACCESO_DENEGADO = "No se ha podido entrar.";

/** Qué falta cuando falta. Se enseña sin ningún valor dentro: el repositorio es público. */
export const VARIABLE_SECRETO = "DASHBOARD_PASSWORD";

/**
 * El secreto **efectivo**: el que de verdad firma y verifica.
 *
 * Vive aquí, en el módulo puro, y no en cada puerta, porque durante un tiempo
 * estuvo en dos: `secretoDeAcceso()` recortaba y el proxy pasaba la variable
 * cruda. Un valor pegado en el panel de Vercel con un salto de línea al final
 * —que es como se pega con el ratón— derivaba entonces **dos claves HMAC
 * distintas**: el login firmaba la cookie con una y el proxy la verificaba con
 * la otra, así que se entraba bien y la navegación siguiente devolvía al
 * formulario, en bucle. En local no se reproducía nunca, porque el `.env` no
 * lleva ese salto.
 *
 * Recortar en un solo sitio no es una comodidad: es lo que hace imposible que
 * las tres puertas vuelvan a discrepar. Vacío y ausente son lo mismo.
 */
export function secretoEfectivo(secreto: string | null | undefined): string | null {
  if (typeof secreto !== "string") return null;
  const limpio = secreto.trim();
  return limpio === "" ? null : limpio;
}

/**
 * La longitud se mide **sobre el secreto efectivo**, no sobre la variable cruda.
 * Medirla sobre la cruda hacía que un valor de quince caracteres más un salto
 * midiera dieciséis para el proxy y quince para el login: el proxy servía el
 * formulario y el login denegaba siempre. Una pantalla que no puede aceptar
 * nada es exactamente lo que `decidir()` dice que quiere evitar.
 */
export function secretoUtilizable(secreto: string | null | undefined): secreto is string {
  const efectivo = secretoEfectivo(secreto);
  return efectivo !== null && efectivo.length >= LONGITUD_MINIMA_SECRETO;
}

/**
 * La clave con la que se firma no es el secreto a pelo, sino un HMAC suyo contra
 * una etiqueta fija. Cuesta un microsegundo y separa los dos usos del mismo
 * valor: lo que se teclea y lo que firma. No convierte un secreto corto en uno
 * bueno —contra eso está `LONGITUD_MINIMA_SECRETO`— pero evita que el material
 * que sale en cada cookie sea exactamente el que se escribe en el formulario.
 */
const ETIQUETA_DERIVACION = "news-monitor/sesion-del-dashboard/v1";

async function claveDeFirma(secreto: string): Promise<CryptoKey> {
  const subtle = globalThis.crypto.subtle;
  const raiz = await subtle.importKey(
    "raw",
    CODIFICADOR.encode(secreto),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derivada = await subtle.sign("HMAC", raiz, CODIFICADOR.encode(ETIQUETA_DERIVACION));
  return subtle.importKey("raw", derivada, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

async function firmar(clave: CryptoKey, mensaje: string): Promise<string> {
  const firma = await globalThis.crypto.subtle.sign("HMAC", clave, CODIFICADOR.encode(mensaje));
  return Array.from(new Uint8Array(firma), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Comparación en tiempo constante.
 *
 * Un `===` sobre cadenas para en la primera diferencia, y esa diferencia de
 * nanosegundos, repetida, deletrea el secreto byte a byte. Aquí se recorre
 * siempre entero y se acumula con OR.
 *
 * Salir por longitudes distintas no filtra nada útil: los dos argumentos son
 * siempre HMAC en hexadecimal, de 64 caracteres, y lo único que revela es el
 * tamaño de lo que ha mandado quien llama, que ya sabe.
 */
function iguales(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diferencia = 0;
  for (let i = 0; i < a.length; i += 1) diferencia |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diferencia === 0;
}

/**
 * `v1.<caducidad en segundos>.<HMAC de los dos campos anteriores>`.
 *
 * La caducidad va **dentro de lo firmado**, y ése es el punto entero del
 * formato. Una cookie que sólo caduca por su atributo `Expires` caduca en el
 * navegador y en ningún sitio más: basta con haberla copiado antes y volver a
 * mandarla. Firmada, cambiarla la invalida y el servidor la rechaza.
 */
export async function emitirSesion(
  secreto: string,
  ahora: Date = new Date(),
): Promise<{ valor: string; expira: Date }> {
  const expira = new Date(ahora.getTime() + DURACION_SESION_MS);
  const carga = `v1.${Math.floor(expira.getTime() / 1000)}`;
  const firma = await firmar(await claveDeFirma(secreto), carga);
  return { valor: `${carga}.${firma}`, expira };
}

export type Verificacion =
  | { valido: true; expira: Date }
  | { valido: false; motivo: "ausente" | "malformada" | "firma" | "caducada" };

/**
 * El orden importa: **primero la firma, después la caducidad**. Mirar la fecha
 * antes de autenticarla es tomarse en serio un campo que todavía no se sabe si
 * lo ha escrito este servidor.
 */
export async function verificarSesion(
  valor: string | null | undefined,
  secreto: string,
  ahora: Date = new Date(),
): Promise<Verificacion> {
  if (!valor) return { valido: false, motivo: "ausente" };

  const partes = valor.split(".");
  if (partes.length !== 3) return { valido: false, motivo: "malformada" };
  const [version, caducidad, firmaRecibida] = partes as [string, string, string];
  if (version !== "v1" || !/^\d{1,15}$/.test(caducidad)) {
    return { valido: false, motivo: "malformada" };
  }

  const esperada = await firmar(await claveDeFirma(secreto), `${version}.${caducidad}`);
  if (!iguales(esperada, firmaRecibida)) return { valido: false, motivo: "firma" };

  const expira = new Date(Number(caducidad) * 1000);
  if (expira.getTime() <= ahora.getTime()) return { valido: false, motivo: "caducada" };
  return { valido: true, expira };
}

/**
 * ¿Es ésta la clave?
 *
 * No se comparan las dos cadenas: se comparan sus HMAC, que miden siempre lo
 * mismo. Así la comprobación no depende de la longitud de lo tecleado —una
 * comparación directa filtraría cuántos caracteres tiene el secreto en cuanto
 * alguien cronometre unos cuantos intentos— y sigue siendo de tiempo constante.
 */
export async function contrasenaValida(entrada: string, secreto: string): Promise<boolean> {
  const clave = await claveDeFirma(secreto);
  const [recibida, buena] = await Promise.all([
    firmar(clave, `clave:${entrada}`),
    firmar(clave, `clave:${secreto}`),
  ]);
  return iguales(recibida, buena);
}

/**
 * La lista blanca, que es de una entrada.
 *
 * Está escrita como excepción y no como regla —"todo es privado salvo esto"— a
 * propósito: cualquier página que se añada mañana nace protegida sin que nadie
 * se acuerde de apuntarla en ninguna lista. El caso contrario, una lista de
 * rutas privadas, se olvida el día que hay prisa.
 */
export function esRutaPublica(pathname: string): boolean {
  return pathname === RUTA_ACCESO || pathname === `${RUTA_ACCESO}/`;
}

/**
 * A dónde se vuelve después de entrar.
 *
 * El destino viene de la URL, así que lo escribe quien quiera: sin filtrar, la
 * pantalla de acceso es un redirector abierto y sirve para mandar a alguien a
 * otro sitio con la credibilidad de este dominio. Sólo pasan rutas de esta
 * misma aplicación: nada de `//otro.example`, ni de esquemas, ni de saltos de
 * línea —que además inyectarían en la cabecera `Location`—, ni volver al propio
 * acceso, que sería un bucle.
 */
export function destinoSeguro(valor: string | null | undefined): string {
  if (!valor || !valor.startsWith("/")) return "/";
  if (valor.startsWith("//") || valor.startsWith("/\\")) return "/";
  if (/[\u0000-\u001f\u007f]/.test(valor)) return "/";
  if (valor === RUTA_ACCESO || valor.startsWith(`${RUTA_ACCESO}/`) || valor.startsWith(`${RUTA_ACCESO}?`)) {
    return "/";
  }
  return valor;
}

export interface Peticion {
  pathname: string;
  /** `GET`, `POST`… en mayúsculas, tal y como lo da el runtime. */
  metodo: string;
  cookie: string | null;
  secreto: string | null;
  ahora?: Date;
}

export type Decision =
  | { tipo: "sin-configurar" }
  | { tipo: "pasa" }
  | { tipo: "a-acceso"; destino: string; caducada: boolean }
  | { tipo: "bloquea-escritura" };

/**
 * La decisión de la puerta, entera y sin depender de Next.
 *
 * Tres cosas que no son obvias:
 *
 * 1. **Sin secreto no pasa nada, ni siquiera la pantalla de acceso.** Un
 *    despliegue al que se le olvidó la variable es exactamente el caso que esto
 *    tiene que cubrir, y un formulario que nunca podrá aceptar nada sólo sirve
 *    para que el fallo parezca otra cosa. Se falla cerrado y se dice qué falta.
 *
 * 2. **Una escritura sin sesión no se redirige: se bloquea.** Una acción de
 *    servidor es un POST a la ruta de la página, y su respuesta la interpreta
 *    React, no el navegador: devolverle el HTML de la pantalla de acceso le hace
 *    reventar de una forma que parece un error cualquiera. Un 403 seco lo
 *    convierte en un fallo que el formulario puede contar (ver
 *    `MENSAJE_SESION_CADUCADA`), y sobre todo **no escribe**.
 *
 * 3. El método basta para distinguir las dos cosas. Next marca sus acciones con
 *    la cabecera `next-action`, pero en esta aplicación no hay ningún route
 *    handler: todo POST a una página es una acción. Depender del método y no de
 *    una cabecera interna es una dependencia menos que se puede renombrar.
 */
export async function decidir(peticion: Peticion): Promise<Decision> {
  // Quien llama pasa la variable **cruda**, que es lo que le da el runtime; la
  // decisión de qué es «el secreto» se toma aquí y en ningún otro sitio.
  const efectivo = secretoEfectivo(peticion.secreto);
  if (!secretoUtilizable(efectivo)) return { tipo: "sin-configurar" };
  if (esRutaPublica(peticion.pathname)) return { tipo: "pasa" };

  const verificacion = await verificarSesion(peticion.cookie, efectivo, peticion.ahora);
  if (verificacion.valido) return { tipo: "pasa" };

  const soloLectura = peticion.metodo === "GET" || peticion.metodo === "HEAD";
  if (!soloLectura) return { tipo: "bloquea-escritura" };

  return {
    tipo: "a-acceso",
    destino: destinoSeguro(peticion.pathname),
    caducada: verificacion.motivo === "caducada",
  };
}
