// End to end against the real GitHub (docs/plans/real-app.md §8, "End to end, opt-in"): Rumbo's
// sync code (remote-github.js, store.js on fake-indexeddb, sync.js, rescue.js) beside real `git`
// running the same commands as the Emacs sync (agentic-org-planner lisp/ps-git-sync.el), on a
// throwaway repo. Never run in CI. Needs `npm install` (fake-indexeddb).
//
//   RUMBO_E2E_REPO=owner/name RUMBO_E2E_TOKEN=github_pat_… node tools/e2e-github.mjs
//
// The repo must be a throwaway one: empty, or holding the `.rumbo-e2e` file this script leaves in
// it. Any other repo is refused before anything is written. The token needs Contents read and
// write on it; it is passed to git through GIT_ASKPASS and is never printed. The sample vault is
// written as an ordinary commit (never a force-push), so the repo's history grows with each run.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { IDBFactory } from "fake-indexeddb";
import { createRemote } from "../app/remote-github.js";
import { openStore } from "../app/store.js";
import { pull, syncOnce } from "../app/sync.js";
import { pushRescue } from "../app/rescue.js";
import { makeOp } from "../app/ops.js";
import { edit, textOf } from "../tests/scenarios.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SAMPLE = join(ROOT, "prototype/sample-vault");
const MARKER = ".rumbo-e2e";

const [owner, repo] = String(process.env.RUMBO_E2E_REPO || "").split("/");
const token = process.env.RUMBO_E2E_TOKEN || "";
const branch = process.env.RUMBO_E2E_BRANCH || "main";
if (!owner || !repo || !token) {
  console.error("Usage: RUMBO_E2E_REPO=owner/name RUMBO_E2E_TOKEN=… [RUMBO_E2E_BRANCH=main] node tools/e2e-github.mjs");
  console.error("The repo must be a throwaway one: empty, or made by an earlier run (it holds .rumbo-e2e).");
  process.exit(2);
}

const work = mkdtempSync(join(tmpdir(), "rumbo-e2e-"));
const clone = join(work, "clone");
const askpass = join(work, "askpass.sh");
writeFileSync(askpass, '#!/bin/sh\nprintf "%s" "$RUMBO_E2E_TOKEN"\n');
chmodSync(askpass, 0o700);
const gitEnv = { ...process.env, GIT_ASKPASS: askpass, GIT_TERMINAL_PROMPT: "0" };
const git = (...args) => execFileSync("git", args, { cwd: clone, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitRaw = (...args) => execFileSync("git", args, { cwd: clone, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const sh = (cmd) => execFileSync("sh", ["-c", cmd], { cwd: clone, env: gitEnv, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/** One Emacs sync tick, exactly as ps-git-sync.el runs it: commit, pull with a merge, push. */
function emacsSync() {
  const stamp = new Date().toISOString().replace("T", " ").slice(0, 19);
  const msg = `Auto backup: ${stamp} (e2e)`;
  return sh(
    "if [ -n \"$(git ls-files --unmerged)\" ]; then echo 'CONFLICT: unresolved merge conflict, nothing committed:'; git diff --name-only --diff-filter=U; exit 1; fi && " +
      "git add -A && " +
      `if ! git diff --cached --quiet || git rev-parse -q --verify MERGE_HEAD >/dev/null; then git commit -m '${msg}'; fi && ` +
      "git pull --no-rebase --no-edit && " +
      "git push",
  );
}

class Refused extends Error {}
const results = [];
async function step(name, fn) {
  try {
    await fn();
    results.push([true, name]);
    console.log(`PASS  ${name}`);
  } catch (e) {
    results.push([false, name]);
    console.log(`FAIL  ${name}\n      ${String(e.message || e).replaceAll(token, "<token>")}`);
  }
}
const check = (ok, what) => {
  if (!ok) throw new Error(what);
};
const fileIn = (path) => readFileSync(join(clone, path), "utf8");

function walk(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name), base) : [join(dir, d.name).slice(base.length + 1)]));
}

try {
  // ------------------------------------------------------------------ the throwaway repo
  execFileSync("git", ["clone", "--quiet", `https://x-access-token@github.com/${owner}/${repo}.git`, clone], { env: gitEnv, stdio: ["ignore", "pipe", "pipe"] });
  git("config", "user.name", "Rumbo e2e");
  git("config", "user.email", "e2e@localhost");
  let hasCommits = true;
  try {
    git("rev-parse", "--verify", "HEAD");
  } catch {
    hasCommits = false;
  }
  if (hasCommits && !existsSync(join(clone, MARKER))) throw new Refused(`${owner}/${repo} has commits and no ${MARKER}. Point this at an empty throwaway repo.`);
  if (!hasCommits) git("checkout", "-q", "-b", branch);
  // The sample vault, as an ordinary commit on top.
  for (const f of hasCommits ? git("ls-files").split("\n").filter(Boolean) : []) if (f !== MARKER) rmSync(join(clone, f));
  cpSync(SAMPLE, clone, { recursive: true });
  writeFileSync(join(clone, MARKER), "This repo is a throwaway for Rumbo's end-to-end test (tools/e2e-github.mjs).\n");
  git("add", "-A");
  try {
    git("commit", "-q", "-m", "e2e: the sample vault");
  } catch {
    // nothing changed since the last run
  }
  git("push", "-q", "-u", "origin", branch);
  console.log(`Repo ready: ${walk(SAMPLE).length} sample files at ${git("rev-parse", "--short", "HEAD")}`);

  // ------------------------------------------------------------------ a Rumbo replica
  const store = openStore({ indexedDB: new IDBFactory() });
  const remote = createRemote({ owner, repo, branch, token });
  await store.setMeta({ repo: `${owner}/${repo}`, branch, token, device: "e2e" });
  const r = { store, remote, device: "e2e", clock: Date.now(), edits: 0 };
  const sync = () => syncOnce({ remote, store });
  const byTitle = (d, t) => d.headings.find((h) => h.title === t);

  await step("Rumbo clones the repo; every file matches git's byte for byte", async () => {
    await pull({ remote, store });
    for (const f of await store.allFiles()) check(fileIn(f.path) === f.text, `${f.path} differs`);
  });

  await step("a Rumbo edit is pushed, and Emacs's sync pulls it byte for byte", async () => {
    await edit(r, "Misc.org", (d) => makeOp(d, "setState", byTitle(d, "Compare note-taking workflows"), { state: "DONE" }));
    check((await sync()).pushed === 1, "nothing was pushed");
    emacsSync();
    check(fileIn("Misc.org") === (await textOf(r, "Misc.org")), "Misc.org differs after git pull");
    check(git("log", "-1", "--format=%s").startsWith("Rumbo: Done"), "the head is not Rumbo's commit");
  });

  await step("Emacs pushes a change to another file, and Rumbo pulls it", async () => {
    writeFileSync(join(clone, "Inbox.org"), `${fileIn("Inbox.org")}\n* TODO From the Mac (e2e)\n`);
    emacsSync();
    const res = await sync();
    check(res.changed, "the pull saw no change");
    check((await textOf(r, "Inbox.org")) === fileIn("Inbox.org"), "Inbox.org differs");
  });

  await step("both edit one file: Rumbo replays its edit on Emacs's text, and git fast-forwards", async () => {
    writeFileSync(join(clone, "Misc.org"), `${fileIn("Misc.org")}* TODO Another from the Mac (e2e)\n`);
    emacsSync();
    const before = git("rev-parse", "HEAD");
    await edit(r, "Misc.org", (d) => makeOp(d, "setState", byTitle(d, "Research standing desk setups"), { state: "NEXT" }));
    check((await sync()).pushed === 1, "nothing was pushed");
    const text = await textOf(r, "Misc.org");
    check(/NEXT Research standing desk setups/.test(text) && /Another from the Mac/.test(text), "the rebased text lost a side");
    emacsSync();
    check(git("rev-list", "--merges", `${before}..HEAD`) === "", "git made a merge commit");
    check(fileIn("Misc.org") === text, "Misc.org differs after git pull");
  });

  await step("a rescue branch holds the local commit; it is then deleted", async () => {
    await edit(r, "Misc.org", (d) => makeOp(d, "setState", byTitle(d, "Read more fiction regularly"), { state: "WAIT" }));
    const { branch: name } = await pushRescue({ remote, store });
    git("fetch", "-q", "origin", name);
    check(gitRaw("show", "FETCH_HEAD:Misc.org") === (await textOf(r, "Misc.org")), "the rescue branch's Misc.org differs");
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/git/refs/heads/${name}`, { method: "DELETE", headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } });
    check(res.status === 204, `deleting the branch answered ${res.status}`);
    check((await sync()).pushed === 1, "the commit itself was not pushed afterwards");
  });

  await step("in the end, Rumbo and git agree on every file", async () => {
    emacsSync();
    const meta = await store.getMeta();
    check(meta.base === git("rev-parse", "HEAD"), "Rumbo's base is not git's HEAD");
    for (const f of await store.allFiles()) check(fileIn(f.path) === (f.work ?? f.text), `${f.path} differs`);
  });
  store.close();
} catch (e) {
  if (e instanceof Refused) {
    console.error(`Refused: ${e.message}`);
    process.exitCode = 2;
  } else {
    console.log(`FAIL  setup\n      ${String(e.stderr || e.message || e).replaceAll(token, "<token>")}`);
    results.push([false, "setup"]);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

if (process.exitCode !== 2) {
  const failed = results.filter(([ok]) => !ok).length;
  console.log(failed ? `\n${failed} of ${results.length} failed` : `\nAll ${results.length} passed`);
  process.exitCode = failed ? 1 : 0;
}
