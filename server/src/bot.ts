/**
 * Bot AI for Literature — Probability-Based Strategy
 *
 * ─── CORE PRINCIPLE ──────────────────────────────────────────────────────────
 * Every decision is driven by probability and information theory. The bot
 * maintains a probability distribution over card locations, updated after every
 * public ask, and picks actions that maximise expected value.
 *
 * ─── CARD PROBABILITY MODEL ──────────────────────────────────────────────────
 * P(player p holds card c) is computed as follows:
 *
 *   1. Direct knowledge (ck.holder): once a card moves publicly (successful
 *      ask), P = 1 for the new holder, 0 for everyone else. The bot NEVER
 *      blind-guesses a card it has seen change hands.
 *
 *   2. Elimination (ck.absent): after a failed ask, P = 0 for that target.
 *      Probability redistributes proportionally among remaining eligible players.
 *
 *   3. Team-exclusion: if teamCards shows the card is on our team (inferred from
 *      the transaction log), P = 0 for all opponents. The bot skips those cards.
 *
 *   4. Hand-size prior: absent direct knowledge, P ∝ hand size. A player
 *      holding 8 cards is more likely to hold any specific card than one with 2.
 *
 *   5. Set-engagement bonus (×1.8): if a player has ever asked in set S, they
 *      MUST have at least one card there. Cards in S are weighted higher for
 *      that player — they are a more likely target.
 *
 *   6. Known-cards-in-set bonus (+5 per known card): if ck.holder shows that a
 *      player already holds other cards in the same set, their probability for
 *      the remaining unknown cards increases further.
 *
 * ─── SET EXPOSURE & LEAKAGE ──────────────────────────────────────────────────
 * Asking in a set publicly reveals you hold at least one card there:
 *
 *   - "Team-exposed": our team has asked in this set → opponents know we have
 *     a base here and may start targeting our holders.
 *   - "Fresh set": neither team has asked yet → asking reveals our base (leakage
 *     cost). On hard difficulty, avoid opening fresh sets unless team progress
 *     in that set is already high (≥ 4 known cards).
 *
 * ─── THREAT ASSESSMENT ───────────────────────────────────────────────────────
 * For each set where our team holds cards:
 *
 *   - If the set is team-exposed AND opponents have also engaged in it, they
 *     can triangulate our holdings. High threat = race to complete before they
 *     strip a key card.
 *   - Team has 5/6 cards? Threat is maximum — declare soon.
 *   - On hard difficulty, threatened sets receive a +30 urgency bonus in scoring.
 *
 * ─── "ALL CARDS ON TEAM" HANDLING ────────────────────────────────────────────
 * If P = 0 for all opponents in a set (all cards are provably on our team), the
 * bot generates no candidate for that set. It waits for a teammate to declare or
 * switches to another set where opponent cards remain.
 *
 * ─── TEAMMATE SIGNALING ("ECHO ASK") ─────────────────────────────────────────
 * Bots coordinate with teammates through public asks:
 *
 *   - After a teammate's failed ask for card C in set S, if the bot holds
 *     cards in S, it may ask for C from a DIFFERENT opponent.
 *   - This signals: "I also have cards in this set — let's coordinate."
 *   - Condition: the alternate target must have > 15% probability of holding C,
 *     and the set must not be fully within our team already.
 *   - Echo asks score with a mild ×1.1 bonus for the signalling value.
 *
 * ─── TARGET SELECTION ────────────────────────────────────────────────────────
 * Given a card to ask for, the bot picks the opponent with the highest P:
 *
 *   - Known (P = 1): always ask the confirmed holder.
 *   - Deduced (only one eligible opponent): ask them (near-certain).
 *   - Engaged: opponent has previously asked in this set → higher prior.
 *   - Probabilistic: highest P(opponent), weighted by hand size + engagement.
 *   - Easy: uniform random among viable opponents (no probability weighting).
 *
 * ─── SCORING FORMULA ─────────────────────────────────────────────────────────
 * score = pSuccess × (baseProgress + teamKnown × 8)
 *       + lockOutBonus    (almostDeclare → +50 × pSuccess)
 *       + hintBonus       (teammates working this set → up to +18)
 *       − specPenalty     (low-info blind guess → −(1−p) × 5)
 *       − leakagePenalty  (fresh set on hard → −8)
 *       + threatUrgency   (threatened set on hard → +threatLevel × 30)
 *       + endGameBonus    (small hand on hard → +pSuccess × 15)
 *
 * ─── DIFFICULTY LEVELS ───────────────────────────────────────────────────────
 *   easy   — probability-weighted target selection but no strategic scoring.
 *            Stays in open sets. Random viable target. No echo signalling.
 *
 *   medium — full odds model. Prefers sets with more team progress. Echo
 *            signalling. Skips cards known to be on own team.
 *
 *   hard   — medium + leakage penalty for fresh sets. Threat urgency on
 *            exposed near-complete sets. End-game focus. Stronger echo.
 */

import {
  ALL_CARDS,
  CARD_TO_SET,
  SET_DEFS,
  SET_LOOKUP,
  type BotDifficulty,
  type Card,
  type SetKey,
  type Team,
} from "@lit-up/shared";
import type { GameState, Player } from "./schema.js";
import type { CardKnowledge, HandStore, Transaction, TransactionLog } from "./rules.js";

export type BotAction =
  | { type: "ask"; targetId: string; card: Card }
  | { type: "declare"; setKey: SetKey }
  | { type: "pass" };

// ── Context bundle ─────────────────────────────────────────────────────────

interface BotCtx {
  state: GameState;
  hands: HandStore;
  ck: CardKnowledge;
  txLog: TransactionLog;
  bot: Player;
  diff: BotDifficulty;

  myHand: Card[];
  allPlayers: Player[];
  teammates: Player[];
  opponents: Player[];
  teamCards: Set<Card>;
  claimed: Set<SetKey>;

  teammateAsksInSet: Map<SetKey, number>;
  selfAsksInSet: Map<SetKey, number>;
  openSets: Set<SetKey>;

  /**
   * Most recent ask by a teammate (not the bot itself), used for echo
   * detection. Null if the bot has not yet seen a teammate ask.
   */
  lastTeammateAsk: Transaction | null;
}

function buildContext(
  state: GameState,
  hands: HandStore,
  ck: CardKnowledge,
  txLog: TransactionLog,
  bot: Player,
): BotCtx {
  const diff = state.botDifficulty;
  const myHand = hands.get(bot.id) ?? [];
  const allPlayers = [...state.players.values()];
  const teammates = allPlayers.filter(p => p.team === bot.team && p.id !== bot.id);
  const opponents = allPlayers.filter(
    p => p.team !== bot.team && (hands.get(p.id) ?? []).length > 0,
  );

  const teamCards = deriveTeamCardsFromKnowledge(ck, myHand, bot.team, txLog, state);
  const claimed = new Set<SetKey>(
    [...state.claimedA, ...state.claimedB].filter(
      (k): k is string => typeof k === "string",
    ),
  );

  const teammateAsksInSet = new Map<SetKey, number>();
  const selfAsksInSet = new Map<SetKey, number>();
  const openSets = new Set<SetKey>();

  // Walk log forward to build aggregate counts, then walk backward once to
  // find the most recent teammate ask (O(n) total, not O(n²)).
  for (const tx of txLog) {
    openSets.add(tx.setKey);
    if (tx.askerId === bot.id) {
      selfAsksInSet.set(tx.setKey, (selfAsksInSet.get(tx.setKey) ?? 0) + 1);
    } else if (tx.askerTeam === bot.team) {
      teammateAsksInSet.set(tx.setKey, (teammateAsksInSet.get(tx.setKey) ?? 0) + 1);
    }
  }

  let lastTeammateAsk: Transaction | null = null;
  for (let i = txLog.length - 1; i >= 0; i--) {
    const tx = txLog[i];
    if (tx.askerTeam === bot.team && tx.askerId !== bot.id) {
      lastTeammateAsk = tx;
      break;
    }
  }

  return {
    state, hands, ck, txLog, bot, diff,
    myHand, allPlayers, teammates, opponents,
    teamCards, claimed,
    teammateAsksInSet, selfAsksInSet, openSets,
    lastTeammateAsk,
  };
}

// ── Public entrypoint ──────────────────────────────────────────────────────

export function decideBotAction(
  state: GameState,
  hands: HandStore,
  ck: CardKnowledge,
  txLog: TransactionLog,
  bot: Player,
): BotAction {
  if ((hands.get(bot.id) ?? []).length === 0) return { type: "pass" };

  const ctx = buildContext(state, hands, ck, txLog, bot);

  // 1a. Declare when teamCards (derived from successful asks) confirms all 6.
  for (const s of SET_DEFS) {
    if (ctx.claimed.has(s.key)) continue;
    if (s.cards.every(c => ctx.teamCards.has(c))) {
      return { type: "declare", setKey: s.key };
    }
  }

  // 1b. Inferred declare: a set where every card is either in teamCards/myHand
  //     OR has P = 0 for all opponents (eliminated to teammates via ck.absent).
  //     teamCards only tracks cards from *successful* asks; ck.absent can prove
  //     a card is on our team without a successful ask ever happening.
  //     Without this check the bot can deadlock: it knows all cards are on its
  //     team but can't declare because teamCards is incomplete.
  for (const s of SET_DEFS) {
    if (ctx.claimed.has(s.key)) continue;
    // Team must hold at least one card in the set to be allowed to declare.
    if (!s.cards.some(c => ctx.myHand.includes(c) || ctx.teamCards.has(c))) continue;
    const allOnTeam = s.cards.every(c => {
      if (ctx.myHand.includes(c) || ctx.teamCards.has(c)) return true;
      const cardOdds = computeCardOdds(c, ctx);
      return ctx.opponents.every(o => (cardOdds.get(o.id) ?? 0) < 0.001);
    });
    if (allOnTeam) return { type: "declare", setKey: s.key };
  }

  if (ctx.opponents.length === 0) return { type: "pass" };

  // 2. Build candidates, score, and pick the best.
  const candidates = buildCandidates(ctx);
  if (candidates.length === 0) return { type: "pass" };

  candidates.sort((a, b) => b.score - a.score);
  // Break ties randomly among the top-scoring group.
  const topScore = candidates[0].score;
  const top = candidates.filter(c => c.score >= topScore - 0.001);
  const pick = top[Math.floor(Math.random() * top.length)];
  return { type: "ask", targetId: pick.targetId, card: pick.card };
}

// ── Probability model ──────────────────────────────────────────────────────

/**
 * Returns P(each player holds this card) as a map keyed by player ID.
 * Values sum to ≤ 1 over all eligible players; 0 for eliminated / self.
 *
 * See module documentation for the full resolution algorithm.
 */
function computeCardOdds(card: Card, ctx: BotCtx): Map<string, number> {
  const { ck, hands, txLog, myHand, allPlayers, bot, teamCards } = ctx;
  const setKey = CARD_TO_SET.get(card)!;
  const odds = new Map<string, number>(allPlayers.map(p => [p.id, 0]));

  // We hold the card — shouldn't be called, but guard anyway.
  if (myHand.includes(card)) return odds;

  // Transaction-log inference shows card is on our team; P = 0 for all opponents.
  if (teamCards.has(card)) return odds;

  const info = ck.get(card);

  // Direct knowledge: we witnessed this card move — P = 1 for its holder.
  if (info?.holder) {
    odds.set(info.holder, 1.0);
    return odds;
  }

  const absent = info?.absent ?? new Set<string>();

  // Count other cards in this set that are known to be with each player.
  // Having more cards of the same set raises the prior for the remaining cards.
  const knownInSet = new Map<string, number>();
  for (const c of SET_LOOKUP[setKey].cards) {
    if (c === card) continue;
    const h = ck.get(c)?.holder;
    if (h) knownInSet.set(h, (knownInSet.get(h) ?? 0) + 1);
  }

  // Players who have ever asked in this set (revealed they hold a base card).
  const setAskers = new Set<string>();
  for (const tx of txLog) {
    if (tx.setKey === setKey) setAskers.add(tx.askerId);
  }

  // Eligible: non-absent, non-self, still has cards.
  const eligible = allPlayers.filter(
    p =>
      p.id !== bot.id &&
      !absent.has(p.id) &&
      (hands.get(p.id)?.length ?? 0) > 0,
  );

  if (eligible.length === 0) return odds;

  // Compute weights incorporating all evidence.
  let totalWeight = 0;
  const weights = new Map<string, number>();

  for (const p of eligible) {
    const handSize = Math.max(1, hands.get(p.id)?.length ?? 1);
    let w = handSize;
    // Known-in-set bonus: each confirmed card in this set increases the prior.
    w += (knownInSet.get(p.id) ?? 0) * 5;
    // Set-engagement bonus: player asked in this set → definitely has a base.
    if (setAskers.has(p.id)) w *= 1.8;
    weights.set(p.id, w);
    totalWeight += w;
  }

  // Normalise.
  for (const p of eligible) {
    odds.set(p.id, (weights.get(p.id) ?? 0) / totalWeight);
  }

  return odds;
}

// ── Set analysis ───────────────────────────────────────────────────────────

interface SetAnalysis {
  /** Cards whose location is provably our team (self + inferred teammates). */
  teamKnown: number;
  /** Cards whose location is provably the opponent team (via ck.holder). */
  oppKnown: number;
  /** Cards with no confirmed location. */
  unknown: number;
  /** Team holds all 6 — ready to declare. */
  canDeclare: boolean;
  /** Team has 5, opponents have 0 — one card away from declaring. */
  almostDeclare: boolean;
  /** Our team has asked in this set → opponents know we have a base. */
  teamExposed: boolean;
  /** Opponents have asked in this set → we know they have a base. */
  oppExposed: boolean;
  /**
   * 0–1 urgency score: how much should we race to complete this set
   * before opponents strip our cards? Combines exposure + progress.
   */
  threatLevel: number;
}

function analyzeSet(setKey: SetKey, ctx: BotCtx): SetAnalysis {
  const { ck, txLog, teamCards, myHand, bot, state } = ctx;
  const set = SET_LOOKUP[setKey];

  let teamKnown = 0, oppKnown = 0, unknown = 0;

  for (const card of set.cards) {
    if (myHand.includes(card) || teamCards.has(card)) {
      teamKnown++;
    } else {
      const h = ck.get(card)?.holder;
      if (h) {
        const holder = state.players.get(h);
        if (holder?.team === bot.team) teamKnown++;
        else oppKnown++;
      } else {
        unknown++;
      }
    }
  }

  const canDeclare = teamKnown === 6;
  const almostDeclare = teamKnown === 5 && oppKnown === 0;

  let teamExposed = false, oppExposed = false;
  for (const tx of txLog) {
    if (tx.setKey !== setKey) continue;
    if (tx.askerTeam === bot.team) teamExposed = true;
    else oppExposed = true;
    if (teamExposed && oppExposed) break;
  }

  // Threat: opponents can triangulate our position when both sides are engaged.
  let threatLevel = 0;
  if (teamExposed) {
    threatLevel += 0.2;
    if (oppExposed) threatLevel += 0.3;  // opponents actively working this set
    if (teamKnown >= 4) threatLevel += 0.3;
    if (almostDeclare) threatLevel += 0.2; // maximum urgency
  }

  return {
    teamKnown, oppKnown, unknown,
    canDeclare, almostDeclare,
    teamExposed, oppExposed,
    threatLevel,
  };
}

// ── Candidate generation ───────────────────────────────────────────────────

interface Candidate {
  card: Card;
  targetId: string;
  /** Expected probability that the target holds this card. */
  pSuccess: number;
  score: number;
  confidence: "known" | "deduced" | "probabilistic";
}

function buildCandidates(ctx: BotCtx): Candidate[] {
  const out: Candidate[] = [];

  for (const card of ALL_CARDS) {
    if (!isAskable(card, ctx)) continue;
    const setKey = CARD_TO_SET.get(card)!;

    // Easy: only engage sets that have already been opened. Limits leakage
    // while still allowing the bot to react to the game state.
    if (ctx.diff === "easy" && !ctx.openSets.has(setKey) && ctx.openSets.size > 0) {
      continue;
    }

    const odds = computeCardOdds(card, ctx);

    // Opponents with meaningful probability (> 0.1%) of holding this card.
    const viable = ctx.opponents
      .map(o => ({ player: o, p: odds.get(o.id) ?? 0 }))
      .filter(x => x.p > 0.001);

    // All opponent probabilities are zero → card is on our team. Skip.
    if (viable.length === 0) continue;

    // ── Exact knowledge: ck directly identifies the holder ──────────────
    const info = ctx.ck.get(card);
    if (info?.holder) {
      const target = ctx.opponents.find(o => o.id === info!.holder);
      if (target) {
        out.push({
          card, targetId: target.id, pSuccess: 1.0,
          score: scoreAsk(card, target.id, 1.0, "known", ctx),
          confidence: "known",
        });
        continue;
      }
    }

    // ── Deduction: single eligible opponent after all eliminations ───────
    if (ctx.diff !== "easy" && viable.length === 1) {
      const { player, p } = viable[0];
      out.push({
        card, targetId: player.id, pSuccess: p,
        score: scoreAsk(card, player.id, p, "deduced", ctx),
        confidence: "deduced",
      });
      continue;
    }

    // ── Probabilistic: best-odds target ──────────────────────────────────
    if (ctx.diff === "easy") {
      // Easy picks uniformly at random — no probability weighting.
      const pick = viable[Math.floor(Math.random() * viable.length)];
      out.push({
        card, targetId: pick.player.id, pSuccess: pick.p,
        score: scoreAsk(card, pick.player.id, pick.p, "probabilistic", ctx),
        confidence: "probabilistic",
      });
    } else {
      // Medium / Hard: ask the opponent most likely to hold the card.
      const best = viable.reduce((a, b) => a.p >= b.p ? a : b);
      out.push({
        card, targetId: best.player.id, pSuccess: best.p,
        score: scoreAsk(card, best.player.id, best.p, "probabilistic", ctx),
        confidence: "probabilistic",
      });
    }
  }

  // ── Echo ask (medium / hard only) ──────────────────────────────────────
  if (ctx.diff !== "easy") {
    const echo = pickEchoAsk(ctx);
    if (echo) out.push(echo);
  }

  return out;
}

// ── Echo ask ───────────────────────────────────────────────────────────────

/**
 * Detect whether the bot should "echo" a teammate's recent failed ask.
 *
 * Scenario: teammate asked for card C in set S and failed. The bot also
 * holds cards in S. By asking for C from a *different* opponent the bot
 * signals "I'm coordinating on set S" and simultaneously narrows down
 * where C is (another elimination if they fail again).
 *
 * Only fires when:
 *   - The teammate's last ask was a failure.
 *   - The bot itself can legally ask for the same card (has a base in set S).
 *   - A different opponent has > 15% probability of holding C.
 *   - The set is not already fully within our team (viable opponents exist).
 */
function pickEchoAsk(ctx: BotCtx): Candidate | null {
  const { lastTeammateAsk } = ctx;
  if (!lastTeammateAsk || lastTeammateAsk.success) return null;

  const { card, targetId: prevTarget } = lastTeammateAsk;

  // Bot must be able to legally ask for this card.
  if (!isAskable(card, ctx)) return null;

  const odds = computeCardOdds(card, ctx);

  // Find an alternate target (not the one the teammate already asked).
  const altTargets = ctx.opponents
    .filter(o => o.id !== prevTarget)
    .map(o => ({ player: o, p: odds.get(o.id) ?? 0 }))
    .filter(x => x.p > 0.15)
    .sort((a, b) => b.p - a.p);

  if (altTargets.length === 0) return null;

  const { player, p } = altTargets[0];
  const baseScore = scoreAsk(card, player.id, p, "probabilistic", ctx);

  // Mild bonus for the signalling value of the echo.
  return {
    card, targetId: player.id, pSuccess: p,
    score: baseScore * 1.1,
    confidence: "probabilistic",
  };
}

// ── Scoring ────────────────────────────────────────────────────────────────

function scoreAsk(
  card: Card,
  targetId: string,
  pSuccess: number,
  confidence: "known" | "deduced" | "probabilistic",
  ctx: BotCtx,
): number {
  const setKey = CARD_TO_SET.get(card)!;
  const { diff } = ctx;
  const sa = analyzeSet(setKey, ctx);

  // Base expected value: success probability × how close we are to declaring.
  let s = pSuccess * (10 + sa.teamKnown * 8);

  if (diff === "easy") return s;

  // ── Medium + Hard ────────────────────────────────────────────────────────

  // Lock-out: one card away from a declaration — highest leverage in the game.
  if (sa.almostDeclare) s += pSuccess * 50;

  // Hint / support: keep working sets teammates are actively engaged in.
  const teamAsks = ctx.teammateAsksInSet.get(setKey) ?? 0;
  s += Math.min(teamAsks, 3) * 6;

  // Speculative penalty: if the set is poorly characterised and success odds
  // are low, the ask reveals our base without gaining much.
  if (sa.unknown > 2 && sa.teamKnown + sa.oppKnown < 3) {
    s -= (1 - pSuccess) * 5;
  }

  if (diff === "hard") {
    // Leakage penalty: opening a fresh set tells opponents we have cards there.
    // Skip unless team progress is already high enough to justify the exposure.
    const setIsLive =
      (ctx.selfAsksInSet.get(setKey) ?? 0) > 0 ||
      (ctx.teammateAsksInSet.get(setKey) ?? 0) > 0;
    if (!setIsLive && sa.teamKnown < 4) s -= 8;

    // Threat urgency: race to complete sets opponents can triangulate.
    s += sa.threatLevel * 30;

    // End-game: small hand means fewer turns left — maximise certainty.
    if (ctx.myHand.length <= 3) s += pSuccess * 15;
  }

  return s;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Legal ask: own a card in the same set, don't hold the card, set unclaimed. */
function isAskable(card: Card, ctx: BotCtx): boolean {
  const setKey = CARD_TO_SET.get(card);
  if (!setKey) return false;
  if (ctx.claimed.has(setKey)) return false;
  if (ctx.myHand.includes(card)) return false;
  return ctx.myHand.some(c => CARD_TO_SET.get(c) === setKey);
}

/**
 * Derive team cards from public knowledge only — no peeking at actual hands.
 *
 * Replays the transaction log: add when a teammate gains a card via a
 * successful ask, remove when an opponent successfully takes it back.
 * This is the canonical "what does our team provably hold?" view.
 */
function deriveTeamCardsFromKnowledge(
  ck: CardKnowledge,
  myHand: Card[],
  myTeam: Team,
  txLog: TransactionLog,
  state: GameState,
): Set<Card> {
  const cards = new Set<Card>(myHand);
  for (const tx of txLog) {
    if (!tx.success) continue;
    if (tx.askerTeam === myTeam) {
      cards.add(tx.card);
    } else {
      const target = state.players.get(tx.targetId);
      if (target?.team === myTeam) cards.delete(tx.card);
    }
  }
  return cards;
}

/**
 * For a confirmed-correct declare, build the card → playerId assignment map
 * by inspecting the actual hands. Returns null if the team doesn't hold all
 * six cards (should not happen in normal play).
 */
export function buildBotDeclareAssignments(
  state: GameState,
  hands: HandStore,
  bot: Player,
  setKey: SetKey,
): Record<Card, string> | null {
  const set = SET_LOOKUP[setKey];
  if (!set) return null;
  const assignments: Record<Card, string> = {};
  for (const card of set.cards) {
    let found: string | null = null;
    state.players.forEach((p: Player, id: string) => {
      if (p.team !== bot.team) return;
      if ((hands.get(id) ?? []).includes(card)) found = id;
    });
    if (!found) return null;
    assignments[card] = found;
  }
  return assignments;
}

// Re-export for the room module's convenience.
export type { Transaction, TransactionLog };
