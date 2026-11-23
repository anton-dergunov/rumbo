// The build obeys the update and offline rules of docs/plans/real-app.md §2
// (after vim-wilds/tests/pwa-build.test.mjs and calorie-logger/scripts/verify-pwa.py).

import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { build, precacheUrl, notPrecached, ORT_WASM } from "../tools/build.mjs";
import { CACHE_PREFIX } from "../app/icon-files.js";
import { createHash } from "node:crypto";

const app = new URL("../app", import.meta.url).pathname;
const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));

function freshBuild(src = app, model = null) {
  const out = mkdtempSync(join(tmpdir(), "rumbo-build-"));
  const r = build({ src, out, model });
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
  assert.deepEqual([...precache].sort(), b.files.filter((f) => f !== "sw.js" && !notPrecached(f)).map(precacheUrl).sort());
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

test("the note libraries are precached, and KaTeX's stylesheet names only fonts that ship", () => {
  const b = freshBuild();
  const precache = precacheOf(b.read("sw.js"));
  for (const f of ["markdown.js", "notes.js", "vendor/marked.esm.js", "vendor/purify.es.mjs", "vendor/katex/katex.mjs", "vendor/katex/katex.min.css"]) assert.ok(precache.includes(f), f);
  const urls = [...b.read("vendor/katex/katex.min.css").matchAll(/url\(([^)]+)\)/g)].map((m) => m[1]);
  assert.ok(urls.length >= 20);
  for (const u of urls) {
    assert.ok(b.files.includes(`vendor/katex/${u}`), u);
    assert.ok(precache.includes(`vendor/katex/${u}`), u);
  }
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
    // WebAssembly (the icon model's runtime) is the one thing allowed beyond 'self'.
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval';/, f);
    assert.doesNotMatch(csp.replace("'wasm-unsafe-eval'", ""), /unsafe-inline|unsafe-eval/, f);
    assert.match(csp, /style-src 'self'/, f);
    assert.doesNotMatch(html, /\sstyle="/, `${f}: style attribute`);
    assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic/, f);
  }
  for (const f of b.files.filter((f) => /\.m?js$/.test(f))) assert.doesNotMatch(b.read(f), /setAttribute\(\s*["']style["']/, `${f}: style attribute set from script`);
});

/** A source tree whose icon manifest names a small fake encoder and tokenizer. */
function fakeModelSource() {
  const src = mkdtempSync(join(tmpdir(), "rumbo-src-"));
  cpSync(app, src, { recursive: true });
  const model = Buffer.from(Array.from({ length: 2500 }, (_, i) => i % 251));
  const tokenizer = Buffer.from('{"fake": true}');
  const sha = (b) => createHash("sha256").update(b).digest("hex");
  const mPath = join(src, "icon-model", "manifest.json");
  const manifest = JSON.parse(readFileSync(mPath, "utf8"));
  manifest.encoder.model = { url: "https://example.org/x/model_int8.onnx", sha256: sha(model), size: model.length };
  manifest.encoder.tokenizer = { url: "https://example.org/x/tokenizer.json", sha256: sha(tokenizer), size: tokenizer.length };
  writeFileSync(mPath, JSON.stringify(manifest));
  return { src, model, tokenizer, sha };
}

test("the icon model is laid out in parts with a list of sizes and sha256s, and none of it is precached", () => {
  const { src, model, tokenizer, sha } = fakeModelSource();
  const b = freshBuild(src, { model, tokenizer, partSize: 1000 });
  const list = JSON.parse(b.read("icon-model/files.json"));
  assert.equal(list.model.parts.length, 3);
  assert.deepEqual(list.model.parts.map((p) => p.size), [1000, 1000, 500]);
  const joined = Buffer.concat(list.model.parts.map((p) => readFileSync(join(b.out, "icon-model", p.path))));
  assert.ok(joined.equals(model));
  assert.equal(list.model.sha256, sha(model));
  for (const p of list.model.parts) assert.equal(sha(readFileSync(join(b.out, "icon-model", p.path))), p.sha256);
  for (const [k, f] of Object.entries(list.files)) {
    const buf = readFileSync(join(b.out, "icon-model", f.path));
    assert.equal(buf.length, f.size, k);
    assert.equal(sha(buf), f.sha256, k);
  }
  assert.equal(list.files.wasm.path, `../${ORT_WASM}`);
  assert.equal(b.read("icon-model/tokenizer.json"), tokenizer.toString());
  assert.match(list.id, /^[0-9a-f]{16}$/);

  const precache = precacheOf(b.read("sw.js"));
  assert.ok(precache.includes("icon-model/files.json"));
  assert.ok(!precache.some((u) => u.startsWith("icon-model/") && u !== "icon-model/files.json"), "model files precached");
  assert.ok(!precache.includes(ORT_WASM));
  for (const f of ["icon-model.js", "icon-worker.js", "icon-matcher.js", "icon-files.js", "icon-query.js", "vendor/ort/ort.wasm.bundle.min.mjs", "vendor/tokenizers.min.mjs"]) assert.ok(precache.includes(f), f);
  rmSync(src, { recursive: true, force: true });
});

test("a new model changes the shell's cache name; the model's cache isn't one the worker's clean-up removes", () => {
  const a = fakeModelSource();
  const one = freshBuild(a.src, { model: a.model, tokenizer: a.tokenizer, partSize: 1000 });
  const other = Buffer.from(a.model);
  other[0] ^= 1;
  const mPath = join(a.src, "icon-model", "manifest.json");
  const manifest = JSON.parse(readFileSync(mPath, "utf8"));
  manifest.encoder.model.sha256 = a.sha(other);
  writeFileSync(mPath, JSON.stringify(manifest));
  const two = freshBuild(a.src, { model: other, tokenizer: a.tokenizer, partSize: 1000 });
  assert.notEqual(one.cache, two.cache);
  assert.notEqual(JSON.parse(one.read("icon-model/files.json")).id, JSON.parse(two.read("icon-model/files.json")).id);
  assert.ok(!CACHE_PREFIX.startsWith("rumbo-"));
  assert.match(readFileSync(join(app, "sw.js"), "utf8"), /startsWith\("rumbo-"\)/);
  rmSync(a.src, { recursive: true, force: true });
});

test("a build without the model ships no files.json, and the app treats that as no model", () => {
  const b = freshBuild();
  assert.ok(!b.files.includes("icon-model/files.json"));
  assert.ok(!b.files.some((f) => f.startsWith("icon-model/model.onnx")));
});
