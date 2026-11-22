// Every op on one heading, and the round trips that must give the original bytes back. Shared by
// tests/edit-properties.test.mjs and tools/vault-check.mjs, so the tests and the check on the real
// vault run the same cases.

import { parseOrg } from "../app/org.js";
import { joinLines, siblingsOf, headingKey, findHeading } from "../app/org-edit.js";
import { applyOp, makeOp, targetArg } from "../app/ops.js";
import { edgeMemory, partition, nodeIdentity, ambiguous } from "../app/spacing.js";

const within = (hd, x) => x.line >= hd.line && x.line < hd.end;

/** The ops to try on heading `hd` of `doc`: [{name, op}]. `other` is a heading outside hd's subtree, to move into. */
export function casesFor(doc, hd, other = null) {
  const op = (name, args) => makeOp(doc, name, hd, args);
  const sib = siblingsOf(doc, hd);
  const i = sib.indexOf(hd);
  const out = [
    { name: "setState", op: op("setState", { state: hd.state === "NEXT" ? "TODO" : "NEXT" }) },
    { name: "setPriority", op: op("setPriority", { priority: hd.priority ? null : "A" }) },
    { name: "setTitle", op: op("setTitle", { title: `${hd.title} (edited)` }) },
    { name: "setTags", op: op("setTags", { tags: [...hd.tags, "edited"] }) },
    { name: "setPlanning", op: op("setPlanning", { patch: { scheduled: { date: "2027-01-10" } } }) },
    { name: "setBody", op: op("setBody", { text: "A new note.\n\nWith a second paragraph." }) },
    { name: "insertAfter", op: makeOp(doc, "insertHeading", null, { ref: headingKey(doc, hd), where: "after", fields: { state: "TODO", title: "Inserted after" } }) },
    { name: "insertFirstChild", op: makeOp(doc, "insertHeading", null, { ref: headingKey(doc, hd), where: "firstChild", fields: { title: "Inserted first" } }) },
    { name: "insertLastChild", op: makeOp(doc, "insertHeading", null, { ref: headingKey(doc, hd), where: "lastChild", fields: { state: "TODO", title: "Inserted last", body: "with a note" } }) },
    { name: "deleteSubtree", op: op("deleteSubtree") },
    { name: "moveToEnd", op: op("moveSubtree", { target: { fileEnd: true, level: 1 } }) },
  ];
  if (i > 0) out.push({ name: "moveUp", op: op("moveUp") }, { name: "demote", op: op("demote") });
  if (i >= 0 && i < sib.length - 1) out.push({ name: "moveDown", op: op("moveDown") });
  if (hd.level > 1) out.push({ name: "promote", op: op("promote") });
  if (hd.children.some((c) => c.state === "DONE")) out.push({ name: "removeDone", op: makeOp(doc, "removeDone", null, { scope: headingKey(doc, hd) }) });
  if (other && !within(hd, other)) {
    out.push({ name: "moveIntoFirst", op: op("moveSubtree", { target: targetArg(doc, { into: other, at: "first" }) }) });
    out.push({ name: "moveIntoLast", op: op("moveSubtree", { target: targetArg(doc, { into: other, at: "last" }) }) });
  }
  return out;
}

/**
 * Where hd is now, as a move target that puts it back at its own level: after its previous sibling,
 * first in its parent, or before the next top-level heading. Null when no target says it (a level jump).
 */
export function placeOf(doc, hd) {
  const sib = siblingsOf(doc, hd);
  const i = sib.indexOf(hd);
  const t = i > 0 ? { after: sib[i - 1] } : hd.parent ? { into: hd.parent, at: "first" } : sib.length > 1 ? { before: sib[1] } : null;
  if (!t) return null;
  const level = t.into ? t.into.level + 1 : (t.after || t.before).level;
  return level === hd.level ? t : null;
}

/** Are all headings told apart by identity? Round trips through the edge memory need it. */
export function identitiesUnique(doc) {
  const part = partition(doc);
  return ambiguous(part.nodes.map((nd) => nodeIdentity(nd, doc.lines))).size === 0;
}

const reparse = (lines, finalNewline) => parseOrg(joinLines(lines, finalNewline));

/**
 * Round trips on heading hd that must give `text` back byte for byte:
 *   setState and back; move to `other` (or the end) and back; extract and insert back.
 * Returns [{name, ok, why}].
 */
export function roundTrips(text, hd, other = null, ctx = {}) {
  const doc = parseOrg(text);
  hd = doc.headings.find((h) => h.line === hd.line);
  if (other) other = doc.headings.find((h) => h.line === other.line) || null;
  const out = [];
  const memory = edgeMemory(doc);
  const c = { ...ctx, memory };
  const check = (name, fn) => {
    try {
      const got = fn();
      out.push({ name, ok: got === text, why: got === text ? null : "bytes differ" });
    } catch (err) {
      out.push({ name, ok: false, why: err.message });
    }
  };
  check("stateAndBack", () => {
    const r = applyOp(doc.lines, doc, makeOp(doc, "setState", hd, { state: hd.state === "NEXT" ? "TODO" : "NEXT" }), c);
    const d1 = reparse(r.lines, doc.finalNewline);
    const h1 = d1.headings.find((h) => h.line === r.at);
    return joinLines(applyOp(d1.lines, d1, makeOp(d1, "setState", h1, { state: hd.state }), c).lines, doc.finalNewline);
  });
  const back = placeOf(doc, hd);
  if (!back || !identitiesUnique(doc)) return out;
  const where = other && !within(hd, other) && other.level + 1 === hd.level ? targetArg(doc, { into: other, at: "last" }) : { fileEnd: true, level: hd.level };
  check("moveAndBack", () => {
    const r = applyOp(doc.lines, doc, makeOp(doc, "moveSubtree", hd, { target: where }), c);
    const d1 = reparse(r.lines, doc.finalNewline);
    const h1 = d1.headings.find((h) => h.line === r.at);
    const target = rekey(doc, d1, back, hd, r.at);
    return joinLines(applyOp(d1.lines, d1, makeOp(d1, "moveSubtree", h1, { target }), c).lines, doc.finalNewline);
  });
  check("extractAndBack", () => {
    const r = applyOp(doc.lines, doc, makeOp(doc, "extractSubtree", hd), c);
    const d1 = reparse(r.lines, doc.finalNewline || !r.lines.length);
    const target = rekey(doc, d1, back, hd);
    const put = applyOp(d1.lines, d1, makeOp(d1, "insertSubtree", null, { chunk: r.chunk, fromLevel: r.level, target }), c);
    return joinLines(put.lines, doc.finalNewline);
  });
  return out;
}

/**
 * A target from the old parse, found in the new one. Same-named headings are counted without the
 * moved subtree (gone after an extract, elsewhere after a move: its heading is at `movedLine`).
 */
function rekey(oldDoc, newDoc, target, hd, movedLine = -1) {
  const how = ["before", "after", "into"].find((k) => target[k]);
  const t = target[how];
  const path = (x) => x.path.map((a) => a.title).join("\u0000");
  const moved = newDoc.headings.find((x) => x.line === movedLine);
  const sameIn = (d, skip) => d.headings.filter((x) => x.title === t.title && path(x) === path(t) && !skip(x));
  const oldSame = sameIn(oldDoc, (x) => within(hd, x));
  const newSame = sameIn(newDoc, (x) => moved && within(moved, x));
  const h = oldSame.length === newSame.length ? newSame[oldSame.indexOf(t)] : null;
  if (!h) throw new Error("the place to go back to is gone");
  return targetArg(newDoc, { [how]: h, ...(target.at ? { at: target.at } : {}) });
}
