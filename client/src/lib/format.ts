/**
 * Formatting helpers shared by views and components.
 */

import { cardLabel, cardShort, SET_LOOKUP, type Card, type SetKey } from "@lit-up/shared";

export function setLabel(key: SetKey): string {
  return SET_LOOKUP[key]?.label ?? key;
}

export function classifyAction(text: string): string {
  if (text.includes("✓")) return "txn-success";
  if (text.includes("✗")) return "txn-fail";
  if (text.includes("declared") || text.includes("missed declaring") || text.includes("wins")) return "txn-declare";
  if (text.includes("passed")) return "txn-pass";
  return "txn-info";
}

export function cardChip(card: Card): { rank: string; symbol: string; red: boolean } {
  return cardShort(card);
}

/**
 * Returns true if the action log text mentions any card that belongs to the
 * given set. Used by FloatingLog to filter entries by half-suit.
 */
export function actionBelongsToSet(text: string, setKey: SetKey): boolean {
  const set = SET_LOOKUP[setKey];
  if (!set) return false;
  return set.cards.some((c) => text.includes(cardLabel(c)));
}
