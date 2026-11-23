// The fallback icon model's arithmetic, without the model (docs/plans/real-app.md §7). Pure.
//
// It mirrors `scripts/org_task_icon_matcher.py` in agentic-org-planner, which the bundle was built
// and evaluated with: the query text ("org-plain", the nearest parent, "<parent>: <title>"),
// the scores (`dense @ q + prior`) and the gate (how many standard deviations the best icon
// stands above the rest). Python's `\w`, `\s`, `\d` and `\b` are Unicode-aware, so the
// classes below spell out what Python means by them.

// Python's whitespace (str.isspace), which JS's \s doesn't quite match (it adds U+FEFF and
// lacks U+001C–U+001F and U+0085).
const WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
const S = `[${WS}]`;
const NS = `[^${WS}]`;
const W = "[\\p{L}\\p{N}_]"; // Python's \w: alphanumeric or underscore
const D = "\\p{Nd}"; // Python's \d
const NOT_W_BEFORE = `(?<!${W})`; // Python's \b before a word character

const KEYWORDS = new Set(["TODO", "NEXT", "INPR", "WAIT", "MAYB", "DONE"]);
const re = (src, flags = "") => new RegExp(src, `u${flags}`);
const STATS_COOKIE_RE = re(`${S}*\\[${D}*(?:/${D}*|%)\\]`, "g");
const PRIORITY_RE = re(`^\\[#[A-Za-z]\\]${S}*`);
const TAGS_RE = re(`${S}+(:(?:[A-Za-z0-9_@#%]+:)+)${S}*$`);
const SCHEDULING_RE = re(`${NOT_W_BEFORE}(SCHEDULED|DEADLINE|CLOSED|Started):`, "gi");
const TIMESTAMP_RE = re(`[<\\[]${D}{4}-${D}{2}-${D}{2}[^>\\]]*[>\\]]`, "g");
const LINK_DESC_RE = re("\\[\\[[^\\]]*?\\]\\[([^\\]]+)\\]\\]", "g");
const LINK_BARE_RE = re("\\[\\[([^\\]]+)\\]\\]", "g");
const URL_RE = re(`${NOT_W_BEFORE}https?://${NS}+`, "g");
const MAILTO_RE = re(`${NOT_W_BEFORE}mailto:(${NS}+)`, "g");
const EMPHASIS_RE = re(`(?<!${W})([*/_=~+])(${NS}(?:[^\\n]*?${NS})?)\\1(?!${W})`, "g");
const RUNS_RE = re(`${S}+`, "g");
const TRIM_RE = re(`^${S}+|${S}+$`, "g");

const strip = (s) => s.replace(TRIM_RE, "");

/** A link target as readable words, or "" when it looks opaque (Python `_readable_from_target`). */
function readable(target) {
  let t = strip(target);
  const m = /^[A-Za-z][A-Za-z0-9+.-]*:([^\n]*)$/u.exec(t);
  if (m) t = m[1];
  t = t.replace(/^\/+/, "");
  if (t.includes("/")) t = t.replace(/\/+$/, "").split("/").at(-1);
  t = t.replace(/[#?][^\n]*$/u, "");
  t = t.replace(/\.[A-Za-z0-9]{1,5}$/, "");
  t = strip(t.replaceAll("_", " ").replaceAll("-", " "));
  if (/^[0-9a-fA-F]{8,}$/.test(t) || !/[A-Za-z]{2,}/.test(t)) return "";
  return t;
}

/** Org heading text → plain text: no cookies, keyword, priority, tags, stamps, links or emphasis. */
export function orgPlain(raw) {
  let text = strip(raw.replace(STATS_COOKIE_RE, ""));
  const first = re(`^(${NS}+)(?:${S}+([^]*))?$`).exec(text);
  if (first && KEYWORDS.has(first[1])) text = first[2] ?? "";
  text = text.replace(PRIORITY_RE, "");
  const tags = TAGS_RE.exec(text);
  if (tags) text = text.slice(0, tags.index);
  text = text.replace(SCHEDULING_RE, " ");
  text = text.replace(TIMESTAMP_RE, " ");
  text = text.replace(LINK_DESC_RE, (_, d) => d);
  text = text.replace(LINK_BARE_RE, (_, t) => readable(t));
  text = text.replace(MAILTO_RE, (_, t) => readable(t));
  text = text.replace(URL_RE, (u) => readable(u));
  let prev = null;
  while (prev !== text) {
    prev = text;
    text = text.replace(EMPHASIS_RE, (_, _m, inner) => inner);
  }
  return strip(text.replace(RUNS_RE, " "));
}

const NORMALIZERS = { "org-plain": orgPlain, none: strip };

/** The query text for a task `{title, parents}` (Python `compose_query`): "<parent>: <title>". */
export function composeQuery(task, spec) {
  const norm = NORMALIZERS[spec.normalize];
  if (!norm) throw new Error(`unknown normalizer ${spec.normalize}`);
  let text = norm(task.title || "");
  const parents = task.parents || [];
  if (spec.inputs.includes("parents") && parents.length) {
    const parent = norm(parents.at(-1));
    if (parent) text = `${parent}: ${text}`;
  }
  return text;
}

/** A float16 bit pattern as a number. */
function half(bits) {
  const exp = (bits >> 10) & 0x1f;
  const frac = bits & 0x3ff;
  const sign = bits & 0x8000 ? -1 : 1;
  if (exp === 0) return sign * frac * 2 ** -24;
  if (exp === 31) return frac ? NaN : sign * Infinity;
  return sign * (1 + frac / 1024) * 2 ** (exp - 15);
}

/** A `.npy` file (little-endian float16 or float32, C order) → `{shape, data: Float32Array}`. */
export function parseNpy(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes[0] !== 0x93 || String.fromCharCode(...bytes.subarray(1, 6)) !== "NUMPY") throw new Error("not a .npy file");
  const major = bytes[6];
  const headerLen = major === 1 ? view.getUint16(8, true) : view.getUint32(8, true);
  const start = major === 1 ? 10 : 12;
  const header = new TextDecoder().decode(bytes.subarray(start, start + headerLen));
  const descr = /'descr':\s*'([^']+)'/.exec(header)?.[1];
  if (/'fortran_order':\s*True/.test(header)) throw new Error(".npy: Fortran order is not supported");
  const shape = (/'shape':\s*\(([^)]*)\)/.exec(header)?.[1] || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number);
  const count = shape.reduce((a, b) => a * b, 1);
  const off = start + headerLen;
  const data = new Float32Array(count);
  if (descr === "<f2") for (let i = 0; i < count; i++) data[i] = half(view.getUint16(off + 2 * i, true));
  else if (descr === "<f4") for (let i = 0; i < count; i++) data[i] = view.getFloat32(off + 4 * i, true);
  else throw new Error(`.npy: unsupported dtype ${descr}`);
  return { shape, data };
}

/** Mean-pool a `[seq, dim]` hidden state (every token counts: no padding) and L2-normalize. */
export function poolNormalize(hidden, seq, dim) {
  const v = new Float64Array(dim);
  for (let t = 0; t < seq; t++) for (let d = 0; d < dim; d++) v[d] += hidden[t * dim + d];
  let norm = 0;
  for (let d = 0; d < dim; d++) {
    v[d] /= seq;
    norm += v[d] * v[d];
  }
  norm = Math.max(Math.sqrt(norm), 1e-12);
  const out = new Float32Array(dim);
  for (let d = 0; d < dim; d++) out[d] = v[d] / norm;
  return out;
}

/**
 * The best icon for query vector `q`: scores = dense · q + prior, then `z`, how many standard
 * deviations the best stands above the mean (Python `confidence`). `dense` is `[icons, dim]`.
 */
export function scoreTop1(q, dense, prior, dim = q.length) {
  const n = prior.length;
  let best = 0;
  let bestScore = -Infinity;
  let sum = 0;
  const scores = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = prior[i];
    const row = i * dim;
    for (let d = 0; d < dim; d++) s += dense[row + d] * q[d];
    scores[i] = s;
    sum += s;
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  const mean = sum / n;
  let varSum = 0;
  for (let i = 0; i < n; i++) varSum += (scores[i] - mean) ** 2;
  const std = Math.sqrt(varSum / n);
  return { index: best, z: std <= 1e-9 ? 0 : (bestScore - mean) / std };
}

/** Token ids cut to `max` the way `tokenizers`' truncation cuts one sequence: keep the end token. */
export function truncateIds(ids, max) {
  return ids.length <= max ? ids : [...ids.slice(0, max - 1), ids.at(-1)];
}
