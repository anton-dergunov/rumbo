// Read the viewer's settings out of the vault's own workspace.org, so Emacs and the viewer share
// one source: file icons, folder icons, whole-folder icons, the folder order and the tag meanings.
// Only the literal forms workspace.org uses are understood; anything else is ignored.

function stripComments(src) {
  return src
    .split("\n")
    .map((l) => l.replace(/;.*$/, ""))
    .join("\n");
}

function lispBlocks(text) {
  const out = [];
  const re = /#\+begin_src\s+emacs-lisp[^\n]*\n([\s\S]*?)#\+end_src/gi;
  for (const m of text.matchAll(re)) out.push(stripComments(m[1]));
  return out.join("\n");
}

/** The parenthesised form that starts at `start` (which must point at "("), or "". */
function sexpAt(src, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return src.slice(start, i + 1);
  }
  return "";
}

function formAfter(src, head) {
  const at = src.indexOf(head);
  if (at < 0) return "";
  let open = src.lastIndexOf("(", at);
  return sexpAt(src, open);
}

function pairs(form) {
  const map = {};
  for (const m of form.matchAll(/\(\s*"([^"]+)"\s*\.\s*"([^"]+)"\s*\)/g)) map[m[1]] = m[2];
  return map;
}

export function parseWorkspace(text) {
  const src = lispBlocks(text || "");
  const fileIcons = {};
  // ps/material-icons-add may be called more than once; merge them all.
  let idx = 0;
  while ((idx = src.indexOf("ps/material-icons-add", idx)) >= 0) {
    Object.assign(fileIcons, pairs(sexpAt(src, src.lastIndexOf("(", idx))));
    idx += 10;
  }
  const folderIcons = pairs(formAfter(src, "ps/material-icons-folder-map"));
  const folderContentIcons = pairs(formAfter(src, "ps/material-icons-folder-contents-map"));

  let order = { head: [], tail: [] };
  const orderForm = formAfter(src, "ps/file-tree-order");
  if (orderForm) {
    const tokens = [...orderForm.matchAll(/"([^"]+)"|(:rest)/g)].map((m) => m[1] || m[2]);
    const rest = tokens.indexOf(":rest");
    order = rest < 0 ? { head: tokens, tail: [] } : { head: tokens.slice(0, rest), tail: tokens.slice(rest + 1) };
  }

  const tags = {};
  for (const m of src.matchAll(/\(:name\s+"([^"]+)"([\s\S]*?)\)/g)) {
    const means = /:means\s+"((?:[^"\\]|\\.)*)"/.exec(m[2]);
    const kind = /:kind\s+"([^"]+)"/.exec(m[2]);
    if (means) tags[m[1]] = { means: means[1], kind: kind ? kind[1] : "" };
  }

  return { fileIcons, folderIcons, folderContentIcons, order, tags };
}

/** Sort folder names the way the Emacs file tree does: pinned head, alphabetical middle, pinned tail. */
export function sortFolders(names, order) {
  const rank = (n) => {
    const h = order.head.indexOf(n);
    if (h >= 0) return [0, h];
    const t = order.tail.indexOf(n);
    if (t >= 0) return [2, t];
    return [1, 0];
  };
  return [...names].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    return ra[0] - rb[0] || ra[1] - rb[1] || (a < b ? -1 : a > b ? 1 : 0);
  });
}
