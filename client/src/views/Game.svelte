<script lang="ts">
  import { untrack } from "svelte";
  import {
    cardLabel,
    CARD_TO_SET,
    SET_DEFS,
    type Card,
    type SetKey,
  } from "@lit-up/shared";
  import { game } from "../lib/client.svelte";
  import type { LastAskSnapshot, PlayerSnapshot } from "../lib/client.svelte";
  import { sound } from "../lib/sounds.svelte";
  import { animateDeclare, animateAskBubble } from "../lib/animations";
  import Hand from "../components/Hand.svelte";
  import Table from "../components/Table.svelte";
  import YouTag from "../components/YouTag.svelte";
  import PlayerActionPopover from "../components/PlayerActionPopover.svelte";
  import AllCardsPopover from "../components/AllCardsPopover.svelte";
  import FloatingLog from "../components/FloatingLog.svelte";
  import PlayerNotesPopover from "../components/PlayerNotesPopover.svelte";
  import DeclareModal from "../components/DeclareModal.svelte";
  import SettingsModal from "../components/SettingsModal.svelte";
  import type { CardPickerStyle } from "../components/SettingsModal.svelte";

  let popoverTarget = $state<PlayerSnapshot | null>(null);
  let notesTarget = $state<PlayerSnapshot | null>(null);
  let declareOpen = $state(false);
  let settingsOpen = $state(false);

  function readCardPickerStyle(): CardPickerStyle {
    const stored = localStorage.getItem("litup_card_picker_style");
    return stored === "all-cards" ? "all-cards" : "suit-first";
  }

  // Re-read on every render so changes in the settings modal take effect immediately.
  let cardPickerStyle = $derived.by((): CardPickerStyle => {
    void settingsOpen; // track open/close to re-derive after modal closes
    return readCardPickerStyle();
  });
  let prevHand = $state<Card[]>([]);
  let newlyAddedCards = $state<Card[]>([]);
  let prevTurnId = $state<string>("");
  let prevStatus = $state<string>("lobby");
  let prevScore = $state({ a: 0, b: 0 });

  // visibleRoom$ drives all rendered UI (frozen during animations).
  // room$ is only used by the queue-drain effect.
  let visibleRoom = $derived(game.visibleRoom$);
  let you = $derived(game.me);

  let yourHasDeclarableSet = $derived.by(() => {
    if (!visibleRoom) return false;
    const claimed = new Set<SetKey>([...visibleRoom.claimedA, ...visibleRoom.claimedB]);
    return SET_DEFS.some(
      (s) => !claimed.has(s.key) && game.hand.some((c) => CARD_TO_SET.get(c) === s.key),
    );
  });

  function onTarget(p: PlayerSnapshot) {
    // If clicking the already-open target, close. Otherwise open.
    popoverTarget = popoverTarget?.id === p.id ? null : p;
  }
  function onPassTo(p: PlayerSnapshot) {
    game.pass(p.id);
  }
  function onDeclare() {
    declareOpen = true;
  }
  function onOpenNotes(p: PlayerSnapshot) {
    notesTarget = p;
  }


  // ── React to incoming hand changes (highlight new cards) ────────
  $effect(() => {
    const h = game.hand;
    untrack(() => {
      const gained = h.filter((c) => !prevHand.includes(c));
      if (gained.length > 0) {
        newlyAddedCards = gained;
        setTimeout(() => (newlyAddedCards = []), 1400);
      }
      prevHand = [...h];
    });
  });

  // ── Single queue-drain loop ──────────────────────────────────────
  // Watches game.eventQueue. When a new head appears and no drain is in
  // progress, kicks off drainHead. consumeEvent() will shift the queue,
  // causing the effect to re-fire and pick up the next event automatically.
  let draining = $state(false);

  $effect(() => {
    const head = game.eventQueue[0];
    if (!head || draining) return;

    // Capture what we need before untrack
    const { kind, snapshot } = head;

    untrack(() => {
      draining = true;
      drainHead(kind, snapshot).finally(() => { draining = false; });
    });
  });

  async function drainHead(kind: string, snapshot: typeof game.eventQueue[0]["snapshot"]): Promise<void> {
    if (kind === "ask") {
      const ask = snapshot.lastAsk;
      const handles = animateAsk(ask);
      if (handles) {
        if (ask.success) {
          // Capture the asker's card count BEFORE the ask resolves so we can
          // hold it at the old value until the return card actually lands.
          const askerOldCount =
            visibleRoom?.players.find((p) => p.id === ask.askerId)?.cardCount ?? 0;

          // Commit point 1 — bubble arrives at target:
          //   target's count decreases, asker's count stays unchanged, hand unchanged.
          await handles.onArrivedAtTarget;
          game.commitAskArrival(ask.askerId, askerOldCount);
          sound.play("success");

          // Commit point 2 — return card lands at asker:
          //   full snapshot revealed (asker count up, hand updated, turn confirmed).
          await handles.onComplete;
          announceAsk(ask, snapshot);
          game.consumeEvent();
          return;
        } else {
          // Commit point — bubble bursts at target:
          //   turn passes immediately, target seat highlights, fail sound fires.
          await handles.onArrivedAtTarget;
          announceAsk(ask, snapshot);
          sound.play("fail");
          game.consumeEvent();

          // Keep draining=true while the burst animation finishes so the next
          // queued event doesn't start until the burst is gone.
          await handles.onComplete;
          return;
        }
      }
    } else if (kind === "declare") {
      const decl = snapshot.lastDeclare;
      if (decl) {
        await animateDeclare(
          decl.declarerId,
          decl.assignments,
          decl.sources,
          decl.success,
          (id) => document.getElementById(`seat-${id}`),
          () => document.querySelector<HTMLElement>(".felt-center"),
        );
        // After a successful declare by us, close the sidebar.
        if (decl.success && decl.declarerId === game.playerId) {
          popoverTarget = null;
        }
      }
    }
    // kind === "none" or no handles (seats not in DOM) — advance immediately.
    game.consumeEvent();
  }

  // ── Brief banner + chime when your turn starts; close sidebar on turn loss ─
  // Watches visibleRoom$ so chimes fire after the animation completes.
  $effect(() => {
    const turn = visibleRoom?.turnId;
    if (!turn || turn === prevTurnId) return;
    untrack(() => {
      const isFirstTurn = prevTurnId === "";
      prevTurnId = turn;
      if (turn === game.playerId && visibleRoom?.status === "playing") {
        game.toast("Your turn!", "info", 1800);
        if (!isFirstTurn) sound.play("turn");
      } else {
        // Turn moved away from us — close the sidebar.
        popoverTarget = null;
      }
    });
  });

  // ── Status & score transitions: deal / declare / win ────────────
  // Watches visibleRoom$ so sounds fire after animations complete.
  $effect(() => {
    const status = visibleRoom?.status ?? "lobby";
    if (status === prevStatus) return;
    untrack(() => {
      const wasLobby = prevStatus === "lobby";
      prevStatus = status;
      if (status === "playing" && wasLobby) sound.play("deal");
      if (status === "ended") sound.play("win");
    });
  });

  $effect(() => {
    const a = visibleRoom?.scoreA ?? 0;
    const b = visibleRoom?.scoreB ?? 0;
    if (a === prevScore.a && b === prevScore.b) return;
    untrack(() => {
      const grew = a > prevScore.a || b > prevScore.b;
      prevScore = { a, b };
      // The "win" effect handles the game-over moment; only fire
      // "declare" while the game is still in progress.
      if (grew && visibleRoom?.status === "playing") sound.play("declare");
    });
  });

  function announceAsk(ask: LastAskSnapshot, snapshot: typeof game.eventQueue[0]["snapshot"]): void {
    const players = snapshot.players ?? [];
    const asker = players.find((p) => p.id === ask.askerId);
    const target = players.find((p) => p.id === ask.targetId);
    if (!asker || !target) return;
    const verb = ask.success ? "got it" : "no luck";
    game.toast(`${asker.name} → ${target.name}: ${verb}`, ask.success ? "success" : "warn", 2800);
  }

  function animateAsk(ask: LastAskSnapshot) {
    const askerSeat = document.getElementById(`seat-${ask.askerId}`);
    const targetSeat = document.getElementById(`seat-${ask.targetId}`);
    if (!askerSeat || !targetSeat) return null;

    return animateAskBubble({
      askerEl: askerSeat,
      targetEl: targetSeat,
      card: ask.card as Card,
      success: ask.success,
    });
  }
</script>

{#if visibleRoom?.status === "ended"}
  <div class="fireworks" aria-hidden="true">
    {#each Array(18) as _, i (i)}
      <div class="firework" style="--i:{i}"></div>
    {/each}
  </div>
{/if}

{#if visibleRoom}
  <div class="game-shell">
    <Table
      room={visibleRoom}
      {you}
      isYourTurn={visibleRoom.turnId === game.playerId}
      yourHandSize={game.hand.length}
      {yourHasDeclarableSet}
      targetedId={popoverTarget?.id ?? null}
      {onTarget}
      {onPassTo}
      {onDeclare}
      {onOpenNotes}
    >
      {#if you && visibleRoom.status === "playing"}
        <YouTag
          {you}
          room={visibleRoom}
          isYourTurn={visibleRoom.turnId === game.playerId}
          isEmpty={game.hand.length === 0}
          canDeclare={visibleRoom.turnId === game.playerId && yourHasDeclarableSet}
          actionBusy={game.queueBusy && visibleRoom.turnId === game.playerId}
          {onDeclare}
          onPassTo={(id) => game.pass(id)}
        />
      {/if}
      <Hand hand={game.hand} {newlyAddedCards} />
    </Table>

    <FloatingLog room={visibleRoom} rightOffset={18} />

    <button
      type="button"
      class="settings-btn"
      aria-label="Settings"
      onclick={() => (settingsOpen = true)}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3"></circle>
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
      </svg>
    </button>

    {#if popoverTarget}
      {#if cardPickerStyle === "all-cards"}
        <AllCardsPopover
          target={popoverTarget}
          room={visibleRoom}
          hand={game.hand}
          onClose={() => (popoverTarget = null)}
        />
      {:else}
        <PlayerActionPopover
          target={popoverTarget}
          room={visibleRoom}
          hand={game.hand}
          onClose={() => (popoverTarget = null)}
        />
      {/if}
    {/if}

    {#if declareOpen && you}
      <DeclareModal
        room={visibleRoom}
        {you}
        hand={game.hand}
        onClose={() => (declareOpen = false)}
      />
    {/if}

    {#if notesTarget && visibleRoom.notesEnabled}
      <PlayerNotesPopover
        target={notesTarget}
        roomCode={visibleRoom.code}
        onClose={() => (notesTarget = null)}
      />
    {/if}

    {#if settingsOpen}
      <SettingsModal onClose={() => (settingsOpen = false)} />
    {/if}
  </div>
{/if}

<style>
  .settings-btn {
    position: absolute;
    top: 12px;
    right: 12px;
    z-index: 10;
    width: 36px;
    height: 36px;
    border-radius: 9px;
    background: rgba(8, 18, 12, 0.72);
    border: 1px solid var(--panel-border);
    color: var(--muted);
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(8px);
    transition: background 0.15s, color 0.15s, border-color 0.15s;
  }

  .settings-btn:hover {
    background: rgba(255, 255, 255, 0.08);
    color: var(--text-soft);
    border-color: rgba(255, 255, 255, 0.18);
  }

  /* Fireworks celebration overlay — shown when game ends */
  .fireworks {
    position: fixed;
    inset: 0;
    pointer-events: none;
    z-index: 9999;
    overflow: hidden;
  }

  .firework {
    position: absolute;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    /* Spread particles across the viewport using --i to vary position + color */
    left: calc(10% + (var(--i) * 4.5%) );
    top: calc(20% + ((var(--i) * 7) % 40) * 1%);
    animation: firework-burst 2.4s ease-out calc(var(--i) * 0.14s) 3 both;
    background: hsl(calc(var(--i) * 20deg), 90%, 65%);
    box-shadow:
      0 0 6px 2px hsl(calc(var(--i) * 20deg), 90%, 65%),
      16px 16px 0 hsl(calc(var(--i) * 20deg + 40deg), 90%, 65%),
      -16px 16px 0 hsl(calc(var(--i) * 20deg + 80deg), 90%, 65%),
      16px -16px 0 hsl(calc(var(--i) * 20deg + 120deg), 90%, 65%),
      -16px -16px 0 hsl(calc(var(--i) * 20deg + 160deg), 90%, 65%),
      0 -24px 0 hsl(calc(var(--i) * 20deg + 200deg), 90%, 65%),
      0 24px 0 hsl(calc(var(--i) * 20deg + 240deg), 90%, 65%),
      24px 0 0 hsl(calc(var(--i) * 20deg + 280deg), 90%, 65%),
      -24px 0 0 hsl(calc(var(--i) * 20deg + 320deg), 90%, 65%);
  }

  @keyframes firework-burst {
    0%   { transform: translateY(60vh) scale(0); opacity: 1; }
    40%  { transform: translateY(-10vh) scale(1); opacity: 1; }
    70%  { transform: translateY(-30vh) scale(1.4); opacity: 0.8; }
    100% { transform: translateY(-50vh) scale(0.5); opacity: 0; }
  }
</style>
