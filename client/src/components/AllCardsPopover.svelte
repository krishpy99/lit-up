<script lang="ts">
  import { onMount } from "svelte";
  import { fly, fade } from "svelte/transition";
  import {
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
    target: PlayerSnapshot;
    room: RoomSnapshot;
    hand: Card[];
    onClose: () => void;
  }

  let { target, room, hand, onClose }: Props = $props();

  let popoverEl: HTMLDivElement | null = $state(null);
  let posStyle = $state("left:0;top:0;");
  let positioned = $state(false);

  let claimed = $derived(new Set<SetKey>([...room.claimedA, ...room.claimedB]));

  interface AskableSet {
    setKey: SetKey;
    setLabel: string;
    cards: Card[];
  }

  let askableSets = $derived.by((): AskableSet[] => {
    const result: AskableSet[] = [];
    for (const set of SET_DEFS) {
      if (claimed.has(set.key)) continue;
      if (!hand.some((c) => CARD_TO_SET.get(c) === set.key)) continue;
      const cards = SET_LOOKUP[set.key].cards.filter((c) => !hand.includes(c));
      if (cards.length > 0) {
        result.push({ setKey: set.key, setLabel: set.label, cards });
      }
    }
    return result;
  });

  function clickCard(card: Card) {
    sound.play("ask");
    game.ask({ toPlayerId: target.id, card });
    onClose();
  }

  function positionToSeat() {
    const seat = document.getElementById(`seat-${target.id}`);
    if (!seat || !popoverEl) return;
    const seatRect = seat.getBoundingClientRect();
    const popRect = popoverEl.getBoundingClientRect();
    const margin = 12;

    let left = seatRect.left + seatRect.width / 2 - popRect.width / 2;
    let top = seatRect.top - popRect.height - margin;

    if (top < margin) top = seatRect.bottom + margin;
    if (top + popRect.height > window.innerHeight - margin) {
      top = window.innerHeight - margin - popRect.height;
    }
    if (top < margin) top = margin;
    if (left + popRect.width > window.innerWidth - margin) {
      left = window.innerWidth - margin - popRect.width;
    }
    if (left < margin) left = margin;

    posStyle = `left:${left}px; top:${top}px;`;
    positioned = true;
  }

  onMount(() => {
    positionToSeat();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onResize = () => positionToSeat();
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  });
</script>

<div class="popover-backdrop" onclick={onClose} role="presentation" transition:fade={{ duration: 150 }}></div>

<div
  class="all-cards-popover"
  class:positioned
  bind:this={popoverEl}
  style={posStyle}
  role="dialog"
  aria-modal="true"
  aria-label="Ask {target.name} for a card"
  tabindex="-1"
  out:fly={{ y: -8, duration: 160 }}
  onclick={(e) => e.stopPropagation()}
  onkeydown={(e) => e.stopPropagation()}
>
  <header class="popover-header">
    <div class="popover-target">
      <Avatar name={target.name} avatar={target.avatar} character={target.character} team={target.team} size={34} />
      <div class="popover-target-text">
        <div class="popover-target-name">Ask {target.name}</div>
        <div class="popover-target-sub">
          {target.cardCount} card{target.cardCount === 1 ? "" : "s"} · pick any card
        </div>
      </div>
    </div>
    <button type="button" class="popover-close" aria-label="Close" onclick={onClose}>×</button>
  </header>

  <div class="popover-scroll">
    {#if askableSets.length === 0}
      <p class="popover-empty">No cards available to ask for.</p>
    {:else}
      {#each askableSets as { setLabel, cards } (setLabel)}
        <div class="popover-set-row">
          <div class="popover-set-label">{setLabel}</div>
          <div class="popover-set-cards">
            {#each cards as card (card)}
              {@const info = cardShort(card)}
              <button
                type="button"
                class="card interactive {info.red ? 'red' : 'black'}"
                data-card={card}
                onclick={() => clickCard(card)}
                aria-label="Ask for {info.rank}{info.symbol}"
              >
                <span class="cr tl">{info.rank}</span>
                <span class="cs tl">{info.symbol}</span>
                <span class="cc">{info.symbol}</span>
                <span class="cr br">{info.rank}</span>
                <span class="cs br">{info.symbol}</span>
              </button>
            {/each}
          </div>
        </div>
      {/each}
    {/if}
  </div>
</div>

<style>
  .popover-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.32);
    backdrop-filter: blur(2px);
    z-index: 350;
  }

  .all-cards-popover {
    position: fixed;
    z-index: 360;
    width: min(460px, calc(100vw - 24px));
    background: rgba(8, 18, 12, 0.96);
    border: 1px solid var(--panel-border);
    border-radius: 14px;
    box-shadow: 0 24px 60px rgba(0, 0, 0, 0.7), 0 0 0 1px rgba(52, 211, 153, 0.18);
    padding: 14px 14px 16px;
    backdrop-filter: blur(16px);

    opacity: 0;
    transform: translateY(-4px) scale(0.97);
    transition:
      opacity 0.18s var(--ease-out),
      transform 0.22s var(--ease-spring);
  }

  .all-cards-popover.positioned {
    opacity: 1;
    transform: translateY(0) scale(1);
  }

  .popover-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 10px;
    margin-bottom: 12px;
  }

  .popover-target {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
  }

  .popover-target-text { min-width: 0; }

  .popover-target-name {
    font-weight: 700;
    font-size: 0.95rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .popover-target-sub {
    font-size: 0.74rem;
    color: var(--muted);
  }

  .popover-close {
    color: var(--muted);
    font-size: 1.5rem;
    line-height: 1;
    width: 30px;
    height: 30px;
    border-radius: 8px;
    transition: background 0.15s, color 0.15s;
  }

  .popover-close:hover {
    background: rgba(255, 255, 255, 0.08);
    color: var(--text);
  }

  .popover-scroll {
    display: flex;
    flex-direction: column;
    gap: 12px;
    max-height: 420px;
    overflow-y: auto;
    padding-right: 4px;
  }

  .popover-scroll::-webkit-scrollbar {
    width: 4px;
  }

  .popover-scroll::-webkit-scrollbar-track {
    background: transparent;
  }

  .popover-scroll::-webkit-scrollbar-thumb {
    background: var(--panel-border);
    border-radius: 2px;
  }

  .popover-set-row {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }

  .popover-set-label {
    font-size: 0.66rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    color: var(--muted);
  }

  .popover-set-cards {
    display: flex;
    flex-wrap: nowrap;
    gap: 6px;
  }

  /* Shrink .card instances inside this popover so all 6 fit in one row */
  .popover-set-cards :global(.card) {
    width: 64px;
    height: 92px;
  }

  .popover-set-cards :global(.card .cr) {
    font-size: 0.88rem;
  }

  .popover-set-cards :global(.card .cs) {
    font-size: 0.82rem;
  }

  .popover-set-cards :global(.card .cr.tl) {
    top: 5px;
    left: 6px;
  }

  .popover-set-cards :global(.card .cs.tl) {
    top: 19px;
    left: 5px;
  }

  .popover-set-cards :global(.card .cr.br) {
    bottom: 5px;
    right: 6px;
  }

  .popover-set-cards :global(.card .cs.br) {
    bottom: 19px;
    right: 5px;
  }

  .popover-set-cards :global(.card .cc) {
    font-size: 2rem;
  }

  .popover-empty {
    font-size: 0.78rem;
    color: var(--muted);
    margin: 0;
    font-style: italic;
  }
</style>
