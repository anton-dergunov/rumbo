// Emacs's task-icon keys, rebuilt from Rumbo's parse (app/icon-keys.js). The expected keys are
// what Org 9.7.11 gives (`org-get-heading t t t t`, `org-get-outline-path`), checked in Emacs.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parseOrg } from "../app/org.js";
import { emacsTitle, outlinePath, iconKey, iconTask, keyOf, parseIconFile, DEFAULT_INPUTS } from "../app/icon-keys.js";
import { buildModel } from "../app/data.js";

const doc = parseOrg(
  [
    "* TODO [#A] Top [[https://x.org/a_b][Desc *bold*]] and [[file:Foo_bar.org]] [1/3] :tag:",
    "** COMMENT Mid ~code~ =Name.org=",
    "*** TODO Leaf *x* [[obsidian:Note]] :t:",
    "* Mid [50%] cookie [2/5]  spaces   inside :a:b:",
    "** NEXT [#B] COMMENT Two  [[a][b]][[c]]",
    "*** INPR [#A] Leaf [1/2] with cookie  ",
    "* Купить билеты — завтра",
    "** TODO Позвонить \"маме\"",
  ].join("\n"),
);
const [top, mid, leaf, mid2, two, leaf2, ru, ruTask] = doc.headings;

test("the title keeps its markup and cookies, and drops the keyword, priority, tags and COMMENT", () => {
  assert.equal(emacsTitle(leaf), "Leaf *x* [[obsidian:Note]]");
  assert.equal(emacsTitle(leaf2), "Leaf [1/2] with cookie");
  assert.equal(emacsTitle(mid), "Mid ~code~ =Name.org=");
  assert.equal(emacsTitle(two), "Two  [[a][b]][[c]]");
});

test("the parents are Org's outline path: cookies out, links shown as their description or target", () => {
  assert.deepEqual(outlinePath(leaf), ["Top Desc *bold* and file:Foo_bar.org", "Mid ~code~ =Name.org="]);
  assert.deepEqual(outlinePath(leaf2), ["Mid  cookie   spaces   inside", "Two  bc"]);
  assert.deepEqual(outlinePath(top), []);
});

test("the key is the fields as JSON, in Emacs's order, with parents always present when read", () => {
  assert.equal(iconKey(top), JSON.stringify({ title: "Top [[https://x.org/a_b][Desc *bold*]] and [[file:Foo_bar.org]] [1/3]", parents: [] }));
  assert.equal(iconKey(ruTask), '{"title":"Позвонить \\"маме\\"","parents":["Купить билеты — завтра"]}');
  assert.equal(iconKey(leaf, ["title"]), '{"title":"Leaf *x* [[obsidian:Note]]"}');
  assert.equal(iconKey(leaf, ["title", "parents", "body"]), null, "a body can't be built here");
  assert.deepEqual(iconTask(ru), { title: "Купить билеты — завтра", parents: [] });
  assert.equal(keyOf({ parents: ["a"], title: "t" }), '{"title":"t","parents":["a"]}');
});

test("the file's keys are read whatever way Emacs escaped them", () => {
  const file = JSON.stringify({
    tag: "F1-x",
    inputs: ["title", "parents"],
    map: {
      // The same task twice: once as JSON.stringify writes it, once with \u escapes and a
      // different field order.
      '{"title":"Позвонить \\"маме\\"","parents":["Купить билеты — завтра"]}': "call",
      '{"parents":["Top"],"title":"\\u0041 task"}': "",
      "not json": "x",
      '{"title":"bad icon"}': 7,
    },
  });
  const f = parseIconFile(file);
  assert.equal(f.tag, "F1-x");
  assert.equal(f.map.get(iconKey(ruTask)), "call");
  assert.equal(f.map.get('{"title":"A task","parents":["Top"]}'), "");
  assert.equal(f.map.size, 2);
  assert.deepEqual(parseIconFile('{"tag":"old","map":{}}').inputs, DEFAULT_INPUTS);
  assert.equal(parseIconFile("{broken").map.size, 0);
  assert.equal(parseIconFile("").map.size, 0);
});

test("the sample vault's icon file gives Emacs's icons, its \"\" no icon, and a guess fills only the rest", () => {
  const root = new URL("../prototype/sample-vault", import.meta.url).pathname;
  const walk = (dir) => readdirSync(dir).flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
  const records = walk(root).map((p) => ({ path: relative(root, p), sha: "x", text: readFileSync(p, "utf8"), work: null }));
  const m = buildModel(records);
  const items = m.agenda.flatMap((s) => s.items.map((i) => i.heading));
  const known = items.filter((h) => m.emacsIcon(h) !== undefined);
  const unknown = items.filter((h) => m.emacsIcon(h) === undefined);
  assert.ok(known.length > 10 && unknown.length > 0);
  for (const h of known) assert.equal(m.taskIcon(h), m.emacsIcon(h) || null);
  for (const h of unknown) assert.equal(m.taskIcon(h), null);
  m.guesses = new Map([...items.map((h) => [m.iconKey(h), "guessed"])]);
  for (const h of known) assert.equal(m.taskIcon(h), m.emacsIcon(h) || null, "Emacs's answer wins over a guess");
  for (const h of unknown) assert.equal(m.taskIcon(h), "guessed");
});
