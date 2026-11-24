// Touch and mouse gestures on the file page. Ported from calorie-logger's rowGestures and its drop
// logic, plus auto-scroll, which neither app had. Both ways into editing are on at once:
//
//   swipe   with a finger or pen, always: a clearly sideways move (1.4x more horizontal than
//           vertical) slides the row to show buttons. Nothing is changed until a button is tapped.
//   handle  in edit mode, the row's handle drags it at once.
// A right-click opens the menu. Anything else is left to the page: a scroll scrolls, and a tap
// opens or closes the notes as always. The click that ends a gesture is swallowed, so it never
// also toggles the row.

import { h } from "./ui.js";
import { state } from "./state.js";
import { localRect, localPoint, panelOpen } from "./edit-ui.js";

const SWIPE_START = 10;
const SWIPE_RATIO = 1.4;
const SWIPE_OPEN = 56;
const SWIPE_BTN_H = 44; // px: the smallest a swipe button gets, whatever the row's height
const SWIPE_GAP = 10; // px between the buttons and the row's text once it has slid aside
const EDGE = 56; // px from the scroller's top or bottom where dragging scrolls

let openSwipe = null;
export function closeSwipe() {
  openSwipe?.close();
}

/**
 * hooks: {
 *   headingOf(node) -> heading,
 *   menu(heading, node, point),
 *   drop(heading, {how: "before" | "after" | "into", target: heading}),
 *   swipeActions(heading, side) -> [{icon, label, cls, run}],
 * }
 */
export function attachGestures(root, hooks) {
  let g = null;
  let claim = false;

  const claimClick = () => {
    claim = true;
    setTimeout(() => (claim = false), 450);
  };
  root.addEventListener(
    "click",
    (e) => {
      if (!claim) return;
      claim = false;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );

  // iOS Safari scrolls even when pointer events are prevented; a non-passive touchmove stops it.
  root.addEventListener(
    "touchmove",
    (e) => {
      if (g && (g.phase === "drag" || g.phase === "swipe" || g.phase === "handle")) e.preventDefault();
    },
    { passive: false },
  );

  root.addEventListener("contextmenu", (e) => {
    const head = e.target.closest(".node > .head");
    if (!head) return;
    // A long-press on Android also fires contextmenu; only a real right-click opens the menu here.
    if (lastType !== "mouse") return;
    e.preventDefault();
    const node = head.parentElement;
    hooks.menu(hooks.headingOf(node), node, { x: e.clientX, y: e.clientY });
  });

  let lastType = "mouse";
  root.addEventListener("pointerdown", (e) => {
    lastType = e.pointerType || "mouse";
    if (panelOpen()) return;
    if (openSwipe && !e.target.closest(".sw-strip")) {
      closeSwipe();
      claimClick();
      return;
    }
    if (e.pointerType === "mouse" && e.button !== 0) return;
    const head = e.target.closest(".node > .head");
    if (!head) return;
    const node = head.parentElement;
    const handle = e.target.closest(".handle");
    if (!handle && e.target.closest("a, button, .sw-strip")) return;
    const type = e.pointerType || "mouse";
    let phase;
    if (handle && state.editing) phase = "handle";
    else if (type !== "mouse") phase = "swipewait";
    else return;
    g = { id: e.pointerId, type, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, head, node, hd: hooks.headingOf(node), phase };
    if (phase === "handle") e.preventDefault();
    document.addEventListener("pointermove", onMove, { passive: false });
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onCancel);
  });

  function onMove(e) {
    if (!g || e.pointerId !== g.id) return;
    g.x = e.clientX;
    g.y = e.clientY;
    const dx = g.x - g.x0;
    const dy = g.y - g.y0;
    const dist = Math.hypot(dx, dy);
    switch (g.phase) {
      case "handle":
        if (dist > 3) startDrag();
        break;
      case "drag":
        e.preventDefault();
        moveDrag();
        break;
      case "swipewait":
        if (Math.abs(dx) > SWIPE_START && Math.abs(dx) > SWIPE_RATIO * Math.abs(dy)) startSwipe();
        else if (Math.abs(dy) > SWIPE_START) reset();
        break;
      case "swipe":
        e.preventDefault();
        moveSwipe(dx);
        break;
    }
  }

  function onUp(e) {
    if (!g || e.pointerId !== g.id) return;
    const cur = g;
    switch (cur.phase) {
      case "drag":
        claimClick();
        endDrag(true);
        break;
      case "handle":
        claimClick();
        break;
      case "swipe":
        claimClick();
        endSwipe(cur.x - cur.x0);
        break;
    }
    reset();
  }

  function onCancel(e) {
    if (!g || e.pointerId !== g.id) return;
    if (g.phase === "drag") endDrag(false);
    if (g.phase === "swipe") endSwipe(0);
    reset();
  }

  function reset() {
    if (!g) return;
    g = null;
    document.removeEventListener("pointermove", onMove);
    document.removeEventListener("pointerup", onUp);
    document.removeEventListener("pointercancel", onCancel);
  }

  // ------------------------------------------------------------ drag to reorder

  let drag = null;

  function startDrag() {
    const layer = document.getElementById("edit-layer");
    const r = localRect(g.head);
    const ghost = g.head.cloneNode(true);
    ghost.className = `${g.head.className} drag-ghost`;
    ghost.style.width = `${r.width}px`;
    const line = h("div", { class: "drop-line" });
    layer.append(ghost, line);
    g.node.classList.add("dragging");
    const p = localPoint(g.x, g.y);
    drag = { ghost, line, offY: p.y - r.top, offX: p.x - r.left, scroller: root.closest(".pane-scroll"), target: null, raf: 0, speed: 0 };
    g.phase = "drag";
    moveDrag();
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function moveDrag() {
    const p = localPoint(g.x, g.y);
    drag.ghost.style.transform = `translate(${p.x - drag.offX}px, ${p.y - drag.offY}px)`;
    const sr = drag.scroller.getBoundingClientRect();
    drag.speed = g.y < sr.top + EDGE ? -Math.ceil((sr.top + EDGE - g.y) / 4) : g.y > sr.bottom - EDGE ? Math.ceil((g.y - (sr.bottom - EDGE)) / 4) : 0;
    findTarget();
  }

  function autoScroll() {
    if (!drag) return;
    if (drag.speed) {
      drag.scroller.scrollTop += drag.speed;
      findTarget();
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  /** The row under the pointer and which side of it: before it, after it, or into a section. */
  function findTarget() {
    const heads = [...root.querySelectorAll(".node > .head")].filter((x) => x.offsetParent && !g.node.contains(x));
    if (!heads.length) return;
    let pick = heads[0];
    for (const x of heads) {
      if (x.getBoundingClientRect().top <= g.y) pick = x;
      else break;
    }
    const node = pick.parentElement;
    const r = pick.getBoundingClientRect();
    const sect = node.classList.contains("sect");
    let how;
    if (g.y < r.top + r.height / 2) how = "before";
    else how = sect ? "into" : "after";
    const target = hooks.headingOf(node);
    drag.target = target ? { how, target, node } : null;
    // Draw the drop line at the target's level.
    const lr = localRect(pick);
    const nr = localRect(node);
    const y = how === "before" ? lr.top - 1 : how === "into" ? lr.bottom + 2 : nr.bottom + 1;
    const x = how === "into" ? lr.left + 18 : lr.left;
    drag.line.style.transform = `translate(${x}px, ${y}px)`;
    drag.line.style.width = `${Math.max(40, lr.right - x)}px`;
    drag.line.dataset.how = how;
  }

  function endDrag(commit) {
    cancelAnimationFrame(drag.raf);
    drag.ghost.remove();
    drag.line.remove();
    g.node.classList.remove("dragging");
    const t = drag.target;
    drag = null;
    if (commit && t) hooks.drop(g.hd, t);
  }

  // ------------------------------------------------------------ swipe actions

  let sw = null;

  function startSwipe() {
    closeSwipe();
    g.phase = "swipe";
    const node = g.node;
    node.classList.add("swiping");
    const mk = (side) => {
      const acts = hooks.swipeActions(g.hd, side);
      const strip = h(
        "div",
        { class: `sw-strip sw-${side}` },
        acts.map((a) =>
          h(
            "button",
            {
              class: `sw-btn ${a.cls || ""}`,
              onclick: (e) => {
                e.stopPropagation();
                closeSwipe();
                a.run();
              },
            },
            h("span", { class: "ms" }, a.icon),
            h("span", { class: "sw-l" }, a.label),
          ),
        ),
      );
      // At least SWIPE_BTN_H tall, centred on the row, so a one-line row still shows the whole
      // button (icon and label); the extra height falls in the gap between rows.
      const hh = g.head.offsetHeight;
      const sh = Math.max(hh, SWIPE_BTN_H);
      strip.style.top = `${g.head.offsetTop - (sh - hh) / 2}px`;
      strip.style.height = `${sh}px`;
      return strip;
    };
    const left = mk("left");
    const right = mk("right");
    node.prepend(left, right);
    sw = { node, head: g.head, left, right, width: { left: left.offsetWidth, right: right.offsetWidth } };
    reveal(sw, 0, false);
  }

  /**
   * Show the buttons on the side the row slid away from, only as wide as the room it left (less the
   * gap), and hide the other side. A button taller than a short row would otherwise peek out above
   * and below it, and both sides would show behind the row while it moves.
   */
  function reveal(s, x, animate) {
    for (const [side, strip] of [["left", s.left], ["right", s.right]]) {
      const w = s.width[side];
      const on = side === "left" ? x > 0 : x < 0;
      const shown = on ? Math.max(0, Math.min(w, Math.abs(x) - SWIPE_GAP)) : 0;
      strip.style.transition = animate ? "" : "none";
      strip.style.clipPath = side === "left" ? `inset(0 ${w - shown}px 0 0)` : `inset(0 0 0 ${w - shown}px)`;
    }
  }

  function moveSwipe(dx) {
    const max = (dx > 0 ? sw.width.left : sw.width.right) + SWIPE_GAP;
    const x = Math.sign(dx) * Math.min(Math.abs(dx), max + 24);
    sw.head.style.transition = "none";
    sw.head.style.transform = `translateX(${x}px)`;
    reveal(sw, x, false);
  }

  function endSwipe(dx) {
    const s = sw;
    sw = null;
    if (!s) return;
    const open = Math.abs(dx) > SWIPE_OPEN;
    const to = open ? (dx > 0 ? s.width.left + SWIPE_GAP : -(s.width.right + SWIPE_GAP)) : 0;
    s.head.style.transition = "";
    s.head.style.transform = to ? `translateX(${to}px)` : "";
    reveal(s, to, true);
    const close = () => {
      s.head.style.transform = "";
      reveal(s, 0, true);
      setTimeout(() => {
        s.left.remove();
        s.right.remove();
        s.node.classList.remove("swiping");
      }, 200);
      if (openSwipe?.node === s.node) openSwipe = null;
    };
    if (open) {
      openSwipe = { node: s.node, close };
      const sc = root.closest(".pane-scroll");
      sc?.addEventListener("scroll", close, { once: true });
    } else close();
  }
}
