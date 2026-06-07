/**
 * Pure game-rule functions, decoupled from Colyseus.
 *
 * These mutate the *server-side* hand store and the synced public state.
 * Each returns either `null` on success or a string error message.
 */

import {
  ALL_CARDS,
  CARD_TO_SET,
  cardLabel,
  SET_DEFS,
  SET_LOOKUP,
  type Card,
  type SetKey,
  type Team,
} from "@lit-up/shared";
import { ArraySchema } from "@colyseus/schema";
import { GameState, Player } from "./schema.js";

// ── Pure helpers ─────────────────────────────────────────────

export function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function otherTeam(t: Team): Team {
  return t === "A" ? "B" : "A";
}

export function isSetClaimed(state: GameState, key: SetKey): boolean {
  return state.claimedA.includes(key) || state.claimedB.includes(key);
}

export function totalClaimed(state: GameState): number {
  return state.claimedA.length + state.claimedB.length;
}

export function pushAction(state: GameState, text: string): void {
  state.actions.unshift(text);
}

// ── Hand store (server-only, never synced) ─────────────────

export type HandStore = Map<string /* playerId */, Card[]>;

export function getHand(hands: HandStore, id: string): Card[] {
  return hands.get(id) ?? [];
}

/**
 * Public transaction history. Every ask is appended here in order.
 * Capped to the last 200 transactions per game so memory stays bounded
 * even on long marathon sessions. The bot AI uses this to do real
 * inference (per-set engagement, leakage, opponent modeling).
 */
export type Transaction = {
  askerId: string;
  targetId: string;
  card: Card;
  setKey: SetKey;
  success: boolean;
  /** Asker's team at time of ask (used to derive teammate engagement). */
  askerTeam: Team;
};

export type TransactionLog = Transaction[];

const TRANSACTIONS_CAP = 200;

export function appendTransaction(log: TransactionLog, tx: Transaction): void {
  log.push(tx);
  while (log.length > TRANSACTIONS_CAP) log.shift();
}

/**
 * Card knowledge tracker. Each card has either a known holder (from witnessing
 * a successful ask) or a list of players ruled out (from witnessed failures).
 * Used by bot AI; resets each game.
 */
export type CardKnowledge = Map<Card, { holder: string | null; absent: Set<string> }>;

export function newKnowledge(): CardKnowledge {
  return new Map();
}

function ckEntry(ck: CardKnowledge, card: Card) {
  let e = ck.get(card);
  if (!e) {
    e = { holder: null, absent: new Set() };
    ck.set(card, e);
  }
  return e;
}

export function recordSuccess(ck: CardKnowledge, card: Card, newHolder: string): void {
  const e = ckEntry(ck, card);
  e.holder = newHolder;
  e.absent.delete(newHolder);
}

export function recordFailure(ck: CardKnowledge, card: Card, target: string): void {
  const e = ckEntry(ck, card);
  if (e.holder === target) e.holder = null;
  e.absent.add(target);
}

// ── Team & turn ─────────────────────────────────────────────

export function assignTeams(state: GameState): void {
  const ids = [...state.players.keys()];
  ids.forEach((id, i) => {
    const p = state.players.get(id)!;
    p.team = i % 2 === 0 ? "A" : "B";
  });
}

export function findNextPlayerWithCards(
  state: GameState,
  hands: HandStore,
  fromId: string,
  team?: Team,
): string | null {
  const ids = [...state.players.keys()];
  if (ids.length === 0) return null;
  let start = ids.indexOf(fromId);
  if (start < 0) start = 0;
  for (let off = 1; off <= ids.length; off++) {
    const id = ids[(start + off) % ids.length];
    const p = state.players.get(id)!;
    if ((hands.get(id)?.length ?? 0) === 0) continue;
    if (team && p.team !== team) continue;
    return id;
  }
  return null;
}

export function ensureValidTurn(state: GameState, hands: HandStore): void {
  if (!state.turnId) return;
  const cur = state.players.get(state.turnId);
  const curHand = hands.get(state.turnId) ?? [];
  if (cur && curHand.length > 0) return;
  const next = findNextPlayerWithCards(state, hands, state.turnId);
  if (next) state.turnId = next;
}

// ── Lifecycle ───────────────────────────────────────────────

export function startGame(state: GameState, hands: HandStore, txLog: TransactionLog): void {
  txLog.length = 0;
  state.status = "playing";
  state.claimedA = new ArraySchema<string>();
  state.claimedB = new ArraySchema<string>();
  state.scoreA = 0;
  state.scoreB = 0;
  state.winnerTeam = "";
  state.actions = new ArraySchema<string>();
  state.lastAsk.assign({ askerId: "", targetId: "", card: "", success: false, at: 0 });
  state.pendingBotAsk.assign({ askerId: "", targetId: "", card: "" });
  state.lastDeclare.assign({ declarerId: "", setKey: "", winningTeam: "", success: false, at: 0 });
  state.lastDeclare.sources.clear();
  state.lastDeclare.assignments.clear();
  state.postDeclareId = "";

  const ids = [...state.players.keys()];
  ids.forEach((id) => hands.set(id, []));

  const deck = shuffle([...ALL_CARDS]);
  deck.forEach((card, i) => {
    const id = ids[i % ids.length];
    hands.get(id)!.push(card);
  });

  ids.forEach((id) => {
    const p = state.players.get(id)!;
    p.cardCount = hands.get(id)!.length;
  });

  const startIdx = Math.floor(Math.random() * ids.length);
  const startingIds = [...ids.slice(startIdx), ...ids.slice(0, startIdx)];
  state.turnId = startingIds.find((id) => (hands.get(id)?.length ?? 0) > 0) ?? "";
  pushAction(state, "Game started — cards dealt!");
}

export function resetToLobby(state: GameState, hands: HandStore, txLog: TransactionLog): void {
  txLog.length = 0;
  state.status = "lobby";
  state.claimedA = new ArraySchema<string>();
  state.claimedB = new ArraySchema<string>();
  state.scoreA = 0;
  state.scoreB = 0;
  state.winnerTeam = "";
  state.actions = new ArraySchema<string>();
  state.lastAsk.assign({ askerId: "", targetId: "", card: "", success: false, at: 0 });
  state.pendingBotAsk.assign({ askerId: "", targetId: "", card: "" });
  state.lastDeclare.assign({ declarerId: "", setKey: "", winningTeam: "", success: false, at: 0 });
  state.lastDeclare.sources.clear();
  state.lastDeclare.assignments.clear();
  state.postDeclareId = "";

  // Drop disconnected non-host players.
  const toDrop: string[] = [];
  state.players.forEach((p: Player, id: string) => {
    if (!p.connected && id !== state.hostId) toDrop.push(id);
  });
  toDrop.forEach((id) => {
    state.players.delete(id);
    hands.delete(id);
  });

  state.players.forEach((p: Player, id: string) => {
    hands.set(id, []);
    p.cardCount = 0;
    p.connected = true;
  });
  assignTeams(state);
  state.turnId = state.hostId;
  pushAction(state, "Returned to lobby.");
}

// ── Actions ─────────────────────────────────────────────────

export function applyAsk(
  state: GameState,
  hands: HandStore,
  ck: CardKnowledge,
  txLog: TransactionLog,
  askerId: string,
  toPlayerId: string,
  card: Card,
): string | null {
  if (state.status !== "playing") return "Game not started.";
  if (state.turnId !== askerId) return "Not your turn.";
  state.postDeclareId = "";
  const asker = state.players.get(askerId);
  const target = state.players.get(toPlayerId);
  if (!asker || !target) return "Player not found.";
  const askerHand = hands.get(askerId) ?? [];
  const targetHand = hands.get(toPlayerId) ?? [];
  if (askerHand.length === 0) return "No cards to ask with.";
  if (target.team === asker.team) return "Can only ask opponents.";
  if (targetHand.length === 0) return "Opponent has no cards.";
  if (!CARD_TO_SET.has(card)) return "Invalid card.";

  const setKey = CARD_TO_SET.get(card)!;
  if (isSetClaimed(state, setKey)) return "Set already claimed.";
  if (!askerHand.some((c) => CARD_TO_SET.get(c) === setKey)) {
    return "Must hold a card in the same set.";
  }
  if (askerHand.includes(card)) return "You already have that card.";

  const success = targetHand.includes(card);

  // The asker does NOT hold this card — they asked for it. Recording this
  // enables elimination-based inference: once every other player is absent,
  // the remaining one must hold it.
  recordFailure(ck, card, askerId);

  if (success) {
    hands.set(toPlayerId, targetHand.filter((c) => c !== card));
    askerHand.push(card);
    // Target no longer holds the card; asker now does.
    recordFailure(ck, card, toPlayerId);
    recordSuccess(ck, card, askerId); // sets holder = asker, clears asker from absent
    pushAction(state, `${asker.name} → ${target.name} for ${cardLabel(card)} ✓`);
    state.turnId = askerId;
  } else {
    recordFailure(ck, card, toPlayerId);
    pushAction(state, `${asker.name} → ${target.name} for ${cardLabel(card)} ✗`);
    state.turnId = toPlayerId;
  }

  state.lastAsk.assign({
    askerId,
    targetId: toPlayerId,
    card,
    success,
    at: Date.now(),
  });

  appendTransaction(txLog, {
    askerId,
    targetId: toPlayerId,
    card,
    setKey,
    success,
    askerTeam: asker.team as Team,
  });

  asker.cardCount = (hands.get(askerId) ?? []).length;
  target.cardCount = (hands.get(toPlayerId) ?? []).length;

  ensureValidTurn(state, hands);
  return null;
}

export function applyDeclare(
  state: GameState,
  hands: HandStore,
  declarerId: string,
  setKey: SetKey,
  assignments: Record<Card, string>,
): string | null {
  if (state.status !== "playing") return "Game not started.";
  if (state.turnId !== declarerId) return "Not your turn.";
  const declarer = state.players.get(declarerId);
  if (!declarer) return "Player not found.";
  const set = SET_LOOKUP[setKey];
  if (!set) return "Unknown set.";
  if (isSetClaimed(state, setKey)) return "Set already claimed.";

  // Declarer must personally hold at least one card from the set.
  const declarerHasBaseCard = (hands.get(declarerId) ?? []).some((c) => set.cards.includes(c));
  if (!declarerHasBaseCard) return "You must hold a card from this set to declare it.";

  const teammateIds = new Set(
    [...state.players.values()].filter((p) => p.team === declarer.team).map((p) => p.id),
  );

  const allAssigned = set.cards.every((c) => teammateIds.has(assignments[c]));
  const allCorrect =
    allAssigned &&
    set.cards.every((c) => (hands.get(assignments[c]) ?? []).includes(c));

  const winningTeam: Team = allCorrect ? declarer.team : otherTeam(declarer.team);

  // Capture the *actual* per-card sources before we strip the cards from
  // hands. Clients use this to fly each card from the right seat to the
  // felt center during the declare animation.
  const sources: Record<Card, string> = {};
  for (const card of set.cards) {
    state.players.forEach((_p: Player, id: string) => {
      if ((hands.get(id) ?? []).includes(card)) sources[card] = id;
    });
  }
  state.lastDeclare.assign({
    declarerId,
    setKey,
    winningTeam,
    success: allCorrect,
    at: Date.now(),
  });
  // Replace the sources map atomically so clients see exactly one update.
  state.lastDeclare.sources.clear();
  for (const [card, holderId] of Object.entries(sources)) {
    state.lastDeclare.sources.set(card, holderId);
  }
  // Populate the declarer's claimed assignments (scoped to this set's cards only).
  state.lastDeclare.assignments.clear();
  for (const card of set.cards) {
    if (assignments[card]) state.lastDeclare.assignments.set(card, assignments[card]);
  }

  // Remove the set's cards from all hands (the set is now off the table).
  state.players.forEach((p: Player, id: string) => {
    const h = hands.get(id) ?? [];
    const filtered = h.filter((c) => !set.cards.includes(c));
    hands.set(id, filtered);
    p.cardCount = filtered.length;
  });

  if (winningTeam === "A") {
    state.claimedA.push(setKey);
    state.scoreA = state.claimedA.length;
  } else {
    state.claimedB.push(setKey);
    state.scoreB = state.claimedB.length;
  }

  const verb = allCorrect ? "declared" : "missed declaring";
  pushAction(
    state,
    `${declarer.name} ${verb} ${set.label} — Team ${winningTeam} scores.`,
  );

  if (totalClaimed(state) >= SET_DEFS.length) {
    state.status = "ended";
    state.winnerTeam = state.scoreA > state.scoreB ? "A" : state.scoreB > state.scoreA ? "B" : "";
    pushAction(state, state.winnerTeam ? `Team ${state.winnerTeam} wins!` : "Game tied.");
    return null;
  }

  if (allCorrect) {
    state.postDeclareId = declarerId;
    // If the declarer has no cards left after the set was stripped, auto-pass
    // to a teammate with cards (or the next player with cards if no teammate).
    if ((hands.get(declarerId) ?? []).length === 0) {
      const teammate = findNextPlayerWithCards(state, hands, declarerId, declarer.team as Team);
      if (teammate) {
        state.postDeclareId = "";
        state.turnId = teammate;
      } else {
        state.postDeclareId = "";
        ensureValidTurn(state, hands);
      }
    }
  } else {
    // Failed declare: turn advances normally.
    state.postDeclareId = "";
    ensureValidTurn(state, hands);
  }
  return null;
}

export function applyPass(
  state: GameState,
  hands: HandStore,
  passerId: string,
  toPlayerId?: string,
): string | null {
  if (state.status !== "playing") return "Game not started.";
  if (state.turnId !== passerId) return "Not your turn.";
  if (state.postDeclareId !== passerId) return "Can only pass after declaring a set.";
  const passer = state.players.get(passerId);
  if (!passer) return "Player not found.";

  let nextId = toPlayerId;
  if (nextId) {
    const target = state.players.get(nextId);
    if (
      !target ||
      target.team !== passer.team ||
      target.id === passer.id ||
      (hands.get(nextId) ?? []).length === 0
    ) {
      return "Cannot pass to that player.";
    }
  } else {
    nextId = findNextPlayerWithCards(state, hands, passerId, passer.team) ?? undefined;
  }
  if (!nextId) return "No valid teammate to pass to.";

  state.postDeclareId = "";
  state.turnId = nextId;
  const target = state.players.get(nextId)!;
  pushAction(state, `${passer.name} passed to ${target.name}.`);
  return null;
}
