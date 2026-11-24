#!/usr/bin/env node
// The spacing review (docs/plans/real-app.md §5): count the vault's blank lines before headings per
// rule cell, then list every heading that goes against its cell's majority, so the owner can fix in
// Emacs what was accidental and keep what was meant. Local and read-only; never commit the output.
//
//   node tools/spacing-report.mjs [--vault DIR] [--file PATH]

import { parseOrg } from "../app/org.js";
import { countSpacing, boundaryGaps, predict, spacingTable, MIN_SAMPLES } from "../app/spacing.js";
import { args, readVault } from "./vault.mjs";

const USAGE = "Usage: node tools/spacing-report.mjs [--vault DIR] [--file PATH]\nThe vault defaults to $PS_ORG_BASE, then :current in ~/.emacs.d/vaults.eld.";

const describe = (n) => (n === 0 ? "no blank" : n === 1 ? "a blank" : `${n} blanks`);

/** The report as lines of text, for files [{path, text}]. Exported for the tests. */
export function spacingReport(files, only = null) {
  const docs = files.map((f) => ({ ...f, doc: parseOrg(f.text) }));
  const rule = countSpacing(docs.map((f) => f.doc));
  const out = [];
  out.push(`${rule.files} files. A blank line before a heading, by cell (a cell is used from ${MIN_SAMPLES} examples):`, "");
  out.push(`${"cell".padEnd(22)}${"examples".padStart(9)}  ${"blank lines: count".padEnd(26)}rule`);
  for (const r of spacingTable(rule)) {
    const counts = r.counts.map(([v, n]) => `${v}: ${n}`).join(", ");
    const why = r.total ? (r.rule == null ? `keep (too few; default ${r.fallback})` : `${r.rule}  (${r.share}%)`) : "—";
    out.push(`${r.cell.padEnd(22)}${String(r.total).padStart(9)}  ${(counts || "—").padEnd(26)}${why}`);
  }
  const against = [];
  let fit = 0;
  for (const f of docs) {
    if (only && f.path !== only) continue;
    for (const g of boundaryGaps(f.doc)) {
      const p = predict(rule, g.cell);
      if (p == null || p === g.value) fit++;
      else against.push(`${f.path}:${g.node.head + 1} — ${g.cell} — ${g.value > p ? "has" : "lacks"} ${describe(g.value > p ? g.value : p)}${g.value > 1 || p > 1 ? ` (has ${g.value}, rule ${p})` : ""}`);
    }
  }
  out.push("", `${against.length} headings go against their cell (${fit} follow it). Each is file:line — cell — what it has or lacks:`, "");
  out.push(...against);
  const byFile = new Map();
  for (const a of against) byFile.set(a.split(":")[0], (byFile.get(a.split(":")[0]) || 0) + 1);
  if (byFile.size) {
    out.push("", "By file:");
    for (const [p, n] of [...byFile].sort((a, b) => b[1] - a[1])) out.push(`${String(n).padStart(5)}  ${p}`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { root, file } = args(USAGE);
  console.log(spacingReport(readVault(root), file).join("\n"));
}
