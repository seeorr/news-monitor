import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
const treeOnly = process.argv.slice(2).includes("--tree-only");
if (process.argv.slice(2).some((arg) => arg !== "--tree-only")) throw new Error("invalid_security_scan_argument");
const git = (...args) => execFileSync("git", args, { encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ["ignore","pipe","pipe"] });
// No inspecciona .env local, almacenes de autenticación ni secretos activos.
// Solo contenido versionable y objetos alcanzables del historial local.
const patterns = [/gh[pousr]_[A-Za-z0-9]{30,}/g, /github_pat_[A-Za-z0-9_]{50,}/g,
  /sk-ant-[A-Za-z0-9_-]{40,}/g, /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g,
  /postgres(?:ql)?:\/\/[^\s/:'"]+:[^\s/@'"${}]+@(?!invalid|example|localhost|127\.0\.0\.1)[A-Za-z0-9.-]*neon\.tech/gi,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g];
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
