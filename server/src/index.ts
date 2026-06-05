/**
 * Server bootstrap. Exposes Colyseus over WebSockets and a tiny HTTP layer
 * for health checks. In production this same Node process also serves the
 * built Svelte client out of ../client/dist, so a single Render service
 * (or any Node host) handles both the SPA and the realtime channel on
 * one origin — no CORS, one URL, one deploy.
 */

import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, statSync } from "node:fs";
import express from "express";
import cors from "cors";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { LiteratureRoom } from "./room.js";

const PORT = parseInt(process.env.PORT ?? "2567", 10);

const app = express();
app.use(cors());
app.get("/health", (_req, res) => res.json({ ok: true }));

// ── Serve the built SPA in production ────────────────────────
//
// We resolve `client/dist` relative to the server's *built* location,
// so it works whether the user runs `node server/dist/index.js` from the
// monorepo root or from inside the server directory. If the build hasn't
// run (dev mode, where Vite serves the client on :5173), this block is a
// no-op and Colyseus serves only its own routes.

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(__dirname, "..", "..", "client", "dist");
const indexHtml = path.join(clientDist, "index.html");
const hasClientBuild = existsSync(indexHtml) && statSync(indexHtml).isFile();

if (hasClientBuild) {
  // Long-cache hashed assets, no-cache the HTML so deploys roll out cleanly.
  app.use(
    express.static(clientDist, {
      index: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith(".html")) {
          res.setHeader("Cache-Control", "no-cache");
        } else {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );
  // SPA fallback for any non-API GET. We exclude `/matchmake` (Colyseus's
  // matchmaking endpoint) and `/health` so they keep their JSON responses.
  app.get(/^\/(?!matchmake|health).*/, (_req, res) => {
    res.sendFile(indexHtml);
  });
}

// Log uncaught exceptions to stderr so they're visible in Render's log viewer
// before Colyseus's internal handler calls gracefullyShutdown().
process.on("uncaughtException", (err) => {
  console.error("[lit-up] uncaughtException:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[lit-up] unhandledRejection:", reason);
});

const httpServer = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("literature", LiteratureRoom);

gameServer.listen(PORT).then(() => {
  console.log(`[lit-up] Colyseus listening on :${PORT}`);
  if (hasClientBuild) {
    console.log(`[lit-up] Serving client from ${clientDist}`);
  }
}).catch((err: unknown) => {
  console.error("[lit-up] Failed to start server:", err);
  process.exit(1);
});
