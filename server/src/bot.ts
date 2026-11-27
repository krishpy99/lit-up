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
 * When a player asks for any card in set S, they must hold ≥1 card there already.
 * That base card (dealt, never transferred) doesn't appear in the transaction log.
 * The inference bumps `minCount` for that player, raising `teamKnown` for scoring
 * and urgency calculations.
 *
 * INVARIANT: ask-eligibility inference feeds teamKnown (scoring) ONLY. It never
 * feeds teamCertain and never triggers a declare. Only concrete evidence (witnessed
 * transfers, ck.absent eliminations) can trigger a declare.
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
 * ─── DECLARE CERTAINTY INVARIANT ─────────────────────────────────────────────
 * A declare fires ONLY from concrete certainty. Three concrete paths:
 *   1a. All 6 cards in `teamCards` (own hand + witnessed ask transfers).
 *   1b. All 6 cards either in `teamCards` or with all opponents in `ck.absent`.
 *   1c. All opponents have empty hands — the bot's team holds everything by
 *       elimination (handles dealt-but-never-transferred cards at end-game).
 *
 * The bot must personally hold at least one card from the set (game rule).
 * Ask-eligibility inference ONLY affects scoring; it never triggers a declare.
 *
 * ─── "ALL CARDS ON TEAM" HANDLING ────────────────────────────────────────────
 * If all remaining cards of a set are provably on our team but the declare
 * checks haven't fired yet (e.g. not all opponents are in ck.absent), the bot
 * generates no candidates for that set (no opponent to ask). It continues with
 * other sets. The declare fires once certainty is established.
 *
 * ─── TEAMMATE SIGNALING ("ECHO ASK") ─────────────────────────────────────────
 * Bots coordinate with teammates through public asks (medium/hard/expert):
 *
 *   - After a teammate's failed ask for card C in set S, if the bot holds
 *     cards in S, it may ask for C from a DIFFERENT opponent.
 *   - This signals: "I also have cards in this set — let's coordinate."
 *   - Condition: the alternate target must have > 15% probability of holding C,
 *     and the set must not be fully within our team already.
 *   - GATED one-off (not a default): only fires when the team is already
 *     information-rich in the set (teamCertain ≥ 4) AND the set is already
 *     team-exposed, so the marginal leakage is ~free. No score bonus — the gate
 *     itself ensures the ask is already strong.
 *
 * ─── TEMPO TRAP (expert only) ────────────────────────────────────────────────
 * If opponent O is searching for card C (has asked for it, not received it), and
 * the bot does not hold C but holds another card D in the same set — ask O for a
 * DIFFERENT card E in that set.
 *
 * Mechanism: O still needs C. The bot hasn't been asked about C yet. O's highest-
 * probability next target for C is the bot. O asks the bot; bot doesn't have C;
 * O loses their turn. Net: bot gets one ask AND triggers a wasted opponent turn.
 * GATED identically to the echo ask (teamCertain ≥ 4 AND team-exposed) so the
 * trap never opens a fresh set on speculation.
 *
 * ─── INFORMATION ECONOMY (the spine — ALL tiers) ─────────────────────────────
 * Every ask publicly reveals "I hold a base in this set." The game is an
 * information-differential war: prefer asks whose expected gain beats their
 * leakage cost. Two mechanisms, applied at every tier including easy:
 *   - pSuccess is SQUARED in the base score, so certainty gates everything — no
 *     stack of additive bonuses lets a speculative ask win.
 *   - Opening a FRESH set (neither team has asked there) is penalised unless the
 *     team already holds ≥4 there; already-open sets carry no penalty, so the bot
 *     naturally finds open cards first and only opens new fronts when invested.
 *
 * ─── SCORING FORMULA ─────────────────────────────────────────────────────────
 * score = pSuccess² × (10 + teamKnown × 8)                          all tiers
 *       − openPenalty     (fresh set → 0 on easy, coldness×5 on medium,
 *                          coldness×(1−p)×22 on hard/expert)
 *       − convergence     (capped: min(oppConv×3,6)×declareProb)    hard/expert
 *       − dangerTarget    (opponent chasing our card → −8)          medium+
 *       + threatUrgency   (threatened set → +threatLevel × 30)      hard/expert
 *       + endGameBonus    (small hand → +pSuccess × 15)             hard/expert
 *       − teamHeldPenalty (likely-team unknowns → −unknown × 6)     hard/expert
 *       + trapBonus       (gated tempo trap → +P(wasted turn) × 15) expert
 *   (coldness = max(0, 4 − teamKnown))
 *
 * ─── DIFFICULTY LEVELS ───────────────────────────────────────────────────────
 * ─── MEMORY & HUMAN-LIKE PLAY ───────────────────────────────────────────────
 * Bots never share a global knowledge table. Each bot replays only the asks it
 * *remembers*: everything it was part of, the last N asks, and a stable random
 * fraction of older ones (see MEMORY). Forgotten asks stay forgotten, so a bot
 * can misremember who took a card and declare wrongly — just like a person.
 * Declares are built from the bot's beliefs, never from peeking at hands.
 * Final choice is a softmax over candidate scores, so bots aren't predictable.
 *
 *   easy   — noisy probability model (short memory, 12% random asks, no
 *            fresh-set penalty). Information leaks freely. No opponent modelling,
 *            no teammate coordination, no tactics.
 *
 *   medium — clean probability model (15% forget) + ask-eligibility inference,
 *            gated echo asks, dangerous-target avoidance. No convergence avoidance.
 *
 *   hard   — medium (3% forget, 2.0× engagement) + convergence avoidance
 *            (threshold ≥ 2 opponents), threat urgency, end-game focus, investment
 *            bonus, almostDeclare urgency.
 *
 *   expert — hard (0% forget, 4.0× engagement) + opponent intent tracking,
 *            tempo trap, leakage exploitation (+28 bonus for sets opponents have
 *            opened), intelligent post-declare pass.
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
import {
  applyAsk,
  applyDeclare,
  applyPass,
  findNextPlayerWithCards,
  newKnowledge,
  pushAction,
  recordFailure,
  recordSuccess,
  type CardKnowledge,
  type HandStore,
  type Transaction,
  type TransactionLog,
} from "./rules.js";
import { appendFileSync } from "fs";
import { fileURLToPath } from "url";
import { resolve, dirname } from "path";

const _botLogPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../bot-thinking.log");
const BOT_LOG = process.env.LIT_BOT_LOG === "1";

/**
 * How well each tier remembers the public ask history.
 * recent — the last N asks are always remembered.
 * keep   — chance an older ask is still remembered (stable per bot+ask).
 * temp   — softmax temperature for the final pick (higher = looser play).
 */
const MEMORY: Record<BotDifficulty, { recent: number; keep: number; temp: number }> = {
  easy: { recent: 8, keep: 0.45, temp: 5 },
  medium: { recent: 10, keep: 0.55, temp: 3 },
  hard: { recent: 30, keep: 0.9, temp: 1.5 },
  expert: { recent: Infinity, keep: 1, temp: 0.6 },
};

/** Deterministic [0,1) hash so a forgotten ask stays forgotten across turns. */
function stableRandom(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

/** The slice of the public log this bot actually remembers. */
export function rememberedLog(txLog: TransactionLog, botId: string, diff: BotDifficulty): TransactionLog {
  const m = MEMORY[diff];
  return txLog.filter((tx, i) => {
    if (tx.askerId === botId || tx.targetId === botId) return true;
    if (txLog.length - 1 - i < m.recent) return true;
    return stableRandom(`${botId}:${tx.seq}`) < m.keep;
  });
}

/** Rebuild card knowledge from (remembered) asks. */
function replayKnowledge(log: TransactionLog): CardKnowledge {
  const ck = newKnowledge();
  for (const tx of log) {
    recordFailure(ck, tx.card, tx.askerId); // the asker didn't hold it
    recordFailure(ck, tx.card, tx.targetId);
    if (tx.success) recordSuccess(ck, tx.card, tx.askerId);
  }
  return ck;
}

function botLog(entry: object): void {
  if (!BOT_LOG) return;
  appendFileSync(_botLogPath, JSON.stringify(entry) + "\n");
}

export type BotAction =
  | { type: "ask"; targetId: string; card: Card }
  | { type: "declare"; setKey: SetKey; assignments: Record<Card, string> }
  | { type: "pass"; toPlayerId?: string };

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
  diff: BotDifficulty,
): BotCtx {
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
  fullLog: TransactionLog,
  bot: Player,
  diff: BotDifficulty = state.botDifficulty as BotDifficulty,
): BotAction {
  if ((hands.get(bot.id) ?? []).length === 0) return { type: "pass" };

  const txLog = rememberedLog(fullLog, bot.id, diff);
  const ctx = buildContext(state, hands, replayKnowledge(txLog), txLog, bot, diff);

  // 1. Declare from belief. Declare once every card is placed, or the whole
  //    set is provably on our team; easy gets rash and guesses the last card.
  // Easy is occasionally rash: 15% of the time it'll gamble on 5 known cards.
  const rash = ctx.diff === "easy" && Math.random() < 0.15 ? 5 : 6;
  for (const s of SET_DEFS) {
    if (ctx.claimed.has(s.key)) continue;
    if (!ctx.myHand.some(c => s.cards.includes(c))) continue; // must hold a base
    // onTeam: the set is provably ours but some holders are a best guess —
    // a person would declare here too rather than ask forever.
    const { assignments, certain, onTeam } = locateSet(s.key, ctx);
    if (assignments && (certain >= rash || onTeam)) {
      botLog({ ts: new Date().toISOString(), bot: bot.id, name: bot.name, action: "declare", certain, setKey: s.key });
      return { type: "declare", setKey: s.key, assignments };
    }
  }

  // No opponent has cards: every remaining card is on our team, so we must
  // declare — guessing who holds what where memory doesn't say.
  if (ctx.opponents.length === 0) {
    for (const s of SET_DEFS) {
      if (ctx.claimed.has(s.key)) continue;
      if (!ctx.myHand.some(c => s.cards.includes(c))) continue;
      const { assignments } = locateSet(s.key, ctx);
      if (assignments) return { type: "declare", setKey: s.key, assignments };
    }
    return { type: "pass" };
  }

  // 1d. Medium+: rescue pass — after declaring a set (postDeclareId === bot.id),
  //     pass to whichever teammate is best positioned to protect against the
  //     opponent's near-complete set (oppKnown >= 5).
  if (ctx.diff !== "easy" && state.postDeclareId === bot.id) {
    const rescueTarget = pickRescuePassTarget(ctx);
    if (rescueTarget) return { type: "pass", toPlayerId: rescueTarget };
  }

  // 1e. Expert post-declare pass: after a successful declare (postDeclareId
  //     is this bot), decide whether to keep the turn or hand it to a better-
  //     positioned teammate. Pass when a teammate has more known cards in a
  //     nearly-completable set than we can exploit in one ask, signalling that
  //     giving them the turn is higher EV than asking ourselves.
  // 1e. Expert post-declare pass: after a successful declare (postDeclareId
  //     is this bot), decide whether to keep the turn or hand it to a better-
  //     positioned teammate.
  if (ctx.diff === "expert" && state.postDeclareId === bot.id) {
    const passTarget = pickIntelligentPassTarget(ctx);
    if (passTarget) return { type: "pass", toPlayerId: passTarget };
  }

  // 2. Easy: 15% of the time skip scoring entirely and pick randomly.
  //    This simulates inexperienced play: wrong target, wrong card, no planning.
  if (ctx.diff === "easy" && Math.random() < 0.12) {
    const randomAction = pickRandomAsk(ctx);
    if (randomAction) return randomAction;
  }

  // 2. Build candidates, score, and pick the best.
  const candidates = buildCandidates(ctx);
  if (candidates.length === 0) {
    const fallback = pickRandomAsk(ctx);
    if (fallback) return fallback;
    botLog({ ts: new Date().toISOString(), bot: bot.id, name: bot.name, action: "pass", reason: "no-candidates" });
    return { type: "pass" };
  }

  candidates.sort((a, b) => b.score - a.score);
  const pick = softmaxPick(candidates, MEMORY[ctx.diff].temp);

  if (BOT_LOG) {
    const setAnalyses = SET_DEFS
      .filter(s => !ctx.claimed.has(s.key))
      .map(s => { const sa = analyzeSet(s.key, ctx); return { set: s.key, ...sa }; });
    botLog({
      ts: new Date().toISOString(),
      bot: bot.id,
      name: bot.name,
      diff: ctx.diff,
      hand: ctx.myHand,
      teamCards: [...ctx.teamCards],
      setAnalyses,
      topCandidates: candidates.slice(0, 10).map(c => ({
        card: c.card,
        target: ctx.allPlayers.find(p => p.id === c.targetId)?.name ?? c.targetId,
        score: Math.round(c.score * 100) / 100,
      })),
      chosen: {
        card: pick.card,
        target: ctx.allPlayers.find(p => p.id === pick.targetId)?.name ?? pick.targetId,
        score: Math.round(pick.score * 100) / 100,
      },
    });
  }

  return { type: "ask", targetId: pick.targetId, card: pick.card };
}

// ── Probability model ──────────────────────────────────────────────────────

/**
 * Returns P(each player holds this card) as a map keyed by player ID.
 * Values sum to ≤ 1 over all eligible players; 0 for eliminated / self.
 */
function computeCardOdds(card: Card, ctx: BotCtx): Map<string, number> {
  const { ck, hands, myHand, allPlayers, bot, teamCards } = ctx;
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
    // Apply set-engagement bonus: player has confirmed set membership, so
    // they're more likely to hold remaining unknown cards in that set.
    // Expert uses a stronger prior (2.5×) for more accurate targeting.
    const psi = ctx.playerSetKnowledge.get(p.id)?.get(setKey);
    if (psi && psi.membership !== null) {
      w *= ctx.diff === "expert" ? 4.0 : ctx.diff === "hard" ? 2.0 : 1.8;
    }
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
  /**
   * Cards provably on our team via CONCRETE evidence only (own hand + witnessed
   * transfers via transaction log + ck.holder). Never inflated by inference.
   * This is the gating field for canDeclare and almostDeclare.
   */
  teamCertain: number;
  /**
   * Cards estimated on our team, including ask-eligibility inference (medium+).
   * May exceed teamCertain. Used for scoring/urgency only — NEVER gates a declare.
   */
  teamKnown: number;
  /** Cards provably on the opponent team (via ck.holder). */
  oppKnown: number;
  /** Cards with no confirmed location. */
  unknown: number;
  /** All 6 cards are provably on the bot's team (based on teamCertain only). */
  canDeclare: boolean;
  /** teamCertain === 5 and no opponent holds any card — one away from declaring. */
  almostDeclare: boolean;
  /** Our team has asked in this set → opponents know we have a base. */
  teamExposed: boolean;
  /** Opponents have asked in this set → they have a base here. */
  oppExposed: boolean;
  /** 0–1 urgency: how much to race to complete this set before opponents do. */
  threatLevel: number;
  /** teamKnown / 6 — probability the team can declare this set soon. */
  declareProb: number;
  /** Distinct opponents who have minCount >= 1 for this set. */
  oppConverging: number;
  /** Every active opponent has minCount >= 1 for this set. */
  contestedByAll: boolean;
}

function analyzeSet(setKey: SetKey, ctx: BotCtx): SetAnalysis {
  const { ck, txLog, teamCards, myHand, bot, state, diff, teammates, playerSetKnowledge } = ctx;
  const set = SET_LOOKUP[setKey];

  // teamCertain: concrete evidence only (own hand + txLog transfers + ck.holder).
  // teamKnown: teamCertain + ask-eligibility inference for medium+ (scoring only).
  let teamCertain = 0, oppKnown = 0, unknown = 0;

  for (const card of set.cards) {
    if (myHand.includes(card) || teamCards.has(card)) {
      teamCertain++;
    } else {
      const h = ck.get(card)?.holder;
      if (h) {
        const holder = state.players.get(h);
        if (holder?.team === bot.team) teamCertain++;
        else oppKnown++;
      } else {
        unknown++;
      }
    }
  }

  // teamKnown starts equal to teamCertain; medium+ may inflate it via inference.
  let teamKnown = teamCertain;

  // Medium+: add untracked teammate base cards via ask-eligibility inference.
  // A teammate who asked in this set held ≥1 base card; if minCount exceeds what
  // we can account for via explicit transfers, the difference is untracked base cards.
  // IMPORTANT: this only feeds teamKnown (scoring/urgency), NOT teamCertain.
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

  // canDeclare and almostDeclare are gated on teamCertain, not teamKnown.
  const canDeclare = teamCertain >= 6;
  const almostDeclare = teamCertain === 5 && oppKnown === 0;

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

  // declareProb uses teamKnown (includes inference) for smoother scoring.
  const declareProb = teamKnown / 6;

  // Count opponents (players NOT on the bot's team) with minCount >= 1 for this set.
  const activeOpponents = ctx.state.players
    ? [...ctx.state.players.values()].filter(p => p.team !== ctx.bot.team && (ctx.hands.get(p.id) ?? []).length > 0)
    : [];
  let oppConverging = 0;
  for (const opp of activeOpponents) {
    const setInfo = ctx.playerSetKnowledge.get(opp.id)?.get(setKey);
    if (setInfo && setInfo.minCount >= 1) oppConverging++;
  }
  const contestedByAll = activeOpponents.length > 0 && oppConverging === activeOpponents.length;

  return {
    teamCertain, teamKnown, oppKnown, unknown,
    canDeclare, almostDeclare,
    teamExposed, oppExposed,
    threatLevel,
    declareProb,
    oppConverging,
    contestedByAll,
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
 *
 * GATE: only fires when the team is already information-rich in this set
 * (teamCertain >= 4) AND the set is already team-exposed. This ensures the
 * marginal leakage from the echo ask is ~free — the set is already open and
 * nearly complete. Without the gate the echo ask opens fresh sets on speculation,
 * which is exactly the leakage we want to avoid.
 *
 * The alternate target must have >15% probability of holding C.
 */
function pickEchoAsk(ctx: BotCtx): Candidate | null {
  const { lastTeammateAsk } = ctx;
  if (!lastTeammateAsk || lastTeammateAsk.success) return null;

  const { card, targetId: prevTarget } = lastTeammateAsk;
  const setKey = CARD_TO_SET.get(card)!;

  if (!isAskable(card, ctx)) return null;

  // Gate: only echo when near-complete AND already exposed.
  const sa = analyzeSet(setKey, ctx);
  if (sa.teamCertain < 4 || !sa.teamExposed) return null;

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
    score: baseScore,  // no bonus — the gate ensures this is already a strong ask
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
 * GATE: only fires when the team is information-rich in the relevant set
 * (teamCertain >= 4) AND the set is already team-exposed. This ensures:
 *   1. The marginal leakage is ~free (set already open, nearly complete).
 *   2. We're not speculating on a cold set for a minor tactical gain.
 *   3. The bonus only adds value on top of an already-strong ask.
 *
 * The trap is scored with a bonus proportional to how likely O is to target the
 * bot for C on their next turn (fewer alternative targets → higher bonus).
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

      // Gate: only run the trap when the team is near-complete AND already exposed.
      // Without this gate the trap opens fresh sets speculatively, leaking our base.
      const sa = analyzeSet(setKey, ctx);
      if (sa.teamCertain < 4 || !sa.teamExposed) continue;

      const set = SET_LOOKUP[setKey];

      for (const altCard of set.cards) {
        if (altCard === soughtCard) continue;
        if (!isAskable(altCard, ctx)) continue;

        const odds = computeCardOdds(altCard, ctx);
        const p = odds.get(opponent.id) ?? 0;
        // Only set up the trap when the ask itself is high-probability —
        // a low-p trap ask is strictly worse than a better regular ask elsewhere.
        if (p < 0.45) continue;

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

        const trapBonus = trapProbability * 8;
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

// ── Rescue pass (medium / hard / expert) ──────────────────────────────────

/**
 * Last-resort defensive pass: if opponents have ≥ 5 confirmed cards in a set
 * where our team also holds cards, we are about to lose that set. Pass to
 * whichever eligible teammate holds the most cards in the most threatened set
 * so they can declare before the opponent does.
 *
 * Returns a teammate playerId to pass to, or null if no rescue is needed.
 */
function pickRescuePassTarget(ctx: BotCtx): string | null {
  const { teammates, hands, claimed } = ctx;
  const eligibleTeammates = teammates.filter(
    (t) => (hands.get(t.id) ?? []).length > 0,
  );
  if (eligibleTeammates.length === 0) return null;

  // Collect contested sets: opponents have 5/6 confirmed and team holds at least one.
  const contestedSets = SET_DEFS.filter((s) => {
    if (claimed.has(s.key)) return false;
    const sa = analyzeSet(s.key, ctx);
    return sa.oppKnown >= 5 && sa.teamKnown > 0;
  });
  if (contestedSets.length === 0) return null;

  // For each eligible teammate score them by priority tier:
  //   Tier 1 — holds a base card in a contested set AND has another canDeclare set
  //   Tier 2 — holds a base card in a contested set
  //   Tier 3 — has any canDeclare set
  //   Tier 4 — everyone else (random fallback)
  // Within each tier, collect all tied candidates and pick randomly.

  function hasBaseInContested(tmId: string): boolean {
    const tmHand = hands.get(tmId) ?? [];
    return contestedSets.some((s) => s.cards.some((c) => tmHand.includes(c)));
  }

  function hasOtherDeclare(tmId: string): boolean {
    return SET_DEFS.some((s) => {
      if (claimed.has(s.key)) return false;
      return analyzeSet(s.key, ctx).canDeclare &&
        (hands.get(tmId) ?? []).some((c) => s.cards.includes(c));
    });
  }

  function pickRandom(pool: typeof eligibleTeammates): string {
    return pool[Math.floor(Math.random() * pool.length)].id;
  }

  const tier1 = eligibleTeammates.filter((t) => hasBaseInContested(t.id) && hasOtherDeclare(t.id));
  if (tier1.length > 0) return pickRandom(tier1);

  const tier2 = eligibleTeammates.filter((t) => hasBaseInContested(t.id));
  if (tier2.length > 0) return pickRandom(tier2);

  const tier3 = eligibleTeammates.filter((t) => hasOtherDeclare(t.id));
  if (tier3.length > 0) return pickRandom(tier3);

  return pickRandom(eligibleTeammates);
}

// ── Intelligent post-declare pass (expert only) ────────────────────────────

/**
 * After a successful declare, decide whether to hand the turn to a teammate
 * who is better positioned to advance a set.
 *
 * Returns a teammate playerId to pass to, or null to keep the turn.
 *
 * Logic:
 *   - Score each teammate by how many confirmed cards they hold in sets that
 *     are one or two cards from completion (teamKnown >= 4) and where the bot
 *     itself has zero confirmed cards.
 *   - If the best teammate's "readiness score" exceeds a threshold, pass to them.
 *   - Never pass if the bot itself has the highest-readiness hand.
 */
function pickIntelligentPassTarget(ctx: BotCtx): string | null {
  const { teammates, hands, bot, claimed } = ctx;
  const eligibleTeammates = teammates.filter(
    (t) => (hands.get(t.id) ?? []).length > 0,
  );
  if (eligibleTeammates.length === 0) return null;

  function teammateReadiness(playerId: string): number {
    let score = 0;
    for (const s of SET_DEFS) {
      if (claimed.has(s.key)) continue;
      const sa = analyzeSet(s.key, ctx);
      if (sa.teamKnown < 4) continue; // only near-complete sets count
      // Does this teammate hold at least one known card in the set?
      const tmHand = hands.get(playerId) ?? [];
      const tmHoldsInSet = s.cards.filter((c) => tmHand.includes(c)).length;
      if (tmHoldsInSet === 0) continue;
      // How many cards does the bot hold in this set?
      const botHoldsInSet = s.cards.filter((c) => ctx.myHand.includes(c)).length;
      // Teammate earns readiness proportional to their contribution minus bot's.
      score += (tmHoldsInSet - botHoldsInSet) * (sa.teamKnown + 1);
    }
    return score;
  }

  const botReadiness = (() => {
    let score = 0;
    for (const s of SET_DEFS) {
      if (claimed.has(s.key)) continue;
      const sa = analyzeSet(s.key, ctx);
      if (sa.teamKnown < 4) continue;
      const botHoldsInSet = s.cards.filter((c) => ctx.myHand.includes(c)).length;
      if (botHoldsInSet === 0) continue;
      score += botHoldsInSet * (sa.teamKnown + 1);
    }
    return score;
  })();

  let bestId: string | null = null;
  let bestScore = 0;
  for (const t of eligibleTeammates) {
    const r = teammateReadiness(t.id);
    if (r > bestScore) { bestScore = r; bestId = t.id; }
  }

  // Only pass if the teammate's readiness strongly exceeds the bot's.
  if (bestId && bestScore > botReadiness + 15) return bestId;
  return null;
}

// ── Dangerous-target detection (medium+) ──────────────────────────────────

/**
 * Returns true when targeting `targetId` for an ask is dangerous: the opponent
 * is searching for a card C that is already confirmed (or likely) on our team.
 * If we give this opponent a turn by failing, they can immediately ask for C.
 *
 * Specifically: the opponent has asked for card C in some set S (per txLog),
 * AND a teammate of the bot holds C (confirmed via ck.holder or via
 * set-count elimination with all opponents absent).
 */
function isDangerousTarget(targetId: string, card: Card, ctx: BotCtx): boolean {
  const { ck, txLog, bot, state, hands, playerSetKnowledge } = ctx;

  // Collect cards the opponent has searched for (failed asks).
  const soughtByTarget = new Set<Card>();
  for (const tx of txLog) {
    if (tx.askerId !== targetId) continue;
    if (!tx.success) soughtByTarget.add(tx.card);
    else soughtByTarget.delete(tx.card); // resolved
  }

  if (soughtByTarget.size === 0) return false;

  const allPlayers = [...state.players.values()];
  const teammates = allPlayers.filter(p => p.team === bot.team && p.id !== bot.id);

  for (const soughtCard of soughtByTarget) {
    const soughtSetKey = CARD_TO_SET.get(soughtCard);
    if (!soughtSetKey) continue;

    // 1. Hard confirm via ck — concrete witnessed transfer.
    const ckInfo = ck.get(soughtCard);
    if (ckInfo?.holder) {
      const holder = state.players.get(ckInfo.holder);
      if (holder?.team === bot.team) return true;
    }

    // 2. All opponents concretely eliminated via ck.absent — card must be on team.
    const absent = ck.get(soughtCard)?.absent ?? new Set<string>();
    const allOpponents = allPlayers.filter(
      p => p.team !== bot.team && (hands.get(p.id) ?? []).length > 0,
    );
    const allOpponentsEliminated = allOpponents.every(o => absent.has(o.id));

    if (allOpponentsEliminated) {
      // Confirm a teammate has at least one card in this set (so the card is
      // plausibly with them, not floating in the ether).
      const teammateHoldsInSet = teammates.some(tm => {
        const setInfo = playerSetKnowledge.get(tm.id)?.get(soughtSetKey);
        return setInfo && setInfo.minCount >= 1;
      });
      if (teammateHoldsInSet) return true;
    }
  }

  return false;
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

  // ── Information-economy spine (ALL tiers) ────────────────────────────────
  //
  // Principle: every ask publicly reveals "I hold a base in this set." The
  // game is an information-differential war. We prefer asks whose expected
  // gain outweighs the leakage cost.
  //
  // pSuccess is SQUARED so certainty gates the whole score. A 0.3-p ask
  // scores 0.09× what a certain ask would — no stack of additive bonuses
  // can let it win. A 0.95-p ask scores 0.90× — nearly full value.
  let s = pSuccess * pSuccess * (10 + sa.teamKnown * 8);

  // Fresh-set leakage: opening a set that neither team has asked in yet
  // reveals our base card. The penalty is zero for already-open sets.
  //
  // At easy/medium: flat penalty scaled by how cold the set is.
  //   Penalty = max(0, 4 - teamKnown) × tierWeight
  //   If teamKnown >= 4: no penalty (investment justifies opening).
  //
  // At hard/expert: penalty also scales with (1 - pSuccess) so a
  //   high-certainty ask in a fresh set is tolerated, but a speculative
  //   ask (low p) in a cold set scores very low.
  //   Penalty = max(0, 4 - teamKnown) × (1 - pSuccess) × tierWeight
  //
  // Applied at ALL tiers so even easy bots prefer already-open sets.
  const setIsOpen =
    (ctx.selfAsksInSet.get(setKey) ?? 0) > 0 ||
    (ctx.teammateAsksInSet.get(setKey) ?? 0) > 0 ||
    ctx.openSets.has(setKey); // opponents have asked in it — already exposed
  if (!setIsOpen) {
    const coldness = Math.max(0, 4 - sa.teamKnown); // 0 when teamKnown >= 4
    let openPenalty: number;
    if (diff === "easy") {
      openPenalty = 0;  // easy opens fresh sets freely, leaking set membership
    } else if (diff === "medium") {
      openPenalty = coldness * 5;
    } else {
      // hard/expert: also multiplied by (1 - pSuccess): speculative opens are
      // far costlier; near-certain opens in a cold set are still penalised but
      // tolerable if the ask is almost guaranteed.
      openPenalty = coldness * (1 - pSuccess) * 22;
    }
    s -= openPenalty;
  }

  if (diff === "easy") return s;

  // ── Medium + ─────────────────────────────────────────────────────────────

  // No explicit teammate-support bonus: the information-economy spine already
  // rewards sets with higher teamKnown (which reflect teammate engagement via
  // ask-eligibility inference). An additive bonus on top of this would
  // over-weight sets that teammates worked, potentially pulling medium toward
  // sub-optimal asks. teamKnown in the base formula handles coordination.

  // Convergence avoidance: mild penalty for handing turns to opponents racing
  // our set. Capped so it never overcrowds the certainty-based base score.
  // Only active when the set is both likely ours (declareProb >= 0.5) and
  // at least one opponent is actively engaged there.
  if ((diff === "hard" || diff === "expert") && sa.oppConverging > 1 && sa.declareProb >= 0.5 && pSuccess < 1.0) {
    s -= Math.min(sa.oppConverging * 3, 6) * sa.declareProb;
  }

  // Dangerous opponent avoidance: mild penalty for asking a target who is
  // actively searching for a card confirmed on our team. The penalty is
  // smaller than before so it steers away from poor targets without
  // completely blocking asks that are otherwise good.
  // No penalty when pSuccess === 1 (we succeed, no turn is handed over).
  if (pSuccess < 1.0 && isDangerousTarget(targetId, card, ctx)) {
    s -= 8;
  }

  if (diff === "hard" || diff === "expert") {
    // Threat urgency: race to complete sets opponents can triangulate.
    // Expert is more aggressive: higher multiplier to react earlier.
    const threatMult = diff === "expert" ? 50 : 30;
    s += sa.threatLevel * threatMult;

    // End-game: small hand means scarce turns — maximise certainty.
    if (ctx.myHand.length <= 3) s += pSuccess * 15;

    // Deprioritise sets where remaining unknowns are likely with teammates.
    // High team concentration + no opponent engagement → don't waste asks here.
    if (sa.teamKnown >= 4 && !sa.oppExposed && sa.unknown > 0) {
      s -= sa.unknown * 6;
    }

    // Personal investment: reward finishing sets where the bot holds many cards.
    // Fresh-set multiplier is 0.1 (not 0.2) so the investment bonus never
    // overrides the leakage penalty on fresh sets.
    const botCardsInSet = ctx.myHand.filter(c => CARD_TO_SET.get(c) === setKey).length;
    const investBonus = diff === "expert" ? 10 : 7;
    s += botCardsInSet * investBonus * (setIsOpen ? 1.0 : 0.1);

    // Almost-declare urgency: team has 5 confirmed cards — one ask away.
    // Expert chases the last card aggressively (even at p=0.3) since winning a
    // full set is extremely high EV. Hard is more conservative (needs p>0.46).
    if (sa.almostDeclare) {
      const almostBonus = diff === "expert" ? 60 : 25;
      s += pSuccess * almostBonus;
    }

    // Near-complete racing (expert only): when teamCertain >= 4, the team is
    // 1-2 cards from completion — expert races these sets more urgently.
    // This fires earlier and more often than almostDeclare, creating a
    // consistent advantage over hard throughout the late-midgame.
    if (diff === "expert" && sa.teamCertain >= 4 && !sa.almostDeclare && setIsOpen) {
      s += pSuccess * 20;
    }

    // Leakage exploitation: when opponents have asked in this set (revealed
    // their base), expert scores a bonus for extracting cards from that
    // exposed set. Easy bots open many sets (high openSets coverage), so
    // this fires far more often against easy than against disciplined hard bots.
    if (diff === "expert" && ctx.openSets.has(setKey)) {
      s += pSuccess * 28;
    }

    // Opponent safety (expert only): penalize giving turns to opponents who are
    // actively building sets. Unlike isDangerousTarget (medium+, specific card),
    // this is broad — any opponent with minCount >= 2 in any set is a threat.
    if (diff === "expert" && pSuccess < 1.0) {
      const targetSets = ctx.playerSetKnowledge.get(targetId);
      if (targetSets) {
        let targetDanger = 0;
        for (const [sk, info] of targetSets) {
          if (ctx.claimed.has(sk)) continue;
          if (info.minCount >= 3) targetDanger += info.minCount - 2;
        }
        s -= targetDanger * 4;
      }
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

/** Weighted-random pick: near-best asks get chosen sometimes, never junk. */
function softmaxPick(sorted: Candidate[], temp: number): Candidate {
  const top = sorted[0].score;
  const weights = sorted.map(c => Math.exp((c.score - top) / temp));
  let r = Math.random() * weights.reduce((a, b) => a + b, 0);
  for (let i = 0; i < sorted.length; i++) {
    r -= weights[i];
    if (r <= 0) return sorted[i];
  }
  return sorted[0];
}

/**
 * Where the bot *believes* each card of a set is, using only its own hand and
 * remembered asks. `certain` counts cards it can place for sure; the rest are
 * guessed among teammates. `assignments` is null if a card is believed to be
 * with an opponent.
 */
function locateSet(
  setKey: SetKey,
  ctx: BotCtx,
): { assignments: Record<Card, string> | null; certain: number; onTeam: boolean } {
  const team = [ctx.bot, ...ctx.teammates].filter(p => (ctx.hands.get(p.id) ?? []).length > 0);
  const assignments: Record<Card, string> = {};
  let certain = 0;
  let onTeam = true; // every unplaced card has been ruled out for all opponents
  for (const card of SET_LOOKUP[setKey].cards) {
    if (ctx.myHand.includes(card)) { assignments[card] = ctx.bot.id; certain++; continue; }
    const info = ctx.ck.get(card);
    // A remembered holder with an empty hand is stale memory — ignore it.
    const holder = info?.holder && (ctx.hands.get(info.holder) ?? []).length > 0
      ? ctx.state.players.get(info.holder) : undefined;
    if (holder) {
      if (holder.team !== ctx.bot.team) return { assignments: null, certain, onTeam: false };
      assignments[card] = holder.id; certain++; continue;
    }
    const absent = info?.absent ?? new Set<string>();
    const oppsLeft = ctx.opponents.filter(o => !absent.has(o.id));
    const mates = team.filter(p => p.id !== ctx.bot.id && !absent.has(p.id));
    if (oppsLeft.length === 0 && mates.length === 1) { assignments[card] = mates[0].id; certain++; continue; }
    if (oppsLeft.length > 0) onTeam = false;
    // Guess: the teammate who seems most engaged in this set, then biggest hand.
    const pool = mates.length ? mates : team.filter(p => p.id !== ctx.bot.id);
    if (pool.length === 0) return { assignments: null, certain, onTeam: false };
    const weight = (id: string) =>
      (ctx.playerSetKnowledge.get(id)?.get(setKey)?.minCount ?? 0) * 10 + (ctx.hands.get(id)?.length ?? 0);
    assignments[card] = pool.reduce((a, b) => (weight(b.id) > weight(a.id) ? b : a)).id;
  }
  return { assignments, certain, onTeam };
}

/**
 * Play one full bot turn against the real rules: decide, apply, and guarantee
 * the turn moves on (a bot can never wedge the game). Used by the room and
 * by the headless sim, so the sim exercises exactly what players face.
 */
export function playBotTurn(
  state: GameState,
  hands: HandStore,
  txLog: TransactionLog,
  botId: string,
  diff: BotDifficulty = state.botDifficulty as BotDifficulty,
): void {
  const bot = state.players.get(botId);
  if (!bot || state.status !== "playing" || state.turnId !== botId) return;
  const action = decideBotAction(state, hands, txLog, bot, diff);

  let err: string | null = "no-op";
  if (action.type === "ask") {
    err = applyAsk(state, hands, txLog, botId, action.targetId, action.card);
  } else if (action.type === "declare") {
    err = applyDeclare(state, hands, botId, action.setKey, action.assignments);
    // Still holding the post-declare turn with an empty hand → hand it on.
    if (!err && state.postDeclareId === botId && (hands.get(botId) ?? []).length === 0) {
      applyPass(state, hands, botId);
    }
  } else if (state.postDeclareId === botId) {
    err = applyPass(state, hands, botId, action.toPlayerId);
    if (err) err = applyPass(state, hands, botId);
  }

  if (err && state.status === "playing" && state.turnId === botId) {
    const next = findNextPlayerWithCards(state, hands, botId);
    if (next && next !== botId) {
      state.postDeclareId = "";
      state.turnId = next;
      pushAction(state, `${bot.name} passed.`);
    }
  }
}

// Re-export for the room module's convenience.
export type { Transaction, TransactionLog };
