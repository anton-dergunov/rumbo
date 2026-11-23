#!/usr/bin/env node
// Write tests/icon-golden.json: the Python matcher's answers for synthetic tasks, which the icon
// tests hold Rumbo's JS to (the query text, the token ids, and the int8 model's top-1 and z).
// The tasks are the sample vault's open tasks and some written here; nothing from the real vault.
// Run again after changing app/icon-model/ (needs uv):
//
//   RUMBO_ICON_MODEL_DIR=<dir with model_int8.onnx and tokenizer.json> node tools/icon-golden.mjs

import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseOrg, isOpen } from "../app/org.js";
import { isIncluded } from "../app/vault-files.js";
import { iconTask } from "../app/icon-keys.js";

const repo = resolve(fileURLToPath(new URL("..", import.meta.url)));
const modelDir = process.env.RUMBO_ICON_MODEL_DIR || join(homedir(), "projects/research/task-concept-retrieval/.cache/onnx/F1-all-kd-final");
const matcher = process.env.RUMBO_ICON_MATCHER || join(homedir(), "projects/products/agentic-org-planner/scripts/org_task_icon_matcher.py");
const bundle = join(repo, "app", "icon-model");
const manifest = JSON.parse(readFileSync(join(bundle, "manifest.json"), "utf8"));

const sample = join(repo, "prototype", "sample-vault");
const walk = (dir) => readdirSync(dir).sort().flatMap((n) => (statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)) : [join(dir, n)]));
const tasks = [];
for (const p of walk(sample)) {
  if (!isIncluded(relative(sample, p))) continue;
  for (const h of parseOrg(readFileSync(p, "utf8")).headings) if (isOpen(h) && iconTask(h)) tasks.push(iconTask(h, manifest.query.inputs));
}

// Written here: other languages, markup, links, stamps, and a title longer than 64 tokens.
const extra = [
  ["Llamar al *dentista* para pedir cita", ["Salud"]],
  ["Купить билеты на поезд до Москвы", ["Поездки"]],
  ["Renew the passport before [[https://example.org/visa_rules.html][the visa]] trip", ["Travel", "Documents"]],
  ["Read [[obsidian:Attention Is All You Need]] again", ["Papers"]],
  ["Fix /the/ =build.mjs= flake ~2x a week", []],
  ["Pay the council tax SCHEDULED: <2027-01-10 Sun>", ["Money"]],
  ["Write to mailto:someone@example.org about the lease", ["Home"]],
  ["Back up photos [2/5]", ["Photos [40%]"]],
  ["Buy 🍎 apples and 🥖 bread", ["Errands"]],
  ["Revisar el presupuesto — mañana", ["Trabajo"]],
  ["Plan a very long weekend trip ".repeat(8).trim(), ["Holidays"]],
].map(([title, parents]) => ({ title, parents }));

const texts = [
  "Hello world",
  "query: Book a dentist appointment",
  "Llamar al dentista: ¿mañana o pasado?",
  "Позвонить маме в воскресенье",
  "Ünïcödé façade naïve café",
  "Full-width ＡＢＣ１２３ and ligature ﬁ",
  "Tabs\tand  double  spaces",
  "Emoji 👩‍💻 and flags 🇪🇸",
  "日本語のテキスト",
  "x".repeat(300),
  "",
];

const run = spawnSync(
  "uv",
  ["run", "--no-project", "--with", "onnxruntime==1.30.0", "--with", "tokenizers==0.23.2", "--with", "numpy", "python", "-I", join(repo, "tools", "icon-golden.py"), "--golden", matcher, modelDir, bundle],
  { input: JSON.stringify({ spec: manifest.query, tasks: [...tasks, ...extra], texts }), encoding: "utf8", maxBuffer: 1 << 28 },
);
if (run.status !== 0) {
  console.error(run.stderr);
  process.exit(1);
}
const out = JSON.parse(run.stdout);
const golden = {
  tag: manifest.tag,
  spec: manifest.query,
  tasks: [...tasks, ...extra].map((t, i) => ({ ...t, ...out.tasks[i] })),
  texts: out.texts,
};
writeFileSync(join(repo, "tests", "icon-golden.json"), JSON.stringify(golden) + "\n");
console.log(`tests/icon-golden.json: ${golden.tasks.length} tasks, ${golden.texts.length} texts (tag ${golden.tag}).`);
