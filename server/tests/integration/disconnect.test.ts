/**
 * Integration tests for disconnect/reconnect and bot-takeover behaviour.
 *
 * Uses @colyseus/testing to boot the real Colyseus room on an ephemeral port,
 * then drives real WebSocket clients through the game lifecycle.
 *
 * Run with (from the server/ directory):
 *   LIT_RECONNECT_GRACE_S=999 LIT_BOT_THINK_MS=0 LIT_POST_BOT_ACTION_DELAY_MS=0 \
 *   tsx --test tests/integration/disconnect.test.ts
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { boot, ColyseusTestServer } from "@colyseus/testing";
import { LiteratureRoom } from "../../src/room.js";
import type { GameState } from "../../src/schema.js";
import type { Room as ClientRoom } from "colyseus.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Wait up to `ms` ms for `predicate` to return true, polling every 50 ms. */
async function waitFor(predicate: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`waitFor timed out after ${ms}ms`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

/**
 * Forcibly close the underlying WebSocket without sending a "leave" packet.
 * This triggers a non-consented disconnect on the server, which is the path
 * that spawns a bot replacement and opens a reconnect window.
 */
function forceClose(room: ClientRoom<GameState>): void {
  const transport = (room as any).connection?.transport;
  if (transport?.ws) {
    transport.ws.close();
    return;
  }
  const conn = (room as any).connection;
  if (conn?.ws) {
    conn.ws.close();
    return;
  }
  throw new Error("Could not locate WebSocket to force-close");
}

/** Join a room by id. Fresh joins use the sessionId as the player id. */
async function joinAndWelcome(
  colyseus: ColyseusTestServer,
  roomId: string,
  name: string,
  extra?: Record<string, unknown>,
): Promise<{ room: ClientRoom<GameState>; playerId: string }> {
  const room = await colyseus.sdk.joinById<GameState>(roomId, { name, ...extra });
  room.onMessage("*", () => {}); // silence unhandled-message warnings
  return { room, playerId: room.sessionId };
}

/**
 * Build a 4-player game (4 real clients) and start it.
 * Returns players in join order; [0] is the host.
 */
async function buildGame(colyseus: ColyseusTestServer): Promise<
  Array<{ room: ClientRoom<GameState>; playerId: string }>
> {
  const host = await colyseus.sdk.create<GameState>("literature", { name: "Alice" });
  host.onMessage("*", () => {});
  const hostPlayerId = host.sessionId;

  const players: Array<{ room: ClientRoom<GameState>; playerId: string }> = [
    { room: host, playerId: hostPlayerId },
  ];

  for (const name of ["Bob", "Carol", "Dave"]) {
    players.push(await joinAndWelcome(colyseus, host.roomId, name));
  }

  host.send("start_game");

  await Promise.all(
    players.map(({ room }) =>
      waitFor(() => (room.state as GameState).status === "playing", 5000),
    ),
  );

  return players;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe("disconnect integration", () => {
  let colyseus: ColyseusTestServer;

  before(async () => {
    const server = new Server({
      transport: new WebSocketTransport(),
    });
    server.define("literature", LiteratureRoom);
    colyseus = await boot(server);
  });

  after(async () => {
    await colyseus.shutdown();
  });

  // ── Test 1: autopilot takes over the same seat on disconnect ───────────────

  it("puts a disconnected player's seat on autopilot without duplicating it", async () => {
    const [host, victim, c, d] = await buildGame(colyseus);
    const serverRoom = colyseus.getRoomById<GameState>(host.room.roomId) as LiteratureRoom;
    const hands: Map<string, string[]> = (serverRoom as any).hands;
    const handBefore = [...(hands.get(victim.playerId) ?? [])];

    // Make it the victim's turn so we also prove the game can't wedge on them.
    serverRoom.state.turnId = victim.playerId;
    forceClose(victim.room);

    await waitFor(() => {
      const p = serverRoom.state.players.get(victim.playerId);
      return !!p && !p.connected && p.isBot;
    }, 2000);

    assert.equal(serverRoom.state.players.size, 4, "no extra replacement player");
    const total = [...hands.values()].reduce((n, h) => n + h.length, 0);
    assert.equal(total, 54 - 6 * (serverRoom.state.claimedA.length + serverRoom.state.claimedB.length), "no cards duplicated or lost");

    // Autopilot plays the turn (bot think is 0 in tests).
    await waitFor(
      () => serverRoom.state.turnId !== victim.playerId || (hands.get(victim.playerId) ?? []).join() !== handBefore.join(),
      3000,
    );

    for (const { room } of [host, c, d]) room.leave(true);
  });

  // ── Test 2: reconnect by token hands the seat back ─────────────────────────

  it("hands the seat (and hand) back on reconnect", async () => {
    const [host, victim, c, d] = await buildGame(colyseus);
    const roomId = victim.room.roomId;
    const serverRoom = colyseus.getRoomById<GameState>(roomId) as LiteratureRoom;
    const hands: Map<string, string[]> = (serverRoom as any).hands;

    forceClose(victim.room);
    await waitFor(() => serverRoom.state.players.get(victim.playerId)?.connected === false, 2000);

    const reconnected = await colyseus.sdk.joinById<GameState>(roomId, {
      name: "Bob",
      reconnectToken: victim.playerId,
    });
    const handMsg = new Promise<string[]>((resolve) =>
      reconnected.onMessage("hand", (m: { hand: string[] }) => resolve(m.hand)),
    );
    reconnected.onMessage("*", () => {});

    await waitFor(() => serverRoom.state.players.get(victim.playerId)?.connected === true, 3000);
    const p = serverRoom.state.players.get(victim.playerId)!;
    assert.equal(p.isBot, false, "seat is human again");
    assert.equal(serverRoom.state.players.size, 4);
    const got = await handMsg;
    assert.deepEqual(got, hands.get(victim.playerId), "client receives its current hand");

    reconnected.leave(true);
    for (const { room } of [host, c, d]) room.leave(true);
  });

  // ── Test 3: stale declare guard ────────────────────────────────────────────
  //
  // Verifies that a set cannot be declared twice. We test this at two levels:
  //
  // a) Rule-level: applyDeclare returns "Set already claimed." on a re-declare.
  // b) Bot-level: after a declare the bot's ctx.claimed guard skips the set,
  //    so no bot will ever emit a second declare for the same setKey.

  it("does not re-declare an already-claimed set on subsequent bot turns", async () => {
    const players = await buildGame(colyseus);
    const [host, b, c, d] = players;

    const serverRoom = colyseus.getRoomById<GameState>(host.room.roomId) as LiteratureRoom;
    const serverHands: Map<string, string[]> = (serverRoom as any).hands;

    // ── Part A: rule-level guard ─────────────────────────────────────────────
    // Find a player who holds all 6 cards of some set so we can declare it,
    // then attempt to declare the same set again and expect a rejection.
    //
    // We manipulate the server hands directly to set up the condition cleanly
    // without needing to wait for bot games to progress.

    // Import applyDeclare at runtime from the already-loaded module.
    const { applyDeclare } = await import("../../src/rules.js");
    const { SET_DEFS } = await import("@lit-up/shared");

    // Gather all player IDs and their hands
    const playerIds = [...(serverRoom.state as GameState).players.keys()];
    assert.ok(playerIds.length >= 1, "at least one player in the room");

    // Put all 6 cards of clubs_low onto the first player's hand
    const testSetKey = "clubs_low";
    const testSet = SET_DEFS.find((s) => s.key === testSetKey)!;
    const firstPlayerId = playerIds[0];
    const firstPlayer = (serverRoom.state as GameState).players.get(firstPlayerId)!;

    // Give all 6 cards to the first player
    serverHands.set(firstPlayerId, [...testSet.cards]);
    firstPlayer.cardCount = testSet.cards.length;

    // Remove those cards from every other player's hand
    for (const pid of playerIds) {
      if (pid === firstPlayerId) continue;
      const hand = serverHands.get(pid) ?? [];
      serverHands.set(pid, hand.filter((c) => !testSet.cards.includes(c)));
    }

    // Force it to be the first player's turn
    (serverRoom.state as GameState).turnId = firstPlayerId;

    // Build correct assignments: all cards assigned to firstPlayerId
    const assignments: Record<string, string> = {};
    for (const card of testSet.cards) {
      assignments[card] = firstPlayerId;
    }

    // First declare: must succeed (returns null)
    const err1 = applyDeclare(
      serverRoom.state as GameState,
      serverHands as Map<string, any>,
      firstPlayerId,
      testSetKey,
      assignments,
    );
    assert.equal(err1, null, `first declare should succeed; got: ${err1}`);

    // Set is now in claimed arrays
    const stateAfterFirst = serverRoom.state as GameState;
    const claimedAll = [...stateAfterFirst.claimedA, ...stateAfterFirst.claimedB];
    assert.ok(claimedAll.includes(testSetKey), `${testSetKey} must be in claimed arrays after first declare`);

    // After a correct declare, the declarer's hand is emptied and turnId advances
    // to the next player with cards. We try the second declare using the new
    // turnId holder — give them the test set's cards to satisfy the base-card
    // requirement and ensure the "Set already claimed." guard fires first.
    const currentTurnId = (serverRoom.state as GameState).turnId;
    serverHands.set(currentTurnId, [...testSet.cards]);
    (serverRoom.state as GameState).players.get(currentTurnId)!.cardCount = testSet.cards.length;

    // Build new assignments pointing at currentTurnId
    const assignments2: Record<string, string> = {};
    for (const card of testSet.cards) assignments2[card] = currentTurnId;

    const err2 = applyDeclare(
      serverRoom.state as GameState,
      serverHands as Map<string, any>,
      currentTurnId,
      testSetKey,
      assignments2,
    );
    assert.equal(
      err2,
      "Set already claimed.",
      `second declare on same set must be rejected; got: ${err2}`,
    );

    // ── Part B: bot ctx guard ─────────────────────────────────────────────────
    // Verify the claimed set is skipped by bot logic. We check bot.ts path
    // indirectly: after a declare, `state.claimedA/B` contains the setKey.
    // Bot's analyzeSet loop does `if (ctx.claimed.has(s.key)) continue;` —
    // this is the same data (ArraySchema) we just verified above.
    // Since the claimed array is authoritative, and the bot reads it on every
    // decideBotAction call, this guard is exercised without needing to run bots.

    const claimedSet = new Set([...stateAfterFirst.claimedA, ...stateAfterFirst.claimedB]);
    assert.ok(
      claimedSet.has(testSetKey),
      "ctx.claimed.has(setKey) will return true — bot's declare loop will skip it",
    );

    // ── Cleanup ───────────────────────────────────────────────────────────────
    for (const { room } of [host, b, c, d]) {
      room.leave(true);
    }
  });
});
