/**
 * Card animations — ask bubble and declare card-flight.
 *
 * Ask flow:
 *   animateAskBubble — a glassy bubble carrying the card face floats from the
 *   asker's seat to the target's seat over 5 s. On arrival:
 *     success  → bubble dissolves, card face flies back to asker over 5 s
 *     failure  → bubble bursts with a pop at the target's seat
 *
 * Declare flow:
 *   flyCard — each of the six set cards flies from its holder's seat into
 *   the felt center on a staggered schedule (unchanged).
 *
 * Uses Motion (https://motion.dev) for all keyframe animations.
 */

import { animate } from "motion";
import { cardShort, type Card } from "@lit-up/shared";

const LAYER_ID = "card-flight-layer";

function ensureLayer(): HTMLElement {
  let el = document.getElementById(LAYER_ID);
  if (el) return el;
  el = document.createElement("div");
  el.id = LAYER_ID;
  document.body.appendChild(el);
  return el;
}

function rectOf(t: HTMLElement | DOMRect): DOMRect {
  return t instanceof DOMRect ? t : t.getBoundingClientRect();
}

// ── Ask bubble ──────────────────────────────────────────────────────────────

/**
 * Animate an ask: a glassy bubble floats from askerEl → targetEl (5 s), then
 * either bursts (failure) or dissolves while the card flies back (success, 5 s).
 */
export function animateAskBubble(opts: {
  askerEl: HTMLElement;
  targetEl: HTMLElement;
  card: Card;
  success: boolean;
}): void {
  const layer = ensureLayer();
  const fromRect = opts.askerEl.getBoundingClientRect();
  const toRect   = opts.targetEl.getBoundingClientRect();
  const { rank, symbol, red } = cardShort(opts.card);

  const SIZE = 88; // bubble diameter px
  const fromX = fromRect.left + fromRect.width  / 2 - SIZE / 2;
  const fromY = fromRect.top  + fromRect.height / 2 - SIZE / 2;
  const toX   = toRect.left   + toRect.width    / 2 - SIZE / 2;
  const toY   = toRect.top    + toRect.height   / 2 - SIZE / 2;

  // ── Build bubble element ──────────────────────────────────────────────────
  const bubble = document.createElement("div");
  bubble.className = `ask-bubble ${red ? "red" : "black"}`;
  bubble.innerHTML = `<span class="abr">${rank}</span><span class="abs">${symbol}</span>`;
  Object.assign(bubble.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width:  `${SIZE}px`,
    height: `${SIZE}px`,
    transform: `translate(${fromX}px, ${fromY}px)`,
    opacity: "0",
    pointerEvents: "none",
    zIndex: "9995",
  });
  layer.appendChild(bubble);

  // Phase 1: pop in at asker (0.4 s)
  Promise.resolve(
    animate(bubble, { opacity: [0, 1], scale: [0.35, 1.12, 1] }, { duration: 0.4, ease: "backOut" }),
  ).then(() => {
    // Phase 2: float to target (5 s)
    Promise.resolve(
      animate(
        bubble,
        { x: [fromX, toX], y: [fromY, toY], scale: [1, 1.07, 1] },
        { duration: 5, ease: [0.37, 0, 0.63, 1] },
      ),
    ).then(() => {
      if (!opts.success) {
        // ── Burst ─────────────────────────────────────────────────────────
        Promise.resolve(
          animate(
            bubble,
            { scale: [1, 1.9, 0.1], opacity: [1, 0.75, 0] },
            { duration: 0.5, ease: "easeOut" },
          ),
        ).then(() => bubble.remove());
      } else {
        // ── Dissolve bubble, then fly card back ────────────────────────────
        animate(bubble, { opacity: [1, 0], scale: [1, 0.55] }, { duration: 0.35, ease: "easeIn" })
          .then(() => bubble.remove());

        // Small pause so the dissolve registers before the card appears.
        setTimeout(() => spawnReturnCard(layer, fromRect, toRect, rank, symbol, red), 220);
      }
    });
  });
}

function spawnReturnCard(
  layer: HTMLElement,
  askerRect: DOMRect,
  targetRect: DOMRect,
  rank: string,
  symbol: string,
  red: boolean,
): void {
  const CW = 84, CH = 120;
  // Card starts centered at target's seat, flies back to asker's seat.
  const cFromX = targetRect.left + targetRect.width  / 2 - CW / 2;
  const cFromY = targetRect.top  + targetRect.height / 2 - CH / 2;
  const cToX   = askerRect.left  + askerRect.width   / 2 - CW / 2;
  const cToY   = askerRect.top   + askerRect.height  / 2 - CH / 2;

  const card = document.createElement("div");
  card.className = `flying-card face ${red ? "red" : "black"}`;
  card.innerHTML =
    `<span class="cr tl">${rank}</span><span class="cs tl">${symbol}</span>` +
    `<span class="cc">${symbol}</span>` +
    `<span class="cr br">${rank}</span><span class="cs br">${symbol}</span>`;
  Object.assign(card.style, {
    position: "fixed",
    left: "0",
    top: "0",
    transform: `translate(${cFromX}px, ${cFromY}px) scale(0.7)`,
    opacity: "0",
    pointerEvents: "none",
    zIndex: "9996",
  });
  layer.appendChild(card);

  // Pop card in at target seat
  Promise.resolve(
    animate(card, { opacity: [0, 1], scale: [0.7, 1.15] }, { duration: 0.35, ease: "backOut" }),
  ).then(() => {
    // Fly back to asker (5 s)
    Promise.resolve(
      animate(
        card,
        { x: [cFromX, cToX], y: [cFromY, cToY], scale: [1.15, 0.95], rotate: [0, -9] },
        { duration: 5, ease: [0.37, 0, 0.63, 1] },
      ),
    ).then(() => {
      Promise.resolve(
        animate(card, { opacity: [1, 0], scale: [0.95, 0.8] }, { duration: 0.35, ease: "easeIn" }),
      ).then(() => card.remove());
    });
  });
}

// ── Declare card-flight (unchanged) ────────────────────────────────────────

export interface CardFlightOpts {
  from: HTMLElement | DOMRect;
  to:   HTMLElement | DOMRect;
  card?: Card;
  duration?: number;
}

export function flyCard(opts: CardFlightOpts): Promise<void> {
  const layer = ensureLayer();
  const from = rectOf(opts.from);
  const to   = rectOf(opts.to);
  const dur  = opts.duration ?? 1.7;

  const el = document.createElement("div");
  el.className = "flying-card" + (opts.card ? " face" : " back");

  if (opts.card) {
    const { rank, symbol, red } = cardShort(opts.card);
    el.classList.add(red ? "red" : "black");
    el.innerHTML =
      `<span class="cr tl">${rank}</span><span class="cs tl">${symbol}</span>` +
      `<span class="cc">${symbol}</span>` +
      `<span class="cr br">${rank}</span><span class="cs br">${symbol}</span>`;
  }

  const startX = from.left + from.width  / 2 - 42;
  const startY = from.top  + from.height / 2 - 60;
  const endX   = to.left   + to.width    / 2 - 42;
  const endY   = to.top    + to.height   / 2 - 60;

  Object.assign(el.style, {
    position: "fixed",
    left: "0px",
    top: "0px",
    transform: `translate(${startX}px, ${startY}px) scale(0.6) rotate(-8deg)`,
    opacity: "0",
    pointerEvents: "none",
    zIndex: "9995",
  });
  layer.appendChild(el);

  const popIn = 0.25;
  const fly   = dur - popIn - 0.25;
  const land  = 0.25;

  return new Promise<void>((resolve) => {
    const finish = () => { el.remove(); resolve(); };

    Promise.resolve(
      animate(el, { opacity: [0, 1], scale: [0.6, 1.1], rotate: [-10, -2] }, { duration: popIn, ease: "easeOut" }),
    ).then(() => {
      Promise.resolve(
        animate(
          el,
          { x: [startX, endX], y: [startY, endY], scale: [1.1, 0.95], rotate: [-2, 6] },
          { duration: fly, ease: [0.25, 0.46, 0.45, 0.94] },
        ),
      ).then(() => {
        animate(el, { opacity: [1, 0], scale: [0.95, 0.8] }, { duration: land, ease: "easeIn" })
          .then(finish, finish);
      });
    });
  });
}

/**
 * Brief shake animation on a failed ask — applied to the asker's seat element.
 */
export function shake(el: HTMLElement, ms = 450): void {
  el.classList.add("shake");
  setTimeout(() => el.classList.remove("shake"), ms);
}
