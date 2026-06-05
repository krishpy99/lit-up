<script lang="ts">
  import { fly, fade } from "svelte/transition";
  import {
    CARD_TO_SET,
    cardShort,
    SET_DEFS,
    SET_LOOKUP,
    type Card,
    type SetKey,
  } from "@lit-up/shared";
  import { game } from "../lib/client.svelte";
  import type { PlayerSnapshot, RoomSnapshot } from "../lib/client.svelte";

  interface Props {
    room: RoomSnapshot;
    you: PlayerSnapshot;
    hand: Card[];
    onClose: () => void;
  }

  let { room, you, hand, onClose }: Props = $props();

  let claimed = $derived(new Set<SetKey>([...room.claimedA, ...room.claimedB]));
  let availableSets = $derived(
    SET_DEFS.filter(
      (s) => !claimed.has(s.key) && hand.some((c) => CARD_TO_SET.get(c) === s.key),
    ),
  );
  let teammates = $derived(room.players.filter((p) => p.team === you.team));

  let selectedSet = $state<SetKey>("");
  let assignments = $state<Record<Card, string>>({});

  $effect(() => {
    if (availableSets.length === 0) {
      selectedSet = "";
      return;
    }
    if (!availableSets.some((s) => s.key === selectedSet)) {
      selectedSet = availableSets[0].key;
    }
  });

  $effect(() => {
    if (!selectedSet) {
      assignments = {};
      return;
    }
    const next: Record<Card, string> = {};
    for (const card of SET_LOOKUP[selectedSet].cards) {
      next[card] = hand.includes(card) ? game.playerId : "";
    }
    assignments = next;
  });

  function declare() {
    if (!selectedSet) return;
    const set = SET_LOOKUP[selectedSet];
    if (set.cards.some((c) => !assignments[c])) {
      game.toast("Assign all 6 cards before declaring.", "warn");
      return;
    }
    game.declare({ setKey: selectedSet, assignments: { ...assignments } });
    onClose();
  }

  let canDeclare = $derived(
    room.status === "playing" &&
      room.turnId === game.playerId &&
      availableSets.length > 0,
  );

  function playerLabel(p: PlayerSnapshot): string {
    return p.id === game.playerId ? "You" : p.name;
  }
</script>

<div class="modal-backdrop" onclick={onClose} role="presentation" transition:fade={{ duration: 180 }}></div>

<div class="declare-modal" role="dialog" aria-modal="true" aria-label="Declare a set" transition:fly={{ y: 24, duration: 240 }}>
  <header class="modal-header">
    <div>
      <div class="modal-title">Declare a set</div>
      <div class="modal-sub">Pick who holds each card in the set.</div>
    </div>
    <button class="modal-close" aria-label="Close" onclick={onClose}>×</button>
  </header>

  {#if availableSets.length === 0}
    <p class="muted">No declarable sets in your hand.</p>
    <button class="btn btn-ghost" onclick={onClose}>Close</button>
  {:else}
    <div class="field">
      <span class="field-label">Set</span>
      <select class="input" bind:value={selectedSet}>
        {#each availableSets as s (s.key)}
          <option value={s.key}>{s.label}</option>
        {/each}
      </select>
    </div>

    {#if selectedSet}
      <div class="assign-grid" style="--player-count: {teammates.length}">
        <!-- Header row: player name labels -->
        <div class="grid-spacer"></div>
        {#each teammates as t (t.id)}
          <div class="player-col-label" class:is-you={t.id === game.playerId}>
            {playerLabel(t)}
          </div>
        {/each}

        <!-- One row per card -->
        {#each SET_LOOKUP[selectedSet].cards as card (card)}
          {@const info = cardShort(card)}
          {@const isMyCard = hand.includes(card)}
          <span class="card-chip {info.red ? 'red' : 'black'}">
            {info.rank}{info.symbol}
          </span>
          {#each teammates as t (t.id)}
            {@const selected = assignments[card] === t.id}
            <button
              class="player-cell"
              class:selected
              class:is-you={t.id === game.playerId}
              class:locked={isMyCard && t.id === game.playerId}
              disabled={isMyCard && t.id !== game.playerId}
              onclick={() => { assignments[card] = t.id; }}
              aria-label="{info.rank}{info.symbol} → {playerLabel(t)}"
              aria-pressed={selected}
            >
              {#if selected}
                <span class="check-mark">✓</span>
              {/if}
            </button>
          {/each}
        {/each}
      </div>

      <div class="modal-actions">
        <button class="btn btn-ghost" onclick={onClose}>Cancel</button>
        <button class="btn btn-gold" onclick={declare} disabled={!canDeclare}>Declare</button>
      </div>
    {/if}
  {/if}
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.55);
    backdrop-filter: blur(4px);
    z-index: 380;
  }
  .declare-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 390;
    width: min(480px, calc(100vw - 24px));
    max-height: calc(100vh - 60px);
    overflow-y: auto;
    background: rgba(10, 22, 14, 0.97);
    border: 1px solid var(--panel-border);
    border-radius: 16px;
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(251, 191, 36, 0.18);
    padding: 22px;
    backdrop-filter: blur(20px);
  }
  .modal-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 16px;
  }
  .modal-title {
    font-size: 1.08rem;
    font-weight: 800;
    color: var(--gold);
  }
  .modal-sub {
    font-size: 0.82rem;
    color: var(--muted);
    margin-top: 2px;
  }
  .modal-close {
    color: var(--muted);
    font-size: 1.6rem;
    line-height: 1;
    width: 32px;
    height: 32px;
    border-radius: 8px;
  }
  .modal-close:hover { background: rgba(255, 255, 255, 0.08); color: var(--text); }

  /* Assignment grid: first col = card chip, remaining cols = one per player */
  .assign-grid {
    display: grid;
    /* first col for the card chip, rest auto-sized equally for players */
    grid-template-columns: auto repeat(var(--player-count, 3), 1fr);
    gap: 5px 6px;
    margin: 12px 0;
    align-items: center;
  }

  .grid-spacer { /* empty top-left corner cell */ }

  .player-col-label {
    text-align: center;
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--muted);
    padding-bottom: 2px;
  }
  .player-col-label.is-you {
    color: var(--accent);
  }

  .card-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 46px;
    padding: 5px 7px;
    border-radius: 6px;
    background: var(--card-bg);
    font-weight: 800;
    font-size: 0.88rem;
    white-space: nowrap;
  }
  .card-chip.red  { color: var(--card-red); }
  .card-chip.black { color: var(--card-black); }

  .player-cell {
    height: 34px;
    border-radius: 7px;
    border: 1.5px solid var(--panel-border);
    background: rgba(255, 255, 255, 0.03);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition:
      background 0.14s var(--ease-out),
      border-color 0.14s var(--ease-out),
      transform 0.12s var(--ease-spring);
    font-size: 0.9rem;
  }
  .player-cell:not(:disabled):hover {
    background: rgba(255, 255, 255, 0.08);
    border-color: rgba(255, 255, 255, 0.22);
    transform: scale(1.06);
  }
  .player-cell.selected {
    background: rgba(52, 211, 153, 0.16);
    border-color: var(--accent);
  }
  .player-cell.selected.is-you {
    background: rgba(52, 211, 153, 0.22);
  }
  /* The current player's own card: pre-selected and visually locked */
  .player-cell.locked {
    background: rgba(52, 211, 153, 0.22);
    border-color: var(--accent);
    cursor: default;
  }
  .player-cell:disabled:not(.locked) {
    opacity: 0.2;
    cursor: not-allowed;
    transform: none;
  }

  .check-mark {
    color: var(--accent);
    font-weight: 800;
    font-size: 0.85rem;
    line-height: 1;
    pointer-events: none;
  }
  .player-cell.locked .check-mark {
    opacity: 0.9;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 12px;
  }
</style>
