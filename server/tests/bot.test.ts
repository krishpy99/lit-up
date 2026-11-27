// Bot strategy checks: lock, holding a finished set, passing within the team.
import { it } from "node:test";
import assert from "node:assert/strict";
import { GameState, Player } from "../src/schema.js";
import { appendTransaction, type HandStore, type TransactionLog } from "../src/rules.js";
import { decideBotAction } from "../src/bot.js";
import { CARD_TO_SET, type Card } from "@lit-up/shared";

type Diff = "medium" | "hard" | "expert";

// Team A: a, b, c (c is the bot). Team B: d, e, f.
function game(handsIn: Record<string, Card[]>, asks: [string, string, Card, boolean][]) {
  const state = new GameState();
  const hands: HandStore = new Map();
  const log: TransactionLog = [];
  for (const id of ["a", "b", "c", "d", "e", "f"]) {
    const p = new Player();
    p.id = id;
    p.name = id;
    p.team = "abc".includes(id) ? "A" : "B";
    p.cardCount = handsIn[id].length;
    state.players.set(id, p);
    hands.set(id, [...handsIn[id]]);
  }
  for (const [askerId, targetId, card, success] of asks) {
    appendTransaction(log, {
      askerId, targetId, card, success,
      setKey: CARD_TO_SET.get(card)!,
      askerTeam: state.players.get(askerId)!.team as "A" | "B",
    });
  }
  state.status = "playing";
  state.turnId = "c";
  return { state, hands, log };
}

function tally(g: ReturnType<typeof game>, diff: Diff, n = 300) {
  const out: Record<string, number> = {};
  for (let i = 0; i < n; i++) {
    const a = decideBotAction(g.state, g.hands, g.log, g.state.players.get("c")!, diff);
    const key = a.type === "ask" ? `ask:${a.targetId}` : a.type === "pass" ? `pass:${a.toPlayerId}` : "declare";
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
}

it("locks the opponent who holds the last card of a set we mostly own", () => {
  // Team A has five high diamonds. a and b both failed to find D10 with d and
  // e, so f has it. c holds no high diamond and can't ask for it: it must not
  // hand f the turn on a guess, or f asks us for the whole set.
  const g = game(
    {
      a: ["D9", "DJ", "S2"], b: ["DQ", "DK", "DA"], c: ["C2", "C3", "H2"],
      d: ["C4", "C5", "H9"], e: ["C6", "C7", "H10"], f: ["D10", "H3", "H4"],
    },
    [
      ["a", "d", "DJ", true],
      ["b", "e", "DQ", true],
      ["a", "d", "D10", false],
      ["d", "b", "HK", false],
      ["b", "e", "D10", false],
      ["e", "c", "HA", false],
    ],
  );
  for (const diff of ["hard", "expert"] as const) {
    const t = tally(g, diff);
    assert.equal(t["ask:f"] ?? 0, 0, `${diff} asked f: ${JSON.stringify(t)}`);
  }
  assert.ok((tally(g, "medium")["ask:f"] ?? 0) < 30, "medium mostly avoids f");
});

it("holds a finished set while it has a sure ask, and cashes it in otherwise", () => {
  const hands = {
    a: ["H2", "H3"], b: ["H4", "H5"], c: ["S2", "S3", "S4", "S5", "S6", "S7", "C2"],
    d: ["C4", "H6"], e: ["C5", "H7"], f: ["C6", "C7"],
  } as Record<string, Card[]>;
  // d took C4 from c earlier, so c knows exactly where it is.
  const sure = tally(game({ ...hands, c: [...hands.c, "C3"] }, [["d", "c", "C4", true]]), "expert");
  assert.ok((sure["ask:d"] ?? 0) > 200, `mostly asks d for C4: ${JSON.stringify(sure)}`);
  assert.ok((sure.declare ?? 0) > 0, "sometimes declares anyway");

  const guess = tally(game(hands, []), "expert");
  assert.equal(guess.declare, 300, `declares instead of guessing: ${JSON.stringify(guess)}`);
});

it("passes to a teammate after declaring when there's nothing safe to ask", () => {
  const g = game(
    { a: ["H2", "H3", "H4"], b: ["H5"], c: ["C2"], d: ["C4", "H6"], e: ["C5", "H7"], f: ["C6", "C7"] },
    [],
  );
  g.state.postDeclareId = "c";
  assert.deepEqual(tally(g, "hard", 50), { "pass:a": 50 });
});
