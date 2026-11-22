// Setup: the vault repo, the token and this device's name (docs/plans/real-app.md §3,
// "Authentication"). Shown until a first pull has succeeded, and again from the Sync page after
// "sign in again". app.js does the work; this only draws the form and reads it.

import { h } from "./ui.js";

/** A guess at the device's name for commit messages, e.g. "iPad" or "Android". */
export function guessDevice() {
  const ua = navigator.userAgent;
  if (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1) return "iPad";
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Mac/.test(ua)) return "Mac";
  return "Browser";
}

const field = (label, input) => h("label", { class: "su-field" }, h("span", null, label), input);
const text = (name, value, attrs = {}) => h("input", { name, value: value || "", spellcheck: "false", autocapitalize: "off", autocomplete: "off", ...attrs });

/**
 * The form. `values` prefills it (from an earlier Setup, or the device check's saved settings).
 * `onSubmit(values, say)` runs the setup; `say(text, kind)` shows progress or an error under it.
 */
export function renderSetup(values, onSubmit) {
  const v = values || {};
  const status = h("p", { class: "su-status", role: "status" });
  const say = (msg, kind = "") => {
    status.textContent = msg;
    status.className = `su-status ${kind}`;
  };
  const noExpiry = h("input", { type: "checkbox", name: "noExpiry", checked: !!v.noExpiry });
  const expiry = h("input", { type: "date", name: "tokenExpiry", value: v.tokenExpiry || "", disabled: !!v.noExpiry });
  noExpiry.addEventListener("change", () => (expiry.disabled = noExpiry.checked));
  const button = h("button", { type: "submit", class: "su-go" }, "Connect and download");

  const form = h(
    "form",
    { class: "su-form", autocomplete: "off" },
    field("Vault repo", text("repo", v.repo, { placeholder: "owner/repo", required: true })),
    field("Branch", text("branch", v.branch || "main", { placeholder: "main" })),
    field("Token", text("token", v.token, { type: "password", placeholder: "github_pat_…", required: true })),
    field("Token expires on", expiry),
    h("label", { class: "su-tick" }, noExpiry, " The token has no expiry"),
    field("This device's name", text("device", v.device || guessDevice(), { placeholder: "iPad" })),
    h("h3", { class: "su-sub" }, "Obsidian (optional)"),
    field("Notes repo", text("notesRepo", v.notesRepo, { placeholder: "owner/repo" })),
    field("Obsidian vault name", text("obsidianVault", v.obsidianVault, { placeholder: "obsidian" })),
    h("p", null, button),
    status,
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = form.elements;
    const values = {
      repo: f.repo.value.trim().replace(/^https:\/\/github\.com\//, "").replace(/\.git$/, ""),
      branch: f.branch.value.trim() || "main",
      token: f.token.value.trim(),
      noExpiry: f.noExpiry.checked,
      tokenExpiry: f.noExpiry.checked ? "" : f.tokenExpiry.value,
      device: f.device.value.trim() || guessDevice(),
      notesRepo: f.notesRepo.value.trim(),
      obsidianVault: f.obsidianVault.value.trim(),
    };
    if (!/^[\w.-]+\/[\w.-]+$/.test(values.repo)) return say("The vault repo is owner/name, for example me/notes.", "error");
    if (!values.noExpiry && !values.tokenExpiry) return say("Give the token's expiry date, or tick that it has none.", "error");
    button.disabled = true;
    try {
      await onSubmit(values, say);
    } finally {
      button.disabled = false;
    }
  });

  return h(
    "main",
    { class: "setup" },
    h("h1", { class: "su-title" }, "Rumbo"),
    h("p", { class: "muted" }, "Connect this device to the vault's repo on GitHub. The token stays on this device; the vault goes only between it and api.github.com."),
    form,
  );
}
