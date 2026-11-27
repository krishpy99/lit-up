/**
 * Headless bot-only games against the REAL rules + bot turn (playBotTurn),
 * so what's measured here is exactly what players face.
 *
 * Asserts every game ends without a wedge, then prints per-tier stats and a
 * mixed-tier win-rate matrix. Exits non-zero on any hang.
 *
 * Run:  npx tsx scripts/sim.ts      Env: SIM_GAMES=400 SIM_H2H=40
 */

import { GameState, Player } from "../src/schema.js";
import { startGame, type HandStore, type TransactionLog } from "../src/rules.js";
import { playBotTurn } from "../src/bot.js";

type Diff = "easy" | "medium" | "hard" | "expert";
const DIFFS: Diff[] = ["easy", "medium", "hard", "expert"];
const GAMES = Number(process.env.SIM_GAMES ?? 400);
const H2H = Number(process.env.SIM_H2H ?? 40);
const MAX_TURNS = 2000;

function runGame(diffA: Diff, diffB: Diff, players = 6) {
  const state = new GameState();
  const hands: HandStore = new Map();
  const log: TransactionLog = [];
  for (let i = 0; i < players; i++) {
    const p = new Player();
    p.id = `p${i}`;
    p.name = `P${i}`;
    p.team = i % 2 === 0 ? "A" : "B";
    p.isBot = true;
    state.players.set(p.id, p);
  }
  startGame(state, hands, log);

  let turns = 0;
  let same = 0;
  let prev = "";
  while (state.status === "playing" && turns++ < MAX_TURNS) {
    same = state.turnId === prev ? same + 1 : 0;
    if (same > 60) break; // wedged
    prev = state.turnId;
    const team = state.players.get(state.turnId)?.team;
    playBotTurn(state, hands, log, state.turnId, team === "A" ? diffA : diffB);
  }
  const missed = [...state.actions].filter((a) => a.includes("missed declaring")).length;
  return { ended: state.status === "ended", turns, winner: state.winnerTeam, asks: log.length, missed };
}

let hung = 0;
console.log(`=== ${GAMES} same-tier games ===`);
console.log("diff     turns  asks  missed-declares/game");
for (const d of DIFFS) {
  let turns = 0, asks = 0, missed = 0;
  const n = Math.ceil(GAMES / DIFFS.length);
  for (let i = 0; i < n; i++) {
    const r = runGame(d, d);
    if (!r.ended) hung++;
    turns += r.turns; asks += r.asks; missed += r.missed;
  }
  console.log(`${d.padEnd(8)} ${(turns / n).toFixed(0).padStart(5)} ${(asks / n).toFixed(0).padStart(5)}  ${(missed / n).toFixed(2)}`);
}

console.log(`\n=== Win rate, team A (rows) vs team B (cols), ${H2H} games each ===`);
console.log("A\\B     " + DIFFS.map((d) => d.padStart(8)).join(""));
for (const a of DIFFS) {
  const row = DIFFS.map((b) => {
    let wins = 0;
    for (let i = 0; i < H2H; i++) {
      const r = runGame(a, b);
      if (!r.ended) hung++;
      if (r.winner === "A") wins++;
    }
    return `${Math.round((wins / H2H) * 100)}%`.padStart(8);
  });
  console.log(a.padEnd(8) + row.join(""));
}

console.log(hung ? `\n${hung} game(s) failed to finish!` : "\nAll games finished.");
process.exit(hung ? 1 : 0);
