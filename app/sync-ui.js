// The sync mark in the header and the Sync page (docs/plans/real-app.md §4). This is the read
// side: where this device is, the last check and error, history from GitHub and the sync log.
// Local commits, the rescue branch and the zip come with the write path (plan steps 4 and 5).

import { h, icon } from "./ui.js";
import { state, runtime, actions } from "./state.js";

const CLASS_NAMES = {
  offline: "offline",
  auth: "sign-in needed",
  "rate-limited": "rate-limited",
  missing: "repo or branch not found",
  rejected: "refused by GitHub",
  server: "GitHub error",
  diverged: "branch rewritten",
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

function logLine(e) {
  const text =
    e.kind === "pull"
      ? `Pulled ${short(e.from)} → ${short(e.to)}: ${e.files} file${e.files === 1 ? "" : "s"} changed${e.removed ? `, ${e.removed} removed` : ""}`
      : e.kind === "error"
        ? `${CLASS_NAMES[e.class] || e.class}: ${e.message}${e.detail ? ` (${e.detail})` : ""}`
        : e.kind === "reset"
          ? "Reset to GitHub: the local copy was forgotten"
          : e.kind === "setup"
            ? `Set up for ${e.repo} (${e.branch})`
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

  return h(
    "div",
    { class: "sync-page" },
    h("h2", { class: "sy-h" }, "Where this device is"),
    row("Repo", `${m.repo || "—"} · ${m.branch || "main"}`),
    row("Base commit", c ? [h("code", null, short(c.sha)), " ", firstLine(c.message), h("span", { class: "muted" }, ` · ${c.author} · ${when(c.date)}`)] : "none yet"),
    row("Local commits", "none: this version doesn't save edits yet"),
    row("Status", s.status === "syncing" ? "syncing…" : s.status === "synced" ? "up to date" : CLASS_NAMES[err?.kind] || s.status),
    row("Last check", when(m.lastCheck)),
    err ? row("Last error", h("span", { class: "sy-err" }, `${CLASS_NAMES[err.kind] || err.kind}: ${err.message}`), err.detail ? h("span", { class: "muted" }, ` (${err.detail})`) : null) : null,
    h(
      "p",
      { class: "sy-actions" },
      h("button", { class: "sy-btn", disabled: s.status === "syncing", onclick: () => actions.syncNow() }, icon("sync"), "Check now"),
      s.stoppedBy === "diverged"
        ? h("button", { class: "sy-btn", onclick: () => confirm("Forget this device's copy and download GitHub's branch again? Nothing here is unsaved.") && actions.resetReplica() }, icon("restart_alt"), "Reset to GitHub")
        : null,
      s.stoppedBy === "auth" || s.stoppedBy === "missing" ? h("button", { class: "sy-btn", onclick: () => actions.openSetup() }, icon("key"), "Setup") : null,
    ),
    h("h2", { class: "sy-h" }, "History on GitHub"),
    commitList(page.vault),
    file ? [h("h2", { class: "sy-h" }, `History of ${file.name}`), commitList(page.file)] : null,
    h("h2", { class: "sy-h" }, "Sync log"),
    page.log?.length ? h("ol", { class: "sy-log" }, [...page.log].reverse().map(logLine)) : h("p", { class: "muted" }, "Nothing yet."),
  );
}
