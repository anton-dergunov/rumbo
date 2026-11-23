// The fallback icon model's files on the device (docs/plans/real-app.md §7). The build lists them
// in `icon-model/files.json` with their sizes and sha256s; they are fetched from the app's own site
// only, when a task first needs a guess, never on first paint, and kept in Cache Storage under a
// name of their own (`icon-model-<id>`, which the service worker's clean-up of `rumbo-` caches
// leaves alone). The encoder comes in parts under GitHub's 100 MiB file limit and is joined here.
// `fetch`, `caches` and `sha256` are injected, so the tests run it on fakes.

export const CACHE_PREFIX = "icon-model-";

export class IconFilesError extends Error {
  /** `kind`: "unavailable" (this build has no model), "offline", "corrupt" (a sha256 differs) or "http". */
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

/** Hex sha256 of bytes, with the browser's (or Node's) Web Crypto. */
export async function sha256Hex(bytes) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(d, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function get(fetchFn, url) {
  let res;
  try {
    // no-store: the bytes go to Cache Storage, so the HTTP cache needn't hold a second copy.
    res = await fetchFn(url, { cache: "no-store" });
  } catch (e) {
    throw new IconFilesError("offline", `${url}: ${e.message}`);
  }
  if (res.status === 404) throw new IconFilesError("unavailable", `${url}: not on the site`);
  if (!res.ok) throw new IconFilesError("http", `${url}: HTTP ${res.status}`);
  return res;
}

/** The build's list of the model's files, or null when this build has none. */
export async function readFileList(base, fetchFn = fetch) {
  try {
    return await (await get(fetchFn, new URL("files.json", base))).json();
  } catch (e) {
    if (e.kind === "unavailable") return null;
    throw e;
  }
}

/** Whether the model's files for `list` are all in Cache Storage. */
export async function isCached(list, base, cachesApi = caches) {
  // `open` would make the cache if it weren't there; `has` only looks.
  if (!(await cachesApi.has(CACHE_PREFIX + list.id))) return false;
  const cache = await cachesApi.open(CACHE_PREFIX + list.id);
  const urls = [...list.model.parts, ...Object.values(list.files)].map((f) => new URL(f.path, base).href);
  for (const u of urls) if (!(await cache.match(u))) return false;
  return true;
}

/** Remove every stored copy of the model. */
export async function removeModel(cachesApi = caches) {
  for (const k of await cachesApi.keys()) if (k.startsWith(CACHE_PREFIX)) await cachesApi.delete(k);
}

/**
 * Every file the model needs, from Cache Storage, else fetched and checked. Returns
 * `{list, files, fetched}`: `files` as createMatcher (icon-matcher.js) takes them, `fetched` the
 * bytes downloaded now. Once all are in, other versions' caches are removed.
 */
/** Every byte the model needs, the runtime included: what a first download costs. */
export const totalSize = (list) => list.model.size + Object.values(list.files).reduce((n, f) => n + f.size, 0);

export async function loadModelFiles({ base, fetch: fetchFn = fetch, caches: cachesApi = caches, sha256 = sha256Hex, onProgress = () => {} }) {
  const list = await readFileList(base, fetchFn);
  if (!list) throw new IconFilesError("unavailable", "this build of Rumbo has no icon model");
  const name = CACHE_PREFIX + list.id;
  const cache = await cachesApi.open(name);
  const total = totalSize(list);
  let fetched = 0;
  let done = 0;

  const one = async (entry) => {
    const url = new URL(entry.path, base).href;
    const hit = await cache.match(url);
    if (hit) {
      const bytes = new Uint8Array(await hit.arrayBuffer());
      if (bytes.length === entry.size) {
        done += bytes.length;
        return bytes;
      }
    }
    const bytes = new Uint8Array(await (await get(fetchFn, url)).arrayBuffer());
    if (bytes.length !== entry.size || (await sha256(bytes)) !== entry.sha256) throw new IconFilesError("corrupt", `${entry.path}: its sha256 differs from the build's`);
    await cache.put(url, new Response(bytes));
    fetched += bytes.length;
    done += bytes.length;
    onProgress(done, total);
    return bytes;
  };

  // One file at a time: the parts are large, and a phone shouldn't hold several half-loaded.
  const loaded = {};
  for (const [k, entry] of Object.entries(list.files)) loaded[k] = await one(entry);
  const model = new Uint8Array(list.model.size);
  let at = 0;
  const fetchedBefore = fetched;
  for (const part of list.model.parts) {
    const bytes = await one(part);
    model.set(bytes, at);
    at += bytes.length;
  }
  if (at !== list.model.size) throw new IconFilesError("corrupt", "the encoder's parts don't add up to its size");
  // The whole file is checked when any part was fetched now; parts read from the cache were
  // checked when they were put there.
  if (fetched > fetchedBefore && (await sha256(model)) !== list.model.sha256) {
    await cachesApi.delete(name);
    throw new IconFilesError("corrupt", "the joined encoder's sha256 differs from the build's");
  }
  for (const k of await cachesApi.keys()) if (k.startsWith(CACHE_PREFIX) && k !== name) await cachesApi.delete(k);

  const text = (b) => new TextDecoder().decode(b);
  return {
    list,
    fetched,
    files: {
      model,
      tokenizer: text(loaded.tokenizer),
      wasm: loaded.wasm,
      manifest: JSON.parse(text(loaded.manifest)),
      names: text(loaded.names),
      dense: loaded.dense,
      prior: loaded.prior,
    },
  };
}
