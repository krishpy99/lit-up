/**
 * LiteratureRoom — one room per game. The room owns the authoritative state
 * and the per-player hands. Clients send commands, server validates them,
 * and synced schema changes propagate to everyone automatically. Hands are
 * pushed privately to their owners via the "hand" message.
 */

import { Room, type Client } from "@colyseus/core";
import {
  AVATAR_CHARACTERS,
  AVATAR_COLORS,
  AVATAR_ILLUSTRATIONS,
  BOT_THINK_MS,
  MAX_PLAYERS,
  MIN_PLAYERS,
  type AskCommand,
  type DeclareCommand,
  type JoinOptions,
  type PassCommand,
  type SetBotDifficultyCommand,
  type SetRoomConfigCommand,
} from "@lit-up/shared";
import { GameState, Player } from "./schema.js";
import {
  applyAsk,
  applyDeclare,
  applyPass,
  assignTeams,
  ensureValidTurn,
  findNextPlayerWithCards,
  getHand,
  newKnowledge,
  pushAction,
  resetToLobby,
  startGame,
  type CardKnowledge,
  type HandStore,
  type TransactionLog,
} from "./rules.js";
import { buildBotDeclareAssignments, decideBotAction } from "./bot.js";

const ROOM_CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RECONNECT_GRACE_S = 300; // 5 minutes

// Single-word movie-inspired bot names
const BOT_NAMES = [
  "Maverick",
  "Zephyr",
  "Falcon",
  "Matrix",
  "Blade",
  "Tron",
  "Ghost",
  "Riddick",
  "Morpheus",
  "Trinity",
  "Maximus",
  "Gandalf",
  "Dredd",
  "Ripley",
  "Groot",
  "Yoda",
] as const;

function generateRoomCode(): string {
  return Array.from({ length: 6 }, () =>
    ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)],
  ).join("");
}

function getNextBotName(state: GameState): string {
  // Count existing bots
  let botCount = 0;
  state.players.forEach((p) => {
    if (p.isBot) botCount++;
  });
  // Cycle through bot names
  return BOT_NAMES[botCount % BOT_NAMES.length];
}

export class LiteratureRoom extends Room<GameState> {
  override maxClients = MAX_PLAYERS;

  /** Server-only: each player's hand. Never goes into the schema. */
  private hands: HandStore = new Map();

  /** Server-only: derived knowledge for bot AI. */
  private knowledge: CardKnowledge = newKnowledge();

  /** Server-only: full transaction log for richer bot inference. */
  private transactions: TransactionLog = [];

  /** Player ids → reconnection tokens (sessionId from Colyseus). */
  private sessionIdToPlayerId = new Map<string, string>();

  /** Tracks which bot replaced a disconnected player: playerId -> botId. */
  private disconnectedReplacements = new Map<string, string>();

  /** Reconnection timeouts per player: playerId -> timeoutHandle. */
  private reconnectTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

  private botTimer: ReturnType<typeof setTimeout> | null = null;

  override onCreate(_options: unknown): void {
    this.setState(new GameState());
    this.state.code = generateRoomCode();
    this.roomId = this.state.code;

    this.onMessage("ask", (client, msg: AskCommand) => this.handleAsk(client, msg));
    this.onMessage("declare", (client, msg: DeclareCommand) => this.handleDeclare(client, msg));
    this.onMessage("pass", (client, msg: PassCommand) => this.handlePass(client, msg));
    this.onMessage("start_game", (client) => this.handleStart(client));
    this.onMessage("add_bot", (client) => this.handleAddBot(client));
    this.onMessage("remove_bots", (client) => this.handleRemoveBots(client));
    this.onMessage("shuffle_teams", (client) => this.handleShuffleTeams(client));
    this.onMessage("reset_game", (client) => this.handleReset(client));
    this.onMessage("set_bot_difficulty", (client, msg: SetBotDifficultyCommand) =>
      this.handleSetBotDifficulty(client, msg),
    );
    this.onMessage("set_room_config", (client, msg: SetRoomConfigCommand) =>
      this.handleSetRoomConfig(client, msg),
    );
  }

  // ── Join / leave ─────────────────────────────────────────

  override onJoin(client: Client, options: JoinOptions): void {
    const name = (options?.name ?? "").trim();
    if (!name) throw new Error("Name required.");
    if (!this.state.status.match(/^(lobby|playing)$/)) throw new Error("Room is not accepting players.");
    if (this.state.players.size >= MAX_PLAYERS) throw new Error("Room is full.");

    // ── Reconnect: restore a disconnected player ─────────────────
    if (options.reconnectToken && this.state.status === "playing") {
      const existingPlayer = this.state.players.get(options.reconnectToken);
      if (existingPlayer && !existingPlayer.connected && existingPlayer.name === name) {
        // Restore the disconnected player
        const playerId = options.reconnectToken;
        existingPlayer.connected = true;
        this.sessionIdToPlayerId.set(client.sessionId, playerId);

        // Remove the bot that replaced them
        const botId = this.disconnectedReplacements.get(playerId);
        if (botId) {
          this.removePlayer(botId);
          this.disconnectedReplacements.delete(playerId);
        }

        // Clear the reconnect timeout
        const timeout = this.reconnectTimeouts.get(playerId);
        if (timeout) {
          clearTimeout(timeout);
          this.reconnectTimeouts.delete(playerId);
        }

        pushAction(this.state, `${name} reconnected.`);
        client.send("welcome", { playerId, roomCode: this.state.code });
        this.sendHand(client);
        return;
      }
    }

    // ── New join ─────────────────────────────────────────────────
    if (this.state.status !== "lobby") throw new Error("Room is not accepting new players during a game.");
    if (
      [...this.state.players.values()].some(
        (p) => p.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw new Error("Name already taken.");
    }

    const playerId = client.sessionId;
    const player = new Player();
    player.id = playerId;
    player.name = name;
    player.avatar = options.avatar || pickFreeAvatar(this.state);
    player.character = sanitizeCharacter(options.character);
    player.team = this.state.players.size % 2 === 0 ? "A" : "B";
    player.isHost = this.state.players.size === 0;
    player.isBot = false;
    player.connected = true;
    player.cardCount = 0;

    this.state.players.set(playerId, player);
    this.hands.set(playerId, []);
    this.sessionIdToPlayerId.set(client.sessionId, playerId);

    if (player.isHost) {
      this.state.hostId = playerId;
      this.state.turnId = playerId;
    }

    pushAction(this.state, `${name} joined.`);
    client.send("welcome", { playerId, roomCode: this.state.code });
    this.sendHand(client);
  }

  override async onLeave(client: Client, consented?: boolean): Promise<void> {
    const playerId = this.sessionIdToPlayerId.get(client.sessionId);
    if (!playerId) return;
    const player = this.state.players.get(playerId);
    if (!player) return;

    // In lobby, leaving is permanent and team is reshuffled.
    if (this.state.status === "lobby" || consented) {
      this.removePlayer(playerId);
      pushAction(this.state, `${player.name} left.`);
      this.maybePromoteHost();
      assignTeams(this.state);
      return;
    }

    // Mid-game: mark disconnected, spawn a bot to take their place, and allow reconnect for 5 min.
    player.connected = false;
    pushAction(this.state, `${player.name} disconnected. A bot is taking over.`);

    // Spawn a bot to replace the disconnected player
    const botId = `bot-${Math.random().toString(36).slice(2, 9)}`;
    const bot = new Player();
    bot.id = botId;
    bot.name = `${player.name} (Bot)`;
    bot.avatar = player.avatar;
    bot.character = player.character;
    bot.team = player.team;
    bot.isBot = true;
    bot.isHost = false;
    bot.connected = true;
    bot.cardCount = player.cardCount;

    this.state.players.set(botId, bot);
    this.hands.set(botId, [...this.hands.get(playerId) ?? []]);
    this.disconnectedReplacements.set(playerId, botId);

    ensureValidTurn(this.state, this.hands);

    // Set a 5-minute reconnect window
    const timeout = setTimeout(() => {
      const still = this.state.players.get(playerId);
      if (still && !still.connected) {
        this.removePlayer(playerId);
        this.disconnectedReplacements.delete(playerId);
        this.reconnectTimeouts.delete(playerId);
        pushAction(this.state, `${player.name} did not reconnect in time.`);
        ensureValidTurn(this.state, this.hands);
      }
    }, RECONNECT_GRACE_S * 1000);

    this.reconnectTimeouts.set(playerId, timeout);

    try {
      await this.allowReconnection(client, RECONNECT_GRACE_S);
    } catch {
      // Timeout was already handled above, so nothing to do here.
    }
  }

  override onDispose(): void {
    if (this.botTimer) clearTimeout(this.botTimer);
    this.reconnectTimeouts.forEach((timeout) => clearTimeout(timeout));
  }

  private removePlayer(playerId: string): void {
    this.state.players.delete(playerId);
    this.hands.delete(playerId);
    this.sessionIdToPlayerId.forEach((pid, sid) => {
      if (pid === playerId) this.sessionIdToPlayerId.delete(sid);
    });
  }

  private maybePromoteHost(): void {
    if (this.state.players.has(this.state.hostId)) return;
    const next = [...this.state.players.values()].find((p) => !p.isBot);
    if (next) {
      this.state.hostId = next.id;
      next.isHost = true;
    }
  }

  // ── Auth helpers ─────────────────────────────────────────

  private clientPlayer(client: Client): Player | null {
    const id = this.sessionIdToPlayerId.get(client.sessionId);
    return id ? this.state.players.get(id) ?? null : null;
  }

  private requireHost(client: Client): Player | null {
    const p = this.clientPlayer(client);
    if (!p || !p.isHost) {
      client.send("error", { message: "Only the host can do that." });
      return null;
    }
    return p;
  }

  private dispatchError(client: Client, message: string): void {
    client.send("error", { message });
  }

  // ── Hands (private state) ────────────────────────────────

  private sendHand(client: Client): void {
    const playerId = this.sessionIdToPlayerId.get(client.sessionId);
    if (!playerId) return;
    client.send("hand", { hand: getHand(this.hands, playerId) });
  }

  /**
   * Push a hand update to a specific player, found by id. Used after every
   * action that mutates a hand. Bots have no client, so they're skipped.
   */
  private pushHandTo(playerId: string): void {
    const player = this.state.players.get(playerId);
    if (!player || player.isBot) return;
    const sessionId = [...this.sessionIdToPlayerId.entries()].find(
      ([, pid]) => pid === playerId,
    )?.[0];
    if (!sessionId) return;
    const client = this.clients.find((c) => c.sessionId === sessionId);
    if (!client) return;
    client.send("hand", { hand: getHand(this.hands, playerId) });
  }

  /** Push hand updates to everyone whose hand might have changed. */
  private pushAllHands(): void {
    this.state.players.forEach((p: Player, id: string) => {
      if (!p.isBot) this.pushHandTo(id);
    });
  }

  // ── Commands ─────────────────────────────────────────────

  private handleAsk(client: Client, msg: AskCommand): void {
    const player = this.clientPlayer(client);
    if (!player) return;
    const err = applyAsk(this.state, this.hands, this.knowledge, this.transactions, player.id, msg.toPlayerId, msg.card);
    if (err) {
      this.dispatchError(client, err);
      return;
    }
    this.pushHandTo(player.id);
    this.pushHandTo(msg.toPlayerId);
    this.scheduleBot();
  }

  private handleDeclare(client: Client, msg: DeclareCommand): void {
    const player = this.clientPlayer(client);
    if (!player) return;
    const err = applyDeclare(this.state, this.hands, player.id, msg.setKey, msg.assignments);
    if (err) {
      this.dispatchError(client, err);
      return;
    }
    this.pushAllHands();
    this.scheduleBot();
  }

  private handlePass(client: Client, msg: PassCommand): void {
    const player = this.clientPlayer(client);
    if (!player) return;
    const err = applyPass(this.state, this.hands, player.id, msg.toPlayerId);
    if (err) {
      this.dispatchError(client, err);
      return;
    }
    this.scheduleBot();
  }

  private handleStart(client: Client): void {
    const host = this.requireHost(client);
    if (!host) return;
    if (this.state.status !== "lobby") {
      this.dispatchError(client, "Can only start from the lobby.");
      return;
    }
    if (
      this.state.players.size < MIN_PLAYERS ||
      this.state.players.size % 2 !== 0
    ) {
      this.dispatchError(client, `Need ${MIN_PLAYERS}+ players, even count.`);
      return;
    }
    this.knowledge = newKnowledge();
    startGame(this.state, this.hands, this.transactions);
    this.pushAllHands();
    this.scheduleBot();
  }

  private handleAddBot(client: Client): void {
    if (!this.requireHost(client)) return;
    if (this.state.status !== "lobby") return;
    const toAdd = botsToAdd(this.state.players.size);
    let added = 0;
    for (let i = 0; i < toAdd; i++) {
      if (this.state.players.size >= MAX_PLAYERS) break;
      const id = `bot-${Math.random().toString(36).slice(2, 9)}`;
      const bot = new Player();
      bot.id = id;
      bot.name = getNextBotName(this.state);
      bot.avatar = pickFreeAvatar(this.state);
      bot.character = AVATAR_CHARACTERS[
        Math.floor(Math.random() * AVATAR_CHARACTERS.length)
      ];
      bot.team = "A";
      bot.isBot = true;
      bot.isHost = false;
      bot.connected = true;
      bot.cardCount = 0;
      this.state.players.set(id, bot);
      this.hands.set(id, []);
      added++;
    }
    if (added === 0) {
      this.dispatchError(client, "Room is full.");
      return;
    }
    assignTeams(this.state);
    pushAction(this.state, added === 1 ? "1 bot joined." : `${added} bots joined.`);
  }

  private handleRemoveBots(client: Client): void {
    if (!this.requireHost(client)) return;
    if (this.state.status !== "lobby") return;
    const botIds: string[] = [];
    this.state.players.forEach((p: Player, id: string) => {
      if (p.isBot) botIds.push(id);
    });
    botIds.forEach((id) => this.removePlayer(id));
    if (botIds.length > 0) pushAction(this.state, "Bots removed.");
    assignTeams(this.state);
  }

  private handleShuffleTeams(client: Client): void {
    if (!this.requireHost(client)) return;
    if (this.state.status !== "lobby") return;
    const ids = [...this.state.players.keys()];
    for (let i = ids.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    // Rebuild map in shuffled order so team assignment reflects it.
    const reordered = new Map<string, Player>();
    ids.forEach((id) => reordered.set(id, this.state.players.get(id)!));
    this.state.players.clear();
    reordered.forEach((p, id) => this.state.players.set(id, p));
    assignTeams(this.state);
    pushAction(this.state, "Teams shuffled.");
  }

  private handleReset(client: Client): void {
    if (!this.requireHost(client)) return;
    this.knowledge = newKnowledge();
    resetToLobby(this.state, this.hands, this.transactions);
    this.pushAllHands();
  }

  private handleSetBotDifficulty(client: Client, msg: SetBotDifficultyCommand): void {
    if (!this.requireHost(client)) return;
    if (msg?.difficulty && ["easy", "medium", "hard"].includes(msg.difficulty)) {
      this.state.botDifficulty = msg.difficulty;
    }
  }

  private handleSetRoomConfig(client: Client, msg: SetRoomConfigCommand): void {
    if (!this.requireHost(client)) return;
    // These only mutate in the lobby; once playing, the host loses the ability
    // to change them so players have a stable contract for the whole game.
    if (this.state.status !== "lobby") {
      this.dispatchError(client, "Room config is locked once the game starts.");
      return;
    }
    if (typeof msg?.notesEnabled === "boolean") {
      this.state.notesEnabled = msg.notesEnabled;
    }
    if (typeof msg?.defaultLogCount === "number") {
      const n = Math.floor(msg.defaultLogCount);
      // 0 = "all"; otherwise clamp to a sane visible range.
      this.state.defaultLogCount = n === 0 ? 0 : Math.min(20, Math.max(1, n));
    }
  }

  // ── Bot scheduler ────────────────────────────────────────

  private scheduleBot(): void {
    if (this.botTimer) clearTimeout(this.botTimer);
    if (this.state.status !== "playing") return;
    const cur = this.state.players.get(this.state.turnId);
    if (!cur || !cur.isBot) return;

    this.botTimer = setTimeout(() => this.runBotTurn(), BOT_THINK_MS);
  }

  private runBotTurn(): void {
    if (this.state.status !== "playing") return;
    const bot = this.state.players.get(this.state.turnId);
    if (!bot || !bot.isBot) return;

    const action = decideBotAction(this.state, this.hands, this.knowledge, this.transactions, bot);

    if (action.type === "ask") {
      // Capture certainty BEFORE ask mutates knowledge (for proof logging).
      const certainHolder = this.knowledge.get(action.card)?.holder;

      const err = applyAsk(
        this.state,
        this.hands,
        this.knowledge,
        this.transactions,
        bot.id,
        action.targetId,
        action.card,
      );
      if (err) {
        pushAction(this.state, err);
        ensureValidTurn(this.state, this.hands);
      } else {
        // Proof that the knowledge tracker is working: when ck.holder had
        // already confirmed the target was holding this card, log it so
        // players can see the bot's inference in the action log.
        if (certainHolder === action.targetId) {
          const target = this.state.players.get(action.targetId);
          pushAction(this.state, `🧠 ${bot.name} tracked: knew ${target?.name ?? "?"} had that card`);
        }
        this.pushHandTo(action.targetId);
      }
      this.scheduleBot();
      return;
    }

    if (action.type === "declare") {
      const assignments = buildBotDeclareAssignments(this.state, this.hands, bot, action.setKey);
      if (assignments) {
        const err = applyDeclare(this.state, this.hands, bot.id, action.setKey, assignments);
        if (!err) {
          this.pushAllHands();
          // After a successful declare, bot holds postDeclareId.
          // If it has no cards left, pass to the next teammate immediately.
          if ((this.hands.get(bot.id) ?? []).length === 0) {
            applyPass(this.state, this.hands, bot.id);
          }
          // Otherwise, let the bot continue on its turn (scheduleBot below).
        }
      } else {
        // Bot's knowledge was stale — skip and advance turn to avoid infinite loop.
        ensureValidTurn(this.state, this.hands);
      }
      this.scheduleBot();
      return;
    }

    // Pass — bot has no valid ask (or is empty-handed).
    if ((this.hands.get(bot.id) ?? []).length > 0) {
      // Bot still has cards but buildCandidates was empty (e.g. all remaining
      // cards in its sets are inferred on teammates and the inferred-declare
      // check above was inconclusive). Force-advance to avoid an infinite
      // retry loop where ensureValidTurn refuses to move the turn away.
      const next = findNextPlayerWithCards(this.state, this.hands, bot.id);
      if (next) {
        pushAction(this.state, `${bot.name} has no valid ask — turn passes.`);
        this.state.turnId = next;
      }
    } else {
      ensureValidTurn(this.state, this.hands);
    }
    this.scheduleBot();
  }
}

// ── Helpers ───────────────────────────────────────────────────

function botsToAdd(playerCount: number): number {
  if (playerCount === 0 || playerCount === 1) return Math.max(MIN_PLAYERS - playerCount, 1);
  if (playerCount % 2 === 1) return 1;
  return 2;
}

function nextBotNumber(state: GameState): number {
  const nums: number[] = [];
  state.players.forEach((p) => {
    if (!p.isBot) return;
    const m = p.name.match(/\d+/);
    if (m) nums.push(parseInt(m[0], 10));
  });
  return nums.length > 0 ? Math.max(...nums) + 1 : 1;
}

function pickFreeAvatar(state: GameState): string {
  const used = new Set<string>();
  state.players.forEach((p) => used.add(p.avatar));
  const free = AVATAR_COLORS.find((c) => !used.has(c));
  return free ?? AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
}

/**
 * Accept an emoji from our curated list, an illustration seed, or empty
 * (use the player's initial). Never trust arbitrary client input — silently
 * drop anything outside the allowed sets so a malicious client can't
 * inject UI or arbitrary URLs.
 */
function sanitizeCharacter(input: unknown): string {
  if (typeof input !== "string" || input === "") return "";
  if (AVATAR_CHARACTERS.includes(input as (typeof AVATAR_CHARACTERS)[number])) {
    return input;
  }
  if (AVATAR_ILLUSTRATIONS.includes(input as (typeof AVATAR_ILLUSTRATIONS)[number])) {
    return input;
  }
  return "";
}
