// The build obeys the update and offline rules of docs/plans/real-app.md §2
// (after vim-wilds/tests/pwa-build.test.mjs and calorie-logger/scripts/verify-pwa.py).

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { build, precacheUrl } from "../tools/build.mjs";

const app = new URL("../app", import.meta.url).pathname;
const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));

function freshBuild(src = app) {
  const out = mkdtempSync(join(tmpdir(), "rumbo-build-"));
  const r = build({ src, out });
  return { ...r, read: (p) => readFileSync(join(out, p), "utf8"), files: walk(out).map((p) => relative(out, p)) };
}

const precacheOf = (sw) => JSON.parse(sw.match(/^const PRECACHE = (\[.*\]);$/m)[1]);
const cacheOf = (sw) => JSON.parse(sw.match(/^const CACHE = (".*");$/m)[1]);

test("the manifest sits at the root, with relative start and scope, and its icons exist", () => {
  const b = freshBuild();
  const manifest = JSON.parse(b.read("manifest.webmanifest"));
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  assert.equal(manifest.display, "standalone");
  for (const icon of manifest.icons) assert.ok(existsSync(join(b.out, icon.src)), icon.src);
  assert.deepEqual(b.files.filter((f) => f.endsWith(".webmanifest")), ["manifest.webmanifest"]);
  const index = b.read("index.html");
  assert.match(index, /rel="manifest" href="manifest\.webmanifest"/);
  assert.match(index, /rel="apple-touch-icon" href="icons\/apple-touch-icon\.png"/);
  assert.match(index, /name="apple-mobile-web-app-capable" content="yes"/);
});

test("every URL is relative, so the site works under /rumbo/ and at a server's root", () => {
  const b = freshBuild();
  for (const f of b.files.filter((f) => /\.(html|css|js|webmanifest)$/.test(f))) {
    const text = b.read(f);
    assert.doesNotMatch(text, /(?:href|src)="\/(?!\/)/, `${f}: root-absolute href/src`);
    assert.doesNotMatch(text, /url\(\s*["']?\/(?!\/)/, `${f}: root-absolute url()`);
    assert.doesNotMatch(text, /from\s+["']\/(?!\/)/, `${f}: root-absolute import`);
    assert.doesNotMatch(text, /"(?:start_url|scope|src)":\s*"\//, `${f}: root-absolute manifest path`);
  }
});

test("the whole shell is precached, pages under their directory URLs, the worker itself not", () => {
  const b = freshBuild();
  const sw = b.read("sw.js");
  const precache = precacheOf(sw);
  assert.deepEqual([...precache].sort(), b.files.filter((f) => f !== "sw.js").map(precacheUrl).sort());
  assert.ok(precache.includes("./"));
  assert.ok(!precache.some((u) => u.endsWith("index.html")));
  assert.ok(!precache.some((u) => /404/.test(u)));
  assert.ok(!precache.includes("sw.js"));
  assert.equal(precacheUrl("check/index.html"), "check/");
  assert.doesNotThrow(() => new Function(sw));
});

test("no automatic activation: skipWaiting only on the page's request, never clients.claim", () => {
  const sw = freshBuild().read("sw.js");
  const code = sw.replace(/^\s*\/\/.*$/gm, "");
  assert.equal(code.match(/skipWaiting\(\)/g)?.length, 1);
  assert.match(code, /addEventListener\("message"[^]*?apply-update[^]*?skipWaiting\(\)/);
  assert.doesNotMatch(code, /clients\.claim/);
});

test("other origins, the GitHub API among them, are never answered from or put in the cache", () => {
  const code = freshBuild().read("sw.js").replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /url\.origin !== self\.location\.origin[^\n]*return;/);
  assert.doesNotMatch(code, /cache\.put|cache\.add\(/);
});

test("the cache name follows the files: same source, same name; any change, a new name", () => {
  const a = freshBuild();
  const again = freshBuild();
  assert.equal(cacheOf(a.read("sw.js")), cacheOf(again.read("sw.js")));
  assert.match(a.cache, /^rumbo-\d+\.\d+\.\d+-[0-9a-f]{10}$/);
  assert.match(a.read("version.js"), new RegExp(`BUILD = "${a.build}"`));

  const src = mkdtempSync(join(tmpdir(), "rumbo-src-"));
  cpSync(app, src, { recursive: true });
  appendFileSync(join(src, "app.css"), "\n/* changed */\n");
  const changed = freshBuild(src);
  assert.notEqual(changed.cache, a.cache);
  rmSync(src, { recursive: true, force: true });
});

test("the unbuilt worker is valid and precaches nothing", () => {
  const sw = readFileSync(join(app, "sw.js"), "utf8");
  assert.deepEqual(precacheOf(sw.replace(" // BUILD:PRECACHE", "")), []);
  assert.doesNotThrow(() => new Function(sw));
  // A build that can't find its markers must fail loudly rather than ship an empty precache.
  const src = mkdtempSync(join(tmpdir(), "rumbo-src-"));
  cpSync(app, src, { recursive: true });
  writeFileSync(join(src, "sw.js"), sw.replace(/ \/\/ BUILD:\w+/g, ""));
  assert.throws(() => freshBuild(src), /BUILD lines/);
  rmSync(src, { recursive: true, force: true });
});

test("the Diagnostics page lives at check/, and the self-hosted fonts are precached", () => {
  const b = freshBuild();
  const precache = precacheOf(b.read("sw.js"));
  assert.ok(precache.includes("check/"));
  assert.ok(precache.includes("fonts/fonts.css"));
  assert.ok(precache.includes("fonts/material-symbols-outlined.woff2"));
  for (const m of b.read("fonts/fonts.css").matchAll(/url\(([^)]+)\)/g)) assert.ok(b.files.includes(`fonts/${m[1]}`), m[1]);
  assert.match(b.read("check/index.html"), /href="\.\.\/manifest\.webmanifest"/);
});

test("every page's CSP allows only itself and api.github.com, and no HTML uses style attributes", () => {
  const b = freshBuild();
  const pages = b.files.filter((f) => f.endsWith(".html"));
  assert.deepEqual(pages.sort(), ["check/index.html", "index.html"]);
  for (const f of pages) {
    const html = b.read(f);
    const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/)?.[1];
    assert.ok(csp, `${f}: no CSP`);
    const hosts = csp.match(/https?:\/\/[^\s;]+/g) || [];
    assert.deepEqual([...new Set(hosts)], ["https://api.github.com"], `${f}: ${hosts}`);
    assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, f);
    assert.match(csp, /style-src 'self'/, f);
    assert.doesNotMatch(html, /\sstyle="/, `${f}: style attribute`);
    assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/, f);
  }
  for (const f of b.files.filter((f) => f.endsWith(".js"))) assert.doesNotMatch(b.read(f), /setAttribute\(\s*["']style["']/, `${f}: style attribute set from script`);
});
