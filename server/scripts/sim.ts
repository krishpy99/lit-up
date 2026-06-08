/**
 * Headless simulation harness for the bot AI.
 *
 * Plays N full bot-only games across all difficulty combinations and asserts:
 *   1. Every game terminates (status === "ended") within MAX_TURNS turns.
 *   2. No game wedges: the same player cannot hold the turn for 50+ steps.
 *
 * Run:  NODE_ENV=test npx tsx scripts/sim.ts
 * Env:  SIM_GAMES=500  SIM_MAX_TURNS=2000  SIM_VERBOSE=1
 *
 * IMPORTANT: This script avoids importing the Colyseus-decorated GameState /
 * Player schema classes because their @type() decorators crash when the
 * Colyseus runtime is not booted. Instead it builds plain-object shims that
 * satisfy the shape the bot and rules functions need.
 */

import {
  SET_DEFS,
  ALL_CARDS,
  CARD_TO_SET,
  SET_LOOKUP,
  type Card,
  type SetKey,
  type Team,
} from "@lit-up/shared";
import {
  newKnowledge,
  shuffle,
  appendTransaction,
  recordSuccess,
  recordFailure,
  findNextPlayerWithCards,
  type HandStore,
  type Transaction,
  type TransactionLog,
  type CardKnowledge,
} from "../src/rules.js";
import {
  decideBotAction,
  buildBotDeclareAssignments,
} from "../src/bot.js";

// ── Disable file logging during sim ─────────────────────────────────────────
// bot.ts checks BOT_LOG = (process.env.NODE_ENV !== "production") and gates
// appendFileSync behind it. Set NODE_ENV=production so no log files are
// created during mass simulation runs.
// (Caller should: NODE_ENV=production npx tsx scripts/sim.ts)
// We do it here defensively as well via env reassignment.
if (!process.env.NODE_ENV || process.env.NODE_ENV === "test") {
  process.env.NODE_ENV = "production";
}

const GAMES = Number(process.env.SIM_GAMES ?? 500);
const MAX_TURNS = Number(process.env.SIM_MAX_TURNS ?? 2000);
const VERBOSE = process.env.SIM_VERBOSE === "1";

type BotDifficulty = "easy" | "medium" | "hard" | "expert";
const DIFFICULTIES: BotDifficulty[] = ["easy", "medium", "hard", "expert"];

// ── Plain-object shims ───────────────────────────────────────────────────────
// These satisfy the structural types that bot.ts and rules.ts expect without
// triggering the Colyseus decorator machinery.

interface SimPlayer {
  id: string;
  name: string;
  avatar: string;
  character: string;
  team: Team;
  isBot: boolean;
  isHost: boolean;
  connected: boolean;
  cardCount: number;
}

interface SimLastAsk {
  askerId: string;
  targetId: string;
  card: string;
  success: boolean;
  at: number;
  assign(v: Partial<SimLastAsk>): void;
}

interface SimLastDeclare {
  declarerId: string;
  setKey: string;
  winningTeam: string;
  success: boolean;
  at: number;
  sources: Map<string, string> & { clear(): void };
  assignments: Map<string, string> & { clear(): void };
  assign(v: Partial<SimLastDeclare>): void;
}

interface SimPendingBotAsk {
  askerId: string;
  targetId: string;
  card: string;
  assign(v: Partial<SimPendingBotAsk>): void;
}

interface SimState {
  code: string;
  status: "lobby" | "playing" | "ended";
  hostId: string;
  turnId: string;
  postDeclareId: string;
  players: Map<string, SimPlayer>;
  claimedA: string[] & { push(v: string): number; includes(v: string): boolean; length: number };
  claimedB: string[] & { push(v: string): number; includes(v: string): boolean; length: number };
  scoreA: number;
  scoreB: number;
  winnerTeam: string;
  actions: string[] & { unshift(v: string): number };
  lastAsk: SimLastAsk;
  pendingBotAsk: SimPendingBotAsk;
  lastDeclare: SimLastDeclare;
  botDifficulty: BotDifficulty;
  notesEnabled: boolean;
  defaultLogCount: number;
}

function makeAssignable<T extends object>(base: T): T & { assign(v: Partial<T>): void } {
  return Object.assign(base, {
    assign(v: Partial<T>) { Object.assign(this, v); },
  }) as T & { assign(v: Partial<T>): void };
}

function makeExtMap(): Map<string, string> & { clear(): void } {
  return new Map() as Map<string, string> & { clear(): void };
}

function buildState(diff: BotDifficulty): SimState {
  return {
    code: "SIM",
    status: "playing",
    hostId: "p1",
    turnId: "p1",
    postDeclareId: "",
    players: new Map(),
    claimedA: [] as SimState["claimedA"],
    claimedB: [] as SimState["claimedB"],
    scoreA: 0,
    scoreB: 0,
    winnerTeam: "",
    actions: [] as SimState["actions"],
    lastAsk: makeAssignable<SimLastAsk>({
      askerId: "", targetId: "", card: "", success: false, at: 0,
      assign(_: Partial<SimLastAsk>) {},
    }),
    pendingBotAsk: makeAssignable<SimPendingBotAsk>({
      askerId: "", targetId: "", card: "",
      assign(_: Partial<SimPendingBotAsk>) {},
    }),
    lastDeclare: Object.assign(
      { declarerId: "", setKey: "", winningTeam: "", success: false, at: 0,
        sources: makeExtMap(), assignments: makeExtMap() },
      { assign(v: Partial<SimLastDeclare>) { Object.assign(this, v); } },
    ) as SimLastDeclare,
    botDifficulty: diff,
    notesEnabled: false,
    defaultLogCount: 5,
  };
}

// Cast SimState to GameState — this works because rules/bot only use the
// structural shape (no instanceof checks, no Colyseus-specific APIs).
type AnyState = SimState;

function buildGame(diff: BotDifficulty): {
  state: AnyState;
  hands: HandStore;
  ck: CardKnowledge;
  txLog: TransactionLog;
} {
  const state = buildState(diff);
  const ids = ["p1", "p2", "p3", "p4", "p5", "p6"];
  const teams: Team[] = ["A", "B", "A", "B", "A", "B"];

  ids.forEach((id, i) => {
    state.players.set(id, {
      id, name: `Bot${i + 1}`, avatar: "#aaa", character: "",
      team: teams[i], isBot: true, isHost: i === 0, connected: true, cardCount: 0,
    });
  });

  const hands: HandStore = new Map();
  const deck = shuffle([...ALL_CARDS]);
  deck.forEach((card, i) => {
    const id = ids[i % ids.length];
    const hand = hands.get(id) ?? [];
    hand.push(card);
    hands.set(id, hand);
  });
  ids.forEach((id) => {
    state.players.get(id)!.cardCount = (hands.get(id) ?? []).length;
  });

  // Random starting player.
  state.turnId = ids[Math.floor(Math.random() * ids.length)];
  state.hostId = ids[0];

  return { state, hands, ck: newKnowledge(), txLog: [] };
}

// ── Minimal implementations of rules functions used by sim loop ───────────────
// We cannot import the real applyAsk/applyDeclare/applyPass because they
// operate on the Colyseus-schema types (MapSchema, ArraySchema, etc.).
// We inline minimal versions that work on our plain-object shims.

function simApplyAsk(
  state: AnyState,
  hands: HandStore,
  ck: CardKnowledge,
  txLog: TransactionLog,
  askerId: string,
  targetId: string,
  card: Card,
): string | null {
  if (state.status !== "playing") return "not playing";
  if (state.turnId !== askerId) return "not your turn";
  state.postDeclareId = "";
  const asker = state.players.get(askerId);
  const target = state.players.get(targetId);
  if (!asker || !target) return "player not found";
  const askerHand = hands.get(askerId) ?? [];
  const targetHand = hands.get(targetId) ?? [];
  if (askerHand.length === 0) return "no cards";
  if (target.team === asker.team) return "same team";
  if (targetHand.length === 0) return "target empty";
  const setKey = CARD_TO_SET.get(card);
  if (!setKey) return "invalid card";
  if (state.claimedA.includes(setKey) || state.claimedB.includes(setKey)) return "set claimed";
  if (!askerHand.some(c => CARD_TO_SET.get(c) === setKey)) return "no base card";
  if (askerHand.includes(card)) return "already have";

  const success = targetHand.includes(card);
  recordFailure(ck, card, askerId);

  if (success) {
    hands.set(targetId, targetHand.filter(c => c !== card));
    askerHand.push(card);
    recordFailure(ck, card, targetId);
    recordSuccess(ck, card, askerId);
    state.turnId = askerId;
  } else {
    recordFailure(ck, card, targetId);
    state.turnId = targetId;
  }

  appendTransaction(txLog, { askerId, targetId: targetId, card, setKey, success, askerTeam: asker.team });
  asker.cardCount = (hands.get(askerId) ?? []).length;
  target.cardCount = (hands.get(targetId) ?? []).length;

  // ensureValidTurn: advance if current player is empty (they may have just given their last card).
  const curHand = hands.get(state.turnId) ?? [];
  if (curHand.length === 0) {
    const next = simFindNext(state, hands, state.turnId);
    if (next) state.turnId = next;
  }

  return null;
}

function simFindNext(state: AnyState, hands: HandStore, fromId: string): string | null {
  const ids = [...state.players.keys()];
  const start = ids.indexOf(fromId);
  for (let off = 1; off <= ids.length; off++) {
    const id = ids[(start + off) % ids.length];
    if ((hands.get(id) ?? []).length > 0) return id;
  }
  return null;
}

function simApplyDeclare(
  state: AnyState,
  hands: HandStore,
  declarerId: string,
  setKey: SetKey,
  assignments: Record<string, string>,
): string | null {
  if (state.status !== "playing") return "not playing";
  if (state.turnId !== declarerId) return "not your turn";
  const declarer = state.players.get(declarerId);
  if (!declarer) return "not found";
  const set = SET_LOOKUP[setKey];
  if (!set) return "invalid set";
  if (state.claimedA.includes(setKey) || state.claimedB.includes(setKey)) return "already claimed";

  const declarerHasBase = (hands.get(declarerId) ?? []).some(c => set.cards.includes(c));
  if (!declarerHasBase) return "no base card";

  const teammateIds = new Set([...state.players.values()].filter(p => p.team === declarer.team).map(p => p.id));
  const allCorrect = set.cards.every(c => {
    const assignee = assignments[c];
    return assignee && teammateIds.has(assignee) && (hands.get(assignee) ?? []).includes(c);
  });

  const winningTeam: Team = allCorrect ? declarer.team : (declarer.team === "A" ? "B" : "A");

  // Remove all set cards from hands.
  state.players.forEach((_p, id) => {
    const h = hands.get(id) ?? [];
    hands.set(id, h.filter(c => !set.cards.includes(c)));
    state.players.get(id)!.cardCount = (hands.get(id) ?? []).length;
  });

  if (winningTeam === "A") {
    state.claimedA.push(setKey);
    state.scoreA = state.claimedA.length;
  } else {
    state.claimedB.push(setKey);
    state.scoreB = state.claimedB.length;
  }

  if (state.claimedA.length + state.claimedB.length >= SET_DEFS.length) {
    state.status = "ended";
    state.winnerTeam = state.scoreA > state.scoreB ? "A" : state.scoreB > state.scoreA ? "B" : "";
    return null;
  }

  // Post-declare: declarer keeps turn (can pass to teammate).
  state.postDeclareId = declarerId;
  return null;
}

function simApplyPass(state: AnyState, hands: HandStore, passerId: string, toId?: string): string | null {
  if (state.postDeclareId !== passerId) return "can only pass after declare";
  const passer = state.players.get(passerId);
  if (!passer) return "not found";

  let nextId = toId;
  if (nextId) {
    const t = state.players.get(nextId);
    if (!t || t.team !== passer.team || t.id === passerId || (hands.get(nextId) ?? []).length === 0) {
      return "invalid target";
    }
  } else {
    // Find next teammate with cards.
    const ids = [...state.players.keys()];
    const start = ids.indexOf(passerId);
    for (let off = 1; off <= ids.length; off++) {
      const id = ids[(start + off) % ids.length];
      const p = state.players.get(id)!;
      if (p.team === passer.team && id !== passerId && (hands.get(id) ?? []).length > 0) {
        nextId = id;
        break;
      }
    }
  }
  if (!nextId) return "no valid teammate";
  state.postDeclareId = "";
  state.turnId = nextId;
  return null;
}

// ── Simulation run ───────────────────────────────────────────────────────────

interface SimResult {
  terminated: boolean;
  turns: number;
  diff: BotDifficulty;
  winner: string;
  staleDetected: boolean;
  wedgeLog?: string;
}

function runGame(diff: BotDifficulty): SimResult {
  const { state, hands, ck, txLog } = buildGame(diff);
  let turns = 0;
  let prevTurnId = "";
  let sameTurnCount = 0;

  while (state.status === "playing" && turns < MAX_TURNS) {
    turns++;
    const currentTurnId = state.turnId;

    if (currentTurnId === prevTurnId) {
      sameTurnCount++;
      if (sameTurnCount === 50 && VERBOSE) {
        const bot = state.players.get(currentTurnId)!;
        const action = decideBotAction(state as any, hands, ck, txLog, bot as any);
        const myHand = hands.get(currentTurnId) ?? [];
        const claimed = new Set([...state.claimedA, ...state.claimedB]);
        const allPlayers = [...state.players.values()];
        const opponents = allPlayers.filter(p => p.team !== bot.team && (hands.get(p.id) ?? []).length > 0);
        console.log(`[diag] sc=50 turn=${turns} bot=${currentTurnId}(${bot.team}) hand=${myHand.length} postDecl=${state.postDeclareId} opp=${opponents.length} action=${JSON.stringify(action)}`);
        console.log(`  claimed=${[...claimed].join(",")}`);
        allPlayers.forEach(p => console.log(`  player ${p.id}(${p.team}) cards=${(hands.get(p.id)??[]).length}`));
      }
      if (sameTurnCount > 50) {
        return {
          terminated: false, turns, diff, winner: "", staleDetected: true,
          wedgeLog: `Turn stuck on ${currentTurnId} for ${sameTurnCount} steps`,
        };
      }
    } else {
      sameTurnCount = 0;
    }
    prevTurnId = currentTurnId;

    const bot = state.players.get(currentTurnId);
    if (!bot) {
      // Shouldn't happen.
      const next = simFindNext(state, hands, currentTurnId);
      if (next) state.turnId = next;
      continue;
    }

    // Cast to GameState shape — structural compatibility only.
    const action = decideBotAction(state as any, hands, ck, txLog, bot as any);

    if (action.type === "ask") {
      const err = simApplyAsk(state, hands, ck, txLog, bot.id, action.targetId, action.card);
      if (err && VERBOSE) console.log(`[sim] ask err: ${err}`);
      if (err) {
        // Invalid ask — advance defensively.
        const next = simFindNext(state, hands, bot.id);
        if (next && next !== bot.id) state.turnId = next;
      }
    } else if (action.type === "declare") {
      const assignments = buildBotDeclareAssignments(state as any, hands, bot as any, action.setKey);
      if (assignments) {
        const err = simApplyDeclare(state, hands, bot.id, action.setKey, assignments);
        if (err && VERBOSE) console.log(`[sim] declare err: ${err} bot=${bot.id} set=${action.setKey}`);
        if (!err && state.status === "playing") {
          // If bot is now empty, pass to teammate immediately.
          if ((hands.get(bot.id) ?? []).length === 0 && state.postDeclareId === bot.id) {
            simApplyPass(state, hands, bot.id);
          }
        }
      } else {
        // Stale declare — force-advance (Phase 0 invariant).
        const next = simFindNext(state, hands, bot.id);
        if (next) {
          state.turnId = next;
          state.postDeclareId = "";
          if (VERBOSE) console.log(`[sim] stale declare by ${bot.id} for ${action.setKey} → forced to ${next}`);
        }
      }
    } else {
      // Pass action.
      if (action.toPlayerId && state.postDeclareId === bot.id) {
        const err = simApplyPass(state, hands, bot.id, action.toPlayerId);
        if (err) simApplyPass(state, hands, bot.id);
      } else if (state.postDeclareId === bot.id) {
        const err = simApplyPass(state, hands, bot.id);
        if (err) {
          // No teammate with cards — mirrors room.ts ensureValidTurn fallback.
          // Clear postDeclareId and advance to ANY next player with cards (any team).
          state.postDeclareId = "";
          const next = simFindNext(state, hands, bot.id);
          if (next) state.turnId = next;
        }
      } else {
        // Voluntary pass — advance to any next player with cards.
        const next = simFindNext(state, hands, bot.id);
        if (next && next !== bot.id) state.turnId = next;
      }
    }
  }

  return {
    terminated: state.status === "ended",
    turns, diff, winner: state.winnerTeam,
    staleDetected: false,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Running ${GAMES} simulated games, MAX_TURNS=${MAX_TURNS}…`);
  const t0 = Date.now();

  let passed = 0, failed = 0;
  const failures: SimResult[] = [];
  const statsByDiff = new Map<BotDifficulty, { count: number; totalTurns: number; stale: number }>();

  for (let i = 0; i < GAMES; i++) {
    const diff = DIFFICULTIES[i % DIFFICULTIES.length];
    const result = runGame(diff);
    const s = statsByDiff.get(diff) ?? { count: 0, totalTurns: 0, stale: 0 };
    s.count++;
    s.totalTurns += result.turns;
    if (result.staleDetected) s.stale++;
    statsByDiff.set(diff, s);

    if (result.terminated && !result.staleDetected) {
      passed++;
      if (VERBOSE) console.log(`  [PASS] game ${i + 1} diff=${diff} turns=${result.turns} winner=${result.winner}`);
    } else {
      failed++;
      failures.push(result);
      console.error(`  [FAIL] game ${i + 1} diff=${diff} turns=${result.turns} terminated=${result.terminated}${result.wedgeLog ? " wedge=" + result.wedgeLog : ""}`);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nResults: ${passed} passed, ${failed} failed out of ${GAMES} games in ${elapsed}s.\n`);
  console.log("Average turns by difficulty:");
  for (const [diff, s] of statsByDiff) {
    console.log(`  ${diff.padEnd(8)} avg=${Math.round(s.totalTurns / s.count).toString().padStart(4)} turns  stale=${s.stale}  (${s.count} games)`);
  }

  if (failures.length > 0) {
    console.error(`\nFirst failure:`, failures[0]);
    process.exit(1);
  }

  console.log("\nAll games terminated — no hangs detected.");
}

main().catch(e => { console.error(e); process.exit(1); });
