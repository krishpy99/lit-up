<script lang="ts">
  import { LOG_COUNT_OPTIONS, MIN_PLAYERS, type BotDifficulty } from "@lit-up/shared";
  import { game } from "../lib/client.svelte";
  import Avatar from "../components/Avatar.svelte";

  let inviteCopied = $state(false);

  const difficulties: BotDifficulty[] = ["easy", "medium", "hard"];

  function canStart(): boolean {
    const r = game.room$;
    if (!r) return false;
    return r.players.length >= MIN_PLAYERS && r.players.length % 2 === 0;
  }

  async function copyInvite() {
    const url = game.inviteUrl();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      inviteCopied = true;
      game.toast("Invite link copied.", "success", 2000);
      setTimeout(() => (inviteCopied = false), 2200);
    } catch {
      game.toast("Couldn't copy link.", "error");
    }
  }
</script>

{#if game.room$}
  {@const room = game.room$}
  <section class="panel panel-wide">
    <div class="lobby-header">
      <div>
        <h2>
          Room <span class="room-code">{room.code}</span>
        </h2>
        <p class="muted">Share the invite link to bring in friends.</p>
      </div>
      <button class="btn btn-danger btn-sm" onclick={() => game.leave()}>Leave</button>
    </div>
    <div class="invite-row">
      <input class="input invite-input" readonly value={game.inviteUrl()} />
      <button class="btn btn-ghost btn-sm invite-copy-btn" onclick={copyInvite}>
        {inviteCopied ? "Copied!" : "Copy link"}
      </button>
    </div>

    {#if game.isHost}
      <div class="lobby-host-controls">
        <div class="field">
          <span class="field-label">Bot difficulty</span>
          <div class="segmented">
            {#each difficulties as d (d)}
              <button
                class:active={room.botDifficulty === d}
                onclick={() => game.setBotDifficulty(d)}
              >
                {d[0].toUpperCase() + d.slice(1)}
              </button>
            {/each}
          </div>
        </div>

        <div class="field">
          <span class="field-label">Recent log entries (locked once the game starts)</span>
          <div class="segmented">
            {#each LOG_COUNT_OPTIONS as opt (opt.value)}
              <button
                class:active={room.defaultLogCount === opt.value}
                onclick={() => game.setRoomConfig({ defaultLogCount: opt.value })}
              >
                {opt.label}
              </button>
            {/each}
          </div>
        </div>

        <label class="toggle-row">
          <input
            type="checkbox"
            checked={room.notesEnabled}
            onchange={(e) => game.setRoomConfig({ notesEnabled: e.currentTarget.checked })}
          />
          <span>
            <strong>Player notes</strong>
            <small>Each player can take private notes on every seat during the game.</small>
          </span>
        </label>
      </div>
    {:else}
      <p class="muted lobby-hint">
        Bot difficulty: <strong>{room.botDifficulty}</strong> · Notes:
        <strong>{room.notesEnabled ? "on" : "off"}</strong> · Log:
        <strong>{room.defaultLogCount === 0 ? "all" : room.defaultLogCount}</strong>
      </p>
    {/if}
  </section>

  <section class="panel panel-wide">
    <div class="lobby-header">
      <h3>Players ({room.players.length})</h3>
      {#if game.isHost}
        <div class="lobby-header-actions">
          <button class="btn btn-ghost btn-sm" onclick={() => game.addBot()}
                  disabled={room.players.length >= 10}>Add bots</button>
          <button class="btn btn-ghost btn-sm" onclick={() => game.removeBots()}
                  disabled={!room.players.some((p) => p.isBot)}>Remove bots</button>
          <button class="btn btn-ghost btn-sm" onclick={() => game.shuffleTeams()}
                  disabled={room.players.length < 2}>Shuffle teams</button>
          <button class="btn btn-primary btn-sm" onclick={() => game.startGame()}
                  disabled={!canStart()}>Start game</button>
        </div>
      {/if}
    </div>

    <div class="teams-grid">
      {#each (["A", "B"] as const) as team (team)}
        {@const teamPlayers = room.players.filter((p) => p.team === team)}
        <div class="team-column">
          <div class="team-heading team-heading-{team.toLowerCase()}">Team {team}</div>
          <div class="player-grid">
            {#each teamPlayers as p (p.id)}
              <div class="player-card" class:team-b={p.team === "B"}>
                <Avatar name={p.name} avatar={p.avatar} character={p.character} team={p.team} size={42} />
                <div class="player-meta">
                  <strong>
                    {p.id === game.playerId ? `${p.name} (you)` : p.name}
                    {#if p.isHost}<span class="muted"> · host</span>{/if}
                    {#if p.isBot}<span class="muted"> · bot</span>{/if}
                  </strong>
                  <span>{p.connected ? "Ready" : "⚠ Disconnected"}</span>
                </div>
              </div>
            {/each}
            {#if teamPlayers.length === 0}
              <p class="muted empty-team">No players yet.</p>
            {/if}
          </div>
        </div>
      {/each}
    </div>
    <p class="muted lobby-hint">Minimum {MIN_PLAYERS} players, even count.</p>
  </section>
{/if}

<style>
  .lobby-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 14px;
    margin-bottom: 14px;
    flex-wrap: wrap;
  }
  .invite-row {
    display: flex;
    gap: 8px;
    align-items: stretch;
    margin-bottom: 0;
  }
  .invite-input {
    flex: 1;
    min-width: 0;
  }
  .invite-copy-btn {
    flex-shrink: 0;
    white-space: nowrap;
  }
  .lobby-host-controls {
    margin-top: 16px;
  }
  h2 { margin: 0; font-size: 1.1rem; }
  h3 { margin: 0; font-size: 1rem; }
  .room-code {
    font-family: "JetBrains Mono", "SF Mono", ui-monospace, monospace;
    color: var(--gold);
    letter-spacing: 0.06em;
  }
  .lobby-hint {
    margin-top: 12px;
    font-size: 0.82rem;
  }
  .teams-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
    margin-bottom: 4px;
  }
  @media (max-width: 560px) {
    .teams-grid { grid-template-columns: 1fr; }
  }
  .team-column {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .team-heading {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.07em;
    padding: 3px 8px;
    border-radius: 5px;
  }
  .team-heading-a {
    color: var(--team-a-text);
    background: rgba(241, 245, 249, 0.08);
    border-left: 3px solid var(--team-a);
  }
  .team-heading-b {
    color: var(--team-b-text);
    background: rgba(148, 163, 184, 0.08);
    border-left: 3px solid rgba(148, 163, 184, 0.5);
  }
  .empty-team {
    font-size: 0.8rem;
    font-style: italic;
    padding: 6px 0;
  }
  .toggle-row {
    display: flex;
    gap: 12px;
    align-items: flex-start;
    margin-top: 14px;
    cursor: pointer;
  }
  .toggle-row input[type="checkbox"] {
    margin-top: 4px;
    width: 18px;
    height: 18px;
    accent-color: var(--accent);
    cursor: pointer;
  }
  .toggle-row strong {
    display: block;
    font-size: 0.92rem;
    margin-bottom: 2px;
  }
  .toggle-row small {
    color: var(--muted);
    font-size: 0.78rem;
    line-height: 1.4;
  }
</style>
