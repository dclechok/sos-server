// server/sockets/socket.js
// Entry point — sets up the game loop and delegates to sub-modules.
//
// Sub-modules:
//   collision.js   — solid object registry + terrain/object collision
//   chat.js        — global chat history + rate limiting
//   playerState.js — per-player state maps, physics, snapshots, DB saves
//   handlers.js    — all socket event handlers

console.log("🔥 USING server/sockets/socket.js FROM:", __filename);

const { WORLD_SEED }       = require("../world/worldSeed");
const { chatHistory }      = require("./chat");
const { activePlayers, shipState, buildNearbySnapshot, tickAll } = require("./playerState");
const { registerHandlers } = require("./handlers");

module.exports = function socketHandler(io) {
  // ── TUNABLES ─────────────────────────────────────────
  const TICK_HZ = 30;
  const TICK_MS = 1000 / TICK_HZ;
  const DT      = 1 / TICK_HZ;

  // ── GAME LOOP ─────────────────────────────────────────
  let lastHrtime = process.hrtime.bigint();
  let accumMs    = 0;

  const gameLoop = setInterval(() => {
    const now       = process.hrtime.bigint();
    const elapsedMs = Math.min(Number(now - lastHrtime) / 1_000_000, 200);
    lastHrtime      = now;
    accumMs        += elapsedMs;

    let ticked = false;
    while (accumMs >= TICK_MS) {
      accumMs -= TICK_MS;
      ticked   = true;
      tickAll(Date.now(), DT);
    }

    if (ticked) {
      const snapNow = Date.now();
      for (const [socketId] of Object.entries(activePlayers)) {
        const sock = io.sockets.sockets.get(socketId);
        if (!sock || !shipState[socketId]) continue;
        sock.emit("world:snapshot", {
          players: buildNearbySnapshot(socketId, snapNow),
          t: snapNow,
        });
      }
    }
  }, Math.floor(TICK_MS / 2));

  // ── CONNECTIONS ───────────────────────────────────────
  io.on("connection", (socket) => {
    socket.emit("world:init", { worldSeed: WORLD_SEED });
    socket.emit("chatHistory", chatHistory);
    registerHandlers(socket, io);
  });

  return () => clearInterval(gameLoop);
};