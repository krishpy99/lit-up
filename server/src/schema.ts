/**
 * Public room state. Auto-synced to all clients via Colyseus.
 *
 * Hidden information (each player's hand) lives only on the server (see room.ts)
 * and is pushed privately to its owner via room messages, never via this schema.
 */

import { ArraySchema, MapSchema, Schema, type } from "@colyseus/schema";

export class Player extends Schema {
  @type("string") id: string = "";
  @type("string") name: string = "";
  @type("string") avatar: string = "";
  /**
   * Optional character glyph (typically an emoji) shown inside the avatar.
   * Empty string falls back to the first letter of the player's name on
   * the client. Independent of `avatar` (the fill color).
   */
  @type("string") character: string = "";
  @type("string") team: "A" | "B" = "A";
  @type("boolean") isBot: boolean = false;
  @type("boolean") isHost: boolean = false;
  @type("boolean") connected: boolean = true;
  @type("number") cardCount: number = 0;
}

/**
 * The most-recent ask, surfaced for animation:
 * the asker's seat will briefly show the card asked,
 * highlighted green on success or red on failure.
 */
export class LastAsk extends Schema {
  @type("string") askerId: string = "";
  @type("string") targetId: string = "";
  @type("string") card: string = "";
  @type("boolean") success: boolean = false;
  /** Server timestamp; clients use it to expire the visual hint. */
  @type("number") at: number = 0;
}

/**
 * A bot's "ask" displayed during its think-time so other players
 * see what's about to happen before the result lands.
 */
export class PendingBotAsk extends Schema {
  @type("string") askerId: string = "";
  @type("string") targetId: string = "";
  @type("string") card: string = "";
}

/**
 * The most-recent declare, surfaced for animation. `sources` records
 * who actually held each card *at the moment of the declare*, so every
 * client can fly the cards in from the right seats — even if it wasn't
 * the declarer's view that knew the truth.
 */
export class LastDeclare extends Schema {
  @type("string") declarerId: string = "";
  @type("string") setKey: string = "";
  @type("string") winningTeam: string = "";
  @type("boolean") success: boolean = false;
  @type({ map: "string" }) sources = new MapSchema<string>();    // actual positions
  @type({ map: "string" }) assignments = new MapSchema<string>(); // declarer's claims
  @type("number") at: number = 0;
}

export class GameState extends Schema {
  @type("string") code: string = "";
  @type("string") status: "lobby" | "playing" | "ended" = "lobby";
  @type("string") hostId: string = "";
  @type("string") turnId: string = "";
  @type("string") postDeclareId: string = "";

  @type({ map: Player }) players = new MapSchema<Player>();

  @type(["string"]) claimedA = new ArraySchema<string>();
  @type(["string"]) claimedB = new ArraySchema<string>();
  @type("number") scoreA: number = 0;
  @type("number") scoreB: number = 0;
  @type("string") winnerTeam: "" | "A" | "B" = "";

  /** Most-recent first; capped at 20 entries. */
  @type(["string"]) actions = new ArraySchema<string>();

  @type(LastAsk) lastAsk = new LastAsk();
  /**
   * Always populated. An empty `askerId` means "no pending ask" — clients
   * check that field rather than treating the instance itself as nullable.
   * Colyseus's schema encoder doesn't gracefully handle uninitialized
   * optional sub-schemas in v2.x.
   */
  @type(PendingBotAsk) pendingBotAsk = new PendingBotAsk();
  /** Same nullability convention as pendingBotAsk: empty `setKey` means
   *  "no recent declare" — clients check that field. */
  @type(LastDeclare) lastDeclare = new LastDeclare();

  @type("string") botDifficulty: "easy" | "medium" | "hard" = "medium";

  // ── Room config (set in the lobby, frozen once the game starts) ──
  /** Whether players can take per-opponent notes during the game. */
  @type("boolean") notesEnabled: boolean = false;
  /** How many recent transactions the floating log shows; 0 = all (capped). */
  @type("number") defaultLogCount: number = 5;
}
