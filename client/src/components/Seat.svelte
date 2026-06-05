<script lang="ts">
  import Avatar from "./Avatar.svelte";
  import { cardShort } from "@lit-up/shared";
  import type { PlayerSnapshot, RoomSnapshot } from "../lib/client.svelte";

  interface Props {
    player: PlayerSnapshot;
    room: RoomSnapshot;
    you: PlayerSnapshot | null;
    isYourTurn: boolean;
    targetedId: string | null;
    /** Position on the felt, 0..1 each. */
    xPct: number;
    yPct: number;
    yourHandSize: number;
    yourHasDeclarableSet: boolean;
    onTarget: (player: PlayerSnapshot) => void;
    onPassTo: (player: PlayerSnapshot) => void;
    onDeclare: () => void;
    onOpenNotes: (player: PlayerSnapshot) => void;
  }

  let {
    player,
    room,
    you,
    isYourTurn,
    targetedId,
    xPct,
    yPct,
    yourHandSize,
    yourHasDeclarableSet,
    onTarget,
    onPassTo,
    onDeclare,
    onOpenNotes,
  }: Props = $props();

  let isYou        = $derived(you?.id === player.id);
  let isTurn       = $derived(room.turnId === player.id);
  let isOpponent   = $derived(!!you && player.team !== you.team);
  let canAsk       = $derived(
    room.status === "playing" &&
      isYourTurn &&
      isOpponent &&
      player.cardCount > 0 &&
      yourHandSize > 0,
  );
  let canPassHere  = $derived(
    room.status === "playing" &&
      isYourTurn &&
      !!room.postDeclareId &&
      room.postDeclareId === you?.id &&
      !!you &&
      player.team === you.team &&
      player.id !== you.id &&
      player.cardCount > 0,
  );
  let canDeclareHere = $derived(
    isYou &&
      room.status === "playing" &&
      isYourTurn &&
      yourHasDeclarableSet,
  );

  let isTargeted   = $derived(targetedId === player.id);
  let isPendingAsk = $derived(room.pendingBotAsk?.askerId === player.id);
  let isPendingTgt = $derived(room.pendingBotAsk?.targetId === player.id);
  let pendingInfo  = $derived(
    isPendingAsk && room.pendingBotAsk ? cardShort(room.pendingBotAsk.card) : null,
  );

  /**
   * Show more visible card-backs as the hand grows, but pack the offsets
   * tightly so the bubble stays a reasonable width on screen. The offset
   * shrinks linearly with hand size so 14 cards still fit within ~70px.
   */
  const MAX_VISIBLE = 10;
  const STACK_MAX_SPAN = 56; // px between first and last card-back
  const BACK_WIDTH = 32;
  let displayedStack = $derived(Math.min(player.cardCount, MAX_VISIBLE));
  let stackStep = $derived(
    displayedStack <= 1
      ? 0
      : Math.min(8, STACK_MAX_SPAN / Math.max(1, displayedStack - 1)),
  );
  let stackWidth = $derived(BACK_WIDTH + (displayedStack - 1) * stackStep);
</script>

<div
  class="seat"
  class:you={isYou}
  class:current-turn={isTurn}
  class:opponent={isOpponent}
  class:targeted={isTargeted}
  class:pending-asker={isPendingAsk}
  class:pending-target={isPendingTgt}
  class:disconnected={!player.connected}
  id="seat-{player.id}"
  style="left:{xPct}%; top:{yPct}%;"
>
  <div
    class="seat-bubble"
    onclick={() => canAsk && onTarget(player)}
    role="presentation"
  >
    {#if isPendingAsk && pendingInfo}
      {@const targetName = room.players.find((p) => p.id === room.pendingBotAsk?.targetId)?.name ?? "?"}
      <div class="seat-thought">
        <span class="seat-thought-text">→ {targetName}</span>
        <span class="seat-thought-card {pendingInfo.red ? 'red' : 'black'}">
          {pendingInfo.rank}{pendingInfo.symbol}
        </span>
      </div>
    {/if}

    {#if isTurn && !isYou}
      <!-- Other players' turn badge stays visible at the seat. For YOU, the
           gold glow on the seat plus the brief "Your turn!" toast is enough,
           so we skip the badge to keep the bubble compact. -->
      <div class="seat-turn-badge">TURN</div>
    {/if}

    <Avatar
      name={player.name}
      avatar={player.avatar}
      character={player.character}
      team={player.team}
      size={42}
    />

    <div class="seat-name-row">
      <span class="seat-name">
        {player.name}{player.isBot ? " 🤖" : ""}
      </span>
      <span class="seat-team-pill team-{player.team.toLowerCase()}">{player.team}</span>
      {#if room.notesEnabled && !isYou}
        <button
          type="button"
          class="seat-notes-btn"
          aria-label="Notes about {player.name}"
          title="Notes about {player.name}"
          onclick={(e) => { e.stopPropagation(); onOpenNotes(player); }}
        >📝</button>
      {/if}
    </div>

    {#if !isYou}
      <div
        class="card-stack"
        aria-label="{player.cardCount} cards"
        style="width:{stackWidth}px;"
      >
        {#if player.cardCount === 0}
          <span class="card-stack-empty">Empty</span>
        {:else}
          {#each Array(displayedStack) as _, i (i)}
            <div class="card-back" style="left:{i * stackStep}px; z-index:{i};"></div>
          {/each}
          <span class="card-stack-count">{player.cardCount}</span>
        {/if}
      </div>
    {:else if player.cardCount === 0}
      <!-- Surface the empty state on YOU even though the fan is gone. -->
      <span class="card-stack-empty">Empty</span>
    {/if}

    {#if canPassHere}
      <button
        type="button"
        class="seat-action-btn"
        onclick={(e) => {
          e.stopPropagation();
          onPassTo(player);
        }}
      >
        Pass here
      </button>
    {/if}

    {#if canDeclareHere}
      <button
        type="button"
        class="seat-action-btn declare"
        onclick={(e) => {
          e.stopPropagation();
          onDeclare();
        }}
      >
        Declare
      </button>
    {/if}
  </div>
</div>
