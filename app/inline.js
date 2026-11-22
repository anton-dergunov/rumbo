// Inline Org markup -> a token tree. Pure (no DOM) so node can test it; ui.js turns tokens into nodes.
//
// Tokens:
//   {t:"text", v}                      plain text
//   {t:"b"|"i"|"s"|"u", kids:[...]}    *bold* /italic/ +strike+ _underline_ (opt-in)
//   {t:"verb", v} {t:"code", v}        =verbatim= ~code~ (opt-in)
//   {t:"link", href, kids}             [[https://…][desc]]  [[https://…]]  bare https://…
//   {t:"obsidian", target, v}          [[obsidian:Note]]  [[obsidian:Note][desc]] (target: the note's name)
//   {t:"file", target, kids}           [[file:…][desc]]  (paths outside the vault; shown, not followed)
//
// Emphasis follows Org's border rules: the opening marker comes after start/whitespace/one of -('"{
// and is followed by a non-space; the closing marker follows a non-space and comes before
// end/whitespace/punctuation. That keeps "~55,000 adults", "Lucene/Elasticsearch" and
// "Deep_Learning" as plain text.

const PRE = /[\s\-('"{—–“‘]/;
const POST = /[\s\-.,;:!?'")}\]—–”’/]/;
// ~code~ and _underline_ are opt-in: in this vault "~" means "approximately" and "_" sits in file names.
const MARKERS = { "*": "b", "/": "i", "+": "s", "=": "verb" };

const URL_RE = /^https?:\/\/[^\s<>"\]]+/;

function trimUrl(url) {
  // Drop trailing punctuation that belongs to the sentence, keeping balanced parentheses.
  let u = url;
  for (;;) {
    const last = u[u.length - 1];
    if (/[.,;:!?'"]/.test(last)) u = u.slice(0, -1);
    else if (last === ")" && (u.match(/\(/g) || []).length < (u.match(/\)/g) || []).length)
      u = u.slice(0, -1);
    else break;
  }
  return u;
}

function findClose(s, from, marker) {
  for (let j = from + 1; j < s.length; j++) {
    if (s[j] !== marker) continue;
    const before = s[j - 1];
    const after = s[j + 1];
    if (/\s/.test(before)) continue;
    if (after !== undefined && !POST.test(after)) continue;
    return j;
  }
  return -1;
}

export function tokenize(s, opts = {}) {
  const markers = { ...MARKERS, ...(opts.underline ? { _: "u" } : {}), ...(opts.tilde ? { "~": "code" } : {}) };
  const out = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ t: "text", v: buf });
    buf = "";
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    const prev = i === 0 ? " " : s[i - 1];

    if (c === "[" && s[i + 1] === "[") {
      const close = s.indexOf("]]", i + 2);
      if (close > 0) {
        const inner = s.slice(i + 2, close);
        const sep = inner.indexOf("][");
        const target = sep >= 0 ? inner.slice(0, sep) : inner;
        const desc = sep >= 0 ? inner.slice(sep + 2) : null;
        flush();
        if (/^obsidian:/i.test(target)) {
          const name = target.replace(/^obsidian:/i, "");
          out.push({ t: "obsidian", target: name, v: desc || name });
        } else if (/^https?:/i.test(target)) {
          out.push({ t: "link", href: target, kids: desc ? tokenize(desc, opts) : [{ t: "text", v: target }] });
        } else if (/^file:/i.test(target)) {
          const path = target.replace(/^file:/i, "");
          out.push({ t: "file", target: path, kids: tokenize(desc || path, opts) });
        } else {
          out.push({ t: "ref", target, kids: tokenize(desc || target, opts) });
        }
        i = close + 2;
        continue;
      }
    }

    if ((c === "h") && (i === 0 || /[\s(<"'“]/.test(prev))) {
      const m = URL_RE.exec(s.slice(i));
      if (m) {
        const url = trimUrl(m[0]);
        flush();
        out.push({ t: "link", href: url, bare: true, kids: [{ t: "text", v: url }] });
        i += url.length;
        continue;
      }
    }

    const kind = markers[c];
    if (kind && PRE.test(prev) && s[i + 1] && !/\s/.test(s[i + 1]) && s[i + 1] !== c) {
      const j = findClose(s, i, c);
      if (j > i + 1) {
        const inner = s.slice(i + 1, j);
        flush();
        if (kind === "verb" || kind === "code") out.push({ t: kind, v: inner });
        else out.push({ t: kind, kids: tokenize(inner, opts) });
        i = j + 1;
        continue;
      }
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

/** Plain text of a token list (what a title reads as with the markup removed). */
export function plain(tokens) {
  return tokens
    .map((k) => (k.kids ? plain(k.kids) : k.v || ""))
    .join("");
}

export const plainText = (s) => plain(tokenize(s));

/** Short display form of a URL: host without www, plus a trimmed path. */
export function shortUrl(href, max = 48) {
  try {
    const u = new URL(href);
    const host = u.hostname.replace(/^www\./, "");
    let rest = decodeURIComponent(u.pathname + u.search).replace(/\/$/, "");
    if (rest.length > max - host.length) rest = rest.slice(0, Math.max(8, max - host.length)) + "…";
    return { host, rest };
  } catch {
    return { host: href, rest: "" };
  }
}
