// The sync mark in the header and the Sync page (docs/plans/real-app.md §4): where this device is,
// the conflict screen when a rebase stopped, the local commits not yet pushed (each with its diff),
// the ways out (a rescue branch, the zip, reset), the last check and error, history from GitHub and
// the sync log.

import { h, icon } from "./ui.js";
import { state, runtime, actions } from "./state.js";
import { clashes, unifiedDiff } from "./merge.js";
import { fileLabel } from "./commits.js";

const CLASS_NAMES = {
  offline: "offline",
  auth: "sign-in needed",
  "rate-limited": "rate-limited",
  missing: "repo or branch not found",
  rejected: "refused by GitHub",
  server: "GitHub error",
  diverged: "branch rewritten",
  conflict: "edited on both sides",
  error: "error",
};

/** The header's mark: nothing while synced or syncing; muted when offline or waiting; accent when it needs the owner. */
export function syncMark() {
  const s = runtime.sync.status;
  if (s === "synced" || s === "syncing") return null;
  const attention = s === "attention";
  const label = attention ? "Sync needs you" : s === "waiting" ? "Sync is waiting" : "Offline";
  return h(
    "button",
    { class: `btn icon-btn sync-mark${attention ? " attention" : ""}`, title: label, "aria-label": label, onclick: () => actions.openSync() },
    icon(attention ? "sync_problem" : s === "waiting" ? "schedule" : "cloud_off"),
  );
}

const short = (sha) => (sha ? sha.slice(0, 7) : "—");
const firstLine = (msg) => (msg || "").split("\n")[0];

export function when(t) {
  if (!t) return "never";
  const d = new Date(t);
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  const rel = mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : mins < 60 * 24 ? `${Math.round(mins / 60)} h ago` : null;
  const abs = d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return rel ? `${rel} (${abs})` : abs;
}

const row = (k, ...v) => h("div", { class: "sy-row" }, h("span", { class: "sy-k" }, k), h("span", { class: "sy-v" }, ...v));

function commitList(list) {
  if (!list) return h("p", { class: "muted" }, "Loading…");
  if (list.error) return h("p", { class: "muted" }, list.error);
  if (!list.length) return h("p", { class: "muted" }, "No commits.");
  return h(
    "ol",
    { class: "sy-commits" },
    list.map((c) =>
      h(
        "li",
        null,
        h("code", null, short(c.sha)),
        " ",
        h("span", null, firstLine(c.message)),
        h("span", { class: "muted" }, ` · ${c.author} · ${when(c.date)}`, c.parents?.length > 1 ? " · merge" : ""),
      ),
    ),
  );
}

/** A diff as lines, each marked as added, removed, a hunk header or context. */
function diffView(text) {
  const kind = (l) => (l.startsWith("@@") ? "hunk" : l.startsWith("+++") || l.startsWith("---") || l.startsWith("diff ") ? "head" : l.startsWith("+") ? "add" : l.startsWith("-") ? "del" : "ctx");
  return h(
    "pre",
    { class: "sy-diff" },
    text
      .replace(/\n$/, "")
      .split("\n")
      .map((l) => h("span", { class: `dl dl-${kind(l)}` }, l || " ")),
  );
}

/** The local commits whose diff is open: kept across redraws (a sync, a resize). */
const openDiffs = new Set();

/** The local commits, oldest first: message, files, when, and the diff behind a disclosure. */
function pendingList(list) {
  return h(
    "ol",
    { class: "sy-commits" },
    list.map((c) =>
      h(
        "li",
        null,
        h(
          "details",
          { open: openDiffs.has(c.id), ontoggle: (e) => (e.target.open ? openDiffs.add(c.id) : openDiffs.delete(c.id)) },
          h("summary", null, h("span", null, firstLine(c.message)), h("span", { class: "muted" }, ` · ${Object.keys(c.files).map(fileLabel).join(", ")} · ${when(c.updated)}`, c.attempt ? " · sent, not confirmed" : "", c.rebased ? " · rebased" : "")),
          diffView(Object.entries(c.files).map(([path, f]) => unifiedDiff(path, f.before ?? null, f.after ?? null)).join("")),
        ),
      ),
    ),
  );
}

const REASON = {
  both: "Changed here and on GitHub in the same place.",
  gone: "Deleted or moved on GitHub, and edited here.",
  readonly: "Changed on GitHub into a file Rumbo can only show (Windows line endings or not UTF-8), and edited here.",
};

const sideLines = (lines, cls) => h("div", { class: `cf-lines ${cls}` }, lines.length ? lines.map((l) => h("span", { class: "cf-line" }, l || " ")) : h("span", { class: "cf-line muted" }, "(nothing)"));

/** One file in conflict: why, the clashes (this device's lines against GitHub's), and the three answers. */
function conflictFile(f, busy) {
  const list = clashes(f.base, f.mine, f.theirs);
  return h(
    "section",
    { class: "sy-conflict" },
    h("h3", { class: "cf-file" }, fileLabel(f.path), h("span", { class: "muted" }, ` · ${f.path}`)),
    h("p", { class: "cf-why" }, REASON[f.reason] || REASON.both),
    list.map((c) =>
      h(
        "div",
        { class: "cf-clash" },
        c.before.length ? sideLines(c.before, "cf-ctx") : null,
        h("div", { class: "cf-side cf-mine" }, h("span", { class: "cf-k" }, "This device"), sideLines(c.mine, "")),
        h("div", { class: "cf-side cf-theirs" }, h("span", { class: "cf-k" }, `GitHub, near line ${c.line}`), sideLines(c.theirs, "")),
        c.after.length ? sideLines(c.after, "cf-ctx") : null,
      ),
    ),
    !list.length && f.reason === "both" ? h("p", { class: "muted" }, "The two versions change the same headings in ways Rumbo can't combine.") : null,
    h(
      "p",
      { class: "sy-actions" },
      h("button", { class: "sy-btn", disabled: busy, onclick: () => actions.keepTheirs(f.path) }, icon("cloud_download"), "Keep GitHub's"),
      h("button", { class: "sy-btn", disabled: busy, onclick: () => actions.keepMine(f.path) }, icon("smartphone"), "Keep mine"),
      h("button", { class: "sy-btn", disabled: busy, onclick: () => actions.rescueAndStop() }, icon("call_split"), "Rescue and stop"),
    ),
  );
}

function conflictSection(m, busy) {
  const files = m.conflict?.files || [];
  if (!files.length) return null;
  return [
    h("h2", { class: "sy-h sy-h-alert" }, files.length === 1 ? "A file to settle" : `${files.length} files to settle`),
    h(
      "p",
      { class: "cf-help" },
      "Nothing is pushed until you choose. ",
      h("strong", null, "Keep GitHub's"),
      " puts your edits on a rescue branch first. ",
      h("strong", null, "Keep mine"),
      " writes this device's text over GitHub's (GitHub's stays in the history). ",
      h("strong", null, "Rescue and stop"),
      " puts all your local commits on a rescue branch and takes GitHub's branch as it is, to finish on the Mac.",
    ),
    files.map((f) => conflictFile(f, busy)),
  ];
}

function logLine(e) {
  const text =
    e.kind === "pull"
      ? `Pulled ${short(e.from)} → ${short(e.to)}: ${e.files} file${e.files === 1 ? "" : "s"} changed${e.removed ? `, ${e.removed} removed` : ""}${e.replayed || e.merged ? `; local commits rebased (${e.replayed} file${e.replayed === 1 ? "" : "s"} replayed, ${e.merged} merged)` : ""}`
      : e.kind === "error"
        ? `${CLASS_NAMES[e.class] || e.class}: ${e.message}${e.detail ? ` (${e.detail})` : ""}`
        : e.kind === "push"
          ? `Pushed ${short(e.sha)}: ${firstLine(e.message)}${e.lost ? " (the answer was lost; found on GitHub)" : ""}`
          : e.kind === "reset"
            ? `Reset to GitHub: the local copy was forgotten${e.dropped ? `, with ${e.dropped} local commit${e.dropped === 1 ? "" : "s"} (saved first)` : ""}`
            : e.kind === "setup"
              ? `Set up for ${e.repo} (${e.branch})`
              : e.kind === "rescue"
                ? `Pushed ${e.commits} local commit${e.commits === 1 ? "" : "s"} to the branch ${e.branch} (${short(e.sha)})`
                : e.kind === "resolve"
                  ? `${fileLabel(e.path)}: kept ${e.how === "mine" ? "this device's text" : "GitHub's text"}`
                  : JSON.stringify(e);
  return h("li", null, h("span", { class: "muted" }, when(e.at)), " ", text);
}

/** The Sync page's body. `page` holds what was fetched when the page opened. */
export function renderSync(model) {
  const m = runtime.meta;
  const s = runtime.sync;
  const page = runtime.syncPage || {};
  const err = s.lastError || m.lastError;
  const c = m.baseCommit;
  const file = state.file && model.byPath.get(state.file);
  const busy = !!runtime.busy;

  return h(
    "div",
    { class: "sync-page" },
    conflictSection(m, busy),
    h("h2", { class: "sy-h" }, "Where this device is"),
    row("Repo", `${m.repo || "—"} · ${m.branch || "main"}`),
    row("Base commit", c ? [h("code", null, short(c.sha)), " ", firstLine(c.message), h("span", { class: "muted" }, ` · ${c.author} · ${when(c.date)}`)] : "none yet"),
    row("Local commits", runtime.pending.length ? `${runtime.pending.length} not pushed` : "none: everything is on GitHub"),
    row("Status", s.status === "syncing" ? "syncing…" : s.status === "synced" ? "up to date" : CLASS_NAMES[s.stoppedBy] || CLASS_NAMES[err?.kind] || s.status),
    row("Last check", when(m.lastCheck)),
    err ? row("Last error", h("span", { class: "sy-err" }, `${CLASS_NAMES[err.kind] || err.kind}: ${err.message}`), err.detail ? h("span", { class: "muted" }, ` (${err.detail})`) : null) : null,
    runtime.syncNote ? row("Done", runtime.syncNote) : null,
    h(
      "p",
      { class: "sy-actions" },
      h("button", { class: "sy-btn", disabled: s.status === "syncing" || busy, onclick: () => actions.syncNow() }, icon("sync"), "Check now"),
      s.stoppedBy === "auth" || s.stoppedBy === "missing" ? h("button", { class: "sy-btn", onclick: () => actions.openSetup() }, icon("key"), "Setup") : null,
    ),
    h("h2", { class: "sy-h" }, "Ways out"),
    h(
      "p",
      { class: "sy-actions" },
      runtime.pending.length ? h("button", { class: "sy-btn", disabled: busy, onclick: () => actions.pushRescue() }, icon("call_split"), "Push my changes to a branch") : null,
      h("button", { class: "sy-btn", disabled: busy, onclick: () => actions.downloadAll() }, icon("download"), "Download everything"),
      h("button", { class: "sy-btn", disabled: busy, onclick: () => actions.resetReplica() }, icon("restart_alt"), "Reset to GitHub"),
    ),
    busy ? h("p", { class: "muted" }, `${runtime.busy}…`) : null,
    runtime.pending.length ? [h("h2", { class: "sy-h" }, "Local commits"), pendingList(runtime.pending)] : null,
    h("h2", { class: "sy-h" }, "History on GitHub"),
    commitList(page.vault),
    file ? [h("h2", { class: "sy-h" }, `History of ${file.name}`), commitList(page.file)] : null,
    h("h2", { class: "sy-h" }, "Sync log"),
    page.log?.length ? h("ol", { class: "sy-log" }, [...page.log].reverse().map(logLine)) : h("p", { class: "muted" }, "Nothing yet."),
  );
}
