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
import { cardShort, handSortKey, DECLARE_BUBBLE_MS, DECLARE_RETURN_MS, type Card } from "@lit-up/shared";

// ── Animation timing constants ────────────────────────────────────────────────
// All values are in milliseconds unless otherwise noted.
// Edit here to tune the feel of the whole animation system.

export const ANIM = {
  // Ask bubble: how long the bubble is visible at the asker's seat before travelling.
  BUBBLE_PAUSE_AT_ASKER_MS: 500,
  // Travel duration for the outgoing ask bubble (asker → target).
  BUBBLE_TRAVEL_MS: 500,
  // How long the bubble sits at the target's seat before burst/dissolve fires.
  BUBBLE_PAUSE_AT_TARGET_MS: 500,
  // How long the bubble takes to dissolve on a successful ask.
  BUBBLE_DISSOLVE_MS: 300,
  // How long the burst animation plays on a failed ask (scale + fade).
  BUBBLE_BURST_MS: 500,
  // Pause between the bubble dissolving and the return card spawning.
  BUBBLE_TO_RETURN_GAP_MS: 200,

  // Return card: how long the card is visible at the target's seat before travelling back.
  RETURN_PAUSE_BEFORE_MS: 500,
  // Travel duration for the return card (target → asker).
  RETURN_TRAVEL_MS: 1000,
  // How long the card sits at the asker's seat before fading out.
  RETURN_PAUSE_AFTER_MS: 500,
  // Fade out duration as the return card disappears at the asker.
  RETURN_FADE_OUT_MS: 250,

  // Declare card-flight stagger (ms between each card launching).
  DECLARE_STAGGER_MS: 110,
  // Total flight duration for a single declare card.
  DECLARE_CARD_FLIGHT_S: 1.5, // seconds, passed to Motion
} as const;

// Env-var overrides for ask/return timing (baked in at build time via Vite).
const effectiveBubblePauseAtAskerMs   = Number(import.meta.env.VITE_BUBBLE_PAUSE_AT_ASKER_MS)   || ANIM.BUBBLE_PAUSE_AT_ASKER_MS;
const effectiveBubbleTravelMs         = Number(import.meta.env.VITE_BUBBLE_TRAVEL_MS)            || ANIM.BUBBLE_TRAVEL_MS;
const effectiveBubblePauseAtTargetMs  = Number(import.meta.env.VITE_BUBBLE_PAUSE_AT_TARGET_MS)  || ANIM.BUBBLE_PAUSE_AT_TARGET_MS;
const effectiveReturnPauseBeforeMs    = Number(import.meta.env.VITE_RETURN_PAUSE_BEFORE_MS)      || ANIM.RETURN_PAUSE_BEFORE_MS;
const effectiveReturnTravelMs         = Number(import.meta.env.VITE_RETURN_TRAVEL_MS)            || ANIM.RETURN_TRAVEL_MS;
const effectiveReturnPauseAfterMs     = Number(import.meta.env.VITE_RETURN_PAUSE_AFTER_MS)       || ANIM.RETURN_PAUSE_AFTER_MS;

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

    // Phase 1: fade in — bubble becomes visible at asker's seat
    rAF2(() => { bubble.style.opacity = "1"; });

    // Phase 2: pause at asker, then travel to target
    setTimeout(() => {
      bubble.style.transition = `left ${effectiveBubbleTravelMs}ms linear, top ${effectiveBubbleTravelMs}ms linear`;
      rAF2(() => {
        bubble.style.left = `${toX}px`;
        bubble.style.top  = `${toY}px`;
      });

      // Phase 3: pause at target before revealing result
      setTimeout(() => {
        resolveArrived();

        // Phase 4: pause at target, then burst or dissolve + return card
        setTimeout(() => {
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
        }, effectiveBubblePauseAtTargetMs);
      }, effectiveBubbleTravelMs);
    }, effectiveBubblePauseAtAskerMs);
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

  // Start at target seat, invisible — fade in for the pre-travel pause
  card.style.cssText = `
    position: fixed;
    left: ${cFromX}px;
    top: ${cFromY}px;
    opacity: 0;
    pointer-events: none;
    z-index: 9996;
    transition: opacity 0.2s ease;
  `;
  layer.appendChild(card);

  // Phase 1: fade in — card becomes visible at target's seat (pause before travel)
  rAF2(() => { card.style.opacity = "1"; });

  // Phase 2: pause at target, then travel back to asker
  setTimeout(() => {
    card.style.transition = `left ${effectiveReturnTravelMs}ms linear, top ${effectiveReturnTravelMs}ms linear`;
    rAF2(() => {
      card.style.left = `${cToX}px`;
      card.style.top  = `${cToY}px`;
    });

    // Phase 3: pause at asker, then fade out
    setTimeout(() => {
      setTimeout(() => {
        const fadeOutS = ANIM.RETURN_FADE_OUT_MS / 1000;
        card.style.transition = `opacity ${fadeOutS}s ease-in`;
        rAF2(() => { card.style.opacity = "0"; });
        setTimeout(() => {
          card.remove();
          onDone();
        }, ANIM.RETURN_FADE_OUT_MS);
      }, effectiveReturnPauseAfterMs);
    }, effectiveReturnTravelMs);
  }, effectiveReturnPauseBeforeMs);
}

// ── Declare animation ────────────────────────────────────────────────────────

// Env-var overrides (baked in at build time via Vite).
const effectiveDeclReturnMs = Number(import.meta.env.VITE_DECLARE_RETURN_MS) || DECLARE_RETURN_MS;

// Internal declare timing constants (all ms).
const OUTBOUND_MS     = Number(import.meta.env.VITE_DECLARE_BUBBLE_MS) || DECLARE_BUBBLE_MS;
const STAGGER_MS      = 50;        // Phase 1: between bubble launches (global order)
const REVEAL_DURATION = 1000;      // Phase 2: opacity transition for correct bubbles
const REVEAL_OVERLAP  = 500;       // Phase 2: next card starts this many ms after previous
const SCALED_W        = 84 * 0.7; // ≈ 59px — bubble width at 70% scale
const SCALED_H        = 120 * 0.7;// ≈ 84px — bubble height at 70% scale
const CARD_GAP        = 8;         // horizontal gap between side-by-side cards

const DECLARE_POP_MS  = 250;       // Phase 2: scale-in pop for wrong indicator card
const DECLARE_FADE_MS = 300;       // Phase 3: fade-out for wrong bubbles/indicators

/**
 * 3-phase declare animation:
 *
 *   Phase 1 (OUTBOUND_MS, STAGGER_MS stagger) — All bubbles fly from the
 *     declarer's seat to just above each assigned player's seat, side-by-side
 *     when multiple cards go to the same player.
 *
 *   Phase 2 (sequential, REVEAL_OVERLAP apart) — Sorted globally by handSortKey:
 *     correct → bubble fades out (opacity → 0), then a solid flying-card flies
 *               from actual holder to felt center.
 *     wrong   → bubble stays visible with .claim styling; a solid indicator card pops in above
 *               the actual holder's seat (scale 0 → 0.7 over DECLARE_POP_MS).
 *
 *   Phase 3 (after all reveals have started) — Simultaneously shake+fade wrong
 *     bubbles and their indicators; correct flyCards run concurrently.
 *     Promise resolves when all flyCards and wrong fade-outs complete.
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
  if (cards.length === 0) return Promise.resolve();

  // Ensure wiggle keyframes exist in the document.
  if (!document.getElementById("declare-wiggle-style")) {
    const style = document.createElement("style");
    style.id = "declare-wiggle-style";
    style.textContent = `
      @keyframes declare-wrong-wiggle {
        0%,100% { transform: scale(0.7) translateX(0); }
        20%     { transform: scale(0.7) translateX(-8px); }
        40%     { transform: scale(0.7) translateX(8px); }
        60%     { transform: scale(0.7) translateX(-6px); }
        80%     { transform: scale(0.7) translateX(6px); }
      }
      @keyframes declare-wrong-wiggle-solid {
        0%,100% { transform: translateX(0); }
        20%     { transform: translateX(-8px); }
        40%     { transform: translateX(8px); }
        60%     { transform: translateX(-6px); }
        80%     { transform: translateX(6px); }
      }
    `;
    document.head.appendChild(style);
  }

  // ── Phase 1: group by assignedId, compute side-by-side layout, fly & park ─

  // Sort all cards by handSortKey — this is the global reveal order used in Phase 2.
  const sortedCards = [...cards].sort((a, b) => handSortKey(a as Card) - handSortKey(b as Card));

  // Group cards by assignedId (preserving handSortKey order within each group).
  const groupsByPlayer = new Map<string, string[]>();
  for (const card of sortedCards) {
    const assignedId = assignments[card];
    if (!assignedId) continue;
    if (!groupsByPlayer.has(assignedId)) groupsByPlayer.set(assignedId, []);
    groupsByPlayer.get(assignedId)!.push(card);
  }

  // Compute (cardX, cardY) for each card using the side-by-side layout formula.
  const cardPositions = new Map<string, { x: number; y: number }>();
  for (const [assignedId, groupCards] of groupsByPlayer) {
    const seatEl = getSeatEl(assignedId);
    if (!seatEl) continue;
    const seatRect = seatEl.getBoundingClientRect();
    const n = groupCards.length;
    const groupWidth = n * SCALED_W + (n - 1) * CARD_GAP;
    const startX = seatRect.left + seatRect.width / 2 - groupWidth / 2;
    const cardY  = seatRect.top - SCALED_H - 8;
    groupCards.forEach((card, j) => {
      cardPositions.set(card, { x: startX + j * (SCALED_W + CARD_GAP), y: cardY });
    });
  }

  const declarerRect = declarerEl.getBoundingClientRect();
  const declCenterX  = declarerRect.left + declarerRect.width  / 2;
  const declCenterY  = declarerRect.top  + declarerRect.height / 2;

  // Track bubbles in global (sortedCards) order for Phase 2.
  type BubbleInfo = { el: HTMLElement; card: string; assignedId: string };
  const bubbles: BubbleInfo[] = [];

  sortedCards.forEach((card, globalIdx) => {
    const assignedId = assignments[card];
    if (!assignedId) return;
    const pos = cardPositions.get(card);
    if (!pos) return;

    const { rank, symbol, red } = cardShort(card as Card);

    // Bubble starts at declarer center (upper-left of the 84×120 box).
    const fromX = declCenterX - SCALED_W / 2;
    const fromY = declCenterY - SCALED_H / 2;

    const bubble = document.createElement("div");
    // "claim" class uses a dimmed background (not opacity) so the text stays
    // fully legible while the bubble still reads as an unverified assignment.
    bubble.className = `ask-bubble claim ${red ? "red" : "black"}`;
    bubble.innerHTML = `<span class="abr">${rank}</span><span class="abs">${symbol}</span><span class="abc">${symbol}</span>`;
    bubble.style.cssText = `
      position: fixed;
      left: ${fromX}px;
      top: ${fromY}px;
      transform: scale(0.7);
      pointer-events: none;
      z-index: 9995;
    `;
    layer.appendChild(bubble);
    bubbles.push({ el: bubble, card, assignedId });

    // Staggered launch using CSS left/top transition.
    const launchDelay = globalIdx * STAGGER_MS;
    setTimeout(() => {
      bubble.style.transition = `left ${OUTBOUND_MS}ms linear, top ${OUTBOUND_MS}ms linear`;
      rAF2(() => {
        bubble.style.left = `${pos.x}px`;
        bubble.style.top  = `${pos.y}px`;
      });
    }, launchDelay);
  });

  // Wait for the last bubble to land.
  const allLandedMs = OUTBOUND_MS + (sortedCards.length - 1) * STAGGER_MS;

  return new Promise<void>((resolve) => {
    // ── Phase 2: sequential reveals ──────────────────────────────────────

    // Track wrong bubbles and their indicators for Phase 3.
    type WrongEntry = { bubble: HTMLElement; indicator: HTMLElement | null };
    const wrongEntries: WrongEntry[] = [];
    const flyCardPromises: Promise<void>[] = [];

    setTimeout(() => {
      const center     = getCenterEl();
      const centerRect = center ? center.getBoundingClientRect() : null;

      bubbles.forEach(({ el: bubble, card, assignedId }, revealIdx) => {
        const isCorrect = assignedId === sources[card];
        const revealDelay = revealIdx * REVEAL_OVERLAP;

        if (isCorrect) {
          const p = new Promise<void>((res) => {
            setTimeout(() => {
              // Fade out the translucent bubble, spawn a solid flying-card.face
              // (identical to the ask return-card mechanic) and slide it to center.
              bubble.style.transition = `opacity 200ms ease-in`;
              rAF2(() => { bubble.style.opacity = "0"; });
              setTimeout(() => bubble.remove(), 210);

              if (!centerRect) { res(); return; }
              const { rank, symbol, red } = cardShort(card as Card);
              const fromX = parseFloat(bubble.style.left);
              const fromY = parseFloat(bubble.style.top);
              const offsetX = (revealIdx - (bubbles.length - 1) / 2) * (84 + 4);
              const toX = centerRect.left + centerRect.width  / 2 - 42 + offsetX;
              const toY = centerRect.top  + centerRect.height / 2 - 60;

              const solid = document.createElement("div");
              solid.className = `flying-card face ${red ? "red" : "black"}`;
              solid.innerHTML = `<span class="cr tl">${rank}</span><span class="cs tl">${symbol}</span><span class="cc">${symbol}</span><span class="cr br">${rank}</span><span class="cs br">${symbol}</span>`;
              solid.style.cssText = `position:fixed;left:${fromX}px;top:${fromY}px;opacity:0;pointer-events:none;z-index:9996;transition:opacity 200ms ease;`;
              layer.appendChild(solid);
              rAF2(() => { solid.style.opacity = "1"; });

              setTimeout(() => {
                solid.style.transition = `left ${effectiveDeclReturnMs}ms linear, top ${effectiveDeclReturnMs}ms linear`;
                rAF2(() => { solid.style.left = `${toX}px`; solid.style.top = `${toY}px`; });
                setTimeout(() => {
                  solid.style.transition = `opacity 250ms ease-in`;
                  rAF2(() => { solid.style.opacity = "0"; });
                  setTimeout(() => { solid.remove(); res(); }, 260);
                }, effectiveDeclReturnMs);
              }, 220);
            }, revealDelay);
          });
          flyCardPromises.push(p);
        } else {
          // Wrong: bubble stays translucent at wrong seat; solid flying-card.face
          // appears at the actual holder so it's immediately obvious where it really was.
          let indicator: HTMLElement | null = null;
          setTimeout(() => {
            const actualEl = getSeatEl(sources[card]);
            if (actualEl) {
              const actualRect = actualEl.getBoundingClientRect();
              const { rank, symbol, red } = cardShort(card as Card);
              const indX = actualRect.left + actualRect.width / 2 - 42;
              const indY = actualRect.top - 120 - 8;

              indicator = document.createElement("div");
              indicator.className = `flying-card face ${red ? "red" : "black"}`;
              indicator.innerHTML = `<span class="cr tl">${rank}</span><span class="cs tl">${symbol}</span><span class="cc">${symbol}</span><span class="cr br">${rank}</span><span class="cs br">${symbol}</span>`;
              indicator.style.cssText = `position:fixed;left:${indX}px;top:${indY}px;opacity:0;pointer-events:none;z-index:9996;transition:opacity ${DECLARE_POP_MS}ms ease;`;
              layer.appendChild(indicator);
              rAF2(() => { indicator!.style.opacity = "1"; });
            }
            wrongEntries.push({ bubble, indicator });
          }, revealDelay);
        }
      });

      // ── Phase 3: simultaneous wrap-up after all reveals have started ──

      const allRevealsStartedMs = (bubbles.length - 1) * REVEAL_OVERLAP + REVEAL_DURATION;

      const wrongFadePromise = new Promise<void>((res) => {
        setTimeout(() => {
          for (const { bubble, indicator } of wrongEntries) {
            // Wiggle then fade the translucent bubble at the wrong seat.
            bubble.style.animation = `declare-wrong-wiggle 400ms ease`;
            setTimeout(() => {
              bubble.style.animation = "";
              bubble.style.transition = `opacity ${DECLARE_FADE_MS}ms ease-in`;
              rAF2(() => { bubble.style.opacity = "0"; });
              setTimeout(() => bubble.remove(), DECLARE_FADE_MS + 50);
            }, 400);

            // Wiggle the solid indicator using the scale-free keyframe.
            // It stays visible — fades out only after correct cards finish flying.
            if (indicator) {
              indicator.style.animation = `declare-wrong-wiggle-solid 400ms ease`;
              setTimeout(() => { indicator!.style.animation = ""; }, 410);
            }
          }
          setTimeout(res, 400 + DECLARE_FADE_MS + 100);
        }, allRevealsStartedMs);
      });

      // Wait for flyCards and wrong bubble fade-outs, then fade solid indicators.
      Promise.all([...flyCardPromises, wrongFadePromise]).then(() => {
        for (const { indicator } of wrongEntries) {
          if (indicator) {
            indicator.style.transition = `opacity 400ms ease-in`;
            rAF2(() => { indicator!.style.opacity = "0"; });
            setTimeout(() => indicator!.remove(), 450);
          }
        }
        setTimeout(resolve, wrongEntries.some(e => e.indicator) ? 460 : 0);
      });
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
