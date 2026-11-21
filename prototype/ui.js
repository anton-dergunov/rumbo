// DOM helpers shared by every view. Vault text only ever reaches the page as text nodes.

import { tokenize, shortUrl } from "./inline.js";
import { actions } from "./state.js";

export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style") el.setAttribute("style", v);
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else if (k === "text") el.textContent = v;
      else el.setAttribute(k, v === true ? "" : v);
    }
  }
  append(el, kids);
  return el;
}

export function append(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return el;
}

/** A Material Symbols glyph by name (ligature). */
export const icon = (name, cls = "") => h("span", { class: `ms ${cls}`, "aria-hidden": "true" }, name || "");

// ---------------------------------------------------------------- inline markup

let model = null;
export function setModel(m) {
  model = m;
}

function renderTokens(tokens, out) {
  for (const t of tokens) {
    switch (t.t) {
      case "text":
        out.append(t.v);
        break;
      case "b":
        out.append(renderTokens(t.kids, h("b")));
        break;
      case "i":
        out.append(renderTokens(t.kids, h("i")));
        break;
      case "s":
        out.append(renderTokens(t.kids, h("s")));
        break;
      case "u":
        out.append(renderTokens(t.kids, h("u")));
        break;
      case "code":
      case "verb": {
        const file = model && /\.org$/.test(t.v) ? model.findFile(t.v) : null;
        if (file) {
          out.append(
            h(
              "a",
              {
                class: "fileref",
                href: `?file=${encodeURIComponent(file.path)}`,
                onclick: (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  actions.openFile(file.path);
                },
              },
              icon(file.icon),
              file.name,
            ),
          );
        } else out.append(h("code", { class: "verb" }, t.v));
        break;
      }
      case "link": {
        const a = h("a", { class: "lnk", href: t.href, target: "_blank", rel: "noopener", onclick: (e) => e.stopPropagation() });
        if (t.bare) {
          const { host, rest } = shortUrl(t.href, 40);
          a.classList.add("bare");
          a.append(h("span", { class: "host" }, host), h("span", { class: "rest" }, rest));
        } else renderTokens(t.kids, a);
        out.append(a);
        break;
      }
      case "obsidian":
        out.append(h("span", { class: "obs", title: "Obsidian note" }, icon("edit_note"), t.v));
        break;
      case "file":
        out.append(h("span", { class: "extfile", title: t.target }, icon("description"), renderTokens(t.kids, h("span"))));
        break;
      default:
        out.append(renderTokens(t.kids || [{ t: "text", v: t.target || "" }], h("span", { class: "ref" })));
    }
  }
  return out;
}

export function inline(text) {
  return renderTokens(tokenize(text), document.createDocumentFragment());
}

// ---------------------------------------------------------------- blocks

export function blocks(list) {
  const frag = document.createDocumentFragment();
  for (const b of list) frag.append(block(b));
  return frag;
}

function block(b) {
  switch (b.type) {
    case "para": {
      const p = h("p");
      b.lines.forEach((line, i) => {
        if (i) p.append(h("br"));
        p.append(inline(line));
      });
      return p;
    }
    case "links":
      return h(
        "ul",
        { class: "links" },
        b.urls.map((u) => {
          const t = tokenize(u)[0];
          if (!t || t.t !== "link") return h("li", null, inline(u));
          const { host, rest } = shortUrl(t.href, 64);
          return h(
            "li",
            null,
            h(
              "a",
              { href: t.href, target: "_blank", rel: "noopener", onclick: (e) => e.stopPropagation() },
              icon("link"),
              t.bare ? null : h("span", { class: "desc" }, renderTokens(t.kids, document.createDocumentFragment())),
              h("span", { class: "host" }, host),
              h("span", { class: "rest" }, rest),
            ),
          );
        }),
      );
    case "list":
      return h(
        "ul",
        { class: "olist" },
        b.items.map((it, n) =>
          h(
            "li",
            { class: it.ordered ? "ord" : "", style: `--depth:${it.depth}`, "data-n": it.ordered ? it.bullet : null },
            it.checkbox != null ? icon(it.checkbox === " " ? "check_box_outline_blank" : "check_box", "cb") : null,
            it.text.split("\n").map((l, i) => [i ? h("br") : null, inline(l)]),
          ),
        ),
      );
    case "src":
      return h("pre", { class: "src", "data-lang": b.lang || b.kind }, b.lines.join("\n"));
    case "table":
      return h(
        "div",
        { class: "tablewrap" },
        h("table", null, b.rows.map((r, i) => h("tr", null, r.map((c) => h(i ? "td" : "th", null, inline(c)))))),
      );
    case "rule":
      return h("hr");
    default:
      return h("div");
  }
}

// ---------------------------------------------------------------- marks

export function stateMark(s) {
  if (!s) return null;
  return h("span", { class: "mark", "data-s": s, title: s }, h("i", { class: "dot" }), h("b", null, s));
}

export function prioMark(p) {
  return p ? h("span", { class: "prio", "data-p": p, title: `Priority ${p}` }, p) : null;
}

export function tagList(tags) {
  if (!tags || !tags.length) return null;
  return h(
    "span",
    { class: "tags" },
    tags.map((t) => h("span", { class: "tag", title: model?.ws.tags[t]?.means || t }, t)),
  );
}

const DAY = 86400000;
export function relDay(dateStr, today = new Date()) {
  const d = new Date(`${dateStr}T00:00:00`);
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const n = Math.round((d - t) / DAY);
  if (n === 0) return "today";
  const abs = Math.abs(n);
  const unit = abs >= 14 ? `${Math.round(abs / 7)}w` : `${abs}d`;
  return n > 0 ? `in ${unit}` : `${unit} ago`;
}

export function planningChips(pl) {
  const out = [];
  for (const [k, ic] of [["deadline", "flag"], ["scheduled", "event"]]) {
    const s = pl?.[k];
    if (!s) continue;
    const d = new Date(`${s.date}T00:00:00`);
    const label = d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
    const rel = relDay(s.date);
    out.push(
      h(
        "span",
        { class: `when when-${k} ${rel.endsWith("ago") ? "past" : rel === "today" ? "today" : ""}`, title: `${k} ${s.raw}` },
        icon(ic),
        `${label}${s.time ? " " + s.time : ""}`,
        h("em", null, rel),
      ),
    );
  }
  return out.length ? h("span", { class: "whens" }, out) : null;
}

/** Signal counts for a file or section: the states that matter, never the sea of TODO. */
export function signal(c, { total = false } = {}) {
  const bits = [];
  if (c.INPR) bits.push(h("span", { class: "sg", "data-s": "INPR", title: "In progress" }, h("i"), c.INPR));
  if (c.A) bits.push(h("span", { class: "sg", "data-s": "A", title: "High priority" }, h("i"), c.A));
  if (c.NEXT) bits.push(h("span", { class: "sg", "data-s": "NEXT", title: "Next" }, h("i"), c.NEXT));
  if (c.WAIT) bits.push(h("span", { class: "sg", "data-s": "WAIT", title: "Waiting" }, h("i"), c.WAIT));
  if (total && c.open) bits.push(h("span", { class: "sg total", title: "Open tasks" }, `${c.open} open`));
  return bits.length ? h("span", { class: "signal" }, bits) : null;
}

export function crumbs(heading, { file, sep = "›" } = {}) {
  const parts = [];
  if (file) parts.push(h("span", { class: "cr-file" }, icon(file.icon), file.name));
  for (const p of heading.path) parts.push(h("span", { class: "cr" }, inline(p.title)));
  const out = h("span", { class: "crumbs" });
  parts.forEach((p, i) => {
    if (i) out.append(h("span", { class: "sep" }, sep));
    out.append(p);
  });
  return out;
}
