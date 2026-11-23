#!/usr/bin/env node
// Build the deployable site: copy app/ to dist/, stamp the version, and write the service
// worker's precache list and cache name (docs/plans/real-app.md §2, "Build and libraries").
// Node built-ins only; the source stays plain ES modules with no bundler.
//
// It also lays out the fallback icon model (real-app.md §7) in `icon-model/`: the ONNX encoder in
// parts under GitHub's 100 MiB limit, its tokenizer, and `files.json` listing every file the
// model needs with its size and sha256. The encoder and tokenizer come from `.cache/icon-model/`,
// else from $RUMBO_ICON_MODEL_DIR, else from the URLs in `icon-model/manifest.json`, and must match
// the manifest's sha256s. The model's files are not precached: the app downloads them only when a
// task needs a guess, into a cache of their own.
//
//   node tools/build.mjs [--src app] [--out dist] [--no-model]

import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));

/** Files left out of the site: editor and OS litter. */
const SKIP = /(^|\/)(\.DS_Store|.*~|.*\.swp)$/;

const walk = (dir) =>
  readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? walk(path) : [path];
    });

/** The URL a file is precached under, relative to the scope: pages by their directory. */
export const precacheUrl = (path) => (path === "index.html" ? "./" : path.replace(/(^|\/)index\.html$/, "$1"));

/** The icon model's ORT runtime, downloaded with the model rather than precached. */
export const ORT_WASM = "vendor/ort/ort-wasm-simd-threaded.wasm";

/**
 * Files the service worker doesn't precache: the icon model, which the app fetches only when a
 * task needs a guess. `icon-model/files.json` is precached, so the app knows offline what it has.
 */
export const notPrecached = (f) => f === ORT_WASM || (f.startsWith("icon-model/") && f !== "icon-model/files.json");

/** The largest part of the encoder: under GitHub's 100 MiB file limit. */
export const PART_SIZE = 95 * 1024 * 1024;

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** A file the manifest names, from the first place that has it, checked against its sha256. */
async function modelSource({ url, sha256: want, size }, dirs) {
  const name = basename(new URL(url).pathname);
  for (const dir of dirs) {
    const p = dir && join(dir, name);
    if (p && existsSync(p)) {
      const buf = readFileSync(p);
      if (sha256(buf) === want) return buf;
      console.warn(`${p}: sha256 differs from the manifest; not used`);
    }
  }
  console.log(`Downloading ${name} (${Math.round(size / 1e6)} MB) from ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha256(buf) !== want) throw new Error(`${url}: sha256 differs from the manifest`);
  const cache = join(repo, ".cache", "icon-model");
  mkdirSync(cache, { recursive: true });
  writeFileSync(join(cache, name), buf);
  return buf;
}

/**
 * The encoder and tokenizer that `src/icon-model/manifest.json` names, as `{model, tokenizer}`
 * buffers: from `.cache/icon-model/`, else $RUMBO_ICON_MODEL_DIR, else downloaded (and kept in
 * `.cache/icon-model/`). Each must match the manifest's sha256.
 */
export async function fetchModel({ src = join(repo, "app"), dirs = [join(repo, ".cache", "icon-model"), process.env.RUMBO_ICON_MODEL_DIR] } = {}) {
  const manifest = JSON.parse(readFileSync(join(src, "icon-model", "manifest.json"), "utf8"));
  return { model: await modelSource(manifest.encoder.model, dirs), tokenizer: await modelSource(manifest.encoder.tokenizer, dirs) };
}

/** Write `icon-model/` in `out`: the encoder's parts, the tokenizer and `files.json`. */
function layOutModel(out, { model, tokenizer, partSize = PART_SIZE }) {
  const dir = join(out, "icon-model");
  const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
  const entry = (path) => {
    const buf = readFileSync(join(dir, path));
    return { path, size: buf.length, sha256: sha256(buf) };
  };
  const parts = [];
  for (let at = 0, i = 0; at < model.length; at += partSize, i++) {
    const part = model.subarray(at, at + partSize);
    const path = `model.onnx.part${i}`;
    writeFileSync(join(dir, path), part);
    parts.push({ path, size: part.length, sha256: sha256(part) });
  }
  writeFileSync(join(dir, "tokenizer.json"), tokenizer);
  const files = {
    tokenizer: entry("tokenizer.json"),
    manifest: entry("manifest.json"),
    names: entry(manifest.icons),
    dense: entry(manifest.dense.matrix),
    prior: entry(manifest.dense.prior),
    wasm: entry(`../${ORT_WASM}`),
  };
  const list = { tag: manifest.tag, model: { size: model.length, sha256: sha256(model), parts }, files };
  // One id for everything the model needs: it names the app's cache for the model.
  list.id = sha256(JSON.stringify([list.model.sha256, ...Object.values(files).map((f) => f.sha256)])).slice(0, 16);
  writeFileSync(join(dir, "files.json"), JSON.stringify(list, null, 1) + "\n");
  return list;
}

/**
 * Build `src` into `out`. `model` is null for a build without the icon model (the app then says
 * it has none), or `{model, tokenizer, partSize?}` from `fetchModel`.
 */
export function build({ src = join(repo, "app"), out = join(repo, "dist"), model = null } = {}) {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  rmSync(out, { recursive: true, force: true });
  cpSync(src, out, { recursive: true, filter: (p) => !SKIP.test(p.split(sep).join("/")) });
  const iconModel = model ? layOutModel(out, model) : null;

  const files = walk(out).map((p) => relative(out, p).split(sep).join("/"));
  const stamped = new Set(["sw.js", "version.js"]);
  const shell = files.filter((f) => !notPrecached(f));

  // The hash covers every precached file but the two the build writes, so it changes exactly when
  // the shell does, and the same source always gives the same cache name. A new model changes it
  // through `icon-model/files.json`.
  const hash = createHash("sha256");
  for (const f of shell.filter((f) => !stamped.has(f))) hash.update(f).update("\0").update(readFileSync(join(out, f))).update("\0");
  const build = hash.digest("hex").slice(0, 10);
  const cache = `rumbo-${pkg.version}-${build}`;

  writeFileSync(
    join(out, "version.js"),
    `// Written by tools/build.mjs.\nexport const VERSION = ${JSON.stringify(pkg.version)};\nexport const BUILD = ${JSON.stringify(build)};\n`,
  );

  const precache = shell.filter((f) => f !== "sw.js").map(precacheUrl);
  const swPath = join(out, "sw.js");
  const sw = readFileSync(swPath, "utf8");
  const stampedSw = sw
    .replace(/^const CACHE = .*\/\/ BUILD:CACHE$/m, `const CACHE = ${JSON.stringify(cache)};`)
    .replace(/^const PRECACHE = .*\/\/ BUILD:PRECACHE$/m, `const PRECACHE = ${JSON.stringify(precache)};`);
  if (stampedSw === sw || /BUILD:/.test(stampedSw)) throw new Error("sw.js: the BUILD lines were not found");
  writeFileSync(swPath, stampedSw);

  return { out, version: pkg.version, build, cache, precache, iconModel };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? resolve(process.argv[i + 1]) : undefined;
  };
  const src = arg("--src");
  const model = process.argv.includes("--no-model") ? null : await fetchModel(src ? { src } : {});
  const r = build({ src, out: arg("--out"), model });
  const m = r.iconModel ? `; icon model ${r.iconModel.tag} in ${r.iconModel.model.parts.length} parts` : "; no icon model (--no-model)";
  console.log(`${relative(process.cwd(), r.out) || "."}: ${r.cache}, ${r.precache.length} files precached${m}`);
}
