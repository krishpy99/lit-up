# Lit Up — Literature Card Game

A real-time multiplayer Literature card game.

* **Authoritative server** (Colyseus on Node) holds the truth and validates every move.
* **Per-client filtered state** — your hand is sent privately; only public state syncs to all.
* **Reactive UI** in Svelte 5 with smooth card animations via [Motion](https://motion.dev).
* **Reconnect-safe** — drop your phone, walk into a tunnel, come back; a bot plays your seat until you rejoin (auto-rejoin, 5 min grace).

## Quick start

Requires Node 20+.

```bash
npm install
npm run dev
```

This starts the Colyseus server on `:2567` and the Vite dev server on `:5173`. Open
[http://localhost:5173](http://localhost:5173), create a room, and share the link
(it includes a `?room=CODE` parameter).

To run them separately:

```bash
npm run dev:server   # Colyseus on :2567
npm run dev:client   # Vite on :5173
```

## Architecture

```
lit-up/
├── shared/    Pure constants & types used by both sides
├── server/    Colyseus room + game rules + bot AI (authoritative)
└── client/    Svelte 5 + Vite + Motion (UI only — no game state lives here)
```

### How a turn flows

1. Player clicks an opponent at the table → `targetedId` set in client state.
2. Player picks a card from the ask picker → `room.send("ask", { toPlayerId, card })`.
3. Server validates: it's your turn, you hold a card in the same set, etc.
4. Server mutates `state.players[*].cardCount`, `turnId`, `actions`, `lastAsk`.
5. Colyseus auto-syncs the schema diff to every client.
6. Server sends private `hand` messages to the asker and the target.
7. Clients see `lastAsk.at` change → run the card-flight animation.

### Server

* **Single room class** (`server/src/room.ts`) handles join, leave, and command messages.
* **Pure rule functions** (`server/src/rules.ts`) — `applyAsk`, `applyDeclare`, `applyPass`. They mutate the synced state and a server-only `HandStore` map.
* **Schema** (`server/src/schema.ts`) — only public fields (no hands).
* **Bot AI** (`server/src/bot.ts`) — four tiers (easy → expert). Each bot only knows what it *remembers* of the public asks (memory fades by tier), declares from its beliefs (so it can get them wrong), and picks among good moves with weighted randomness. `playBotTurn` is the single entry point used by the room and the sim.
* **Disconnects** — the seat flips to autopilot in place (same hand, same turn order) and flips back on reconnect. Grace window: `LIT_RECONNECT_GRACE_S` (default 300).
* **Checks** — `npm run test:integration -w server`, `npm run sim -w server` (bot-only games: hang detection + win-rate matrix), `npm run smoke -w server` (against a running server).

### Client

* **`game` singleton** (`client/src/lib/client.svelte.ts`) — wraps the Colyseus connection, mirrors synced state into Svelte 5 runes, exposes commands.
* **Views**: `Landing`, `Lobby`, `Game` — picked by `game.view`.
* **Animations**: card flight uses Motion to fly an overlay card between two DOM rects. Hand reordering uses Svelte's built-in `animate:flip`. Score pop, seat glow, and toasts are CSS-driven.

### Why this stack

| Layer | Pick | Why |
|---|---|---|
| Server | **Colyseus** | Purpose-built for multiplayer rooms — schema diff, lobby, reconnection, monitor, all in one. |
| UI | **Svelte 5** | Smallest runtime of the well-known frameworks; runes give clean reactive state without boilerplate. |
| Animations | **Motion** | Tiny (~5kb), declarative, perfect for the "fly between two DOM rects" pattern. |

## Production

```bash
npm install
npm run build   # builds shared, server, then client into client/dist/
npm start       # runs the server, which also serves client/dist on the same port
```

In production the Node server (`server/src/index.ts`) serves the built
Svelte SPA from `client/dist/` at `/`, plus Colyseus matchmaking at
`/matchmake/*` and the WebSocket upgrade on the same port. One URL, no CORS.

## Deploying to Render

The repo ships with a [`render.yaml`](render.yaml) blueprint, so Render
sets everything up automatically.

1. Push this repo to GitHub.
2. In Render → **New +** → **Blueprint** → connect your repo.
3. Render reads `render.yaml`, runs `npm install && npm run build`, then `npm start`. Your app is live at `https://<service-name>.onrender.com`.

The free plan spins the service down after 15 minutes of inactivity (next
visitor waits ~30s on cold start). Bump the `plan:` field in `render.yaml`
to `starter` ($7/mo) for always-on if friends will use the link without
warning.

### Other hosts

The same `npm install && npm run build && npm start` setup works on Fly.io,
Railway, Heroku, anywhere that runs a Node web service with WebSocket
support. The server reads `PORT` from the environment (every host sets it).

