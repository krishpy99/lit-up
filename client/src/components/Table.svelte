<script lang="ts">
  import type { Snippet } from "svelte";
  import type { PlayerSnapshot, RoomSnapshot } from "../lib/client.svelte";
  import { game } from "../lib/client.svelte";
  import Seat from "./Seat.svelte";
  import Scoreboard from "./Scoreboard.svelte";

  interface Props {
    room: RoomSnapshot;
    you: PlayerSnapshot | null;
    isYourTurn: boolean;
    yourHandSize: number;
    yourHasDeclarableSet: boolean;
    targetedId: string | null;
    onTarget: (p: PlayerSnapshot) => void;
    onPassTo: (p: PlayerSnapshot) => void;
    onDeclare: () => void;
    onOpenNotes: (p: PlayerSnapshot) => void;
    /** The hand fan overlay — rendered absolutely-positioned inside the arena. */
    children?: Snippet;
  }

  let {
    room,
    you,
    isYourTurn,
    yourHandSize,
    yourHasDeclarableSet,
    targetedId,
    onTarget,
    onPassTo,
    onDeclare,
    onOpenNotes,
    children,
  }: Props = $props();

  /**
   * Place seats on an oval, with the local player at the bottom-center
   * (the canonical position for "you" in card games). Other players fan
   * out clockwise from there.
   *
   * In CSS coordinates +y points down, so sin(90°) = 1 lands at the bottom.
   */
  function seatPosition(i: number, n: number, youIndex: number): { x: number; y: number } {
    const relIdx = ((i - youIndex) + n) % n;
    const angle = (90 + (relIdx * 360) / n) * (Math.PI / 180);
    // Equal radii (rx == ry) so seats sit on a circle. Center is pushed
    // *below* the arena's vertical midline (cy = 52) and the radius is
    // tightened to 30: this keeps the topmost opponent's bubble well
    // clear of the sticky header (which would otherwise crop it off).
    const r = 30, cx = 50, cy = 52;
    return {
      x: cx + r * Math.cos(angle),
      y: cy + r * Math.sin(angle),
    };
  }

  let youIndex = $derived(you ? room.players.findIndex((p) => p.id === you.id) : 0);
</script>

<div class="game-arena">
  <div class="felt">
    <div class="felt-center">
      <Scoreboard {room} />
    </div>
  </div>

  {#if room.status === "ended"}
    <div class="felt-over-banner">
      <div class="winner">
        {room.winnerTeam ? `Team ${room.winnerTeam} wins! 🎉` : "Game tied"}
      </div>
      <div class="sub">{room.scoreA} – {room.scoreB}</div>
      <div class="over-actions">
        {#if game.isHost}
          <button class="btn btn-primary btn-sm" onclick={() => game.resetGame()}>
            Back to room
          </button>
        {:else}
          <button class="btn btn-ghost btn-sm" onclick={() => game.leave()}>
            Leave
          </button>
        {/if}
      </div>
    </div>
  {/if}

  <div class="seats">
    {#each room.players as player, i (player.id)}
      {#if !you || player.id !== you.id}
        {@const pos = seatPosition(i, room.players.length, youIndex)}
        <Seat
          {player}
          {room}
          {you}
          {isYourTurn}
          {targetedId}
          xPct={pos.x}
          yPct={pos.y}
          {yourHandSize}
          {yourHasDeclarableSet}
          {onTarget}
          {onPassTo}
          {onDeclare}
          {onOpenNotes}
        />
      {/if}
    {/each}
  </div>

  {#if children}{@render children()}{/if}
</div>
