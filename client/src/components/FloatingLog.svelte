<script lang="ts">
  import { fly, fade } from "svelte/transition";
  import { cardShort, SUITS, SUIT_SYMBOL, SUIT_COLOR, type Suit, type SetKey } from "@lit-up/shared";
  import { classifyAction, actionBelongsToSet } from "../lib/format";
  import type { RoomSnapshot } from "../lib/client.svelte";

  interface Props {
    room: RoomSnapshot;
    /** Pixels from right edge. Increase when sidebar is open. */
    rightOffset?: number;
  }

  let { room, rightOffset = 18 }: Props = $props();

  let open = $state(false);
  let unread = $state(0);
  let prevTopAction = $state<string | undefined>();

  // Level-1 selection: a suit key, "joker", or null (= All)
  let selectedSuit = $state<Suit | "joker" | null>(null);
  // Level-2 selection: "low", "high", or null (= both halves of the suit)
  let selectedHalf = $state<"low" | "high" | null>(null);

  // Derived active SetKey(s) for filtering
  let activeSetKeys = $derived.by((): SetKey[] => {
    if (selectedSuit === null) return [];
    if (selectedSuit === "joker") return ["eights_jokers"];
    if (selectedHalf === "low") return [`${SUITS.find(s => s.key === selectedSuit)!.name.toLowerCase()}_low`];
    if (selectedHalf === "high") return [`${SUITS.find(s => s.key === selectedSuit)!.name.toLowerCase()}_high`];
    // Suit selected but no half yet — show both halves
    const name = SUITS.find(s => s.key === selectedSuit)!.name.toLowerCase();
    return [`${name}_low`, `${name}_high`];
  });

  function selectSuit(suit: Suit | "joker") {
    if (selectedSuit === suit) {
      // Deselect
      selectedSuit = null;
      selectedHalf = null;
    } else {
      selectedSuit = suit;
      selectedHalf = null;
      // Joker has no sub-set, filter applies immediately
    }
  }

  function selectHalf(half: "low" | "high") {
    selectedHalf = selectedHalf === half ? null : half;
  }

  // 0 = show all. Apply set filter first so the count limit isn't consumed
  // by entries that won't be shown anyway.
  let actions = $derived.by(() => {
    let list = room.actions;
    if (activeSetKeys.length > 0) {
      list = list.filter((t) => activeSetKeys.some(k => actionBelongsToSet(t, k)));
    }
    if (room.defaultLogCount !== 0) {
      list = list.slice(0, room.defaultLogCount);
    }
    return list;
  });

  $effect(() => {
    const top = room.actions[0];
    if (!open && top && top !== prevTopAction) {
      unread += 1;
    }
    prevTopAction = top;
  });

  function toggle() {
    open = !open;
    if (open) unread = 0;
  }

  let pendingAsker = $derived(
    room.pendingBotAsk
      ? room.players.find((p) => p.id === room.pendingBotAsk!.askerId) ?? null
      : null,
  );
  let pendingTarget = $derived(
    room.pendingBotAsk
      ? room.players.find((p) => p.id === room.pendingBotAsk!.targetId) ?? null
      : null,
  );
  let pendingInfo = $derived(room.pendingBotAsk ? cardShort(room.pendingBotAsk.card) : null);
</script>

{#if open}
  <div class="log-panel" role="region" aria-label="Action log" style="right: {rightOffset}px" transition:fly={{ y: 16, duration: 200 }}>
    <header class="log-panel-header">
      <span>Action log</span>
      <button class="log-close" onclick={toggle} aria-label="Close log">×</button>
    </header>
    {#if room.actions.length > 10}
    <div class="log-filter-strip">
      <!-- Level 1: All + suit chips + Joker -->
      <button
        class="log-filter-chip"
        class:active={selectedSuit === null}
        onclick={() => { selectedSuit = null; selectedHalf = null; }}
      >All</button>
      {#each SUITS as s (s.key)}
        <button
          class="log-filter-chip suit-chip"
          class:active={selectedSuit === s.key}
          class:red={SUIT_COLOR[s.key] === 'red'}
          onclick={() => selectSuit(s.key)}
        >{SUIT_SYMBOL[s.key]}</button>
      {/each}
      <button
        class="log-filter-chip joker-chip"
        class:active={selectedSuit === 'joker'}
        onclick={() => selectSuit('joker')}
      >Jo</button>
      <!-- Level 2: Minor/Major sub-chips, only when a suit (not joker) is active -->
      {#if selectedSuit !== null && selectedSuit !== 'joker'}
        <span class="log-filter-sep">›</span>
        <button
          class="log-filter-chip sub-chip"
          class:active={selectedHalf === 'low'}
          onclick={() => selectHalf('low')}
        >Minor</button>
        <button
          class="log-filter-chip sub-chip"
          class:active={selectedHalf === 'high'}
          onclick={() => selectHalf('high')}
        >Major</button>
      {/if}
    </div>
    {/if}
    <div class="log-list">
      {#if room.pendingBotAsk && pendingAsker && pendingTarget && pendingInfo}
        <div class="log-pending">
          <span class="log-pending-text">{pendingAsker.name} → {pendingTarget.name}</span>
          <span class="log-pending-card {pendingInfo.red ? 'red' : 'black'}">
            {pendingInfo.rank}{pendingInfo.symbol}
          </span>
          <span class="log-pending-dots">…</span>
        </div>
      {/if}
      {#if actions.length === 0}
        <p class="muted">Nothing yet.</p>
      {:else}
        {#each actions as txt, i (i + "-" + txt)}
          <div class="log-row {classifyAction(txt)}">{txt}</div>
        {/each}
      {/if}
    </div>
  </div>
{/if}

<button
  class="log-toggle"
  class:active={open}
  style="right: {rightOffset}px"
  onclick={toggle}
  aria-expanded={open}
  aria-label="Toggle action log"
>
  <span class="log-toggle-icon" aria-hidden="true">≡</span>
  <span>Log</span>
  {#if unread > 0 && !open}
    <span class="log-toggle-badge" transition:fade={{ duration: 120 }}>{unread}</span>
  {/if}
</button>

<style>
  .log-toggle {
    position: fixed;
    right: 18px;
    bottom: 18px;
    z-index: 350;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 9px 14px;
    border-radius: 999px;
    background: rgba(8, 18, 12, 0.92);
    border: 1px solid var(--panel-border);
    color: var(--text);
    font-size: 0.84rem;
    font-weight: 700;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    backdrop-filter: blur(10px);
    transition: transform 0.15s var(--ease-out), background 0.18s, border-color 0.18s;
  }
  .log-toggle:hover {
    transform: translateY(-1px);
    background: rgba(20, 38, 26, 0.95);
    border-color: rgba(52, 211, 153, 0.32);
  }
  .log-toggle.active {
    background: rgba(52, 211, 153, 0.16);
    border-color: var(--accent);
    color: var(--accent);
  }
  .log-toggle-icon {
    font-size: 1rem;
    line-height: 1;
  }
  .log-toggle-badge {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    border-radius: 999px;
    background: var(--gold);
    color: #2a1a00;
    font-size: 0.68rem;
    font-weight: 800;
    margin-left: 2px;
  }

  .log-panel {
    position: fixed;
    right: 18px;
    bottom: 70px;
    z-index: 350;
    width: min(360px, calc(100vw - 36px));
    max-height: 60vh;
    background: rgba(8, 18, 12, 0.96);
    border: 1px solid var(--panel-border);
    border-radius: 14px;
    box-shadow: 0 16px 50px rgba(0, 0, 0, 0.6);
    backdrop-filter: blur(14px);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .log-panel-header {
    flex-shrink: 0;
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 10px 14px;
    border-bottom: 1px solid var(--panel-border);
    font-size: 0.74rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--muted);
  }
  .log-close {
    color: var(--muted);
    font-size: 1.2rem;
    line-height: 1;
    width: 24px;
    height: 24px;
    border-radius: 6px;
  }
  .log-close:hover { background: rgba(255, 255, 255, 0.08); color: var(--text); }
  .log-filter-strip {
    flex-shrink: 0;
    display: flex;
    flex-wrap: nowrap;
    overflow-x: auto;
    gap: 5px;
    padding: 7px 14px;
    border-bottom: 1px solid var(--panel-border);
    scrollbar-width: none;
  }
  .log-filter-strip::-webkit-scrollbar { display: none; }
  .log-filter-chip {
    flex-shrink: 0;
    padding: 3px 9px;
    border-radius: 999px;
    background: rgba(255, 255, 255, 0.05);
    border: 1px solid var(--panel-border);
    color: var(--muted);
    font-size: 0.68rem;
    font-weight: 700;
    cursor: pointer;
    transition: background 0.14s, border-color 0.14s, color 0.14s;
    white-space: nowrap;
  }
  .log-filter-chip:hover {
    background: rgba(255, 255, 255, 0.1);
    color: var(--text);
  }
  .log-filter-chip.active {
    background: rgba(52, 211, 153, 0.18);
    border-color: var(--accent);
    color: var(--accent);
  }
  .log-filter-chip.suit-chip {
    font-size: 0.82rem;
    padding: 3px 8px;
  }
  .log-filter-chip.suit-chip.red {
    color: #f87171;
  }
  .log-filter-chip.suit-chip.red.active {
    color: #fca5a5;
    border-color: #f87171;
    background: rgba(248, 113, 113, 0.18);
  }
  .log-filter-chip.joker-chip {
    font-size: 0.7rem;
    font-style: italic;
    padding: 3px 8px;
  }
  .log-filter-chip.sub-chip {
    font-size: 0.65rem;
    padding: 2px 7px;
    opacity: 0.85;
  }
  .log-filter-sep {
    display: flex;
    align-items: center;
    color: var(--muted);
    font-size: 0.75rem;
    padding: 0 1px;
    flex-shrink: 0;
    user-select: none;
  }

  .log-list {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
    padding: 8px 14px 14px;
    display: flex;
    flex-direction: column;
    gap: 0;
    scrollbar-width: thin;
    scrollbar-color: var(--panel-border) transparent;
  }
  .log-row {
    font-size: 0.82rem;
    line-height: 1.45;
    padding: 6px 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.04);
    animation: log-row-in 0.32s var(--ease-out);
  }
  .log-row:last-child { border-bottom: none; }
  @keyframes log-row-in {
    from { opacity: 0; transform: translateY(-4px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .log-row.txn-info    { color: var(--text); }
  .log-row.txn-success { color: #6ee7b7; }
  .log-row.txn-fail    { color: #fca5a5; }
  .log-row.txn-declare { color: var(--gold); }
  .log-row.txn-pass    { color: #94a3b8; }

  .log-pending {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 0 10px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.08);
    margin-bottom: 4px;
  }
  .log-pending-text {
    font-size: 0.78rem;
    color: var(--gold);
    flex: 1;
    font-weight: 600;
  }
  .log-pending-card {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 36px;
    height: 50px;
    border-radius: 6px;
    background: var(--card-bg);
    border: 1.5px solid var(--card-border);
    font-weight: 800;
    font-size: 0.78rem;
    animation: pending-pulse-bg 1.1s ease-in-out infinite;
  }
  .log-pending-card.red   { color: var(--card-red); }
  .log-pending-card.black { color: var(--card-black); }
  @keyframes pending-pulse-bg {
    0%, 100% { box-shadow: 1px 3px 8px rgba(0, 0, 0, 0.4), 0 0 0 0 rgba(251, 191, 36, 0); }
    50%      { box-shadow: 1px 3px 8px rgba(0, 0, 0, 0.4), 0 0 0 5px rgba(251, 191, 36, 0.28); }
  }
  .log-pending-dots {
    color: var(--gold);
    animation: dots-pulse 1.5s ease-in-out infinite;
  }
  @keyframes dots-pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }
</style>
