#!/usr/bin/env node
// Build the deployable site: copy app/ to dist/, stamp the version, and write the service
// worker's precache list and cache name (docs/plans/real-app.md §2, "Build and libraries").
// Node built-ins only; the source stays plain ES modules with no bundler.
//
//   node tools/build.mjs [--src app] [--out dist]

import { createHash } from "node:crypto";
import { cpSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
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

export function build({ src = join(repo, "app"), out = join(repo, "dist") } = {}) {
  const pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"));
  rmSync(out, { recursive: true, force: true });
  cpSync(src, out, { recursive: true, filter: (p) => !SKIP.test(p.split(sep).join("/")) });

  const files = walk(out).map((p) => relative(out, p).split(sep).join("/"));
  const stamped = new Set(["sw.js", "version.js"]);

  // The hash covers every file but the two the build writes, so it changes exactly when the
  // shell does, and the same source always gives the same cache name.
  const hash = createHash("sha256");
  for (const f of files.filter((f) => !stamped.has(f))) hash.update(f).update("\0").update(readFileSync(join(out, f))).update("\0");
  const build = hash.digest("hex").slice(0, 10);
  const cache = `rumbo-${pkg.version}-${build}`;

  writeFileSync(
    join(out, "version.js"),
    `// Written by tools/build.mjs.\nexport const VERSION = ${JSON.stringify(pkg.version)};\nexport const BUILD = ${JSON.stringify(build)};\n`,
  );

  const precache = files.filter((f) => f !== "sw.js").map(precacheUrl);
  const swPath = join(out, "sw.js");
  const sw = readFileSync(swPath, "utf8");
  const stampedSw = sw
    .replace(/^const CACHE = .*\/\/ BUILD:CACHE$/m, `const CACHE = ${JSON.stringify(cache)};`)
    .replace(/^const PRECACHE = .*\/\/ BUILD:PRECACHE$/m, `const PRECACHE = ${JSON.stringify(precache)};`);
  if (stampedSw === sw || /BUILD:/.test(stampedSw)) throw new Error("sw.js: the BUILD lines were not found");
  writeFileSync(swPath, stampedSw);

  return { out, version: pkg.version, build, cache, precache };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? resolve(process.argv[i + 1]) : undefined;
  };
  const r = build({ src: arg("--src"), out: arg("--out") });
  console.log(`${relative(process.cwd(), r.out) || "."}: ${r.cache}, ${r.precache.length} files precached`);
}
