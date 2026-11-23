// Guessed task icons (docs/plans/real-app.md §7). Emacs's icons (`.ps/task-icons.json`) stay the
// source; an agenda task Emacs has no answer for yet (added or changed on this device, say) gets a
// guess from the on-device model (icon-model.js) a moment after the agenda is drawn. Emacs's icon
// replaces the guess as soon as a pull brings it. Guesses live in this device's settings
// (`iconGuesses`), never in the vault, so a reopen shows them with no model loaded.

import { iconTask } from "./icon-keys.js";

/** The agenda tasks that need a guess: no answer from Emacs (its "" counts) and none guessed yet. */
export function missingTasks(model, guesses) {
  const out = new Map();
  for (const sec of model.agenda)
    for (const { heading } of sec.items) {
      const key = model.iconKey(heading);
      if (key == null || out.has(key) || guesses.has(key) || model.emacsIcon(heading) !== undefined) continue;
      out.set(key, { key, ...iconTask(heading, ["title", "parents"]) });
    }
  return [...out.values()];
}

/** The keys of the agenda's tasks now, so guesses for tasks that left it can be let go. */
const agendaKeys = (model) => new Set(model.agenda.flatMap((s) => s.items.map(({ heading }) => model.iconKey(heading))));

const BACKOFF = [60_000, 5 * 60_000, 30 * 60_000];

/**
 * `store` keeps the guesses, `iconModel` makes them, `redraw` draws the agenda again, `busy()` says
 * a sync is running (the guesses wait for it), `log` records a download or a failure once.
 */
export function createIcons({ store, iconModel, redraw, busy = () => false, log = () => {}, delay = 1000 }) {
  /** key → icon, or "" when the model abstained (so that task isn't asked about again). */
  const guesses = new Map();
  let tag = null;
  let timer = null;
  let running = false;
  let failures = 0;
  let retryAt = 0;
  let unavailable = false;
  let model = null;
  let loaded = null;
  let ready = false;

  const save = () => store.setSetting("iconGuesses", { tag, map: Object.fromEntries(guesses) }).catch(() => {});

  async function run() {
    timer = null;
    if (!model || running || unavailable || Date.now() < retryAt) return;
    if (busy()) return schedule(model, "agenda", 2000);
    const tasks = missingTasks(model, guesses);
    if (!tasks.length) return;
    running = true;
    try {
      const list = await iconModel.list();
      if (!list) {
        unavailable = true;
        return;
      }
      const t0 = Date.now();
      const r = await iconModel.guess(tasks);
      if (r.tag !== tag) {
        guesses.clear();
        tag = r.tag;
      }
      for (const [k, icon] of Object.entries(r.guesses)) guesses.set(k, icon || "");
      if (r.stats?.fetched) log({ kind: "icons", fetched: r.stats.fetched, ms: Date.now() - t0 });
      failures = 0;
      await save();
      redraw();
    } catch (e) {
      if (e.kind === "unavailable") unavailable = true;
      else if (e.kind !== "stopped") {
        if (!failures) log({ kind: "icons", error: e.message });
        retryAt = Date.now() + BACKOFF[Math.min(failures, BACKOFF.length - 1)];
        failures++;
      }
    } finally {
      running = false;
    }
  }

  /** After a draw: forget guesses Emacs has answered, and ask for the missing ones soon. */
  function schedule(m, view, wait = delay) {
    model = m;
    m.guesses = guesses;
    if (!ready) return;
    let dropped = false;
    const keep = agendaKeys(m);
    for (const k of guesses.keys())
      if (m.icons.map.has(k) || !keep.has(k)) {
        guesses.delete(k);
        dropped = true;
      }
    if (dropped) save();
    if (view !== "agenda" || timer || running) return;
    if (missingTasks(m, guesses).length) timer = setTimeout(run, wait);
  }

  return {
    guesses,
    /** Read the stored guesses; call once before the first draw. */
    load() {
      loaded ||= store
        .getSetting("iconGuesses")
        .then((v) => {
          if (v?.map) {
            tag = v.tag || null;
            for (const [k, icon] of Object.entries(v.map)) if (typeof icon === "string") guesses.set(k, icon);
          }
        })
        .catch(() => {})
        .then(() => {
          ready = true;
        });
      return loaded;
    },
    schedule,
    /** Give the model this device's guesses, before it is drawn. */
    attach(m) {
      m.guesses = guesses;
    },
    /** Forget every guess (after the model is removed), so the next agenda asks again. */
    async clear() {
      guesses.clear();
      unavailable = false;
      failures = 0;
      retryAt = 0;
      await save();
    },
    /** For the tests: run the scheduled request now, if there is one. */
    flush: () => {
      if (!timer) return Promise.resolve();
      clearTimeout(timer);
      return run();
    },
  };
}
