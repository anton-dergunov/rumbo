#!/usr/bin/env node
// Run every op on every heading of a vault in memory, with the vault's own spacing counts, and
// report any invariant failure or round trip that doesn't give the original bytes back
// (docs/plans/real-app.md §8). Writes nothing; never commit the output.
//
//   node tools/vault-check.mjs [--vault DIR] [--file PATH]

import { parseOrg } from "../app/org.js";
import { applyOp } from "../app/ops.js";
import { countSpacing } from "../app/spacing.js";
import { casesFor, roundTrips } from "./op-cases.mjs";
import { args, readVault } from "./vault.mjs";

const USAGE = "Usage: node tools/vault-check.mjs [--vault DIR] [--file PATH]\nThe vault defaults to $PS_ORG_BASE, then :current in ~/.emacs.d/vaults.eld.";

const { root, file } = args(USAGE);
const files = readVault(root).map((f) => ({ ...f, doc: parseOrg(f.text) }));
const rule = countSpacing(files.map((f) => f.doc));
const ctx = { rule };
const tally = new Map(); // case name -> {ok, failed}
const failures = [];
const count = (name, ok) => {
  const t = tally.get(name) || { ok: 0, failed: 0 };
  t[ok ? "ok" : "failed"]++;
  tally.set(name, t);
};
const started = Date.now();
let skipped = 0;
let headings = 0;

for (const f of files) {
  if (file && f.path !== file) continue;
  const { doc, text } = f;
  if (doc.hasCR) {
    skipped++;
    continue;
  }
  for (const hd of doc.headings) {
    headings++;
    const other = doc.headings.find((x) => x !== hd && (x.line < hd.line || x.line >= hd.end) && x.level === 1) || null;
    for (const c of casesFor(doc, hd, other)) {
      try {
        applyOp(doc.lines, doc, c.op, ctx);
        count(c.name, true);
      } catch (err) {
        count(c.name, false);
        failures.push(`${f.path}:${hd.line + 1} ${c.name} ${err.code || "error"}: ${err.message}`);
      }
    }
    for (const t of roundTrips(text, hd, other, ctx)) {
      count(t.name, t.ok);
      if (!t.ok) failures.push(`${f.path}:${hd.line + 1} ${t.name}: ${t.why}`);
    }
  }
}

console.log(`${files.length} files, ${headings} headings${skipped ? `, ${skipped} files with CR line endings skipped (never edited)` : ""}, ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
for (const [name, t] of [...tally].sort()) console.log(`${name.padEnd(18)}${String(t.ok).padStart(7)} ok${t.failed ? `${String(t.failed).padStart(7)} FAILED` : ""}`);
console.log(failures.length ? `\n${failures.length} failures:\n${failures.join("\n")}` : "\nNo failures.");
process.exit(failures.length ? 1 : 0);
