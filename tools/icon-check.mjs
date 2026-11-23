#!/usr/bin/env node
// Task icons against the real data (docs/plans/real-app.md §7). Local and read-only; never commit
// the output, which quotes the vault.
//
//   node tools/icon-check.mjs [--vault DIR] [--cache FILE]
//
// 1. Keys: every key in Emacs's icon cache should be the key Rumbo builds for some heading, and
//    every agenda task Emacs has drawn should find its key. A miss is shown beside the key Rumbo
//    built for a heading with the same title, so the difference is visible.
// 2. Query text: Rumbo's `orgPlain` and `composeQuery` against the Python matcher's, on every task
//    (needs `uv`; skipped without it).

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseOrg, agendaSections, isOpen } from "../app/org.js";
import { iconTask, keyOf, parseIconFile } from "../app/icon-keys.js";
import { composeQuery } from "../app/icon-query.js";
import { args, readVault } from "./vault.mjs";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const USAGE = "Usage: node tools/icon-check.mjs [--vault DIR] [--cache FILE]";
const opt = args(USAGE);
const ci = process.argv.indexOf("--cache");
const cacheFile = ci > 0 ? process.argv[ci + 1] : join(homedir(), ".cache", "ps-task-icons", "task_cache.json");
const matcher = join(homedir(), "projects", "products", "agentic-org-planner", "scripts", "org_task_icon_matcher.py");

const files = readVault(opt.root).map((f) => ({ ...f, doc: parseOrg(f.text) }));
const cache = existsSync(cacheFile) ? parseIconFile(readFileSync(cacheFile, "utf8")) : null;
const inputs = cache?.inputs;

const byKey = new Map();
const byTitle = new Map();
const tasks = [];
for (const f of files)
  for (const h of f.doc.headings) {
    const task = iconTask(h, inputs);
    if (!task) continue;
    const key = keyOf(task);
    byKey.set(key, { f, h });
    if (!byTitle.has(task.title)) byTitle.set(task.title, []);
    byTitle.get(task.title).push(key);
    if (isOpen(h)) tasks.push({ path: f.path, line: h.line + 1, task });
  }

console.log(`${files.length} files, ${byKey.size} distinct heading keys, ${tasks.length} open tasks.`);

if (!cache) console.log(`\n1. Keys: no cache at ${cacheFile}; skipped.`);
else {
  const keys = [...cache.map.keys()];
  const missing = keys.filter((k) => !byKey.has(k));
  console.log(`\n1. Keys (cache tag ${cache.tag}, inputs ${cache.inputs.join("+")}): ${keys.length - missing.length} of ${keys.length} cached keys match a heading.`);
  for (const k of missing) {
    const t = JSON.parse(k).title;
    const near = byTitle.get(t);
    console.log(`  - cached: ${k}`);
    console.log(near ? near.map((n) => `    built:  ${n}`).join("\n") : "    (no heading with this title: deleted or renamed since)");
  }
  const agenda = agendaSections(files).flatMap((s) => s.items);
  const drawn = agenda.filter(({ heading }) => cache.map.has(keyOf(iconTask(heading, inputs))));
  console.log(`   Agenda tasks with a cached icon: ${drawn.length} of ${agenda.length}.`);
}

const py = spawnSync("uv", ["--version"], { encoding: "utf8" });
if (py.status !== 0 || !existsSync(matcher)) console.log("\n2. Query text: needs uv and agentic-org-planner's matcher; skipped.");
else {
  const spec = { inputs: ["title", "parents"], normalize: "org-plain", body_chars: 400 };
  const run = spawnSync("uv", ["run", "--no-project", "python", "-I", join(repo, "tools", "icon-golden.py"), "--queries", matcher], {
    input: JSON.stringify({ spec, tasks: tasks.map((t) => t.task) }),
    encoding: "utf8",
    maxBuffer: 1 << 28,
  });
  if (run.status !== 0) {
    console.log(`\n2. Query text: the Python side failed:\n${run.stderr}`);
    process.exit(1);
  }
  const theirs = JSON.parse(run.stdout);
  const diffs = tasks.filter((t, i) => composeQuery(t.task, spec) !== theirs[i]);
  console.log(`\n2. Query text: ${tasks.length - diffs.length} of ${tasks.length} tasks give the same query as the Python matcher.`);
  for (const t of diffs.slice(0, 40)) {
    console.log(`  - ${t.path}:${t.line}\n    rumbo:  ${JSON.stringify(composeQuery(t.task, spec))}\n    python: ${JSON.stringify(theirs[tasks.indexOf(t)])}`);
  }
}
