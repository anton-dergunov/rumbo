// Org parser for Plan Viewer. Pure functions, no DOM, so it runs in node tests too.
//
// It reads only the subset of Org the vault uses: file keywords, a preamble, headings with
// state / priority / tags, planning lines, and body blocks. Every heading keeps the line span
// it came from, so later edits can rewrite one span and leave every other byte alone.

export const OPEN_STATES = ["TODO", "NEXT", "INPR", "WAIT", "MAYB"];
export const DONE_STATES = ["DONE"];
const ALL_STATES = new Set([...OPEN_STATES, ...DONE_STATES]);

const HEADING_RE = /^(\*+)[ \t]+(.*)$/;
const PRIORITY_RE = /^\[#([A-Z0-9])\][ \t]*/;
const TAGS_RE = /[ \t]+(:(?:[\w@#%]+:)+)[ \t]*$/;
const KEYWORD_RE = /^[ \t]*#\+([A-Za-z_]+):[ \t]*(.*)$/;
const PLANNING_RE = /^[ \t]*(SCHEDULED|DEADLINE|CLOSED):/;
const STAMP_RE = /(SCHEDULED|DEADLINE|CLOSED):[ \t]*([<[])(\d{4})-(\d{2})-(\d{2})(?:[ \t]+[A-Za-z]{2,3}\.?)?(?:[ \t]+(\d{1,2}:\d{2})(?:-(\d{1,2}:\d{2}))?)?(?:[ \t]+[.+-]+\d+[hdwmy](?:\/\d+[hdwmy])?)*[>\]]/g;
const BEGIN_RE = /^[ \t]*#\+begin_(\w+)(?:[ \t]+(.*))?$/i;
const DRAWER_RE = /^[ \t]*:([\w-]+):[ \t]*$/;
const LIST_RE = /^([ \t]*)([-+]|[ \t]+\*|\d+[.)])[ \t]+(?:\[([ xX-])\][ \t]+)?(.*)$/;
const RULE_RE = /^[ \t]*-{3,}[ \t]*$/;
const URL_LINE_RE = /^[ \t]*(?:https?:\/\/\S+|\[\[https?:[^\]]+\](?:\[[^\]]*\])?\])[ \t]*$/;

/** Parse one heading line (without the newline) into its parts, or null if it is not a heading. */
export function parseHeadingLine(line, states = ALL_STATES) {
  const m = HEADING_RE.exec(line);
  if (!m) return null;
  let rest = m[2];
  let state = null;
  const word = /^(\S+)(?:[ \t]+|$)/.exec(rest);
  if (word && states.has(word[1])) {
    state = word[1];
    rest = rest.slice(word[0].length);
  }
  let priority = null;
  const p = PRIORITY_RE.exec(rest);
  if (p) {
    priority = p[1];
    rest = rest.slice(p[0].length);
  }
  let tags = [];
  const t = TAGS_RE.exec(rest);
  if (t) {
    tags = t[1].split(":").filter(Boolean);
    rest = rest.slice(0, t.index);
  }
  return { level: m[1].length, state, priority, title: rest.trim(), tags };
}

/** Pull SCHEDULED/DEADLINE/CLOSED stamps out of a planning line; return them and any leftover text. */
export function parsePlanning(line) {
  const planning = {};
  let leftover = line;
  for (const m of line.matchAll(STAMP_RE)) {
    planning[m[1].toLowerCase()] = {
      active: m[2] === "<",
      date: `${m[3]}-${m[4]}-${m[5]}`,
      time: m[6] || null,
      end: m[7] || null,
      raw: m[0].slice(m[0].indexOf(m[2])),
    };
    leftover = leftover.replace(m[0], "");
  }
  return { planning, leftover: leftover.trim() };
}

/**
 * Split body lines into display blocks:
 *   para  {lines}            consecutive prose lines (line breaks kept)
 *   links {urls}             a run of lines that are each just a URL / link
 *   list  {items:[{depth, bullet, checkbox, text}]}
 *   src   {lang, lines}      #+begin_X … #+end_X, shown verbatim
 *   table {rows}             | a | b | lines
 *   rule  {}                 a line of dashes
 * Blank lines separate blocks and are otherwise dropped (the raw text keeps them).
 */
export function parseBlocks(lines) {
  const blocks = [];
  let i = 0;
  const push = (b) => blocks.push(b);
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    const begin = BEGIN_RE.exec(line);
    if (begin) {
      const kind = begin[1].toLowerCase();
      const end = new RegExp(`^[ \\t]*#\\+end_${kind}\\b`, "i");
      const body = [];
      i++;
      while (i < lines.length && !end.test(lines[i])) body.push(lines[i++]);
      i++;
      push({ type: "src", kind, lang: (begin[2] || "").split(/\s+/)[0] || "", lines: body });
      continue;
    }
    if (DRAWER_RE.test(line) && !/^[ \t]*:END:/i.test(line)) {
      // Property / logbook drawers: skip to :END: (the vault has none today).
      let j = i + 1;
      while (j < lines.length && !/^[ \t]*:END:[ \t]*$/i.test(lines[j])) j++;
      if (j < lines.length) {
        i = j + 1;
        continue;
      }
    }
    if (RULE_RE.test(line)) {
      push({ type: "rule" });
      i++;
      continue;
    }
    if (/^[ \t]*\|/.test(line)) {
      const rows = [];
      while (i < lines.length && /^[ \t]*\|/.test(lines[i])) {
        const row = lines[i++].trim();
        if (/^\|[-+|]+\|?$/.test(row)) continue;
        rows.push(row.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
      }
      push({ type: "table", rows });
      continue;
    }
    if (URL_LINE_RE.test(line)) {
      const urls = [];
      while (i < lines.length && URL_LINE_RE.test(lines[i])) urls.push(lines[i++].trim());
      push({ type: "links", urls });
      continue;
    }
    const li = LIST_RE.exec(line);
    if (li) {
      const items = [];
      const indents = [];
      while (i < lines.length) {
        const m = LIST_RE.exec(lines[i]);
        if (!m) {
          // Continuation: a non-blank line indented past the last bullet belongs to that item.
          const last = items[items.length - 1];
          const ind = /^[ \t]*/.exec(lines[i])[0].length;
          if (last && lines[i].trim() && ind > last.indent && !URL_LINE_RE.test(lines[i])) {
            last.text += "\n" + lines[i].trim();
            i++;
            continue;
          }
          break;
        }
        const indent = m[1].length;
        while (indents.length && indents[indents.length - 1] > indent) indents.pop();
        if (!indents.length || indents[indents.length - 1] < indent) indents.push(indent);
        items.push({
          indent,
          depth: indents.length - 1,
          bullet: m[2].trim(),
          ordered: /\d/.test(m[2]),
          checkbox: m[3] === undefined ? null : m[3],
          text: m[4],
        });
        i++;
      }
      push({ type: "list", items });
      continue;
    }
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !LIST_RE.test(lines[i]) &&
      !BEGIN_RE.test(lines[i]) &&
      !RULE_RE.test(lines[i]) &&
      !URL_LINE_RE.test(lines[i]) &&
      !/^[ \t]*\|/.test(lines[i])
    )
      para.push(lines[i++]);
    push({ type: "para", lines: para });
  }
  return blocks;
}

/**
 * Parse a whole file.
 * Returns {keywords, preamble, children, headings, lines}. Each heading:
 *   {id, level, state, priority, title, tags, planning, blocks, children, parent,
 *    line, bodyStart, bodyEnd, end, path}
 * Line numbers are 0-based; `end` is exclusive and covers the whole subtree.
 */
export function parseOrg(text, opts = {}) {
  const states = opts.states ? new Set(opts.states) : ALL_STATES;
  const idPrefix = opts.idPrefix || "h";
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();

  const keywords = {};
  const root = { level: 0, children: [], id: null };
  const headings = [];
  const stack = [root];
  let current = null;
  let preambleLines = [];
  let bodyLines = [];

  const closeBody = (endLine) => {
    if (current) {
      current.bodyEnd = endLine;
      current.blocks = parseBlocks(bodyLines);
      current.bodyText = bodyLines.join("\n").trim();
    }
    bodyLines = [];
  };

  for (let n = 0; n < lines.length; n++) {
    const line = lines[n];
    const h = line.startsWith("*") ? parseHeadingLine(line, states) : null;
    if (h) {
      closeBody(n);
      while (stack.length > 1 && stack[stack.length - 1].level >= h.level) {
        stack.pop().end = n;
      }
      const parent = stack[stack.length - 1];
      const node = {
        id: `${idPrefix}${headings.length}`,
        ...h,
        planning: {},
        blocks: [],
        bodyText: "",
        children: [],
        parent: parent === root ? null : parent,
        line: n,
        bodyStart: n + 1,
        bodyEnd: n + 1,
        end: lines.length,
      };
      node.path = node.parent ? [...node.parent.path, node.parent] : [];
      parent.children.push(node);
      headings.push(node);
      stack.push(node);
      current = node;
      // A planning line sits directly under the heading. Text after the stamps is body text.
      if (n + 1 < lines.length && PLANNING_RE.test(lines[n + 1])) {
        const { planning, leftover } = parsePlanning(lines[n + 1]);
        node.planning = planning;
        node.planningLine = n + 1;
        if (leftover) bodyLines.push(leftover);
        n++;
      }
      continue;
    }
    if (current) {
      bodyLines.push(line);
    } else {
      const kw = KEYWORD_RE.exec(line);
      if (kw && !/^begin_|^end_/i.test(kw[1])) keywords[kw[1].toUpperCase()] = kw[2].trim();
      else preambleLines.push(line);
    }
  }
  closeBody(lines.length);
  while (stack.length > 1) stack.pop().end = lines.length;

  return {
    keywords,
    preamble: parseBlocks(preambleLines),
    children: root.children,
    headings,
    lines,
  };
}

export const isTask = (h) => !!h.state;
export const isOpen = (h) => !!h.state && OPEN_STATES.includes(h.state);

/** Count what a subtree holds, for badges: {tasks, open, NEXT, INPR, WAIT, MAYB, A}. */
export function countSubtree(nodes) {
  const c = { tasks: 0, open: 0, TODO: 0, NEXT: 0, INPR: 0, WAIT: 0, MAYB: 0, DONE: 0, A: 0 };
  const walk = (list) => {
    for (const h of list) {
      if (h.state) {
        c.tasks++;
        c[h.state] = (c[h.state] || 0) + 1;
        if (isOpen(h)) c.open++;
        if (h.priority === "A" && isOpen(h)) c.A++;
      }
      walk(h.children);
    }
  };
  walk(nodes);
  return c;
}

/**
 * The three pull sections of the Emacs agenda `c`, in the same precedence:
 *   High-priority  [#A] and open, but not INPR      (tags-todo "+PRIORITY=\"A\"/-INPR")
 *   In progress    INPR                              (todo "INPR")
 *   Next up        NEXT without [#A]                 (tags-todo "-PRIORITY=\"A\"/NEXT")
 * `files` must already be in agenda order (Emacs sorts the paths with string<).
 */
export function agendaSections(files) {
  const high = [];
  const inpr = [];
  const next = [];
  for (const file of files) {
    for (const h of file.doc.headings) {
      if (!isOpen(h)) continue;
      const item = { file, heading: h };
      if (h.state === "INPR") inpr.push(item);
      else if (h.priority === "A") high.push(item);
      else if (h.state === "NEXT") next.push(item);
    }
  }
  return [
    { key: "high", title: "High priority", items: high },
    { key: "inpr", title: "In progress", items: inpr },
    { key: "next", title: "Next up", items: next },
  ];
}
