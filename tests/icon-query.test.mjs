// The fallback model's arithmetic without the model (app/icon-query.js). Its query text is also
// checked against the Python matcher on every golden task (icon-model.test.mjs) and on the real
// vault (tools/icon-check.mjs).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { orgPlain, composeQuery, parseNpy, poolNormalize, scoreTop1, truncateIds } from "../app/icon-query.js";

const spec = { inputs: ["title", "parents"], normalize: "org-plain", body_chars: 400 };

test("org-plain drops cookies, keywords, priority, tags, stamps, links and emphasis as the Python does", () => {
  const cases = [
    ["TODO [#A] Book a *dentist* appointment :health:", "Book a dentist appointment"],
    ["Back up photos [2/5] [40%]", "Back up photos"],
    ["Read [[https://example.org/a][the paper]] and [[file:Notes_on_it.org]]", "Read the paper and Notes on it"],
    ["See https://example.org/path/some-page.html now", "See some page now"],
    ["Hash [[https://x.org/deadbeefcafe1234]] link", "Hash link"],
    ["Write to mailto:jane_doe@example.org today", "Write to jane doe@example today"],
    ["Pay SCHEDULED: <2027-01-10 Sun> rent", "Pay rent"],
    ["Fix /the/ =build.mjs= flake ~2x a week", "Fix the build.mjs flake ~2x a week"],
    ["Nested */bold italic/* text", "Nested bold italic text"],
    ["snake_case_name stays", "snake_case_name stays"],
    ["Ünïcode*word* stays", "Ünïcode*word* stays"],
    ["Купить *хлеб* и молоко", "Купить хлеб и молоко"],
    ["  spaced　out text  ", "spaced out text"],
    ["TODO", ""],
  ];
  for (const [raw, want] of cases) assert.equal(orgPlain(raw), want, raw);
});

test("the query is the nearest parent, then the title", () => {
  assert.equal(composeQuery({ title: "Book *dentist*", parents: ["Health", "Teeth [1/2]"] }, spec), "Teeth: Book dentist");
  assert.equal(composeQuery({ title: "Book dentist", parents: [] }, spec), "Book dentist");
  assert.equal(composeQuery({ title: "Book dentist", parents: ["[50%]"] }, spec), "Book dentist");
  assert.equal(composeQuery({ title: "Book dentist", parents: ["Teeth"] }, { ...spec, inputs: ["title"] }), "Book dentist");
});

test(".npy files are read in float16 and float32", () => {
  const dense = parseNpy(readFileSync(new URL("../app/icon-model/dense.npy", import.meta.url)));
  const prior = parseNpy(readFileSync(new URL("../app/icon-model/prior.npy", import.meta.url)));
  const names = readFileSync(new URL("../app/icon-model/names.txt", import.meta.url), "utf8").split(/\s+/).filter(Boolean);
  assert.deepEqual(dense.shape, [names.length, 384]);
  assert.deepEqual(prior.shape, [names.length]);
  // Each icon vector is unit length (fp16, so roughly).
  for (const i of [0, 1, names.length - 1]) {
    let n = 0;
    for (let d = 0; d < 384; d++) n += dense.data[i * 384 + d] ** 2;
    assert.ok(Math.abs(Math.sqrt(n) - 1) < 0.01, `row ${i}: ${Math.sqrt(n)}`);
  }
  assert.throws(() => parseNpy(new Uint8Array(16)), /not a \.npy/);
});

test("pooling averages every token and normalizes; scoring picks the best and its z", () => {
  const v = poolNormalize(new Float32Array([1, 0, 3, 0]), 2, 2);
  assert.ok(Math.abs(v[0] - 1) < 1e-6 && Math.abs(v[1]) < 1e-6);
  const dense = new Float32Array([1, 0, 0, 1, -1, 0, 0.5, 0.5]);
  const { index, z } = scoreTop1(new Float32Array([1, 0]), dense, new Float32Array([0, 0, 0, 0]), 2);
  assert.equal(index, 0);
  // scores 1, 0, -1, 0.5: mean 0.125, std √0.546875
  assert.ok(Math.abs(z - 0.875 / Math.sqrt(0.546875)) < 1e-9);
  assert.equal(scoreTop1(new Float32Array([0, 0]), dense, new Float32Array(4), 2).z, 0);
  // The prior shifts the pick.
  assert.equal(scoreTop1(new Float32Array([1, 0]), dense, new Float32Array([0, 2, 0, 0]), 2).index, 1);
});

test("truncation keeps the end token, as the tokenizers library does", () => {
  assert.deepEqual(truncateIds([0, 5, 6, 2], 64), [0, 5, 6, 2]);
  assert.deepEqual(truncateIds([0, 5, 6, 7, 8, 2], 4), [0, 5, 6, 2]);
});
