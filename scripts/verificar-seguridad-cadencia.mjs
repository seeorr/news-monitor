import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const treeOnly = process.argv.slice(2).includes("--tree-only");
if (process.argv.slice(2).some((arg) => arg !== "--tree-only")) throw new Error("invalid_security_scan_argument");
const git = (...args) => execFileSync("git", args, { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore","pipe","pipe"] });
// No inspecciona .env local, almacenes de autenticación ni secretos activos.
// Solo contenido versionable y objetos alcanzables del historial local.
// Las tres ultimas se anadieron despues de escribir este archivo, y hasta hoy no
// estaban: un `gsk_` commiteado pasaba el control en verde sobre un repositorio
// publico. Un secreto publicado una vez sigue publicado aunque se borre, asi que
// el escaner tiene que conocer TODAS las claves que el proyecto usa hoy, no solo
// las que usaba el dia en que se escribio.
const patterns = [/gh[pousr]_[A-Za-z0-9]{30,}/g, /github_pat_[A-Za-z0-9_]{50,}/g,
  /sk-ant-[A-Za-z0-9_-]{40,}/g, /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g,
  /postgres(?:ql)?:\/\/[^\s/:'"]+:[^\s/@'"${}]+@(?!invalid|example|localhost|127\.0\.0\.1)[A-Za-z0-9.-]*neon\.tech/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  // Groq: `gsk_` y 52 caracteres. El prefijo es suyo y basta para reconocerla.
  /\bgsk_[A-Za-z0-9]{40,}\b/g,
  // OpenRouter: `sk-or-v1-` y 64 hex. Va aparte de `sk-ant-` y no ampliando
  // aquella: distinto prefijo y distinto alfabeto, y una sola expresion para las
  // dos acabaria siendo mas laxa con la de Anthropic de lo que es hoy.
  /\bsk-or-v1-[A-Za-z0-9]{40,}\b/g,
  // FRED: 32 hex en minusculas y SIN prefijo. Es la unica que no se reconoce por
  // si misma, y buscar 32 hex a secas no vale: en `docs/` ya hay un id de cuenta
  // de Cloudflare con esa forma exacta. Un escaner que da un positivo falso en
  // cada pasada se acaba ignorando, y eso deja el repositorio igual de
  // desprotegido que no tener la regla. Asi que se exige el contexto por el que
  // una clave llega de verdad a un archivo: asignada a algo que se llama clave,
  // ficha o secreto -`FRED_API_KEY=...`, `?api_key=...`, `"apiKey": "..."`-.
  /(?:key|token|secret)["'`\s]*[:=]\s*["'`]?[0-9a-f]{32}(?![0-9a-fA-F])/gi];
const hits = (text) => patterns.reduce((n, expression) => n + [...text.matchAll(expression)].length, 0);
const files = git("ls-files", "-z", "--cached", "--others", "--exclude-standard").split("\0").filter(Boolean);
let treeHits = 0, historyHits = 0, blobs = 0;
for (const path of new Set(files)) {
  if (/\.(?:png|jpg|woff2?|ico|pdf)$/i.test(path)) continue;
  treeHits += hits(readFileSync(path, "utf8"));
}
// Batch: no valores coincidentes se imprimen, ni mensajes de commit.
const objects = treeOnly ? [] : git("rev-list", "--objects", "--all").split("\n").filter(Boolean).map((line) => line.split(" ")[0]);
for (const id of objects) {
  if (git("cat-file", "-t", id).trim() !== "blob") continue;
  blobs++; historyHits += hits(git("cat-file", "blob", id));
}
console.log(JSON.stringify({ code: "SECRET_PATTERN_SCAN", files: new Set(files).size, blobs, treeHits, historyHits,
  scope: treeOnly ? "versionable_tree_only" : "versionable_tree_and_local_reachable_history", valuesPrinted: false }));
process.exitCode = treeHits || historyHits ? 1 : 0;
