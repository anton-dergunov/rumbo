// Registers the service worker and offers updates on request (docs/plans/real-app.md §2).
// A new version downloads quietly and waits; `applyUpdate()` switches to it, and the caller
// decides when that is safe (never during a sync).

import { VERSION, BUILD } from "./version.js";

const HOUR = 60 * 60 * 1000;
let registration = null;
let applying = false;
const listeners = new Set();

const notify = () => listeners.forEach((fn) => fn(status()));

/** What the page can show: whether a worker controls it, and whether an update is waiting. */
export function status() {
  return {
    version: VERSION,
    build: BUILD,
    supported: "serviceWorker" in navigator,
    controlled: !!navigator.serviceWorker?.controller,
    waiting: !!(registration?.waiting && navigator.serviceWorker.controller),
  };
}

export const onStatus = (fn) => (listeners.add(fn), fn(status()));

export async function startPwa() {
  // Unbuilt (served straight from app/), there is nothing to precache, so no worker.
  if (BUILD === "dev" || !("serviceWorker" in navigator)) return notify();
  const root = new URL("./", import.meta.url);
  registration = await navigator.serviceWorker.register(new URL("sw.js", root), { scope: root.pathname });
  registration.addEventListener("updatefound", () => {
    const worker = registration.installing;
    worker?.addEventListener("statechange", notify);
  });
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    // Only a switch the owner asked for reloads the page.
    if (applying) location.reload();
    else notify();
  });
  const check = () => registration.update().catch(() => {});
  document.addEventListener("visibilitychange", () => document.visibilityState === "visible" && check());
  setInterval(check, HOUR);
  notify();
}

/** Switch to the waiting version and reload. Returns false when there is none. */
export function applyUpdate() {
  if (!registration?.waiting) return false;
  applying = true;
  registration.waiting.postMessage({ type: "apply-update" });
  return true;
}
