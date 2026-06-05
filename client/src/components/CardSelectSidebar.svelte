<script lang="ts">
  import { fly } from "svelte/transition";
  import {
    cardLabel,
    cardShort,
    CARD_TO_SET,
    SET_DEFS,
    SET_LOOKUP,
    type Card,
    type SetKey,
  } from "@lit-up/shared";
  import { game } from "../lib/client.svelte";
  import { sound } from "../lib/sounds.svelte";
  import type { PlayerSnapshot, RoomSnapshot } from "../lib/client.svelte";
  import Avatar from "./Avatar.svelte";

  interface Props {
    target: PlayerSnapshot | null;
    room: RoomSnapshot;
    hand: Card[];
    onClose: () => void;
  }

  let { target, room, hand, onClose }: Props = $props();

  let claimed = $derived(new Set<SetKey>([...room.claimedA, ...room.claimedB]));

  interface AskableBySet {
    setKey: SetKey;
    setLabel: string;
    cards: Card[];
  }

  let askableSets = $derived.by(() => {
    if (!target) return [];
    const result: AskableBySet[] = [];
    for (const set of SET_DEFS) {
      if (claimed.has(set.key)) continue;
      if (!hand.some((c) => CARD_TO_SET.get(c) === set.key)) continue;
      const cards = set.cards.filter((c) => !hand.includes(c));
      if (cards.length > 0) {
        result.push({ setKey: set.key, setLabel: set.label, cards });
      }
    }
    return result;
  });

  function clickCard(card: Card) {
    sound.play("ask");
    game.ask({ toPlayerId: target!.id, card });
    // Don't close sidebar - keep it open for next ask
  }

  function passToTeammate() {
    if (!target) return;
    game.pass(target.id);
    // Keep sidebar open for potential pass to other teammate
  }
</script>

<div class="sidebar" class:open={target} transition:fly={{ x: 300, duration: 250 }}>
  {#if target}
    <div class="sidebar-header">
      <div class="target-info">
        <Avatar
          name={target.name}
          avatar={target.avatar}
          character={target.character}
          team={target.team}
          size={40}
        />
        <div class="target-details">
          <div class="target-name">Ask {target.name}</div>
          <div class="target-sub">{target.cardCount} card{target.cardCount === 1 ? "" : "s"}</div>
        </div>
      </div>
      <button type="button" class="sidebar-close" aria-label="Close" onclick={onClose}>×</button>
    </div>

    <div class="sidebar-section">
      <h3 class="section-title">Select Card</h3>
      <div class="cards-section">
        {#if askableSets.length === 0}
          <p class="empty-state">No cards available to ask for.</p>
        {:else}
          {#each askableSets as { setLabel, cards } (setLabel)}
            <div class="set-row">
              <div class="set-label">{setLabel}</div>
              <div class="cards-list">
                {#each cards as card (card)}
                  {@const info = cardShort(card)}
                  <button
                    type="button"
                    class="card-btn {info.red ? 'red' : 'black'}"
                    title={cardLabel(card)}
                    onclick={() => clickCard(card)}
                  >
                    <div class="card-rank">{info.rank}</div>
                    <div class="card-suit">{info.symbol}</div>
                  </button>
                {/each}
              </div>
            </div>
          {/each}
        {/if}
      </div>
    </div>

    <div class="sidebar-section logs-section">
      <h3 class="section-title">Recent Activity</h3>
      <div class="logs-list">
        {#each room.actions.slice(0, 8) as action, i (i + ":" + action)}
          <div class="log-entry">{action}</div>
        {/each}
      </div>
    </div>

  {/if}
</div>

<div class="sidebar-backdrop" class:open={target} onclick={onClose} />

<style>
  .sidebar {
    position: fixed;
    right: -380px;
    top: var(--header-h);
    width: 380px;
    height: calc(100vh - var(--header-h));
    background: rgba(8, 18, 12, 0.98);
    border-left: 1px solid var(--panel-border);
    backdrop-filter: blur(16px);
    z-index: 340;
    transition: right 0.3s var(--ease-spring);
    display: flex;
    flex-direction: column;
  }

  .sidebar.open {
    right: 0;
  }

  .sidebar-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0);
    z-index: 330;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.25s;
  }

  .sidebar-backdrop.open {
    background: rgba(0, 0, 0, 0.32);
    pointer-events: auto;
    opacity: 1;
  }

  .sidebar-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 16px;
    border-bottom: 1px solid var(--panel-border);
    flex-shrink: 0;
  }

  .target-info {
    display: flex;
    align-items: center;
    gap: 12px;
    flex: 1;
    min-width: 0;
  }

  .target-details {
    min-width: 0;
    flex: 1;
  }

  .target-name {
    font-weight: 700;
    font-size: 0.95rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .target-sub {
    font-size: 0.75rem;
    color: var(--muted);
  }

  .sidebar-close {
    color: var(--muted);
    font-size: 1.8rem;
    line-height: 1;
    width: 36px;
    height: 36px;
    border-radius: 8px;
    flex-shrink: 0;
    transition: background 0.15s, color 0.15s;
  }

  .sidebar-close:hover {
    background: rgba(255, 255, 255, 0.08);
    color: var(--text);
  }

  .sidebar-section {
    display: flex;
    flex-direction: column;
    gap: 12px;
    padding: 16px;
    overflow-y: auto;
    flex: 1;
    min-height: 0;
  }

  .sidebar-section.logs-section {
    border-top: 1px solid var(--panel-border);
    flex: 0.6;
  }

  .section-title {
    font-size: 0.75rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--muted);
    margin: 0;
    padding: 0;
  }

  .cards-section {
    display: flex;
    flex-direction: column;
    gap: 12px;
  }

  .set-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .set-label {
    font-size: 0.7rem;
    font-weight: 600;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .cards-list {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }

  .card-btn {
    box-sizing: border-box;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    width: 60px;
    height: 80px;
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.06);
    border: 1.5px solid var(--panel-border);
    color: var(--text);
    font-size: 1rem;
    font-weight: 700;
    transition: transform 0.12s var(--ease-out), background 0.12s, border-color 0.12s;
    cursor: pointer;
  }

  .card-btn:hover {
    background: rgba(52, 211, 153, 0.15);
    border-color: var(--accent);
    transform: translateY(-3px);
  }

  .card-btn:active {
    transform: translateY(-1px);
  }

  .card-btn.red {
    color: var(--card-red);
  }

  .card-rank {
    font-weight: 700;
    line-height: 1;
  }

  .card-suit {
    font-size: 1.4em;
    line-height: 1;
  }

  .logs-list {
    display: flex;
    flex-direction: column;
    gap: 6px;
    overflow-y: auto;
    padding-right: 4px;
  }

  .log-entry {
    font-size: 0.75rem;
    color: var(--muted);
    line-height: 1.3;
    padding: 4px 6px;
    border-left: 2px solid var(--accent);
    padding-left: 10px;
  }

  .empty-state {
    font-size: 0.78rem;
    color: var(--muted);
    font-style: italic;
    margin: 0;
  }

  .sidebar-footer {
    padding: 12px 16px;
    border-top: 1px solid var(--panel-border);
    flex-shrink: 0;
  }

  .pass-btn {
    width: 100%;
    padding: 10px 16px;
    border-radius: 8px;
    background: linear-gradient(135deg, rgba(52, 211, 153, 0.2) 0%, rgba(59, 130, 246, 0.2) 100%);
    border: 1.5px solid var(--accent);
    color: var(--accent);
    font-size: 0.9rem;
    font-weight: 600;
    transition: all 0.15s var(--ease-out);
    cursor: pointer;
  }

  .pass-btn:hover {
    background: linear-gradient(135deg, rgba(52, 211, 153, 0.3) 0%, rgba(59, 130, 246, 0.3) 100%);
    transform: translateY(-2px);
    box-shadow: 0 4px 12px rgba(52, 211, 153, 0.2);
  }

  .pass-btn:active {
    transform: translateY(-1px);
  }
</style>
