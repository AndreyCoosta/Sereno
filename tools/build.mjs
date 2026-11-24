// Gera os pacotes para as lojas a partir do mesmo código:
//   dist/sereno-edge-<versão>.zip      (Microsoft Edge Add-ons)
//   dist/sereno-firefox-<versão>.zip   (addons.mozilla.org)
// Uso: node tools/build.mjs
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const SKIP = new Set([".git", ".github", ".gitignore", "dist", "platforms", "tools", "README.md", "node_modules"]);
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2) + "\n");
const version = readJson(join(ROOT, "manifest.json")).version;

function copySource(dest) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(ROOT)) {
    if (SKIP.has(name) || name.endsWith(".zip")) continue;
    cpSync(join(ROOT, name), join(dest, name), { recursive: true });
  }
}

function zipDir(dir, out) {
  rmSync(out, { force: true });
  execFileSync("zip", ["-qrX", out, "."], { cwd: dir });
}

mkdirSync(DIST, { recursive: true });

// Edge: o código como está
const edgeDir = join(DIST, "edge");
copySource(edgeDir);
zipDir(edgeDir, join(DIST, `sereno-edge-${version}.zip`));

// Firefox: manifesto próprio + textos que citam o Edge trocados
const ffDir = join(DIST, "firefox");
copySource(ffDir);
const ffManifest = readJson(join(ROOT, "platforms/firefox/manifest.json"));
ffManifest.version = version;
writeJson(join(ffDir, "manifest.json"), ffManifest);
const overrides = readJson(join(ROOT, "platforms/firefox/locale-overrides.json"));
for (const [locale, keys] of Object.entries(overrides)) {
  const file = join(ffDir, "_locales", locale, "messages.json");
  const messages = readJson(file);
  for (const [key, message] of Object.entries(keys)) {
    if (!messages[key]) throw new Error(`${locale}: chave ${key} não existe`);
    messages[key].message = message;
  }
  writeJson(file, messages);
}
zipDir(ffDir, join(DIST, `sereno-firefox-${version}.zip`));

console.log(`dist/sereno-edge-${version}.zip\ndist/sereno-firefox-${version}.zip`);
