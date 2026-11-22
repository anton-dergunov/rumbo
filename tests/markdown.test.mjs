// An Obsidian note as HTML (app/markdown.js, real-app.md §6): the pure part, before sanitising.

import { test } from "node:test";
import assert from "node:assert/strict";
import { noteHtml, parseWikiTarget, cellWidth, calloutTitle, escapeHtml, escapeTableBars } from "../app/markdown.js";

const NOTES = { "career strategy": "Career strategy", "ai systems": "AI Systems", "a<b": "A<b" };
const FILES = { "diagram.svg": "90 Meta/Images/diagram.svg", "photo.webp": "90 Meta/Images/photo.webp" };
const lookups = {
  note: (name) => NOTES[name.toLowerCase().replace(/\.md$/i, "")] ?? null,
  file: (name) => FILES[name.split("/").pop().toLowerCase()] ?? null,
};
const html = (text) => noteHtml(text, lookups);

test("front matter is left out, only at the very top", () => {
  assert.equal(html("---\ntags: [x]\n---\n\nBody").trim(), "<p>Body</p>");
  assert.match(html("Body\n\n---\nnot: front matter\n---\n"), /not: front matter/);
});

test("wiki links: found by name in any case, with an alias, a heading, or within the note", () => {
  assert.match(html("See [[career strategy]]."), /<a class="wl" data-note="Career strategy">career strategy<\/a>/);
  assert.match(html("[[AI Systems|the systems note]]"), /data-note="AI Systems">the systems note<\/a>/);
  assert.match(html("[[AI Systems#Evaluation]]"), /data-note="AI Systems" data-heading="Evaluation">AI Systems › Evaluation<\/a>/);
  assert.match(html("[[#Score]]"), /<a class="wl" data-heading="Score">Score<\/a>/);
  assert.match(html("[[AI Systems.md]]"), /data-note="AI Systems"/);
  assert.match(html("[[AI Systems#^block-1]]"), /data-heading="block-1"/);
});

test("a wiki link to a note that isn't there is shown as not found", () => {
  assert.match(html("[[Gone note]]"), /<span class="wl missing"[^>]*>Gone note<\/span>/);
});

test("wiki links in a table keep their alias (Obsidian writes the bar as \\|)", () => {
  const out = html("| A | B |\n|---|---|\n| [[AI Systems\\|systems]] | x |\n");
  assert.match(out, /<td><a class="wl" data-note="AI Systems">systems<\/a><\/td>/);
});

test("a wiki link's bar in a table works unescaped too, as in Obsidian; code fences are left alone", () => {
  const out = html("| A | B |\n|---|---|\n| [[AI Systems|systems]] | x |\n");
  assert.match(out, /<td><a class="wl" data-note="AI Systems">systems<\/a><\/td>\s*<td>x<\/td>/);
  assert.equal(escapeTableBars("```\n| [[a|b]] |\n```"), "```\n| [[a|b]] |\n```");
  assert.equal(escapeTableBars("| [[a\\|b]] | [[c|d]] |"), "| [[a\\|b]] | [[c\\|d]] |");
});

test("parseWikiTarget", () => {
  assert.deepEqual(parseWikiTarget("Note#Part|shown"), { name: "Note", heading: "Part", alias: "shown" });
  assert.deepEqual(parseWikiTarget("#Part"), { name: "", heading: "Part", alias: "" });
  assert.deepEqual(parseWikiTarget("Note.md"), { name: "Note", heading: "", alias: "" });
});

test("image embeds point at the file's path, with a width when given", () => {
  assert.match(html("![[diagram.svg|320]]"), /<img class="embed" data-embed="90 Meta\/Images\/diagram.svg" alt="diagram.svg" width="320">/);
  assert.match(html("![[photo.webp|200x100]]"), /width="200" height="100"/);
  assert.match(html("![[photo.webp|a caption]]"), /<img class="embed" data-embed="90 Meta\/Images\/photo.webp" alt="photo.webp">/);
  assert.match(html("![[nowhere.png]]"), /<span class="wl missing"[^>]*>nowhere.png<\/span>/);
});

test("a note embedded is a link to it; other files are named only", () => {
  assert.match(html("![[AI Systems]]"), /<a class="wl" data-note="AI Systems">AI Systems<\/a>/);
  assert.match(html("![[Places.base]]"), /<span class="embed-other"[^>]*>Places.base<\/span>/);
});

test("footnotes are numbered in order of use and listed at the end", () => {
  const out = html("First[^b] then[^a] and again[^b].\n\n[^a]: Alpha, [*link*](https://example.com).\n[^b]: Beta.\n");
  const refs = [...out.matchAll(/<sup class="fn-ref"><a id="([^"]+)" data-jump="([^"]+)">(\d)<\/a><\/sup>/g)].map((m) => m.slice(1));
  assert.deepEqual(refs, [
    ["note-fnref-1", "note-fn-1", "1"],
    ["note-fnref-2", "note-fn-2", "2"],
    ["note-fnref-1-2", "note-fn-1", "1"],
  ]);
  const list = /<ol class="footnotes">([\s\S]*)<\/ol>/.exec(out)[1];
  assert.match(list, /^<li id="note-fn-1">Beta\./);
  assert.match(list, /<li id="note-fn-2">Alpha, <a href="https:\/\/example.com"><em>link<\/em><\/a>/);
  assert.match(list, /data-jump="note-fnref-1"/);
  assert.doesNotMatch(out, /\[\^a\]:/);
});

test("a reference with no definition stays as text; no references, no list", () => {
  assert.match(html("Text[^9]."), /Text\[\^9\]\./);
  assert.doesNotMatch(html("Plain.\n\n[^1]: Unused."), /footnotes/);
});

test("comments are left out, inline and over several lines", () => {
  assert.equal(html("Shown %%hidden%% too").trim(), "<p>Shown  too</p>");
  assert.equal(html("%%\nall of\nthis\n%%\nAfter").trim(), "<p>After</p>");
});

test("==highlight== is a mark, and can hold other markup", () => {
  assert.match(html("Keep ==the **three** questions=="), /<mark>the <strong>three<\/strong> questions<\/mark>/);
  assert.doesNotMatch(html("a == b == c"), /<mark>/);
});

test("maths becomes placeholders holding the TeX, escaped; prices stay text", () => {
  assert.match(html("Value $E = \\sum_i p_i$ here"), /<span class="maths">E = \\sum_i p_i<\/span>/);
  assert.match(html("$$\na < b\n$$"), /<div class="maths display">a &lt; b<\/div>/);
  assert.doesNotMatch(html("A price of $5 and $10."), /maths/);
});

test("nothing changes inside code", () => {
  const out = html("`[[x]]` and\n\n```\n[[AI Systems]] ==no== %%no%% $x$ [^1]\n```\n");
  assert.match(out, /<code>\[\[x\]\]<\/code>/);
  assert.match(out, /<pre><code>\[\[AI Systems\]\] ==no== %%no%% \$x\$ \[\^1\]\n<\/code><\/pre>/);
  assert.doesNotMatch(out, /class="wl"/);
});

test("mermaid stays as its source", () => {
  assert.match(html("```mermaid\ngraph LR\n  A --> B\n```\n"), /<pre><code class="language-mermaid">graph LR\n {2}A --&gt; B\n<\/code><\/pre>/);
});

test("names are escaped in text and attributes", () => {
  assert.match(html("[[A<b]]"), /data-note="A&lt;b">A&lt;b<\/a>/);
  assert.match(html('[[x" onclick="y]]'), /<span class="wl missing"[^>]*>x&quot; onclick=&quot;y<\/span>/);
  assert.equal(escapeHtml(`<&>"'`), "&lt;&amp;&gt;&quot;&#39;");
});

test("raw HTML keeps its tags but loses style attributes, which the CSP forbids", () => {
  assert.match(html('Read <mark style="background: #FFF3A3A6;">this part</mark> twice.'), /Read <mark>this part<\/mark> twice\./);
  assert.match(html("<div style='color:red' class=\"x\">\nblock\n</div>\n"), /<div class="x">/);
  // Text that only looks like an attribute is left alone.
  assert.match(html('`<b style="x">`'), /&lt;b style=&quot;x&quot;&gt;/);
});

test("a single newline is a line break, as in Obsidian", () => {
  assert.match(html("one\ntwo"), /one<br>two/);
});

test("callout titles and table cells", () => {
  assert.equal(calloutTitle("abstract", ""), "Abstract");
  assert.equal(calloutTitle("tip", " Rule of thumb "), "Rule of thumb");
  assert.equal(cellWidth("Fig. 1, p. 3"), "short");
  assert.equal(cellWidth("a much longer entry that wraps"), "wide");
});
