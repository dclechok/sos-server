// sockets/socket.js (OPEN WORLD MMO + GLOBAL CHAT) — CLICK/DRAG-TO-MOVE (NO OVERSHOOT / NO SPIN / NO FLOP)
//
// Key fixes vs your version:
// 1) Arrival is DISTANCE-ONLY: when within ARRIVE_RADIUS, we SNAP to target, ZERO velocity, CLEAR moveTarget.
// 2) No "minimum arrive speed" creep.
// 3) Slow zone compares speed ALONG the target direction (speedToward).
// 4) FACE_LOCK_RADIUS prevents last-moment atan2 flips.
//
// ✅ UPDATE INCLUDED:
// - world:snapshot now includes vx/vy per player (for buttery client prediction).
// - Snapshot still includes server timestamp `t`.
//
// NOTE: This file assumes your existing imports/paths are correct.

const { ObjectId } = require("mongodb");
const { WORLD_SEED } = require("../world/worldSeed");

const activePlayers = {}; // socket.id -> characterId
const playerMeta = {}; // socket.id -> { characterId, name }

// Authoritative ship state
// socket.id -> { x, y, vx, vy, angle, moveTarget, lastSeenAt }
const shipState = {};

// Last input per player
// socket.id -> { thrust, targetAngle?, lastAt }
const shipInput = {};

// ------------------------------
// GLOBAL CHAT (server-wide)
// ------------------------------
const CHAT_MAX = 100;
const chatHistory = [];

function pushChat(msg) {
  chatHistory.push(msg);
  if (chatHistory.length > CHAT_MAX) {
    chatHistory.splice(0, chatHistory.length - CHAT_MAX);
  }
}

const CHAT_MIN_INTERVAL_MS = 800;
const CHAT_MSG_MAX = 240;
const CHAT_NAME_MAX = 24;
const lastChatAt = {}; // socket.id -> timestamp

module.exports = function socketHandler(io) {
  // ======================================================
  // Tunables
  // ======================================================
  const TICK_HZ = 20; // physics tick
  const DT = 1 / TICK_HZ;

  const SNAPSHOT_HZ = 20; // network snapshot rate (20Hz feels way better)

  // Movement
  const TURN_RATE = 4.5; // rad/sec
  const THRUST = 180; // px/sec^2
  const DRAG = 0.92; // per-tick damping
  const MAX_SPEED = 320; // px/sec cap

  // Click-to-move autopilot
  const SLOW_RADIUS = 120;
  const ARRIVE_RADIUS = 14;

  const FACE_LOCK_RADIUS = 28;

  const ARRIVE_K = 2.2;
  const MAX_ARRIVE_SPEED = 170;
  const ARRIVE_DRAG = 0.84;

  // Interest management
  const VIEW_RADIUS = 2400;
  const VIEW_RADIUS_SQ = VIEW_RADIUS * VIEW_RADIUS;

  const INPUT_STALE_MS = 2000;

  function clamp(x, a, b) {
    return x < a ? a : x > b ? b : x;
  }

  function wrapAngle(a) {
    while (a <= -Math.PI) a += Math.PI * 2;
    while (a > Math.PI) a -= Math.PI * 2;
    return a;
  }

  function turnToward(current, target, maxDelta) {
    let d = wrapAngle(target - current);
    if (d > maxDelta) d = maxDelta;
    if (d < -maxDelta) d = -maxDelta;
    return wrapAngle(current + d);
  }

  function safeNameFromMeta(socketId) {
    const n = playerMeta[socketId]?.name;
    if (!n) return null;
    const s = String(n).trim();
    if (!s) return null;
    return s.slice(0, CHAT_NAME_MAX);
  }

  // ✅ Snapshot builder now includes vx/vy for remote prediction
  function buildNearbySnapshot(meId) {
    const me = shipState[meId];
    if (!me) return {};

    const players = {};
    const mx = me.x;
    const my = me.y;

    for (const [id, p] of Object.entries(shipState)) {
      if (!p) continue;

      const name = playerMeta[id]?.name || null;

      if (id === meId) {
        players[id] = {
          x: p.x,
          y: p.y,
          vx: p.vx,
          vy: p.vy,
          angle: p.angle,
          name,
        };
        continue;
      }

      const dx = p.x - mx;
      const dy = p.y - my;
      const d2 = dx * dx + dy * dy;

      if (d2 <= VIEW_RADIUS_SQ) {
        players[id] = {
          x: p.x,
          y: p.y,
          vx: p.vx,
          vy: p.vy,
          angle: p.angle,
          name,
        };
      }
    }

    return players;
  }

  // ======================================================
  // Authoritative physics tick (fixed rate)
  // ======================================================
  setInterval(() => {
    const now = Date.now();

    for (const [id, p] of Object.entries(shipState)) {
      if (!p) continue;

      const inp = shipInput[id];

      const manualThrust =
        inp && now - (inp.lastAt || 0) <= INPUT_STALE_MS ? !!inp.thrust : false;

      let desiredAngle = p.angle;
      let thrusting = manualThrust;

      if (
        p.moveTarget &&
        Number.isFinite(p.moveTarget.x) &&
        Number.isFinite(p.moveTarget.y)
      ) {
        const tx = p.moveTarget.x;
        const ty = p.moveTarget.y;

        const dx = tx - p.x;
        const dy = ty - p.y;
        const dist = Math.hypot(dx, dy);

        if (dist <= ARRIVE_RADIUS) {
          // snap+stop
          p.x = tx;
          p.y = ty;
          p.vx = 0;
          p.vy = 0;
          p.moveTarget = null;
          thrusting = false;
          desiredAngle = p.angle;
        } else {
          if (dist > FACE_LOCK_RADIUS) desiredAngle = Math.atan2(dy, dx);

          if (dist > SLOW_RADIUS) {
            thrusting = true;
          } else {
            const inv = 1 / dist;
            const dirx = dx * inv;
            const diry = dy * inv;

            const speedToward = p.vx * dirx + p.vy * diry;
            const desiredSpeed = clamp(dist * ARRIVE_K, 0, MAX_ARRIVE_SPEED);

            thrusting = speedToward < desiredSpeed;

            if (speedToward > desiredSpeed) {
              p.vx *= ARRIVE_DRAG;
              p.vy *= ARRIVE_DRAG;
            } else {
              p.vx *= 0.985;
              p.vy *= 0.985;
            }
          }
        }
      } else {
        const hasFreshAngle =
          inp &&
          now - (inp.lastAt || 0) <= INPUT_STALE_MS &&
          Number.isFinite(inp.targetAngle);

        if (hasFreshAngle) desiredAngle = inp.targetAngle;
      }

      p.angle = turnToward(p.angle, desiredAngle, TURN_RATE * DT);

      if (thrusting) {
        p.vx += Math.cos(p.angle) * THRUST * DT;
        p.vy += Math.sin(p.angle) * THRUST * DT;
      }

      p.vx *= DRAG;
      p.vy *= DRAG;

      const sp = Math.hypot(p.vx, p.vy);
      if (sp > MAX_SPEED) {
        const k = MAX_SPEED / sp;
        p.vx *= k;
        p.vy *= k;
      }

      p.x += p.vx * DT;
      p.y += p.vy * DT;
    }
  }, 1000 / TICK_HZ);

  // ======================================================
  // Snapshot tick (per-socket, interest-managed)
  // ======================================================
  setInterval(() => {
    const now = Date.now();

    for (const [socketId] of Object.entries(activePlayers)) {
      const sock = io.sockets.sockets.get(socketId);
      if (!sock) continue;
      if (!shipState[socketId]) continue;

      sock.emit("world:snapshot", {
        players: buildNearbySnapshot(socketId),
        t: now,
      });
    }
  }, 1000 / SNAPSHOT_HZ);

  // ======================================================
  // Socket connections
  // ======================================================
  io.on("connection", (socket) => {
    // console.log("Client connected:", socket.id);

    socket.emit("world:init", { worldSeed: WORLD_SEED });
    socket.emit("chatHistory", chatHistory);

    shipInput[socket.id] = { thrust: false, targetAngle: 0, lastAt: Date.now() };

    socket.on("sendMessage", ({ message } = {}) => {
      const now = Date.now();

      const prev = lastChatAt[socket.id] || 0;
      if (now - prev < CHAT_MIN_INTERVAL_MS) return;
      lastChatAt[socket.id] = now;

      const cleanMsg = String(message ?? "").trim().slice(0, CHAT_MSG_MAX);
      if (!cleanMsg) return;

      const serverName = safeNameFromMeta(socket.id) || "Unknown";
      const payload = { user: serverName, message: cleanMsg, at: now };

      pushChat(payload);
      io.emit("newMessage", payload);
    });

    // identify: bind characterId + spawn ship from DB
    socket.on("identify", async ({ characterId } = {}) => {
      // console.log("identify:", socket.id, "=>", characterId);

      if (!characterId) {
        socket.emit("sceneError", { error: "Missing characterId." });
        return;
      }

      let oid;
      try {
        oid = new ObjectId(String(characterId));
      } catch {
        socket.emit("sceneError", { error: "Invalid characterId." });
        return;
      }

      activePlayers[socket.id] = String(characterId);

      try {
        const db = require("../config/db").getDB();
        const player = await db.collection("player_data").findOne(
          { _id: oid },
          { projection: { currentLoc: 1, charName: 1 } }
        );

        if (!player) {
          socket.emit("sceneError", { error: "Character not found." });
          return;
        }
        //default starting position

        const x = Number(11686);
        const y = Number(13578);

        const nameRaw = String(player?.charName ?? "").trim();
        const name = nameRaw ? nameRaw.slice(0, CHAT_NAME_MAX) : null;

        playerMeta[socket.id] = { characterId: String(characterId), name };

        shipState[socket.id] = {
          x,
          y,
          vx: 0,
          vy: 0,
          angle: 0,
          moveTarget: null,
          lastSeenAt: Date.now(),
        };

        socket.emit("player:self", {
          id: socket.id,
          ship: { ...shipState[socket.id], name },
        });

        socket.emit("world:snapshot", {
          players: buildNearbySnapshot(socket.id),
          t: Date.now(),
        });
      } catch (err) {
        console.error("identify error:", err);
        socket.emit("sceneError", { error: "Server error during identify." });
      }
    });

    // player:moveTo
    socket.on("player:moveTo", ({ x, y } = {}) => {
      if (!activePlayers[socket.id]) return;
      const p = shipState[socket.id];
      if (!p) return;

      const tx = Number(x);
      const ty = Number(y);
      if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;

      p.moveTarget = { x: tx, y: ty };
      p.lastSeenAt = Date.now();
    });

    socket.on("player:moveCancel", () => {
      if (!activePlayers[socket.id]) return;
      const p = shipState[socket.id];
      if (!p) return;

      p.moveTarget = null;
      p.lastSeenAt = Date.now();
    });

    // player:input
    socket.on("player:input", ({ thrust, targetAngle } = {}) => {
      if (!activePlayers[socket.id]) return;
      if (!shipState[socket.id]) return;

      const ta = Number(targetAngle);

      shipInput[socket.id] = {
        thrust: !!thrust,
        targetAngle: Number.isFinite(ta)
          ? ta
          : shipInput[socket.id]?.targetAngle,
        lastAt: Date.now(),
      };

      shipState[socket.id].lastSeenAt = Date.now();
    });

    socket.on("disconnect", () => {
      // console.log("Client disconnected:", socket.id);
      delete activePlayers[socket.id];
      delete shipState[socket.id];
      delete shipInput[socket.id];
      delete playerMeta[socket.id];
      delete lastChatAt[socket.id];
    });
  });
};
