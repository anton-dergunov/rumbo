import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseOrg, parseHeadingLine, parseBlocks, agendaSections, countSubtree } from "../app/org.js";
import { tokenize, plainText, shortUrl } from "../app/inline.js";
import { parseWorkspace, sortFolders } from "../app/workspace.js";

const SAMPLE = `#+TITLE: Errands
#+SUBTITLE: Money, renting and the bicycle

Charter paragraph with *bold* text.
Second charter line.

* Current money matters
** TODO Double check that all receipts are correct
** WAIT Receive the refund for the returned kettle
SCHEDULED: <2027-01-10 Sun>
The shop says it takes two to four weeks
https://example.com/help/refunds/
** TODO [#A] Call the GP :phone:easy:
- first point
  continued
- second point
  - nested

* SIM cards
** MAYB Send the cut old driving license to DVLA
SCHEDULED: <2027-08-02 Mon> Read [[obsidian:Financial plan]] against reality
*** NEXT Deep task
`;

test("headings: only configured keywords are states", () => {
  assert.equal(parseHeadingLine("* SIM cards").state, null);
  assert.equal(parseHeadingLine("** PPO in depth").state, null);
  assert.equal(parseHeadingLine("** MLX course").title, "MLX course");
  const h = parseHeadingLine("** TODO [#A] Call the GP :phone:easy:");
  assert.deepEqual([h.level, h.state, h.priority, h.title, h.tags], [2, "TODO", "A", "Call the GP", ["phone", "easy"]]);
  assert.equal(parseHeadingLine("*bold* not a heading"), null);
});

test("document: keywords, preamble, tree, spans", () => {
  const doc = parseOrg(SAMPLE);
  assert.equal(doc.keywords.TITLE, "Errands");
  assert.equal(doc.keywords.SUBTITLE, "Money, renting and the bicycle");
  assert.equal(doc.preamble.length, 1);
  assert.deepEqual(doc.preamble[0].lines, ["Charter paragraph with *bold* text.", "Second charter line."]);
  assert.equal(doc.children.length, 2);
  const [money, sim] = doc.children;
  assert.equal(money.children.length, 3);
  assert.equal(money.line, 6);
  assert.equal(money.end, 18);
  assert.equal(sim.children[0].children[0].state, "NEXT");
  assert.equal(sim.children[0].children[0].path.length, 2);
  // Every line is accounted for by the spans: the raw text survives untouched.
  assert.equal(doc.lines.join("\n") + "\n", SAMPLE);
});

test("planning: stamps parsed, trailing text kept as body", () => {
  const doc = parseOrg(SAMPLE);
  const wait = doc.headings.find((h) => h.state === "WAIT");
  assert.equal(wait.planning.scheduled.date, "2027-01-10");
  assert.equal(wait.blocks[0].type, "para");
  assert.equal(wait.blocks[1].type, "links");
  const mayb = doc.headings.find((h) => h.state === "MAYB");
  assert.equal(mayb.planning.scheduled.date, "2027-08-02");
  assert.match(mayb.blocks[0].lines[0], /^Read \[\[obsidian:Financial plan\]\]/);
});

test("lists: continuation and nesting", () => {
  const doc = parseOrg(SAMPLE);
  const gp = doc.headings.find((h) => h.priority === "A");
  const list = gp.blocks[0];
  assert.equal(list.type, "list");
  assert.equal(list.items.length, 3);
  assert.equal(list.items[0].text, "first point\ncontinued");
  assert.equal(list.items[2].depth, 1);
});

test("blocks: src, rule, table", () => {
  const b = parseBlocks(["#+BEGIN_SRC shell", "ls -la", "#+END_SRC", "---", "| a | b |", "|---+---|", "| 1 | 2 |"]);
  assert.deepEqual(b.map((x) => x.type), ["src", "rule", "table"]);
  assert.deepEqual(b[0].lines, ["ls -la"]);
  assert.deepEqual(b[2].rows, [["a", "b"], ["1", "2"]]);
});

test("inline: emphasis border rules", () => {
  assert.deepEqual(tokenize("about ~55,000 adults and ~$7/TB"), [{ t: "text", v: "about ~55,000 adults and ~$7/TB" }]);
  assert.deepEqual(tokenize("Lucene/Elasticsearch and Deep_Learning"), [{ t: "text", v: "Lucene/Elasticsearch and Deep_Learning" }]);
  const t = tokenize("Read /How to Scale Your Model/ (DeepMind) with *Hugging Face* and =bert-base=.");
  assert.deepEqual(t.map((x) => x.t), ["text", "i", "text", "b", "text", "verb", "text"]);
  assert.equal(plainText("*Bupa Dental Care* Cannon Street"), "Bupa Dental Care Cannon Street");
  assert.equal(tokenize("(=Deep.org=)")[1].v, "Deep.org");
  assert.equal(tokenize("2*3*4").length, 1);
  assert.equal(tokenize("at ~$7/TB, (=~/.claude/=) ~x~")[1].v, "~/.claude/");
  assert.equal(tokenize("use ~x~ here", { tilde: true })[1].t, "code");
});

test("inline: links", () => {
  const t = tokenize("See [[https://arxiv.org/abs/2407.01449][ColPali]] and [[obsidian:NDCG]].");
  assert.equal(t[1].t, "link");
  assert.equal(t[1].href, "https://arxiv.org/abs/2407.01449");
  assert.equal(t[3].t, "obsidian");
  assert.equal(t[3].v, "NDCG");
  assert.equal(t[3].target, "NDCG");
  // A description is what shows; the note's name is still what opens.
  const described = tokenize("[[obsidian:Financial plan][the plan]]")[0];
  assert.deepEqual([described.t, described.target, described.v], ["obsidian", "Financial plan", "the plan"]);
  const bare = tokenize("Russian edition: https://example.com/books/x/. Next");
  assert.equal(bare[1].href, "https://example.com/books/x/");
  assert.equal(tokenize("(see https://en.wikipedia.org/wiki/Foo_(bar))")[1].href, "https://en.wikipedia.org/wiki/Foo_(bar)");
  assert.deepEqual(shortUrl("https://www.ted.com/talks/hans_rosling"), { host: "ted.com", rest: "/talks/hans_rosling" });
});

test("agenda: INPR beats [#A] beats NEXT, no duplicates, file order", () => {
  const a = parseOrg("* S\n** NEXT [#A] na\n** INPR [#A] ia\n** NEXT n1\n** TODO [#A] ta\n** WAIT w\n");
  const b = parseOrg("* S\n** NEXT n2\n** DONE [#A] done\n");
  const files = [{ path: "A.org", doc: a }, { path: "B.org", doc: b }];
  const [high, inpr, next] = agendaSections(files);
  assert.deepEqual(high.items.map((i) => i.heading.title), ["na", "ta"]);
  assert.deepEqual(inpr.items.map((i) => i.heading.title), ["ia"]);
  assert.deepEqual(next.items.map((i) => i.heading.title), ["n1", "n2"]);
  const c = countSubtree(a.children);
  assert.equal(c.open, 5);
  assert.equal(c.A, 3);
});

test("workspace: icons, order, tags", () => {
  const ws = parseWorkspace(readFileSync(new URL("../prototype/sample-vault/workspace.org", import.meta.url), "utf8"));
  assert.equal(ws.fileIcons.Blog, "edit_square");
  assert.equal(ws.folderIcons.Current, "calendar_month");
  assert.equal(ws.folderIcons.Mind, undefined, "commented-out entries are ignored");
  assert.deepEqual(ws.order, { head: [], tail: ["Current", "Vision"] });
  assert.match(ws.tags.phone.means, /small screen/);
  assert.equal(ws.tags.m, undefined);
  assert.deepEqual(
    sortFolders(["Play", "Zed", "Current", "ML", "Alpha"], { head: ["ML", "Play"], tail: ["Current"] }),
    ["ML", "Play", "Alpha", "Zed", "Current"],
  );
});
