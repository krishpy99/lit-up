/**
 * Card animations — ask bubble and declare card-flight.
 *
 * Ask flow:
 *   animateAskBubble — a glassy bubble carrying the card face travels from the
 *   asker's seat to the target's seat over 5 s using a CSS left/top transition
 *   (straight line, predictable, no Motion quirks). On arrival:
 *     success  → bubble dissolves, card face travels back to asker over 5 s
 *     failure  → bubble bursts (scale + fade)
 *
 * Declare flow:
 *   flyCard — each of the six set cards flies from its holder's seat into
 *   the felt center on a staggered schedule (uses Motion).
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

/** Double requestAnimationFrame — ensures browser has committed styles before transition fires. */
function rAF2(fn: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

// ── Ask bubble ──────────────────────────────────────────────────────────────

/**
 * Animate an ask: a glassy bubble travels from askerEl → targetEl (5 s), then
 * either bursts (failure) or dissolves while the card travels back (success, 5 s).
 * Uses CSS left/top transitions so the movement is always visible and predictable.
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

  // Cloud element dimensions (body only; CSS bumps extend above via ::before/::after).
  const W = 100, H = 54;
  const fromX = fromRect.left + fromRect.width  / 2 - W / 2;
  const fromY = fromRect.top  + fromRect.height / 2 - H / 2;
  const toX   = toRect.left   + toRect.width    / 2 - W / 2;
  const toY   = toRect.top    + toRect.height   / 2 - H / 2;

  const bubble = document.createElement("div");
  bubble.className = `ask-bubble ${red ? "red" : "black"}`;
  bubble.innerHTML = `<span class="abr">${rank}</span><span class="abs">${symbol}</span>`;

  // Start at asker position, invisible. transition is opacity-only for the fade-in phase.
  bubble.style.cssText = `
    position: fixed;
    left: ${fromX}px;
    top: ${fromY}px;
    opacity: 0;
    pointer-events: none;
    z-index: 9995;
    transition: opacity 0.35s ease;
  `;
  layer.appendChild(bubble);

  // Phase 1: fade in (0.35 s)
  rAF2(() => { bubble.style.opacity = "1"; });

  // Phase 2: travel to target (3 s straight line), starts after fade-in settles
  setTimeout(() => {
    bubble.style.transition = "left 3s linear, top 3s linear";
    rAF2(() => {
      bubble.style.left = `${toX}px`;
      bubble.style.top  = `${toY}px`;
    });

    // Phase 3: arrival — burst or dissolve + return card
    setTimeout(() => {
      if (!opts.success) {
        // Burst: scale up and fade out (0.5 s)
        bubble.style.transition = "transform 0.5s ease-out, opacity 0.5s ease-out";
        rAF2(() => {
          bubble.style.transform = "scale(2.2)";
          bubble.style.opacity   = "0";
        });
        setTimeout(() => bubble.remove(), 550);
      } else {
        // Dissolve
        bubble.style.transition = "opacity 0.3s ease-in";
        rAF2(() => { bubble.style.opacity = "0"; });
        setTimeout(() => {
          bubble.remove();
          spawnReturnCard(layer, fromRect, toRect, rank, symbol, red);
        }, 350);
      }
    }, 3000);
  }, 400);
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

  // Start at target seat, invisible
  card.style.cssText = `
    position: fixed;
    left: ${cFromX}px;
    top: ${cFromY}px;
    opacity: 0;
    pointer-events: none;
    z-index: 9996;
    transition: opacity 0.35s ease;
  `;
  layer.appendChild(card);

  // Fade in at target seat
  rAF2(() => { card.style.opacity = "1"; });

  // Travel back to asker (4 s straight line)
  setTimeout(() => {
    card.style.transition = "left 4s linear, top 4s linear";
    rAF2(() => {
      card.style.left = `${cToX}px`;
      card.style.top  = `${cToY}px`;
    });

    // Fade out on arrival
    setTimeout(() => {
      card.style.transition = "opacity 0.35s ease-in";
      rAF2(() => { card.style.opacity = "0"; });
      setTimeout(() => card.remove(), 400);
    }, 4000);
  }, 400);
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
