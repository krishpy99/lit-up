/**
 * Wire protocol shared between client and server.
 *
 * The Colyseus room schema is the source of truth for *public* state — it auto-syncs
 * to all clients. These types describe the *commands* clients send and the *private*
 * messages the server pushes back to individual clients.
 */

import type { Card, SetKey } from "./cards.js";

// ── Bot difficulty ─────────────────────────────────────────
export type BotDifficulty = "easy" | "medium" | "hard";

// ── Commands (client → server) ─────────────────────────────
// Sent as Colyseus messages: room.send("ask", { ... }), etc.

export interface AskCommand {
  toPlayerId: string;
  card: Card;
}

export interface DeclareCommand {
  setKey: SetKey;
  /** Card → playerId in the declarer's team */
  assignments: Record<Card, string>;
}

export interface PassCommand {
  toPlayerId?: string;
}

export interface AddBotCommand {
  /* host only */
}

export interface SetBotDifficultyCommand {
  difficulty: BotDifficulty;
}

export interface SetRoomConfigCommand {
  notesEnabled?: boolean;
  /** 0 = "all" (capped); otherwise positive integer. */
  defaultLogCount?: number;
}

export const LOG_COUNT_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 3, label: "3" },
  { value: 5, label: "5" },
  { value: 10, label: "10" },
  { value: 0, label: "All" },
];

// ── Private messages (server → one client) ─────────────────

/** Sent to a player after every state change that affects their hand. */
export interface HandMessage {
  hand: Card[];
}

/** Sent when a player joins, with metadata about their session. */
export interface WelcomeMessage {
  playerId: string;
  roomCode: string;
}

/** Recoverable error — surfaces as a toast. */
export interface ErrorMessage {
  message: string;
}

// ── Lobby join options (Colyseus joinOptions) ──────────────

export interface JoinOptions {
  name: string;
  avatar: string;
  /** Emoji or single-character glyph to render inside the avatar. */
  character?: string;
  /** When set, attempts to reconnect to an existing player slot. */
  reconnectToken?: string;
}

// ── Game status enum ───────────────────────────────────────

export type GameStatus = "lobby" | "playing" | "ended";

// ── Avatar palette (shared so server can pick bot colors) ──

export const AVATAR_COLORS = [
  "#ef4444", "#f97316", "#eab308", "#22c55e",
  "#06b6d4", "#3b82f6", "#8b5cf6", "#ec4899",
] as const;

/**
 * Curated grid of emoji characters players can pick to fill their avatar.
 * Empty string is the implicit "use my initial" default. Kept compact so
 * the picker stays visually scannable on mobile.
 */
export const AVATAR_CHARACTERS = [
  "🦊", "🐱", "🐺", "🦁", "🐉", "🦅",
  "🐸", "🐢", "🐙", "🦑", "🦄", "🐝",
  "🤠", "🎩", "👽", "🤖", "🧙", "🦸",
  "🍕", "🌮", "🍣", "🍩", "☕", "🍷",
  "⭐", "🌙", "🔥", "🌈", "⚡", "💎",
] as const;

/**
 * Illustrated human-style avatars rendered via the DiceBear "avataaars"
 * style. Stored as `art:<seed>`; the seed is opaque on the server but
 * deterministic on the client (DiceBear renders a unique avatar per seed).
 *
 * Why DiceBear and why over HTTP? The library would add ~150 KB to the
 * bundle and can't easily be swapped for new styles without a rebuild.
 * The HTTP API is free, the SVGs are aggressively cacheable, and the
 * fallback when the network is down is the emoji set above.
 */
export const AVATAR_ILLUSTRATIONS = [
  "art:alex",   "art:blake",  "art:casey",
  "art:drew",   "art:ellis",  "art:finn",
  "art:gray",   "art:harper", "art:indigo",
  "art:jamie",  "art:kai",    "art:lane",
] as const;

/** DiceBear style + URL builder. Kept central so server and client agree. */
export const ILLUSTRATION_STYLE = "avataaars";

export function illustrationUrl(seed: string): string {
  // `seed` is everything after `art:`. Render with a transparent
  // background so our colored ring around the avatar shows through.
  return `https://api.dicebear.com/9.x/${ILLUSTRATION_STYLE}/svg?seed=${encodeURIComponent(seed)}&backgroundType=solid&backgroundColor=transparent`;
}

export function isIllustration(character: string): boolean {
  return character.startsWith("art:");
}

export const MIN_PLAYERS = 4;
export const MAX_PLAYERS = 10;
export const SETS_TO_WIN = 5;
export const PENDING_BOT_ASK_MS = 0; // no longer used — ask fires immediately after think
export const BOT_THINK_MS = 2200;  // 2.2 s silent think before executing
/** Delay between resolving a bot action and scheduling the next bot think.
 *  Must be >= the longest ask animation (~7.85 s for a successful ask). */
export const POST_BOT_ACTION_DELAY_MS = 8000;
