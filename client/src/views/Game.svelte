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
  import type { LastAskSnapshot, LastDeclareSnapshot, PlayerSnapshot } from "../lib/client.svelte";
  import { sound } from "../lib/sounds.svelte";
  import { flyCard, animateAskBubble } from "../lib/animations";
  import Hand from "../components/Hand.svelte";
  import Table from "../components/Table.svelte";
  import YouTag from "../components/YouTag.svelte";
  import CardSelectSidebar from "../components/CardSelectSidebar.svelte";
  import FloatingLog from "../components/FloatingLog.svelte";
  import PlayerNotesPopover from "../components/PlayerNotesPopover.svelte";
  import DeclareModal from "../components/DeclareModal.svelte";

  let popoverTarget = $state<PlayerSnapshot | null>(null);
  let notesTarget = $state<PlayerSnapshot | null>(null);
  let declareOpen = $state(false);
  let prevHand = $state<Card[]>([]);
  let newlyAddedCards = $state<Card[]>([]);
  let prevAskAt = $state(0);
  let prevDeclareAt = $state(0);
  let prevTurnId = $state<string>("");
  let prevStatus = $state<string>("lobby");
  let prevScore = $state({ a: 0, b: 0 });

  let room = $derived(game.room$);
  let you = $derived(game.me);

  let yourHasDeclarableSet = $derived.by(() => {
    if (!room) return false;
    const claimed = new Set<SetKey>([...room.claimedA, ...room.claimedB]);
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

  // ── React to ask events (animate the card flight + play sounds) ─
  $effect(() => {
    const ask = room?.lastAsk;
    if (!ask || !ask.at || ask.at === prevAskAt) return;
    untrack(() => {
      prevAskAt = ask.at;
      animateAsk(ask);
      // Delay reveal until cloud arrives (3 s) to preserve suspense.
      setTimeout(() => {
        announceAsk(ask);
        sound.play(ask.success ? "success" : "fail");
      }, 3000);
    });
  });

  // ── Brief banner + chime when your turn starts; close sidebar on turn loss ─
  $effect(() => {
    const turn = room?.turnId;
    if (!turn || turn === prevTurnId) return;
    untrack(() => {
      const isFirstTurn = prevTurnId === "";
      prevTurnId = turn;
      if (turn === game.playerId && room?.status === "playing") {
        game.toast("Your turn!", "info", 1800);
        if (!isFirstTurn) sound.play("turn");
      } else {
        // Turn moved away from us — close the sidebar.
        popoverTarget = null;
      }
    });
  });

  // ── Status & score transitions: deal / declare / win ────────────
  $effect(() => {
    const status = room?.status ?? "lobby";
    if (status === prevStatus) return;
    untrack(() => {
      const wasLobby = prevStatus === "lobby";
      prevStatus = status;
      if (status === "playing" && wasLobby) sound.play("deal");
      if (status === "ended") sound.play("win");
    });
  });

  $effect(() => {
    const a = room?.scoreA ?? 0;
    const b = room?.scoreB ?? 0;
    if (a === prevScore.a && b === prevScore.b) return;
    untrack(() => {
      const grew = a > prevScore.a || b > prevScore.b;
      prevScore = { a, b };
      // The "win" effect handles the game-over moment; only fire
      // "declare" while the game is still in progress.
      if (grew && room?.status === "playing") sound.play("declare");
    });
  });

  // ── React to declare events: fly each card from its holder to center ─
  $effect(() => {
    const decl = room?.lastDeclare;
    if (!decl || !decl.at || decl.at === prevDeclareAt) return;
    untrack(() => {
      prevDeclareAt = decl.at;
      animateDeclare(decl);
      // After a successful declare by us, close the sidebar so the player
      // sees the full table and the "Pass here" buttons on teammate seats.
      if (decl.success && decl.declarerId === game.playerId) {
        popoverTarget = null;
      }
    });
  });

  function announceAsk(ask: LastAskSnapshot): void {
    const players = room?.players ?? [];
    const asker = players.find((p) => p.id === ask.askerId);
    const target = players.find((p) => p.id === ask.targetId);
    if (!asker || !target) return;
    const verb = ask.success ? "got it" : "no luck";
    game.toast(`${asker.name} → ${target.name}: ${verb}`, ask.success ? "success" : "warn", 2800);
  }

  /**
   * When a declare resolves (correct or not), each of the set's six cards
   * was just stripped from its holder's hand. We fly the card faces from
   * each holder's seat in toward the felt center on a staggered schedule
   * so the table reads "every position contributed". The cards land near
   * the scoreboard, where the persistent set chip lives going forward.
   */
  function animateDeclare(decl: LastDeclareSnapshot): void {
    const center = document.querySelector<HTMLElement>(".felt-center");
    if (!center) return;
    const targetRect = center.getBoundingClientRect();
    // We keep the destination slightly off-center so all six cards don't
    // pile on the same pixel — light spread matches the scoreboard width.
    const cards = Object.entries(decl.sources);
    cards.forEach(([card, holderId], i) => {
      const fromEl = document.getElementById(`seat-${holderId}`);
      if (!fromEl) return;
      const offsetX = (i - (cards.length - 1) / 2) * 18;
      const dest = new DOMRect(
        targetRect.left + offsetX,
        targetRect.top - 18,
        targetRect.width,
        targetRect.height,
      );
      // Stagger so the table feels like a sequence of contributions.
      setTimeout(() => {
        flyCard({ from: fromEl, to: dest, card, duration: 1.5 });
      }, i * 110);
    });
  }

  function animateAsk(ask: LastAskSnapshot): void {
    const askerSeat = document.getElementById(`seat-${ask.askerId}`);
    const targetSeat = document.getElementById(`seat-${ask.targetId}`);
    if (!askerSeat || !targetSeat) return;

    animateAskBubble({
      askerEl: askerSeat,
      targetEl: targetSeat,
      card: ask.card as Card,
      success: ask.success,
    });
  }
</script>

{#if room}
  <div class="game-shell" class:sidebar-open={popoverTarget !== null}>
    <Table
      {room}
      {you}
      isYourTurn={room.turnId === game.playerId}
      yourHandSize={game.hand.length}
      {yourHasDeclarableSet}
      targetedId={popoverTarget?.id ?? null}
      {onTarget}
      {onPassTo}
      {onDeclare}
      {onOpenNotes}
    >
      {#if you && room.status === "playing"}
        <YouTag
          {you}
          {room}
          isYourTurn={room.turnId === game.playerId}
          isEmpty={game.hand.length === 0}
          canDeclare={room.turnId === game.playerId && yourHasDeclarableSet}
          {onDeclare}
          onPassTo={(id) => game.pass(id)}
        />
      {/if}
      <Hand hand={game.hand} {newlyAddedCards} />
    </Table>

    <FloatingLog {room} rightOffset={popoverTarget ? 398 : 18} />

    <!-- Sidebar is now the primary UI for card selection -->
    <CardSelectSidebar
      target={popoverTarget}
      {room}
      hand={game.hand}
      onClose={() => (popoverTarget = null)}
    />

    {#if declareOpen && you}
      <DeclareModal
        {room}
        {you}
        hand={game.hand}
        onClose={() => (declareOpen = false)}
      />
    {/if}

    {#if notesTarget && room.notesEnabled}
      <PlayerNotesPopover
        target={notesTarget}
        roomCode={room.code}
        onClose={() => (notesTarget = null)}
      />
    {/if}
  </div>
{/if}
