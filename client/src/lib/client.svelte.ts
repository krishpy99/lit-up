/**
 * GameClient — wraps Colyseus into a small reactive surface for Svelte.
 *
 * Colyseus has its own listener model; this module bridges it to Svelte 5
 * runes by mirroring the synced schema into a plain JS snapshot on every
 * state change. Components import `game` and read its $state fields directly.
 */

import { Client, type Room } from "colyseus.js";
import {
  AVATAR_COLORS,
  type AskCommand,
  type BotDifficulty,
  type Card,
  type DeclareCommand,
  type GameStatus,
  type JoinOptions,
  type WelcomeMessage,
  type MovePlayerCommand,
  type SetKey,
  type SetRoomConfigCommand,
  type Team,
} from "@lit-up/shared";
// animations import removed — queue drain is now driven by Game.svelte

// ── Snapshot types — plain JS mirrors of the Colyseus schema ──

export interface PlayerSnapshot {
  id: string;
  name: string;
  avatar: string;
  /** Optional emoji glyph for the avatar; empty falls back to first letter. */
  character: string;
  team: Team;
  isBot: boolean;
  isHost: boolean;
  connected: boolean;
  cardCount: number;
}

export interface PendingBotAskSnapshot {
  askerId: string;
  targetId: string;
  card: Card;
}

export interface LastAskSnapshot {
  askerId: string;
  targetId: string;
  card: Card;
  success: boolean;
  at: number;
}

export interface LastDeclareSnapshot {
  declarerId: string;
  setKey: SetKey;
  winningTeam: "" | "A" | "B";
  success: boolean;
  /** Map of card → playerId who held it at declare time. */
  sources: Record<Card, string>;
  /** Map of card → playerId the declarer claimed held it. */
  assignments: Record<Card, string>;
  at: number;
}

export interface RoomSnapshot {
  code: string;
  status: GameStatus;
  hostId: string;
  turnId: string;
  postDeclareId: string;
  players: PlayerSnapshot[];
  claimedA: SetKey[];
  claimedB: SetKey[];
  scoreA: number;
  scoreB: number;
  winnerTeam: "" | "A" | "B";
  actions: string[];
  lastAsk: LastAskSnapshot;
  lastDeclare: LastDeclareSnapshot | null;
  pendingBotAsk: PendingBotAskSnapshot | null;
  botDifficulty: BotDifficulty;
  notesEnabled: boolean;
  defaultLogCount: number;
}

export interface Toast {
  id: number;
  text: string;
  kind: "info" | "success" | "error" | "warn" | "celebrate";
}

// ── Animation event queue types ──────────────────────────────

/**
 * The type of animation that a state transition requires.
 *
 * "ask"     — an ask bubble animation (3–7 s)
 * "declare" — a declare card-flight animation (~1.5 s staggered)
 * "none"    — no animation; visibleRoom$ can advance immediately
 */
export type QueuedEventKind = "ask" | "declare" | "none";

export interface QueuedEvent {
  kind: QueuedEventKind;
  snapshot: RoomSnapshot;
  /**
   * The local player's hand at the time this event was enqueued, captured from
   * pendingHand at enqueue time. Applied to `game.hand` at the appropriate
   * commit point for each event kind:
   *   - "ask" success: at commitAskArrival (bubble arrives at target)
   *   - "ask" failure / "declare" / "none": at consumeEvent
   * Null if no "hand" message arrived before this state change.
   */
  pendingHand: Card[] | null;
}

/**
 * Inspect the diff between the previous visible snapshot and the new one
 * to decide what animation (if any) is required before revealing the new state.
 */
function classifyEvent(prev: RoomSnapshot | null, next: RoomSnapshot): QueuedEventKind {
  // New ask: at timestamp changed and askerId is set
  if (
    next.lastAsk?.at &&
    next.lastAsk.at !== (prev?.lastAsk?.at ?? 0) &&
    next.lastAsk.askerId
  ) {
    return "ask";
  }
  // New declare: lastDeclare appeared or its timestamp changed
  if (
    next.lastDeclare?.at &&
    next.lastDeclare.at !== (prev?.lastDeclare?.at ?? 0)
  ) {
    return "declare";
  }
  return "none";
}

// ── Server URL discovery ─────────────────────────────────────

function inferServerUrl(): string {
  // Colyseus.js uses HTTP for matchmaking and upgrades the connection to a
  // WebSocket internally — pass a http(s) URL, never ws(s).
  const explicit = (import.meta as ImportMeta & { env: Record<string, string> }).env
    ?.VITE_SERVER_URL;
  if (explicit) return explicit;
  if (typeof window === "undefined") return "http://localhost:2567";
  const proto = window.location.protocol === "https:" ? "https:" : "http:";
  if (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1") {
    return `${proto}//${window.location.hostname}:2567`;
  }
  return `${proto}//${window.location.host}`;
}

// ── Session storage ──────────────────────────────────────────

const SESSION_KEY = "lit-up-session";

interface StoredSession {
  roomCode: string;
  playerId: string;
  /** Seat secret from "welcome"; required to rejoin mid-game. */
  reconnectToken?: string;
  name: string;
  avatar: string;
  character: string;
}

// ── Class with reactive fields ───────────────────────────────

class GameClient {
  private client = new Client(inferServerUrl());
  private room: Room | null = null;

  // Pending session data captured at join time, saved once welcome arrives.
  private _pendingName = "";
  private reconnectToken = "";
  /** Bumped by create/join/leave so an in-flight auto-rejoin knows to stop. */
  private rejoinGen = 0;
  /** True while we hold a seat in a running game. Survives the reset in
   *  onLeave, so a drop right after a rejoin (before state arrives) still
   *  triggers another rejoin. */
  private inGame = false;
  /** Set by "welcome": the hand that follows a (re)join must show at once —
   *  no state patch may follow it to flush a staged hand. */
  private applyNextHandNow = false;
  private _pendingAvatar = "";
  private _pendingCharacter = "";

  // Connection
  status = $state<"idle" | "connecting" | "connected" | "error">("idle");
  view = $state<"landing" | "lobby" | "game">("landing");
  errorBanner = $state<string>("");

  // Identity
  playerId = $state<string>("");
  roomCode = $state<string>("");

  // Mirrored room state
  room$ = $state<RoomSnapshot | null>(null);
  /**
   * Visible snapshot — frozen during animations so card counts, turn
   * indicator, and log don't jump mid-flight. Advances to room$ once the
   * current animation completes (or immediately if nothing is playing).
   */
  visibleRoom$ = $state<RoomSnapshot | null>(null);
  hand = $state<Card[]>([]);
  /**
   * Staging area for hand updates that arrive via the "hand" message before
   * the accompanying state-change has been received. Captured into the queued
   * event at enqueue time (or flushed immediately on the fast-path for "none"
   * events). After enqueue, this is reset to null so it doesn't bleed into a
   * subsequent event's capture.
   */
  private pendingHand: Card[] | null = null;

  /**
   * True once commitAskArrival has already flushed the head event's hand.
   * Used by consumeEvent to skip the hand flush (avoiding a double-apply).
   * Reset to false whenever the head event changes.
   */
  private headHandApplied = false;

  // Toast queue
  toasts = $state<Toast[]>([]);
  private toastSeq = 0;

  // ── Animation event queue ────────────────────────────────
  /**
   * Pending state snapshots waiting for their animation to complete before
   * being promoted to visibleRoom$. Game.svelte drains this by awaiting each
   * animation and then calling consumeEvent().
   */
  eventQueue = $state<QueuedEvent[]>([]);
  /**
   * True while an event is being animated by Game.svelte. Buttons are
   * disabled during this period.
   */
  queueBusy = $state(false);

  /**
   * Called by Game.svelte after it has fully awaited the animation for the
   * head of the queue. Promotes the snapshot to visibleRoom$ and removes the
   * event from the queue.
   *
   * For "ask" success events the hand was already flushed by commitAskArrival
   * when the bubble arrived (headHandApplied = true). For all other events the
   * hand is flushed here so the hand fan and card counts advance together.
   */
  consumeEvent(): void {
    const head = this.eventQueue[0];
    if (!head) return;
    // Flush this event's captured hand if commitAskArrival hasn't done it yet.
    if (!this.headHandApplied && head.pendingHand !== null) {
      this.hand = head.pendingHand;
    }
    this.headHandApplied = false; // reset for the next head
    this.visibleRoom$ = head.snapshot;
    this.eventQueue = this.eventQueue.slice(1);
    this.queueBusy = this.eventQueue.length > 0;
  }

  /**
   * Mid-animation commit for a SUCCESSFUL ask when the bubble arrives at the
   * target. Reveals the target's card count decrease and flushes the pending
   * hand (so the local player's hand fan loses the card at the correct visual
   * moment). The asker's card count is held at its pre-ask value so it doesn't
   * jump before the return card lands.
   *
   * Does NOT advance the event queue — consumeEvent() handles that when the
   * return card finishes traveling.
   *
   * @param askerId        Player whose count should be held at the old value.
   * @param askerOldCount  The asker's card count before the ask resolved.
   */
  commitAskArrival(askerId: string, askerOldCount: number): void {
    const head = this.eventQueue[0];
    if (!head) return;
    // Build intermediate snapshot: full new state but with asker's OLD count.
    const intermediate: RoomSnapshot = {
      ...head.snapshot,
      players: head.snapshot.players.map((p) =>
        p.id === askerId ? { ...p, cardCount: askerOldCount } : p,
      ),
    };
    this.visibleRoom$ = intermediate;

    // Flush the pending hand NOW — bubble arrived = card visually left the target.
    // Set headHandApplied so consumeEvent() knows to skip the hand flush.
    if (head.pendingHand !== null) {
      this.hand = head.pendingHand;
      this.headHandApplied = true;
    }
  }

  // Sidebar is now the primary UI (no toggle needed)

  // ── Lifecycle ────────────────────────────────────────────

  // ── Session persistence ──────────────────────────────────

  private saveSession(): void {
    try {
      const s: StoredSession = {
        roomCode: this.roomCode,
        playerId: this.playerId,
        reconnectToken: this.reconnectToken,
        name: this._pendingName,
        avatar: this._pendingAvatar,
        character: this._pendingCharacter,
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(s));
    } catch { /* storage unavailable */ }
  }

  private clearSession(): void {
    try { localStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
  }

  private storedSession(): StoredSession | null {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      return raw ? (JSON.parse(raw) as StoredSession) : null;
    } catch {
      return null; // corrupt data / storage unavailable
    }
  }

  /** The seat this tab holds right now (independent of other tabs). */
  private currentSession(): StoredSession {
    return {
      roomCode: this.roomCode,
      playerId: this.playerId,
      reconnectToken: this.reconnectToken,
      name: this._pendingName,
      avatar: this._pendingAvatar,
      character: this._pendingCharacter,
    };
  }

  /** Silently rejoin a seat: on app mount from the saved session, or after
   *  a drop from this tab's own seat (`session`), so one tab never grabs a
   *  seat that another tab saved. `retryForMs` > 0 keeps retrying transient
   *  failures (with backoff) for that long — the server's seat-hold window. */
  async tryAutoReconnect(retryForMs = 0, session?: StoredSession): Promise<void> {
    const s = session ?? this.storedSession();
    if (!s?.roomCode || !s?.playerId || !s?.name) return;

    const gen = ++this.rejoinGen;
    const deadline = Date.now() + retryForMs;
    this._pendingName = s.name;
    this._pendingAvatar = s.avatar;
    this._pendingCharacter = s.character;
    this.status = "connecting";
    let serverSaidNo = false;
    for (let delay = 1000; ; delay = Math.min(delay * 2, 15000)) {
      try {
        const room = await this.client.joinById<unknown>(s.roomCode, {
          name: s.name,
          avatar: s.avatar,
          character: s.character,
          playerId: s.playerId,
          reconnectToken: s.reconnectToken,
        } satisfies JoinOptions);
        // User moved on meanwhile: drop it as a *disconnect* (not a leave),
        // so the server keeps the seat and its secret for the grace window.
        if (gen !== this.rejoinGen) { room.leave(false); return; }
        this.inGame = true;
        this.bindRoom(room);
        return;
      } catch (err) {
        if (gen !== this.rejoinGen) return;
        // Give up only on a definite refusal: our onJoin said no (4216) or
        // the room is gone (4212). HTTP 5xx/429, socket closes and expired
        // seat reservations are transient — keep backing off.
        const code = (err as { code?: unknown })?.code;
        serverSaidNo = code === 4216 || code === 4212;
        if (serverSaidNo || Date.now() + delay > deadline) break;
        await new Promise((r) => setTimeout(r, delay));
        if (gen !== this.rejoinGen) return;
      }
    }
    // Only forget the seat if the server refused it, and only if it's still
    // the one we tried (another tab may have saved a different seat since).
    if (serverSaidNo && this.storedSession()?.playerId === s.playerId) this.clearSession();
    this.inGame = false;
    this.status = "idle";
  }

  // ── Lifecycle ────────────────────────────────────────────

  async createRoom(name: string, avatar: string, character = ""): Promise<void> {
    if (!name.trim()) {
      this.errorBanner = "Enter a name to host.";
      return;
    }
    const gen = ++this.rejoinGen;
    this._pendingName = name.trim();
    this._pendingAvatar = avatar;
    this._pendingCharacter = character;
    this.errorBanner = "";
    this.status = "connecting";
    try {
      const room = await this.client.create<unknown>("literature", {
        name: name.trim(),
        avatar,
        character,
      } satisfies JoinOptions);
      if (gen !== this.rejoinGen) { room.leave(true); return; } // superseded (e.g. double click)
      this.bindRoom(room);
    } catch (err) {
      this.status = "error";
      this.errorBanner = errorMessage(err);
    }
  }

  async joinRoom(code: string, name: string, avatar: string, character = ""): Promise<void> {
    const trimmedName = name.trim();
    const normCode = code.trim().toUpperCase().replace(/\s+/g, "");
    if (!trimmedName) {
      this.errorBanner = "Enter a name to join.";
      return;
    }
    if (!normCode) {
      this.errorBanner = "Enter a room code.";
      return;
    }
    // Re-entering the code of the game we hold a seat in = rejoin that seat
    // (a plain join is refused mid-game), with the usual retry/backoff.
    const saved = this.storedSession();
    if (saved?.roomCode === normCode && saved.reconnectToken) {
      this.errorBanner = "";
      return this.tryAutoReconnect(5 * 60_000, saved);
    }
    const gen = ++this.rejoinGen;
    this._pendingName = trimmedName;
    this._pendingAvatar = avatar;
    this._pendingCharacter = character;
    this.errorBanner = "";
    this.status = "connecting";
    try {
      const room = await this.client.joinById<unknown>(normCode, {
        name: trimmedName,
        avatar,
        character,
      } satisfies JoinOptions);
      if (gen !== this.rejoinGen) { room.leave(true); return; } // superseded
      this.bindRoom(room);
    } catch (err) {
      this.status = "error";
      this.errorBanner = errorMessage(err);
    }
  }

  leave(): void {
    this.rejoinGen++;
    this.inGame = false;
    this.clearSession();
    this.room?.leave(true);
    this.room = null;
    this.room$ = null;
    this.visibleRoom$ = null;
    this.eventQueue = [];
    this.queueBusy = false;
    this.hand = [];
    this.pendingHand = null;
    this.headHandApplied = false;
    this.playerId = "";
    this.roomCode = "";
    this.status = "idle";
    this.view = "landing";
    this.errorBanner = "";
  }

  // ── Commands ─────────────────────────────────────────────

  ask(cmd: AskCommand): void {
    this.room?.send("ask", cmd);
  }
  declare(cmd: DeclareCommand): void {
    this.room?.send("declare", cmd);
  }
  pass(toPlayerId?: string): void {
    this.room?.send("pass", { toPlayerId });
  }
  startGame(): void {
    this.room?.send("start_game", {});
  }
  addBot(): void {
    this.room?.send("add_bot", {});
  }
  removeBots(): void {
    this.room?.send("remove_bots", {});
  }
  shuffleTeams(): void {
    this.room?.send("shuffle_teams", {});
  }
  resetGame(): void {
    this.room?.send("reset_game", {});
  }
  setBotDifficulty(difficulty: BotDifficulty): void {
    this.room?.send("set_bot_difficulty", { difficulty });
  }
  setRoomConfig(cfg: SetRoomConfigCommand): void {
    this.room?.send("set_room_config", cfg);
  }
  movePlayer(cmd: MovePlayerCommand): void {
    this.room?.send("move_player", cmd);
  }

  // ── Derived helpers ──────────────────────────────────────

  get me(): PlayerSnapshot | null {
    if (!this.room$ || !this.playerId) return null;
    return this.room$.players.find((p) => p.id === this.playerId) ?? null;
  }

  get isMyTurn(): boolean {
    return !!this.room$ && this.room$.turnId === this.playerId;
  }

  get isHost(): boolean {
    return !!this.me?.isHost;
  }

  inviteUrl(): string {
    if (!this.roomCode) return "";
    if (typeof window === "undefined") return "";
    const url = new URL(window.location.href);
    url.searchParams.set("room", this.roomCode);
    return url.toString();
  }

  // ── Toast ────────────────────────────────────────────────

  toast(text: string, kind: Toast["kind"] = "info", durationMs = 3500): void {
    const id = ++this.toastSeq;
    this.toasts = [...this.toasts, { id, text, kind }];
    setTimeout(() => {
      this.toasts = this.toasts.filter((t) => t.id !== id);
    }, durationMs);
  }

  // ── Internal: Colyseus binding ───────────────────────────

  private bindRoom(room: Room<unknown>): void {
    this.room = room;

    // Every handler ignores rooms we've since left or replaced, so a stale or
    // duplicate room can never drive the UI or overwrite the saved session.
    room.onStateChange((state) => {
      if (this.room !== room) return;
      const next = snapshotRoom(state);
      this.room$ = next;
      // Keep view in sync with room status.
      const status = (state as { status: GameStatus }).status;
      this.view = status === "lobby" ? "lobby" : "game";
      this.inGame = status === "playing";

      // Classify what animation (if any) this transition requires, using the
      // last snapshot that is currently visible or queued as the "previous" state.
      const lastQueued = this.eventQueue[this.eventQueue.length - 1];
      const prev = lastQueued?.snapshot ?? this.visibleRoom$;
      const kind = classifyEvent(prev, next);

      if (kind === "none" && this.eventQueue.length === 0) {
        // Fast path: nothing animating, nothing queued — advance immediately.
        // Also flush any pending hand so card counts and hand fan stay in sync.
        if (this.pendingHand !== null) {
          this.hand = this.pendingHand;
          this.pendingHand = null;
        }
        this.visibleRoom$ = next;
      } else {
        // Capture pendingHand into the event so each event carries exactly the
        // hand update that belongs to it. This prevents a hand message from one
        // ask leaking into a later event's consumeEvent() call.
        const capturedHand = this.pendingHand;
        this.pendingHand = null;
        this.eventQueue = [...this.eventQueue, { kind, snapshot: next, pendingHand: capturedHand }];
        this.queueBusy = true;
      }
    });

    room.onMessage("welcome", (msg: WelcomeMessage) => {
      if (this.room !== room) return;
      this.playerId = msg.playerId;
      this.roomCode = msg.roomCode;
      this.reconnectToken = msg.reconnectToken;
      this.status = "connected";
      this.applyNextHandNow = true;
      this.saveSession();
    });

    room.onMessage("hand", (msg: { hand: Card[] }) => {
      if (this.room !== room) return;
      // The hand right after "welcome" (a join or rejoin) shows at once: the
      // full state already arrived and no patch may follow to flush it.
      if (this.applyNextHandNow && this.eventQueue.length === 0) {
        this.applyNextHandNow = false;
        this.hand = msg.hand;
        this.pendingHand = null;
        return;
      }
      // Otherwise stage it. The server sends "hand" messages before
      // broadcasting the schema state change (Colyseus flushes schema patches
      // at the end of the request cycle, after explicit client.send() calls).
      // Staging here ensures the hand fan and card counts advance together
      // when consumeEvent() or the fast-path flush fires — never before.
      this.pendingHand = msg.hand;
    });

    room.onMessage("error", (msg: { message: string }) => {
      if (this.room !== room) return;
      this.toast(msg.message, "error");
    });

    room.onLeave((code) => {
      if (this.room !== room) return; // stale room (we already left/rebound)
      if (this.room$?.status === "ended") this.clearSession();
      // 4000 = we left on purpose. 4001 = this seat was opened in another
      // tab/device, which now owns it: rejoining would just steal it back.
      // Anything else mid-game is a network drop: a bot holds the seat, so
      // quietly rejoin it — with this tab's own seat, not whatever another
      // tab saved to localStorage.
      const replaced = code === 4001;
      const rejoin = code !== 4000 && !replaced && this.inGame;
      const mySeat = this.currentSession();
      this.toast(
        replaced ? "This game was opened in another tab." :
        rejoin ? "Connection lost — rejoining…" : "Disconnected from room.",
        "warn",
      );
      this.room = null;
      this.room$ = null;
      this.visibleRoom$ = null;
      this.eventQueue = [];
      this.queueBusy = false;
      this.hand = [];
      this.pendingHand = null;
      this.headHandApplied = false;
      this.status = "idle";
      this.view = "landing";
      if (rejoin) void this.tryAutoReconnect(5 * 60_000, mySeat); // server holds the seat 5 min
      else this.inGame = false;
    });

    room.onError((_code, message) => {
      this.toast(message ?? "Connection error.", "error");
    });
  }
}

// ── Snapshot helper ──────────────────────────────────────────

function snapshotRoom(state: unknown): RoomSnapshot {
  // The Colyseus state is a Schema instance; we duck-type rather than import
  // the server's class to avoid a circular package dep at type level.
  const s = state as {
    code: string;
    status: GameStatus;
    hostId: string;
    turnId: string;
    postDeclareId?: string;
    players: { forEach: (cb: (v: PlayerSnapshot, k: string) => void) => void };
    claimedA: SetKey[];
    claimedB: SetKey[];
    scoreA: number;
    scoreB: number;
    winnerTeam: "" | "A" | "B";
    actions: string[];
    lastAsk: LastAskSnapshot;
    pendingBotAsk?: PendingBotAskSnapshot;
    lastDeclare?: {
      declarerId: string;
      setKey: SetKey;
      winningTeam: "" | "A" | "B";
      success: boolean;
      sources: { forEach(cb: (value: string, key: string) => void): void };
      assignments: { forEach(cb: (value: string, key: string) => void): void };
      at: number;
    };
    botDifficulty: BotDifficulty;
    notesEnabled?: boolean;
    defaultLogCount?: number;
  };

  const players: PlayerSnapshot[] = [];
  s.players.forEach((p) => {
    players.push({
      id: p.id,
      name: p.name,
      avatar: p.avatar,
      character: typeof (p as { character?: string }).character === "string"
        ? (p as { character: string }).character
        : "",
      team: p.team,
      isBot: p.isBot,
      isHost: p.isHost,
      connected: p.connected,
      cardCount: p.cardCount,
    });
  });

  return {
    code: s.code,
    status: s.status,
    hostId: s.hostId,
    turnId: s.turnId,
    postDeclareId: s.postDeclareId ?? "",
    players,
    claimedA: [...s.claimedA],
    claimedB: [...s.claimedB],
    scoreA: s.scoreA,
    scoreB: s.scoreB,
    winnerTeam: s.winnerTeam,
    actions: [...s.actions],
    lastAsk: { ...s.lastAsk },
    pendingBotAsk:
      s.pendingBotAsk && s.pendingBotAsk.askerId
        ? {
            askerId: s.pendingBotAsk.askerId,
            targetId: s.pendingBotAsk.targetId,
            card: s.pendingBotAsk.card,
          }
        : null,
    lastDeclare: snapshotLastDeclare(s.lastDeclare),
    botDifficulty: s.botDifficulty,
    notesEnabled: !!s.notesEnabled,
    defaultLogCount: typeof s.defaultLogCount === "number" ? s.defaultLogCount : 5,
  };
}

function snapshotLastDeclare(
  src: { declarerId?: string; setKey?: string; at?: number } | undefined,
): LastDeclareSnapshot | null {
  if (!src || !src.setKey) return null;
  const raw = src as unknown as {
    sources?: { forEach(cb: (v: string, k: string) => void): void };
    assignments?: { forEach(cb: (v: string, k: string) => void): void };
  };
  const sources: Record<Card, string> = {};
  if (raw.sources && typeof raw.sources.forEach === "function") {
    raw.sources.forEach((holderId: string, card: string) => {
      sources[card] = holderId;
    });
  }
  const assignments: Record<Card, string> = {};
  if (raw.assignments && typeof raw.assignments.forEach === "function") {
    raw.assignments.forEach((holderId: string, card: string) => {
      assignments[card] = holderId;
    });
  }
  return {
    declarerId: (src as { declarerId: string }).declarerId,
    setKey: (src as { setKey: SetKey }).setKey,
    winningTeam: (src as { winningTeam: "" | "A" | "B" }).winningTeam,
    success: (src as { success: boolean }).success,
    sources,
    assignments,
    at: (src as { at: number }).at,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  return "Connection failed.";
}

export const game = new GameClient();
export { AVATAR_COLORS };
