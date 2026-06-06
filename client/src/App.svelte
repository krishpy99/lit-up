<script lang="ts">
  import { onMount } from "svelte";
  import { game } from "./lib/client.svelte";
  import { sound } from "./lib/sounds.svelte";
  import Landing from "./views/Landing.svelte";
  import Lobby from "./views/Lobby.svelte";
  import Game from "./views/Game.svelte";
  import Toaster from "./components/Toaster.svelte";
  import RulesPanel from "./components/RulesPanel.svelte";
  import BgFloaters from "./components/BgFloaters.svelte";

  let rulesOpen = $state(false);

  // derive synchronously — window is always defined in this SPA
  const _initialCode = typeof window !== "undefined"
    ? (new URL(window.location.href).searchParams.get("room") ?? "").toUpperCase()
    : "";
  let prefilledCode = $state(_initialCode);

  $effect(() => {
    document.body.classList.toggle("in-game", game.view === "game");
  });

  onMount(async () => {
    // Silently restore session if the user refreshed mid-game.
    await game.tryAutoReconnect();
  });

  function leave() {
    if (game.view === "game" && !confirm("Leave the game?")) return;
    game.leave();
  }
</script>

<BgFloaters />

<header class="site-header">
  <div class="site-header-title">
    <h1>Lit Up</h1>
    {#if game.view === "landing"}
      <p class="subtitle">Play Literature with friends.</p>
    {/if}
  </div>
  <div class="site-header-actions">
    <button type="button" class="btn btn-ghost btn-sm" onclick={() => (rulesOpen = true)}>
      Rules
    </button>
    {#if game.view !== "landing"}
      <button type="button" class="btn btn-ghost btn-sm" onclick={leave}>Leave</button>
    {/if}
    <button
      type="button"
      class="mute-btn"
      class:muted={sound.muted}
      onclick={() => sound.toggle()}
      title={sound.muted ? "Sound muted — click to enable" : "Sound on — click to mute"}
      aria-label={sound.muted ? "Unmute sound" : "Mute sound"}
      aria-pressed={sound.muted}
    >
      {#if sound.muted}
        <!-- Volume X -->
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
          <line x1="22" y1="9" x2="16" y2="15"></line>
          <line x1="16" y1="9" x2="22" y2="15"></line>
        </svg>
      {:else}
        <!-- Volume 2 -->
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
        </svg>
      {/if}
    </button>
    <span
      class="conn-dot"
      class:online={game.status === "connected"}
      class:offline={game.status === "idle" || game.status === "error"}
      class:connecting={game.status === "connecting"}
      title={game.status === "connected" ? "Connected" : game.status === "connecting" ? "Connecting…" : "Offline"}
      aria-label="Connection status"
    ></span>
  </div>
</header>

<main>
  {#if game.errorBanner}
    <div class="error-banner">{game.errorBanner}</div>
  {/if}

  {#if game.view === "landing"}
    <Landing {prefilledCode} />
  {:else if game.view === "lobby"}
    <Lobby />
  {:else}
    <Game />
  {/if}
</main>

<RulesPanel open={rulesOpen} onClose={() => (rulesOpen = false)} />
<Toaster />
