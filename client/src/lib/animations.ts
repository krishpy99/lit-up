/**
 * Card animations — ask bubble and declare card-flight.
 *
 * Ask flow:
 *   animateAskBubble — a glassy circle bubble carrying the card face travels
 *   from the asker's seat to the target's seat using a CSS left/top transition
 *   (straight line, predictable, no Motion quirks). On arrival:
 *     success  → bubble dissolves, card face travels back to asker
 *     failure  → bubble bursts (scale + fade)
 *
 *   Returns { onArrivedAtTarget, onComplete } so callers can fire sounds/toasts
 *   at the correct moment (when the result is visually revealed to the asker).
 *
 *   Calls are automatically queued — a new ask animation does not start until
 *   the previous one fully completes.
 *
 * Declare flow:
 *   flyCard — each of the six set cards flies from its holder's seat into
 *   the felt center on a staggered schedule (uses Motion).
 */

import { animate } from "motion";
import { cardShort, handSortKey, DECLARE_RETURN_MS, type Card } from "@lit-up/shared";

// ── Animation timing constants ────────────────────────────────────────────────
// All values are in milliseconds unless otherwise noted.
// Edit here to tune the feel of the whole animation system.

export const ANIM = {
  // Ask bubble: fade in at asker's seat before starting travel.
  BUBBLE_FADE_IN_MS:  350,
  // Settle delay before the bubble starts moving (gives the fade-in time to finish).
  BUBBLE_PRE_TRAVEL_MS: 400,
  // Travel duration for the outgoing ask bubble (asker → target).
  // Must be exactly RETURN_TRAVEL_MS - 500 per design spec.
  BUBBLE_TRAVEL_MS: 1500,
  // How long the bubble takes to dissolve on a successful ask.
  BUBBLE_DISSOLVE_MS: 300,
  // How long the burst animation plays on a failed ask (scale + fade).
  BUBBLE_BURST_MS: 500,
  // Pause between the bubble dissolving and the return card spawning.
  BUBBLE_TO_RETURN_GAP_MS: 350,

  // Return card: fade in at target seat before traveling back.
  RETURN_FADE_IN_MS: 350,
  // Settle delay before the return card starts moving.
  RETURN_PRE_TRAVEL_MS: 400,
  // Travel duration for the return card (target → asker).
  // Bubble travel = RETURN_TRAVEL_MS - 500, so the bubble is 500 ms faster.
  RETURN_TRAVEL_MS: 2000,
  // Fade out duration as the return card lands at the asker.
  RETURN_FADE_OUT_MS: 350,
  // Extra pause after fade-out completes before the promise resolves.
  RETURN_LAND_SETTLE_MS: 400,

  // Declare card-flight stagger (ms between each card launching).
  DECLARE_STAGGER_MS: 110,
  // Total flight duration for a single declare card.
  DECLARE_CARD_FLIGHT_S: 1.5, // seconds, passed to Motion
} as const;

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

// ── Ask bubble queue ─────────────────────────────────────────────────────────

/** Queue of pending ask animations. Each entry is a factory that runs the
 *  animation and resolves when it is fully complete. */
const askQueue: Array<() => Promise<void>> = [];
let askRunning = false;

/** Callbacks registered via onNextIdle; fired once when the queue drains. */
const idleCallbacks: Array<() => void> = [];

function drainAskQueue(): void {
  if (askRunning || askQueue.length === 0) return;
  askRunning = true;
  const next = askQueue.shift()!;
  next().then(() => {
    askRunning = false;
    drainAskQueue();
    // If queue is now truly empty, fire and clear idle callbacks.
    if (!askRunning && askQueue.length === 0) {
      const cbs = idleCallbacks.splice(0);
      cbs.forEach((cb) => cb());
    }
  });
}

/** Returns true while any ask animation is queued or running. */
export function isAnimating(): boolean {
  return askRunning || askQueue.length > 0;
}

/**
 * Register a callback to fire the next time the animation queue goes idle.
 * If the queue is already idle, the callback fires synchronously.
 */
export function onNextIdle(cb: () => void): void {
  if (!isAnimating()) {
    cb();
  } else {
    idleCallbacks.push(cb);
  }
}

// ── Ask bubble ───────────────────────────────────────────────────────────────

export interface AskBubbleHandles {
  /** Resolves when the bubble arrives at the target (burst on fail, dissolve on success).
   *  For a failed ask this is the moment the result is revealed. */
  onArrivedAtTarget: Promise<void>;
  /** Resolves when the entire animation is done.
   *  For a successful ask this is when the return card reaches the asker,
   *  i.e. the moment the result is visually revealed to them. */
  onComplete: Promise<void>;
}

/**
 * Queue and animate an ask: a circle bubble travels from askerEl → targetEl
 * (3 s), then either bursts (failure) or dissolves while the card travels back
 * (success, ~4 s). Animations are serialized — only one runs at a time.
 *
 * Returns handles so callers can fire sounds/toasts at the right moment:
 *   - fail:    listen to onArrivedAtTarget (burst = result revealed)
 *   - success: listen to onComplete (card back at asker = result revealed)
 */
export function animateAskBubble(opts: {
  askerEl: HTMLElement;
  targetEl: HTMLElement;
  card: Card;
  success: boolean;
}): AskBubbleHandles {
  let resolveArrived!: () => void;
  let resolveComplete!: () => void;
  const onArrivedAtTarget = new Promise<void>((res) => { resolveArrived = res; });
  const onComplete        = new Promise<void>((res) => { resolveComplete = res; });

  askQueue.push(() => runAskBubble(opts, resolveArrived, resolveComplete));
  drainAskQueue();

  return { onArrivedAtTarget, onComplete };
}

function runAskBubble(
  opts: { askerEl: HTMLElement; targetEl: HTMLElement; card: Card; success: boolean },
  resolveArrived: () => void,
  resolveComplete: () => void,
): Promise<void> {
  return new Promise<void>((resolveRun) => {
    const layer = ensureLayer();
    const fromRect = opts.askerEl.getBoundingClientRect();
    const toRect   = opts.targetEl.getBoundingClientRect();
    const { rank, symbol, red } = cardShort(opts.card);

    // Ghost card dimensions — matches .ask-bubble { width: 84px; height: 120px }
    const W = 84, H = 120;
    const fromX = fromRect.left + fromRect.width  / 2 - W / 2;
    const fromY = fromRect.top  + fromRect.height / 2 - H / 2;
    const toX   = toRect.left   + toRect.width    / 2 - W / 2;
    const toY   = toRect.top    + toRect.height   / 2 - H / 2;

    const bubble = document.createElement("div");
    bubble.className = `ask-bubble ${red ? "red" : "black"}`;
    bubble.innerHTML = `<span class="abr">${rank}</span><span class="abs">${symbol}</span><span class="abc">${symbol}</span>`;

    // Start at asker position, invisible.
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

    // Phase 1: fade in
    rAF2(() => { bubble.style.opacity = "1"; });

    // Phase 2: travel to target (straight line), starts after fade-in settles
    setTimeout(() => {
      bubble.style.transition = `left ${ANIM.BUBBLE_TRAVEL_MS}ms linear, top ${ANIM.BUBBLE_TRAVEL_MS}ms linear`;
      rAF2(() => {
        bubble.style.left = `${toX}px`;
        bubble.style.top  = `${toY}px`;
      });

      // Phase 3: arrival — burst or dissolve + return card
      setTimeout(() => {
        resolveArrived();

        if (!opts.success) {
          // Burst: scale up and fade out — result is now revealed (fail)
          const burstS = ANIM.BUBBLE_BURST_MS / 1000;
          bubble.style.transition = `transform ${burstS}s ease-out, opacity ${burstS}s ease-out`;
          rAF2(() => {
            bubble.style.transform = "scale(2.2)";
            bubble.style.opacity   = "0";
          });
          setTimeout(() => {
            bubble.remove();
            resolveComplete();
            resolveRun();
          }, ANIM.BUBBLE_BURST_MS + 50);
        } else {
          // Dissolve, then send return card back to asker
          const dissolveS = ANIM.BUBBLE_DISSOLVE_MS / 1000;
          bubble.style.transition = `opacity ${dissolveS}s ease-in`;
          rAF2(() => { bubble.style.opacity = "0"; });
          setTimeout(() => {
            bubble.remove();
            spawnReturnCard(layer, fromRect, toRect, rank, symbol, red, () => {
              // Card has arrived at asker — result is now revealed (success)
              resolveComplete();
              resolveRun();
            });
          }, ANIM.BUBBLE_TO_RETURN_GAP_MS);
        }
      }, ANIM.BUBBLE_TRAVEL_MS);
    }, ANIM.BUBBLE_PRE_TRAVEL_MS);
  });
}

function spawnReturnCard(
  layer: HTMLElement,
  askerRect: DOMRect,
  targetRect: DOMRect,
  rank: string,
  symbol: string,
  red: boolean,
  onDone: () => void,
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
  const fadeInS = ANIM.RETURN_FADE_IN_MS / 1000;
  card.style.cssText = `
    position: fixed;
    left: ${cFromX}px;
    top: ${cFromY}px;
    opacity: 0;
    pointer-events: none;
    z-index: 9996;
    transition: opacity ${fadeInS}s ease;
  `;
  layer.appendChild(card);

  // Fade in at target seat
  rAF2(() => { card.style.opacity = "1"; });

  // Travel back to asker
  setTimeout(() => {
    card.style.transition = `left ${ANIM.RETURN_TRAVEL_MS}ms linear, top ${ANIM.RETURN_TRAVEL_MS}ms linear`;
    rAF2(() => {
      card.style.left = `${cToX}px`;
      card.style.top  = `${cToY}px`;
    });

    // Fade out on arrival, then notify caller
    setTimeout(() => {
      const fadeOutS = ANIM.RETURN_FADE_OUT_MS / 1000;
      card.style.transition = `opacity ${fadeOutS}s ease-in`;
      rAF2(() => { card.style.opacity = "0"; });
      setTimeout(() => {
        card.remove();
        onDone();
      }, ANIM.RETURN_LAND_SETTLE_MS);
    }, ANIM.RETURN_TRAVEL_MS);
  }, ANIM.RETURN_PRE_TRAVEL_MS);
}

// ── Declare animation ────────────────────────────────────────────────────────

// Env-var overrides (baked in at build time via Vite).
const effectiveDeclReturnMs = Number(import.meta.env.VITE_DECLARE_RETURN_MS) || DECLARE_RETURN_MS;

// Internal declare timing constants (all ms).
const DECLARE_FLY_MS         = 500;  // Phase 1: bubble travel duration
const DECLARE_STAGGER_MS_PH1 = 60;   // Phase 1: stagger between bubble launches
const DECLARE_REVEAL_GAP_MS  = 500;  // Phase 2: ms between each card's reveal start
const DECLARE_DISSOLVE_MS    = 400;  // Phase 2: opacity transition for correct bubble
const DECLARE_PAUSE_MS       = 300;  // Phase 2: pause after dissolve before flyCard
const DECLARE_POP_MS         = 300;  // Phase 2: scale-in pop for wrong card
const DECLARE_WIGGLE_MS      = 400;  // Phase 3: wiggle duration for wrong bubbles
const DECLARE_FADE_MS        = 300;  // Phase 3: fade-out for wrong bubbles

/**
 * 3-phase declare animation:
 *   Phase 1 — All 6 bubbles fly from declarer to their assigned seats (~0.5s,
 *              60ms stagger) and park there.
 *   Phase 2 — Sequential reveal, lowest → highest rank, 500ms apart:
 *              correct → bubble goes solid, then flyCard to center (not awaited);
 *              wrong   → bubble dims (opacity → 0.2), solid card pops at actual seat.
 *   Phase 3 — After all reveals, wrong bubbles wiggle then fade out.
 *
 * Promise resolves after Phase 3 completes.
 */
export function animateDeclare(
  declarerId: string,
  assignments: Record<string, string>,  // card → assigned holderId (declarer's claim)
  sources: Record<string, string>,       // card → actual holderId
  success: boolean,
  getSeatEl: (playerId: string) => HTMLElement | null,
  getCenterEl: () => HTMLElement | null,
): Promise<void> {
  const layer = ensureLayer();
  const declarerEl = getSeatEl(declarerId);
  if (!declarerEl) return Promise.resolve();

  const cards = Object.keys(sources);
  const W = 84, H = 120;

  // ── Phase 1: fly all bubbles to assigned seats ──────────────────────────

  const bubbleEls: { el: HTMLElement; assignedId: string; card: string }[] = [];

  cards.forEach((card, i) => {
    const assignedId = assignments[card];
    if (!assignedId) return;
    const targetEl = getSeatEl(assignedId);
    if (!targetEl) return;

    const fromRect = declarerEl.getBoundingClientRect();
    const toRect   = targetEl.getBoundingClientRect();
    const { rank, symbol, red } = cardShort(card as Card);

    const fromX = fromRect.left + fromRect.width  / 2 - W / 2;
    const fromY = fromRect.top  + fromRect.height / 2 - H / 2;
    const toX   = toRect.left   + toRect.width    / 2 - W / 2;
    const toY   = toRect.top    + toRect.height   / 2 - H / 2;

    const bubble = document.createElement("div");
    bubble.className = `ask-bubble ${red ? "red" : "black"}`;
    bubble.innerHTML = `<span class="abr">${rank}</span><span class="abs">${symbol}</span><span class="abc">${symbol}</span>`;
    // Scale down to ~70% via inline transform.
    bubble.style.cssText = `
      position: fixed;
      left: ${fromX}px;
      top: ${fromY}px;
      opacity: 0.35;
      transform: scale(0.7);
      pointer-events: none;
      z-index: 9995;
    `;
    layer.appendChild(bubble);
    bubbleEls.push({ el: bubble, assignedId, card });

    // Staggered launch: set up CSS transition then move after a rAF.
    const launchDelay = i * DECLARE_STAGGER_MS_PH1;
    setTimeout(() => {
      bubble.style.transition = `left ${DECLARE_FLY_MS}ms linear, top ${DECLARE_FLY_MS}ms linear`;
      rAF2(() => {
        bubble.style.left = `${toX}px`;
        bubble.style.top  = `${toY}px`;
      });
    }, launchDelay);
  });

  // All bubbles have landed once the last one finishes travel.
  const allLandedMs = DECLARE_FLY_MS + (cards.length > 0 ? (cards.length - 1) * DECLARE_STAGGER_MS_PH1 : 0);

  return new Promise<void>((resolve) => {
    // ── Phase 2: sequential reveal, ordered by card rank ─────────────────

    setTimeout(() => {
      const center = getCenterEl();
      const centerRect = center ? center.getBoundingClientRect() : null;

      // Sort cards lowest → highest by hand sort key.
      const sortedBubbles = [...bubbleEls].sort(
        (a, b) => handSortKey(a.card as Card) - handSortKey(b.card as Card),
      );

      const wrongBubbleEls: HTMLElement[] = [];

      sortedBubbles.forEach(({ el: bubble, assignedId, card }, revealIdx) => {
        const revealDelay = revealIdx * DECLARE_REVEAL_GAP_MS;
        const isCorrect = assignedId === sources[card];

        if (isCorrect) {
          // Correct: opacity 0.35 → 1 over 0.4s, then flyCard (not awaited).
          setTimeout(() => {
            bubble.style.transition = `opacity ${DECLARE_DISSOLVE_MS}ms ease`;
            rAF2(() => { bubble.style.opacity = "1"; });

            setTimeout(() => {
              bubble.remove();
              if (!centerRect) return;
              const offsetX = (revealIdx - (sortedBubbles.length - 1) / 2) * 18;
              const dest = new DOMRect(
                centerRect.left + offsetX,
                centerRect.top - 18,
                centerRect.width,
                centerRect.height,
              );
              const sourceEl = getSeatEl(sources[card]);
              if (!sourceEl) return;
              // Fire-and-forget — runs concurrently with subsequent reveals.
              flyCard({
                from: sourceEl,
                to: dest,
                card: card as Card,
                duration: effectiveDeclReturnMs / 1000,
              });
            }, DECLARE_DISSOLVE_MS + DECLARE_PAUSE_MS);
          }, revealDelay);
        } else {
          // Wrong: dim the misplaced bubble; pop in a solid card at the actual seat.
          setTimeout(() => {
            bubble.style.transition = "opacity 0.2s ease";
            rAF2(() => { bubble.style.opacity = "0.2"; });

            const actualEl = getSeatEl(sources[card]);
            if (actualEl) {
              const actualRect = actualEl.getBoundingClientRect();
              const { rank, symbol, red } = cardShort(card as Card);
              const ind = document.createElement("div");
              ind.className = `flying-card face ${red ? "red" : "black"}`;
              ind.innerHTML =
                `<span class="cr tl">${rank}</span><span class="cs tl">${symbol}</span>` +
                `<span class="cc">${symbol}</span>` +
                `<span class="cr br">${rank}</span><span class="cs br">${symbol}</span>`;
              const ix = actualRect.left + actualRect.width  / 2 - 42;
              const iy = actualRect.top  + actualRect.height / 2 - 60;
              ind.style.cssText = `
                position: fixed;
                left: ${ix}px;
                top: ${iy}px;
                opacity: 1;
                transform: scale(0);
                pointer-events: none;
                z-index: 9996;
                transition: transform ${DECLARE_POP_MS}ms ease-out;
              `;
              layer.appendChild(ind);
              rAF2(() => { ind.style.transform = "scale(1)"; });
            }

            wrongBubbleEls.push(bubble);
          }, revealDelay);
        }
      });

      // ── Phase 3: wiggle wrong bubbles then fade everything out ──────────

      const allRevealsMs = sortedBubbles.length > 0
        ? (sortedBubbles.length - 1) * DECLARE_REVEAL_GAP_MS + DECLARE_DISSOLVE_MS
        : 0;

      setTimeout(() => {
        wrongBubbleEls.forEach((bubble) => {
          // CSS keyframe wiggle via class — add a keyframe rule dynamically.
          const wiggleKeyframes = `
            @keyframes declare-wrong-wiggle {
              0%,100% { transform: scale(0.7) translateX(0); }
              20%     { transform: scale(0.7) translateX(-6px); }
              40%     { transform: scale(0.7) translateX(6px); }
              60%     { transform: scale(0.7) translateX(-5px); }
              80%     { transform: scale(0.7) translateX(5px); }
            }
          `;
          if (!document.getElementById("declare-wiggle-style")) {
            const style = document.createElement("style");
            style.id = "declare-wiggle-style";
            style.textContent = wiggleKeyframes;
            document.head.appendChild(style);
          }
          bubble.style.animation = `declare-wrong-wiggle ${DECLARE_WIGGLE_MS}ms ease`;

          setTimeout(() => {
            bubble.style.animation = "";
            bubble.style.transition = `opacity ${DECLARE_FADE_MS}ms ease-in`;
            rAF2(() => { bubble.style.opacity = "0"; });
            setTimeout(() => bubble.remove(), DECLARE_FADE_MS + 50);
          }, DECLARE_WIGGLE_MS);
        });

        setTimeout(resolve, DECLARE_WIGGLE_MS + DECLARE_FADE_MS + 100);
      }, allRevealsMs);
    }, allLandedMs);
  });
}

// ── Declare card-flight ──────────────────────────────────────────────────────

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
    left: `${startX}px`,
    top: `${startY}px`,
    transform: `scale(0.6) rotate(-8deg)`,
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
          { x: [0, endX - startX], y: [0, endY - startY], scale: [1.1, 0.95], rotate: [-2, 6] },
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
