// An Obsidian note as the page draws it (docs/plans/real-app.md §6). Adapted from carrel's browser
// Markdown module (carrel/src/carrel/static/markdown.js): GFM through marked, maths as placeholders
// that KaTeX draws after sanitising, Obsidian callouts. Rumbo adds what this vault's notes use:
//   [[Note]] [[Note|alias]] [[Note#Heading]] [[#Heading]]   wiki links, found by name in the index
//   ![[picture.png|300]]                                   image embeds, fetched as blobs
//   [^1] … [^1]: Authors (year), [*Title*](link).          footnotes, numbered in order of use
//   ==highlight==   %%comment%%   front matter (left out)
// Each is a marked extension, so nothing changes inside code.
//
// `noteHtml` is pure (no DOM), so node tests it; its HTML is not yet safe. `drawNote` sanitises it
// with DOMPurify before it enters the page. Style attributes are dropped: the CSP forbids them.
// Mermaid blocks stay as their source (drawing them needs inline <style>, which the CSP forbids).

import { Marked } from "./vendor/marked.esm.js";

const BLOCK_MATHS = [/^ {0,3}\$\$([\s\S]+?)\$\$[^\S\n]*(?:\n|$)/, /^ {0,3}\\\[([\s\S]+?)\\\][^\S\n]*(?:\n|$)/];
const DISPLAY = [/^\$\$([\s\S]+?)\$\$/, /^\\\[([\s\S]+?)\\\]/];
// A `$` follows Pandoc's rule (no space inside either `$`, no digit after the closing one), so
// "$5 and $10" stays text.
const INLINE = [/^\\\(([\s\S]+?)\\\)/, /^\$(?![\s$])((?:\\.|[^\\$\n])+?)(?<![\s\\])\$(?!\d)/];

const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|bmp)$/i;
const FRONT_MATTER = /^---[^\S\n]*\r?\n[\s\S]*?\r?\n---[^\S\n]*(?:\r?\n|$)/;

export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// What the extensions need while one note is parsed: the lookups and the footnotes. A parse is
// synchronous, so one module-level context is enough.
let ctx = null;

/** `[[target#heading|alias]]` → its parts; a table's `\|` is a plain `|` by now. */
export function parseWikiTarget(inner) {
  const bar = inner.indexOf("|");
  const target = (bar >= 0 ? inner.slice(0, bar) : inner).replace(/\\$/, "").trim();
  const alias = bar >= 0 ? inner.slice(bar + 1).trim() : "";
  const hash = target.indexOf("#");
  const name = (hash >= 0 ? target.slice(0, hash) : target).trim().replace(/\.md$/i, "");
  const heading = hash >= 0 ? target.slice(hash + 1).replace(/^\^/, "").trim() : "";
  return { name, heading, alias };
}

function wikiLink({ name, heading, alias }) {
  const shown = alias || (name ? (heading ? `${name} › ${heading}` : name) : heading);
  if (!name) return `<a class="wl" data-heading="${escapeHtml(heading)}">${escapeHtml(shown)}</a>`;
  const found = ctx.note(name);
  if (!found) return `<span class="wl missing" title="Not in the Obsidian vault">${escapeHtml(shown)}</span>`;
  return `<a class="wl" data-note="${escapeHtml(found)}"${heading ? ` data-heading="${escapeHtml(heading)}"` : ""}>${escapeHtml(shown)}</a>`;
}

function embed(inner) {
  const bar = inner.indexOf("|");
  const name = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
  const size = bar >= 0 ? inner.slice(bar + 1).trim() : "";
  if (IMAGE.test(name)) {
    const path = ctx.file(name);
    if (!path) return `<span class="wl missing" title="Not in the Obsidian vault">${escapeHtml(name)}</span>`;
    const [w, hgt] = /^(\d+)(?:x(\d+))?$/.exec(size)?.slice(1) || [];
    return `<img class="embed" data-embed="${escapeHtml(path)}" alt="${escapeHtml(name)}"${w ? ` width="${w}"` : ""}${hgt ? ` height="${hgt}"` : ""}>`;
  }
  // A note (or a heading of one) embedded: a link to it, not its text.
  if (!/\.[a-z0-9]+$/i.test(name.replace(/#.*$/, "")) || /\.md$/i.test(name)) return wikiLink(parseWikiTarget(inner));
  return `<span class="embed-other" title="Shown in Obsidian only">${escapeHtml(name)}</span>`;
}

function footnoteRef(id) {
  const def = ctx.defs.get(id);
  if (def == null) return null;
  let n = ctx.order.indexOf(id) + 1;
  if (!n) n = ctx.order.push(id);
  const uses = (ctx.uses.get(id) || 0) + 1;
  ctx.uses.set(id, uses);
  const ref = `note-fnref-${n}${uses > 1 ? `-${uses}` : ""}`;
  return `<sup class="fn-ref"><a id="${ref}" data-jump="note-fn-${n}">${n}</a></sup>`;
}

const extensions = [
  {
    name: "comment",
    level: "block",
    start: (src) => src.match(/^%%/m)?.index,
    tokenizer(src) {
      const m = /^%%[\s\S]*?%%[^\S\n]*(?:\n|$)/.exec(src);
      if (m) return { type: "comment", raw: m[0] };
    },
    renderer: () => "",
  },
  {
    name: "commentInline",
    level: "inline",
    start: (src) => src.indexOf("%%") >= 0 ? src.indexOf("%%") : undefined,
    tokenizer(src) {
      const m = /^%%[\s\S]*?%%/.exec(src);
      if (m) return { type: "commentInline", raw: m[0] };
    },
    renderer: () => "",
  },
  {
    name: "footnoteDef",
    level: "block",
    start: (src) => src.match(/^\[\^[^\]\s]+\]:/m)?.index,
    tokenizer(src) {
      // One line, as the vault writes them, plus any indented lines under it.
      const m = /^\[\^([^\]\s]+)\]:[^\S\n]*([^\n]*(?:\n(?: {2,}|\t)[^\n]*)*)(?:\n|$)/.exec(src);
      if (!m) return undefined;
      if (!ctx.defs.has(m[1])) ctx.defs.set(m[1], m[2].replace(/\n\s+/g, " ").trim());
      return { type: "footnoteDef", raw: m[0] };
    },
    renderer: () => "",
  },
  {
    name: "mathsBlock",
    level: "block",
    start: (src) => src.match(/^ {0,3}(?:\$\$|\\\[)/m)?.index,
    tokenizer(src) {
      for (const form of BLOCK_MATHS) {
        const m = form.exec(src);
        if (m) return { type: "mathsBlock", raw: m[0], tex: m[1].trim() };
      }
    },
    renderer: ({ tex }) => `<div class="maths display">${escapeHtml(tex)}</div>\n`,
  },
  {
    name: "maths",
    level: "inline",
    // An escaped `$` is the escape tokenizer's, not a formula's.
    start: (src) => src.match(/(?<!\\)\$|\\[([]/)?.index,
    tokenizer(src) {
      for (const [forms, display] of [
        [DISPLAY, true],
        [INLINE, false],
      ]) {
        for (const form of forms) {
          const m = form.exec(src);
          if (m) return { type: "maths", raw: m[0], tex: m[1].trim(), display };
        }
      }
    },
    renderer: ({ tex, display }) => `<span class="maths${display ? " display" : ""}">${escapeHtml(tex)}</span>`,
  },
  {
    name: "embed",
    level: "inline",
    start: (src) => (src.indexOf("![[") >= 0 ? src.indexOf("![[") : undefined),
    tokenizer(src) {
      const m = /^!\[\[([^\]\n]+)\]\]/.exec(src);
      if (m) return { type: "embed", raw: m[0], inner: m[1] };
    },
    renderer: ({ inner }) => embed(inner),
  },
  {
    name: "wikiLink",
    level: "inline",
    start: (src) => (src.indexOf("[[") >= 0 ? src.indexOf("[[") : undefined),
    tokenizer(src) {
      const m = /^\[\[([^\]\n]+)\]\]/.exec(src);
      if (m) return { type: "wikiLink", raw: m[0], link: parseWikiTarget(m[1]) };
    },
    renderer: ({ link }) => wikiLink(link),
  },
  {
    name: "footnoteRef",
    level: "inline",
    start: (src) => (src.indexOf("[^") >= 0 ? src.indexOf("[^") : undefined),
    tokenizer(src) {
      const m = /^\[\^([^\]\s]+)\]/.exec(src);
      if (m) return { type: "footnoteRef", raw: m[0], id: m[1] };
    },
    renderer: ({ id, raw }) => footnoteRef(id) ?? escapeHtml(raw),
  },
  {
    name: "highlight",
    level: "inline",
    start: (src) => (src.indexOf("==") >= 0 ? src.indexOf("==") : undefined),
    tokenizer(src) {
      const m = /^==(?=\S)([^\n]*?\S)==/.exec(src);
      if (m) return { type: "highlight", raw: m[0], tokens: this.lexer.inlineTokens(m[1]) };
    },
    renderer(token) {
      return `<mark>${this.parser.parseInline(token.tokens)}</mark>`;
    },
  },
];

/**
 * A wiki link's alias bar in a table row written without its `\` (Obsidian draws it as a link
 * anyway) is escaped, so the table doesn't split the link across two cells. Code fences are left
 * alone.
 */
export function escapeTableBars(text) {
  let fence = null;
  return text
    .split("\n")
    .map((line) => {
      const f = /^ {0,3}(`{3,}|~{3,})/.exec(line);
      if (f && (!fence || f[1][0] === fence[0])) {
        fence = fence ? null : f[1];
        return line;
      }
      if (fence || !/^\s*\|/.test(line)) return line;
      return line.replace(/\[\[[^\]\n]*\]\]/g, (link) => link.replace(/(?<!\\)\|/g, "\\|"));
    })
    .join("\n");
}

// Raw HTML in a note (`<mark style="…">`, `<br>`) keeps its tags but loses its style attributes
// here, before any parser sees them: WebKit reports a CSP violation for a style attribute even
// while DOMPurify parses it in an inert document. DOMPurify still sanitises all of it.
const STYLE_ATTR = /\sstyle\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi;
const renderer = { html: ({ text }) => text.replace(STYLE_ATTR, "") };

// Obsidian shows a single newline as a line break (its "strict line breaks" is off by default).
const markdown = new Marked({ gfm: true, breaks: true }, { extensions, renderer });

/**
 * The note's Markdown as HTML: not yet sanitised. `note(name)` gives a note's own name if the
 * Obsidian vault has it (any case), else null; `file(name)` gives an embedded file's path, or null.
 */
export function noteHtml(text, { note = () => null, file = () => null } = {}) {
  const body = escapeTableBars(text.replace(/^﻿/, "").replace(FRONT_MATTER, ""));
  ctx = { note, file, defs: new Map(), order: [], uses: new Map() };
  try {
    let html = markdown.parse(body);
    // Definitions are read in the block pass, before any inline is drawn, so a reference before
    // its definition is found. The list follows the order of first use.
    if (ctx.order.length) {
      const items = ctx.order.map((id, i) => {
        const n = i + 1;
        return `<li id="note-fn-${n}">${markdown.parseInline(ctx.defs.get(id))} <a class="fn-back" data-jump="note-fnref-${n}" aria-label="Back to the text">↩</a></li>`;
      });
      html += `<ol class="footnotes">${items.join("")}</ol>\n`;
    }
    return html;
  } finally {
    ctx = null;
  }
}

// ---------------------------------------------------------------- in the page

// A table's text wraps, and the browser shares the width out by how much each column holds, which
// leaves a column of short entries its longest word beside one of sentences. So a short entry
// stays on one line, and a longer one keeps a few words to a line (carrel's and lectern's rule).
const SHORT_CELL = 16;

/** How a table's cell of `text` is laid out: 'short' on one line, 'wide' at least 8em wide. */
export function cellWidth(text) {
  return text.trim().length <= SHORT_CELL ? "short" : "wide";
}

const CALLOUT = /^\[!([\w-]+)\][+-]?[^\S\n]*/;

/** "abstract" → "Abstract". */
export function calloutTitle(kind, title) {
  const given = title.trim();
  return given || kind.charAt(0).toUpperCase() + kind.slice(1);
}

/**
 * Turns each sanitised `<blockquote>` that starts with `[!kind] Title` into a callout box,
 * `.callout.callout-<kind>` with a `.callout-title`. The marker and the title are read from the
 * DOM's text and written as text; what follows them stays the nodes DOMPurify left (carrel's).
 */
function drawCallouts(element) {
  for (const quote of element.querySelectorAll("blockquote")) {
    const first = quote.firstElementChild;
    if (first?.tagName !== "P") continue;
    const marker = CALLOUT.exec(first.textContent);
    if (!marker) continue;
    const kind = marker[1].toLowerCase();
    let title = "";
    let line = true;
    for (const node of [...first.childNodes]) {
      if (!line) break;
      const text = node.textContent;
      const breakAt = node.nodeType === Node.TEXT_NODE ? text.indexOf("\n") : node.nodeName === "BR" ? 0 : -1;
      if (breakAt < 0) {
        title += text;
        node.remove();
      } else {
        title += text.slice(0, breakAt);
        if (node.nodeType === Node.TEXT_NODE) node.textContent = text.slice(breakAt + 1);
        else node.remove();
        line = false;
      }
    }
    title = title.replace(CALLOUT, "");
    if (!first.textContent.trim()) first.remove();
    const box = document.createElement("div");
    box.className = `callout callout-${kind.replace(/[^\w-]/g, "")}`;
    const heading = box.appendChild(document.createElement("div"));
    heading.className = "callout-title";
    heading.textContent = calloutTitle(kind, title);
    box.append(...quote.childNodes);
    quote.replaceWith(box);
  }
}

function wrap(element, className) {
  const box = document.createElement("div");
  box.className = className;
  element.replaceWith(box);
  box.append(element);
  return box;
}

let katexCss = false;
function loadKatexCss() {
  if (katexCss) return;
  katexCss = true;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = new URL("./vendor/katex/katex.min.css", import.meta.url).href;
  document.head.append(link);
}

let purify = null;
const sanitizer = () => (purify ??= import("./vendor/purify.es.mjs").then((m) => m.default));

/**
 * Draws a note's HTML (from `noteHtml`) into `el`: sanitised, then the callouts, tables, maths and
 * images. `loadImage(path)` gives an embedded image's URL (a promise); links are left to
 * `bindNoteClicks`.
 */
export async function drawNote(el, html, { loadImage = async () => null } = {}) {
  const DOMPurify = await sanitizer();
  el.innerHTML = DOMPurify.sanitize(html, { FORBID_ATTR: ["style"], FORBID_TAGS: ["style", "form", "input", "button", "textarea", "select"] });
  drawCallouts(el);
  for (const table of el.querySelectorAll("table")) {
    wrap(table, "table");
    for (const cell of table.querySelectorAll("th, td")) cell.classList.add(cellWidth(cell.textContent));
  }
  for (const a of el.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (/^https?:/i.test(href)) {
      a.target = "_blank";
      a.rel = "noopener";
    } else if (/^#/.test(href)) {
      // A heading in this note: a jump, never a change of the URL's hash.
      a.removeAttribute("href");
      a.classList.add("wl");
      a.dataset.heading = decodeURIComponent(href.slice(1)).replace(/-/g, " ");
    } else if (/\.md(#.*)?$/i.test(href) && !/^[a-z]+:/i.test(href)) {
      // A Markdown link to another note: found by its name, as a wiki link is.
      const [path, heading = ""] = decodeURIComponent(href).split("#");
      a.removeAttribute("href");
      a.classList.add("wl");
      a.dataset.note = path.split("/").pop().replace(/\.md$/i, "");
      if (heading) a.dataset.heading = heading;
    }
  }
  const maths = el.querySelectorAll(".maths");
  if (maths.length) {
    loadKatexCss();
    const { default: katex } = await import("./vendor/katex/katex.mjs");
    for (const placeholder of maths) {
      katex.render(placeholder.textContent, placeholder, { displayMode: placeholder.classList.contains("display"), throwOnError: false });
    }
  }
  for (const img of el.querySelectorAll("img[data-embed]")) {
    img.loading = "lazy";
    loadImage(img.dataset.embed).then(
      (url) => (url ? (img.src = url) : img.classList.add("failed")),
      () => img.classList.add("failed"),
    );
  }
  return el;
}

const normal = (s) => s.toLowerCase().replace(/[\s\-_]+/g, " ").replace(/[^\p{L}\p{N} ]/gu, "").trim();

/** Scrolls `el`'s heading whose text is `heading` (Obsidian's matching: case and punctuation aside) into view. */
export function jumpToHeading(el, heading) {
  const want = normal(heading);
  const found = [...el.querySelectorAll("h1, h2, h3, h4, h5, h6")].find((x) => normal(x.textContent) === want);
  found?.scrollIntoView({ block: "start" });
  return !!found;
}

/**
 * One click handler on the note: a wiki link opens its note (`openNote(name, heading)`); a heading
 * of this note, a footnote and its way back scroll inside the page. The URL's hash never changes:
 * that would be a history entry the app doesn't know.
 */
export function bindNoteClicks(el, openNote) {
  el.addEventListener("click", (e) => {
    const a = e.target.closest?.("a");
    if (!a || !el.contains(a)) return;
    if (a.dataset.jump) {
      e.preventDefault();
      el.querySelector(`#${CSS.escape(a.dataset.jump)}`)?.scrollIntoView({ block: "center" });
    } else if (a.classList.contains("wl")) {
      e.preventDefault();
      if (a.dataset.note) openNote(a.dataset.note, a.dataset.heading || "");
      else if (a.dataset.heading) jumpToHeading(el, a.dataset.heading);
    }
  });
}
