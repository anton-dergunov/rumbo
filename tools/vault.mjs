// Reading a vault from disk for the local tools: which directory (the same order as
// prototype/serve.py: --vault, then $PS_ORG_BASE, then :current in ~/.emacs.d/vaults.eld) and which
// files (app/vault-files.js, as the app keeps them). Read-only.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { homedir } from "node:os";
import { isIncluded } from "../app/vault-files.js";

const expand = (p) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

/** The vault directory, or null. */
export function resolveVault(cli) {
  if (cli) return expand(cli);
  if (process.env.PS_ORG_BASE) return expand(process.env.PS_ORG_BASE);
  const registry = join(homedir(), ".emacs.d", "vaults.eld");
  if (existsSync(registry)) {
    const m = /:current\s+"([^"]+)"/.exec(readFileSync(registry, "utf8"));
    if (m) return expand(m[1]);
  }
  return null;
}

/** The agenda files of a vault, as [{path, text}], sorted as Emacs sorts them. */
export function readVault(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = statSync(p);
      const rel = relative(root, p).split(sep).join("/");
      if (st.isDirectory()) {
        if (!name.startsWith(".")) walk(p);
      } else if (isIncluded(rel)) out.push({ path: rel, text: readFileSync(p, "utf8") });
    }
  };
  walk(root);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Parse the command line: {vault, file, rest}; exits with usage on --help. */
export function args(usage) {
  const a = process.argv.slice(2);
  const opt = { vault: null, file: null };
  for (let i = 0; i < a.length; i++) {
    if (a[i] === "--help" || a[i] === "-h") {
      console.log(usage);
      process.exit(0);
    } else if (a[i] === "--vault") opt.vault = a[++i];
    else if (a[i] === "--file") opt.file = a[++i];
    else if (!opt.vault && !a[i].startsWith("-")) opt.vault = a[i];
  }
  const root = resolveVault(opt.vault);
  if (!root || !existsSync(root)) {
    console.error(`No vault found${root ? ` at ${root}` : ""}. Pass --vault DIR or set PS_ORG_BASE.\n\n${usage}`);
    process.exit(2);
  }
  return { root, file: opt.file };
}
