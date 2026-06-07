/**
 * Bot AI for Literature — Probability-Based Strategy
 *
 * ─── CORE PRINCIPLE ──────────────────────────────────────────────────────────
 * Every decision is driven by probability and information theory. The bot
 * maintains a probability distribution over card locations, updated after every
 * public ask, and picks actions that maximise expected value.
 *
 * ─── KNOWLEDGE TABLE ─────────────────────────────────────────────────────────
 * Every bot maintains an implicit 54×N table (card × player) updated from the
 * public transaction log. Three layers:
 *
 *   Card-level (per card, per player):
 *     P = 1   — confirmed holder (witnessed successful ask transfer)
 *     P = 0   — eliminated (failed ask, or team-exclusion)
 *     P ∝ ... — unknown: hand-size prior + set-engagement + known-in-set bonus
 *
 *   Set-level (per player, per set):
 *     membership  — does this player hold ≥1 card here? "hard"/"soft"/"null"
 *     minCount    — lower bound on cards held (from ask-eligibility + transfers)
 *
 *   Intent (per opponent):
 *     Which cards is this opponent actively searching for? Derived from their
 *     ask history; resolved when they receive the card.
 *
 * ─── SET-LEVEL CONFIDENCE ────────────────────────────────────────────────────
 * When a player asks for a card in set S they reveal they hold ≥1 card there.
 *
 *   hard confirm  — teammate asks + bot is medium difficulty (honest signalling)
 *   soft confirm  — teammate asks + bot is hard/expert (deceptive asks exist);
 *                   OR any opponent ask (can never see their difficulty level)
 *
 * ─── ASK-ELIGIBILITY INFERENCE (medium+) ─────────────────────────────────────
 * When teammate T successfully asks for card C in set S, T had to hold ≥1 base
 * card already. That base card never appeared in the transaction log. The inference
 * bumps teamKnown beyond what explicit transfers show, enabling immediate declares
 * that naive tracking misses.
 *
 * ─── SET EXPOSURE & LEAKAGE ──────────────────────────────────────────────────
 * Asking in a set publicly reveals you hold at least one card there:
 *
 *   - "Team-exposed": our team has asked in this set → opponents know we have
 *     a base here and may start targeting our holders.
 *   - "Fresh set": neither team has asked yet → asking reveals our base (leakage
 *     cost). On hard/expert difficulty, avoid opening fresh sets unless team
 *     progress in that set is already high (≥ 4 known cards).
 *
 * ─── THREAT ASSESSMENT ───────────────────────────────────────────────────────
 * For each set where our team holds cards:
 *
 *   - If the set is team-exposed AND opponents have also engaged in it, they
 *     can triangulate our holdings. High threat = race to complete before they
 *     strip a key card.
 *   - Team has 5/6 cards? Threat is maximum — declare soon.
 *   - On hard/expert difficulty, threatened sets receive a +30 urgency bonus.
 *
 * ─── "ALL CARDS ON TEAM" HANDLING ────────────────────────────────────────────
 * If P = 0 for all opponents in a set (all cards are provably on our team), the
 * bot generates no candidate for that set. It waits for a teammate to declare or
 * switches to another set where opponent cards remain.
 *
 * ─── TEAMMATE SIGNALING ("ECHO ASK") ─────────────────────────────────────────
 * Bots coordinate with teammates through public asks (medium/hard/expert):
 *
 *   - After a teammate's failed ask for card C in set S, if the bot holds
 *     cards in S, it may ask for C from a DIFFERENT opponent.
 *   - This signals: "I also have cards in this set — let's coordinate."
 *   - Condition: the alternate target must have > 15% probability of holding C,
 *     and the set must not be fully within our team already.
 *   - Echo asks score with a mild ×1.1 bonus for the signalling value.
 *
 * ─── TEMPO TRAP (expert only) ────────────────────────────────────────────────
 * If opponent O is searching for card C (has asked for it, not received it), and
 * the bot does not hold C but holds another card D in the same set — ask O for a
 * DIFFERENT card E in that set.
 *
 * Mechanism: O still needs C. The bot hasn't been asked about C yet. O's highest-
 * probability next target for C is the bot. O asks the bot; bot doesn't have C;
 * O loses their turn. Net: bot gets one ask AND triggers a wasted opponent turn.
 *
 * ─── SCORING FORMULA ─────────────────────────────────────────────────────────
 * score = pSuccess × (10 + teamKnown × 8)
 *       + lockOutBonus    (almostDeclare → +50 × pSuccess)           medium+
 *       + hintBonus       (teammates working this set → up to +18)   medium+
 *       − specPenalty     (low-info blind guess → −(1−p) × 5)        medium+
 *       − leakagePenalty  (fresh set → −8)                           hard/expert
 *       + threatUrgency   (threatened set → +threatLevel × 30)       hard/expert
 *       + endGameBonus    (small hand → +pSuccess × 15)              hard/expert
 *       − teamHeldPenalty (likely-team unknowns → −unknown × 6)      hard/expert
 *       + trapBonus       (tempo trap → +P(wasted turn) × 25)        expert
 *
 * ─── DIFFICULTY LEVELS ───────────────────────────────────────────────────────
 *   easy   — full probability model. Highest-P target. Deduction. No strategic
 *            scoring, no teammate coordination, no set restrictions.
 *
 *   medium — easy + ask-eligibility inference, immediate declares, echo asks,
 *            strategic scoring (lockout, hint, speculative penalty). Hard-confirms
 *            teammate set membership signals.
 *
 *   hard   — medium + soft-confirm signals (aware of deceptive asks). Leakage
 *            penalty, threat urgency, end-game focus. Deprioritises sets whose
 *            remaining unknowns are likely with teammates.
 *
 *   expert — hard + opponent intent tracking + tempo trap.
 */

import {
  ALL_CARDS,
  CARD_TO_SET,
  SET_DEFS,
  SET_LOOKUP,
  type Card,
  type SetKey,
  type Team,
} from "@lit-up/shared";

/** All four difficulty tiers. Defined locally so the bot compiles independently
 *  of which version of the shared package is installed in node_modules. */
type BotDifficulty = "easy" | "medium" | "hard" | "expert";
import type { GameState, Player } from "./schema.js";
import type { CardKnowledge, HandStore, Transaction, TransactionLog } from "./rules.js";

export type BotAction =
  | { type: "ask"; targetId: string; card: Card }
  | { type: "declare"; setKey: SetKey }
  | { type: "pass" };

// ── Knowledge model types ──────────────────────────────────────────────────

/** Confidence of a set-membership inference derived from ask history. */
type ConfidenceLevel = "hard" | "soft";

/**
 * What the bot knows about a single (player, set) pair.
 *
 * membership — null: no evidence; "soft": player probably has ≥1 card here;
 *              "hard": player definitely has ≥1 card here.
 * minCount   — lower bound on how many cards this player currently holds in
 *              the set, derived from ask-eligibility + witnessed transfers.
 */
interface PlayerSetInfo {
  membership: ConfidenceLevel | null;
  minCount: number;
}

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

  /** Most recent ask by a teammate (not the bot), used for echo detection. */
  lastTeammateAsk: Transaction | null;

  /**
   * Per-player, per-set knowledge derived from ask history.
   * Outer key: playerId. Inner key: setKey.
   */
  playerSetKnowledge: Map<string, Map<SetKey, PlayerSetInfo>>;

  /**
   * Cards each opponent is actively searching for, inferred from asks.
   * Key: opponentId. Value: cards asked for but not yet received.
   * Used by expert tier for tempo-trap detection.
   */
  opponentIntents: Map<string, Set<Card>>;
}

function buildContext(
  state: GameState,
  hands: HandStore,
  ck: CardKnowledge,
  txLog: TransactionLog,
  bot: Player,
): BotCtx {
  const diff = state.botDifficulty as BotDifficulty; // schema type is a superset
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
  const playerSetKnowledge = new Map<string, Map<SetKey, PlayerSetInfo>>();
  const opponentIntents = new Map<string, Set<Card>>();

  // Helper: get-or-create the PlayerSetInfo for a given (player, set) pair.
  function getSetInfo(playerId: string, setKey: SetKey): PlayerSetInfo {
    let playerMap = playerSetKnowledge.get(playerId);
    if (!playerMap) {
      playerMap = new Map();
      playerSetKnowledge.set(playerId, playerMap);
    }
    let info = playerMap.get(setKey);
    if (!info) {
      info = { membership: null, minCount: 0 };
      playerMap.set(setKey, info);
    }
    return info;
  }

  // Single forward pass: aggregate ask counts, set membership, minCounts,
  // opponent intents, and open sets all at once.
  for (const tx of txLog) {
    openSets.add(tx.setKey);

    if (tx.askerId === bot.id) {
      selfAsksInSet.set(tx.setKey, (selfAsksInSet.get(tx.setKey) ?? 0) + 1);
    } else if (tx.askerTeam === bot.team) {
      teammateAsksInSet.set(tx.setKey, (teammateAsksInSet.get(tx.setKey) ?? 0) + 1);
    }

    // ── Set membership + minCount for the asker ──────────────────────────
    const askerInfo = getSetInfo(tx.askerId, tx.setKey);

    // Determine confidence: depends on whether asker is a teammate and bot's tier.
    let confidence: ConfidenceLevel;
    const askerIsTeammate = tx.askerTeam === bot.team && tx.askerId !== bot.id;
    if (askerIsTeammate && diff === "medium") {
      confidence = "hard"; // medium bots trust teammate signals as honest
    } else {
      confidence = "soft"; // opponents always soft; hard/expert aware of deception
    }

    // Only upgrade confidence, never downgrade (null → soft → hard).
    if (
      askerInfo.membership === null ||
      (askerInfo.membership === "soft" && confidence === "hard")
    ) {
      askerInfo.membership = confidence;
    }

    // Asker had at least a base card to ask.
    if (askerInfo.minCount < 1) askerInfo.minCount = 1;
    // Successful ask: asker also received a card.
    if (tx.success) askerInfo.minCount++;

    // ── minCount update for the target (lost a card on success) ──────────
    if (tx.success) {
      const targetInfo = getSetInfo(tx.targetId, tx.setKey);
      targetInfo.minCount = Math.max(0, targetInfo.minCount - 1);
    }

    // ── Opponent intent tracking (expert uses this for tempo trap) ────────
    const askerIsOpponent = tx.askerTeam !== bot.team;
    if (askerIsOpponent) {
      let intents = opponentIntents.get(tx.askerId);
      if (!intents) {
        intents = new Set();
        opponentIntents.set(tx.askerId, intents);
      }
      if (tx.success) {
        intents.delete(tx.card); // intent resolved — they found the card
      } else {
        intents.add(tx.card); // still searching
      }
    }
  }

  // Single backward pass to find the most recent teammate ask for echo detection.
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
    playerSetKnowledge,
    opponentIntents,
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

  // 1b. Inferred declare: every card is either in teamCards/myHand OR has P = 0
  //     for all opponents (eliminated via ck.absent). Covers cards that were never
  //     transferred but that opponents have been fully eliminated from.
  for (const s of SET_DEFS) {
    if (ctx.claimed.has(s.key)) continue;
    if (!s.cards.some(c => ctx.myHand.includes(c) || ctx.teamCards.has(c))) continue;
    const allOnTeam = s.cards.every(c => {
      if (ctx.myHand.includes(c) || ctx.teamCards.has(c)) return true;
      const cardOdds = computeCardOdds(c, ctx);
      return ctx.opponents.every(o => (cardOdds.get(o.id) ?? 0) < 0.001);
    });
    if (allOnTeam) return { type: "declare", setKey: s.key };
  }

  // 1c. Ask-eligibility declare (medium+): a teammate's untracked base card
  //     completes the set. analyzeSet incorporates this inference for medium+,
  //     so canDeclare here reflects base cards that 1a/1b would miss.
  if (ctx.diff !== "easy") {
    for (const s of SET_DEFS) {
      if (ctx.claimed.has(s.key)) continue;
      if (!s.cards.some(c => ctx.myHand.includes(c) || ctx.teamCards.has(c))) continue;
      if (analyzeSet(s.key, ctx).canDeclare) {
        return { type: "declare", setKey: s.key };
      }
    }
  }

  if (ctx.opponents.length === 0) return { type: "pass" };

  // 2. Build candidates, score, and pick the best.
  const candidates = buildCandidates(ctx);
  if (candidates.length === 0) {
    const fallback = pickRandomAsk(ctx);
    if (fallback) return fallback;
    return { type: "pass" };
  }

  candidates.sort((a, b) => b.score - a.score);
  const topScore = candidates[0].score;
  const top = candidates.filter(c => c.score >= topScore - 0.001);
  const pick = top[Math.floor(Math.random() * top.length)];
  return { type: "ask", targetId: pick.targetId, card: pick.card };
}

// ── Probability model ──────────────────────────────────────────────────────

/**
 * Returns P(each player holds this card) as a map keyed by player ID.
 * Values sum to ≤ 1 over all eligible players; 0 for eliminated / self.
 */
function computeCardOdds(card: Card, ctx: BotCtx): Map<string, number> {
  const { ck, hands, txLog, myHand, allPlayers, bot, teamCards } = ctx;
  const setKey = CARD_TO_SET.get(card)!;
  const odds = new Map<string, number>(allPlayers.map(p => [p.id, 0]));

  if (myHand.includes(card)) return odds;
  if (teamCards.has(card)) return odds;

  const info = ck.get(card);

  if (info?.holder) {
    odds.set(info.holder, 1.0);
    return odds;
  }

  const absent = info?.absent ?? new Set<string>();

  const knownInSet = new Map<string, number>();
  for (const c of SET_LOOKUP[setKey].cards) {
    if (c === card) continue;
    const h = ck.get(c)?.holder;
    if (h) knownInSet.set(h, (knownInSet.get(h) ?? 0) + 1);
  }

  const setAskers = new Set<string>();
  for (const tx of txLog) {
    if (tx.setKey === setKey) setAskers.add(tx.askerId);
  }

  const eligible = allPlayers.filter(
    p =>
      p.id !== bot.id &&
      !absent.has(p.id) &&
      (hands.get(p.id)?.length ?? 0) > 0,
  );

  if (eligible.length === 0) return odds;

  let totalWeight = 0;
  const weights = new Map<string, number>();

  for (const p of eligible) {
    const handSize = Math.max(1, hands.get(p.id)?.length ?? 1);
    let w = handSize;
    w += (knownInSet.get(p.id) ?? 0) * 5;
    if (setAskers.has(p.id)) w *= 1.8;
    weights.set(p.id, w);
    totalWeight += w;
  }

  for (const p of eligible) {
    odds.set(p.id, (weights.get(p.id) ?? 0) / totalWeight);
  }

  return odds;
}

// ── Set analysis ───────────────────────────────────────────────────────────

interface SetAnalysis {
  /** Cards provably on our team (explicit + inferred base cards for medium+). */
  teamKnown: number;
  /** Cards provably on the opponent team (via ck.holder). */
  oppKnown: number;
  /** Cards with no confirmed location. */
  unknown: number;
  /** Team holds all 6 — ready to declare. */
  canDeclare: boolean;
  /** Team has 5, opponents have 0 — one card away from declaring. */
  almostDeclare: boolean;
  /** Our team has asked in this set → opponents know we have a base. */
  teamExposed: boolean;
  /** Opponents have asked in this set → they have a base here. */
  oppExposed: boolean;
  /** 0–1 urgency: how much to race to complete this set before opponents do. */
  threatLevel: number;
}

function analyzeSet(setKey: SetKey, ctx: BotCtx): SetAnalysis {
  const { ck, txLog, teamCards, myHand, bot, state, diff, teammates, playerSetKnowledge } = ctx;
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

  // Medium+: add untracked teammate base cards via ask-eligibility inference.
  // A teammate who asked in this set held ≥1 base card; if minCount exceeds what
  // we can account for via explicit transfers, the difference is untracked base cards.
  if (diff !== "easy") {
    for (const teammate of teammates) {
      const setInfo = playerSetKnowledge.get(teammate.id)?.get(setKey);
      if (!setInfo || setInfo.membership === null) continue;
      // Cards in this set that are in teamCards and attributed to this teammate.
      const alreadyTracked = set.cards.filter(c => {
        if (!teamCards.has(c)) return false;
        return ck.get(c)?.holder === teammate.id;
      }).length;
      const extra = Math.max(0, setInfo.minCount - alreadyTracked);
      teamKnown += extra;
      unknown = Math.max(0, unknown - extra);
    }
  }

  const canDeclare = teamKnown >= 6;
  const almostDeclare = teamKnown === 5 && oppKnown === 0;

  let teamExposed = false, oppExposed = false;
  for (const tx of txLog) {
    if (tx.setKey !== setKey) continue;
    if (tx.askerTeam === bot.team) teamExposed = true;
    else oppExposed = true;
    if (teamExposed && oppExposed) break;
  }

  let threatLevel = 0;
  if (teamExposed) {
    threatLevel += 0.2;
    if (oppExposed) threatLevel += 0.3;
    if (teamKnown >= 4) threatLevel += 0.3;
    if (almostDeclare) threatLevel += 0.2;
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
  pSuccess: number;
  score: number;
  confidence: "known" | "deduced" | "probabilistic";
}

function buildCandidates(ctx: BotCtx): Candidate[] {
  const out: Candidate[] = [];

  for (const card of ALL_CARDS) {
    if (!isAskable(card, ctx)) continue;
    const setKey = CARD_TO_SET.get(card)!;

    const odds = computeCardOdds(card, ctx);

    const viable = ctx.opponents
      .map(o => ({ player: o, p: odds.get(o.id) ?? 0 }))
      .filter(x => x.p > 0.001);

    if (viable.length === 0) continue;

    // ── Exact knowledge: confirmed holder is an opponent ─────────────────
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
    // All difficulty levels do basic deduction — this is card-counting, not strategy.
    if (viable.length === 1) {
      const { player, p } = viable[0];
      out.push({
        card, targetId: player.id, pSuccess: p,
        score: scoreAsk(card, player.id, p, "deduced", ctx),
        confidence: "deduced",
      });
      continue;
    }

    // ── Probabilistic: highest-P opponent ────────────────────────────────
    // All difficulties pick the most probable target. Easy just scores differently.
    const best = viable.reduce((a, b) => a.p >= b.p ? a : b);
    out.push({
      card, targetId: best.player.id, pSuccess: best.p,
      score: scoreAsk(card, best.player.id, best.p, "probabilistic", ctx),
      confidence: "probabilistic",
    });
  }

  // ── Echo ask (medium / hard / expert) ──────────────────────────────────
  if (ctx.diff !== "easy") {
    const echo = pickEchoAsk(ctx);
    if (echo) out.push(echo);
  }

  // ── Tempo trap (expert only) ────────────────────────────────────────────
  if (ctx.diff === "expert") {
    const trap = pickTempoTrap(ctx);
    if (trap) out.push(trap);
  }

  return out;
}

// ── Echo ask ───────────────────────────────────────────────────────────────

/**
 * After a teammate's failed ask for card C in set S, ask for C from a DIFFERENT
 * opponent. Signals coordination on the set and generates another elimination.
 * The alternate target must have >15% probability of holding C.
 */
function pickEchoAsk(ctx: BotCtx): Candidate | null {
  const { lastTeammateAsk } = ctx;
  if (!lastTeammateAsk || lastTeammateAsk.success) return null;

  const { card, targetId: prevTarget } = lastTeammateAsk;

  if (!isAskable(card, ctx)) return null;

  const odds = computeCardOdds(card, ctx);

  const altTargets = ctx.opponents
    .filter(o => o.id !== prevTarget)
    .map(o => ({ player: o, p: odds.get(o.id) ?? 0 }))
    .filter(x => x.p > 0.15)
    .sort((a, b) => b.p - a.p);

  if (altTargets.length === 0) return null;

  const { player, p } = altTargets[0];
  const baseScore = scoreAsk(card, player.id, p, "probabilistic", ctx);

  return {
    card, targetId: player.id, pSuccess: p,
    score: baseScore * 1.1,
    confidence: "probabilistic",
  };
}

// ── Tempo trap ─────────────────────────────────────────────────────────────

/**
 * Manufacture a wasted opponent turn.
 *
 * If opponent O is searching for card C in set S (asked for it, never received it),
 * the bot does not hold C, and the bot holds card D in set S — ask O for a different
 * card E in set S.
 *
 * O will eventually ask the bot for C. Since the bot doesn't have C, O loses that
 * turn. By asking O for E first, the bot gets one ask AND sets up that wasted turn:
 * two productive events in two turns instead of one.
 *
 * The trap is scored with a bonus proportional to how likely O is to target the bot
 * for C on their next turn (fewer alternative targets → higher bonus).
 */
function pickTempoTrap(ctx: BotCtx): Candidate | null {
  let bestCandidate: Candidate | null = null;

  for (const opponent of ctx.opponents) {
    const intents = ctx.opponentIntents.get(opponent.id);
    if (!intents || intents.size === 0) continue;

    for (const soughtCard of intents) {
      // Bot must NOT hold the card the opponent is searching for.
      if (ctx.myHand.includes(soughtCard)) continue;
      const setKey = CARD_TO_SET.get(soughtCard)!;

      // Bot must hold at least one card in this set to be eligible to ask.
      if (!ctx.myHand.some(c => CARD_TO_SET.get(c) === setKey)) continue;

      const set = SET_LOOKUP[setKey];

      for (const altCard of set.cards) {
        if (altCard === soughtCard) continue;
        if (!isAskable(altCard, ctx)) continue;

        const odds = computeCardOdds(altCard, ctx);
        const p = odds.get(opponent.id) ?? 0;
        if (p < 0.001) continue;

        // Estimate how likely O is to ask the bot for soughtCard next turn.
        // The fewer non-bot targets remain, the more certain O asks the bot.
        const soughtOdds = computeCardOdds(soughtCard, ctx);
        const otherViableTargets = ctx.allPlayers.filter(
          pl => pl.id !== opponent.id &&
                pl.id !== ctx.bot.id &&
                (soughtOdds.get(pl.id) ?? 0) > 0.001,
        ).length;

        const botNotEliminated = !(ctx.ck.get(soughtCard)?.absent.has(ctx.bot.id) ?? false);
        const totalTargets = otherViableTargets + (botNotEliminated ? 1 : 0);
        const trapProbability = botNotEliminated && totalTargets > 0
          ? 1 / totalTargets
          : 0;

        const trapBonus = trapProbability * 25;
        const totalScore = scoreAsk(altCard, opponent.id, p, "probabilistic", ctx) + trapBonus;

        if (!bestCandidate || totalScore > bestCandidate.score) {
          bestCandidate = {
            card: altCard,
            targetId: opponent.id,
            pSuccess: p,
            score: totalScore,
            confidence: "probabilistic",
          };
        }
      }
    }
  }

  return bestCandidate;
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

  // Base: success probability × how close the team is to declaring this set.
  let s = pSuccess * (10 + sa.teamKnown * 8);

  if (diff === "easy") return s;

  // ── Medium + ─────────────────────────────────────────────────────────────

  // Lock-out: one card from a declaration — highest-leverage ask in the game.
  if (sa.almostDeclare) s += pSuccess * 50;

  // Support: keep working sets teammates are engaged in.
  const teamAsks = ctx.teammateAsksInSet.get(setKey) ?? 0;
  s += Math.min(teamAsks, 3) * 6;

  // Speculative penalty: blind ask in a poorly-characterised set reveals our
  // base without a meaningful return.
  if (sa.unknown > 2 && sa.teamKnown + sa.oppKnown < 3) {
    s -= (1 - pSuccess) * 5;
  }

  if (diff === "hard" || diff === "expert") {
    // Leakage penalty: opening a fresh set tells opponents we hold cards there.
    const setIsLive =
      (ctx.selfAsksInSet.get(setKey) ?? 0) > 0 ||
      (ctx.teammateAsksInSet.get(setKey) ?? 0) > 0;
    if (!setIsLive && sa.teamKnown < 4) s -= 8;

    // Threat urgency: race to complete sets opponents can triangulate.
    s += sa.threatLevel * 30;

    // End-game: small hand means scarce turns — maximise certainty.
    if (ctx.myHand.length <= 3) s += pSuccess * 15;

    // Deprioritise sets where remaining unknowns are likely with teammates.
    // High team concentration + no opponent engagement → don't waste asks here.
    if (sa.teamKnown >= 4 && !sa.oppExposed && sa.unknown > 0) {
      s -= sa.unknown * 6;
    }
  }

  return s;
}

// ── Helpers ────────────────────────────────────────────────────────────────

/**
 * Last-resort random ask. Called only when buildCandidates returns empty —
 * typically when all candidate cards are probabilistically on the bot's own
 * team but the declare checks were inconclusive. Always better than passing.
 */
function pickRandomAsk(ctx: BotCtx): BotAction | null {
  const askable: { card: Card; opponents: string[] }[] = [];

  for (const card of ALL_CARDS) {
    const setKey = CARD_TO_SET.get(card);
    if (!setKey) continue;
    if (ctx.claimed.has(setKey)) continue;
    if (ctx.myHand.includes(card)) continue;
    if (!ctx.myHand.some(c => CARD_TO_SET.get(c) === setKey)) continue;
    const eligibleOpponents = ctx.opponents
      .filter(o => (ctx.hands.get(o.id) ?? []).length > 0)
      .map(o => o.id);
    if (eligibleOpponents.length === 0) continue;
    askable.push({ card, opponents: eligibleOpponents });
  }

  if (askable.length === 0) return null;
  const pick = askable[Math.floor(Math.random() * askable.length)];
  const targetId = pick.opponents[Math.floor(Math.random() * pick.opponents.length)];
  return { type: "ask", card: pick.card, targetId };
}

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
 * Replays the transaction log: add when a teammate gains a card, remove when
 * an opponent takes one back.
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
