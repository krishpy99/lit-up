<script lang="ts">
  import { fade, fly } from "svelte/transition";

  export type CardPickerStyle = "suit-first" | "all-cards";

  const STORAGE_KEY = "litup_card_picker_style";

  interface Props {
    onClose: () => void;
  }

  let { onClose }: Props = $props();

  function readPref(): CardPickerStyle {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === "all-cards" ? "all-cards" : "suit-first";
  }

  let style = $state<CardPickerStyle>(readPref());

  function setPref(val: CardPickerStyle) {
    style = val;
    localStorage.setItem(STORAGE_KEY, val);
  }
</script>

<div
  class="modal-backdrop"
  onclick={onClose}
  role="presentation"
  transition:fade={{ duration: 180 }}
></div>

<div
  class="settings-modal"
  role="dialog"
  aria-modal="true"
  aria-label="Settings"
  tabindex="-1"
  transition:fly={{ y: 20, duration: 220 }}
  onclick={(e) => e.stopPropagation()}
  onkeydown={(e) => e.stopPropagation()}
>
  <header class="modal-header">
    <div class="modal-title">Settings</div>
    <button class="modal-close" aria-label="Close" onclick={onClose}>×</button>
  </header>

  <div class="setting-row">
    <div class="setting-label">
      <div class="setting-name">Card picker style</div>
      <div class="setting-desc">How to browse cards when asking an opponent</div>
    </div>
    <div class="toggle-group">
      <button
        type="button"
        class="toggle-btn"
        class:active={style === "suit-first"}
        onclick={() => setPref("suit-first")}
      >
        Suit first
      </button>
      <button
        type="button"
        class="toggle-btn"
        class:active={style === "all-cards"}
        onclick={() => setPref("all-cards")}
      >
        All cards
      </button>
    </div>
  </div>
</div>

<style>
  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    backdrop-filter: blur(4px);
    z-index: 380;
  }

  .settings-modal {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    z-index: 390;
    width: min(380px, calc(100vw - 24px));
    background: rgba(10, 22, 14, 0.97);
    border: 1px solid var(--panel-border);
    border-radius: 16px;
    box-shadow: 0 24px 80px rgba(0, 0, 0, 0.8), 0 0 0 1px rgba(52, 211, 153, 0.12);
    padding: 22px;
    backdrop-filter: blur(20px);
  }

  .modal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-bottom: 20px;
  }

  .modal-title {
    font-size: 1.05rem;
    font-weight: 800;
    color: var(--text);
  }

  .modal-close {
    color: var(--muted);
    font-size: 1.6rem;
    line-height: 1;
    width: 32px;
    height: 32px;
    border-radius: 8px;
    transition: background 0.15s, color 0.15s;
  }

  .modal-close:hover {
    background: rgba(255, 255, 255, 0.08);
    color: var(--text);
  }

  .setting-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }

  .setting-label {
    min-width: 0;
  }

  .setting-name {
    font-size: 0.9rem;
    font-weight: 600;
    color: var(--text);
  }

  .setting-desc {
    font-size: 0.75rem;
    color: var(--muted);
    margin-top: 2px;
  }

  .toggle-group {
    display: flex;
    border: 1px solid var(--panel-border);
    border-radius: 8px;
    overflow: hidden;
    flex-shrink: 0;
  }

  .toggle-btn {
    padding: 7px 14px;
    font-size: 0.8rem;
    font-weight: 600;
    color: var(--muted);
    background: transparent;
    transition: background 0.15s, color 0.15s;
    white-space: nowrap;
  }

  .toggle-btn + .toggle-btn {
    border-left: 1px solid var(--panel-border);
  }

  .toggle-btn.active {
    background: rgba(52, 211, 153, 0.18);
    color: var(--accent);
  }

  .toggle-btn:not(.active):hover {
    background: rgba(255, 255, 255, 0.06);
    color: var(--text-soft);
  }
</style>
