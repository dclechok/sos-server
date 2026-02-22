// sockets/socket.js (OPEN WORLD MMO + GLOBAL CHAT) — ARPG CLICK/DRAG MOVE
//
// ✅ Position persistence:
// - identify() reads x/y from currentLoc in MongoDB (falls back to defaults)
// - Physics tick auto-saves position to MongoDB every SAVE_INTERVAL_MS (5s)
// - On disconnect, position is saved immediately
// - class-based sprites: identify() loads `class` from player_data
//

const { ObjectId } = require("mongodb");
const { WORLD_SEED } = require("../world/worldSeed");

const activePlayers = {}; // socket.id -> characterId
const playerMeta = {}; // socket.id -> { characterId, name, classId }

// Authoritative state
// socket.id -> { x, y, vx, vy, angle, facing, moveTarget, lastSeenAt }
const shipState = {};

// Last input per player (kept for compatibility; not used for ARPG click-move)
const shipInput = {};

// Position save throttle
const lastSavedAt = {}; // socket.id -> timestamp
const SAVE_INTERVAL_MS = 5000; // save position every 5 seconds

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

// ------------------------------
// HELPERS
// ------------------------------

// Fire-and-forget position save to MongoDB
async function savePosition(socketId) {
  const p = shipState[socketId];
  const meta = playerMeta[socketId];
  if (!p || !meta?.characterId) return;

  try {
    const db = require("../config/db").getDB();
    await db.collection("player_data").updateOne(
      { _id: new ObjectId(meta.characterId) },
      { $set: { "currentLoc.x": p.x, "currentLoc.y": p.y } }
    );
  } catch (err) {
    console.error("position save error:", err);
  }
}

module.exports = function socketHandler(io) {
  // ======================================================
  // Tunables
  // ======================================================
  const TICK_HZ = 20; // physics tick
  const DT = 1 / TICK_HZ;

  const SNAPSHOT_HZ = 20;

  // ARPG Movement
  const MAX_SPEED = 45; // px/sec
  const SLOW_RADIUS = 30; // slow down within this distance
  const STOP_EPS = 0.75; // stop when within this distance

  // Interest management
  const VIEW_RADIUS = 2400;
  const VIEW_RADIUS_SQ = VIEW_RADIUS * VIEW_RADIUS;

  function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  function safeNameFromMeta(socketId) {
    const n = playerMeta[socketId]?.name;
    if (!n) return null;
    const s = String(n).trim();
    if (!s) return null;
    return s.slice(0, CHAT_NAME_MAX);
  }

  // Snapshot builder — includes vx/vy, ts, facing, name, class per player
  function buildNearbySnapshot(meId, now) {
    const me = shipState[meId];
    if (!me) return {};

    const players = {};
    const mx = me.x;
    const my = me.y;

    for (const [id, p] of Object.entries(shipState)) {
      if (!p) continue;

      const name = playerMeta[id]?.name || null;
      const classId = playerMeta[id]?.classId || null;

      if (id === meId) {
        players[id] = {
          x: p.x,
          y: p.y,
          vx: p.vx,
          vy: p.vy,
          angle: p.angle,
          facing: p.facing || "right",
          name,
          class: classId,
          ts: now,
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
          facing: p.facing || "right",
          name,
          class: classId,
          ts: now,
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

      // ARPG click-to-move: no inertia. Always b-line to target.
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

        if (dist <= STOP_EPS) {
          // finish cleanly
          p.x = tx;
          p.y = ty;
          p.vx = 0;
          p.vy = 0;
          p.moveTarget = null;
        } else {
          const dirx = dx / dist;
          const diry = dy / dist;

          // smooth decel near target (linear-to-zero within slow radius)
          const slowFactor = clamp01(dist / SLOW_RADIUS);
          const speed = MAX_SPEED * slowFactor;

          // velocity points directly at target
          p.vx = dirx * speed;
          p.vy = diry * speed;

          // face direction (left/right)
          p.facing = dx < 0 ? "left" : "right";

          // keep angle for legacy client usage
          p.angle = Math.atan2(dy, dx);

          // integrate without overshoot
          const step = speed * DT;
          if (step >= dist) {
            p.x = tx;
            p.y = ty;
            p.vx = 0;
            p.vy = 0;
            p.moveTarget = null;
          } else {
            p.x += dirx * step;
            p.y += diry * step;
          }
        }
      } else {
        // no target => no drift
        p.vx = 0;
        p.vy = 0;
      }

      // ✅ Throttled position save — fires every SAVE_INTERVAL_MS
      const lastSave = lastSavedAt[id] || 0;
      if (now - lastSave >= SAVE_INTERVAL_MS) {
        lastSavedAt[id] = now;
        savePosition(id);
      }
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
        players: buildNearbySnapshot(socketId, now),
        t: now,
      });
    }
  }, 1000 / SNAPSHOT_HZ);

  // ======================================================
  // Socket connections
  // ======================================================
  io.on("connection", (socket) => {
    socket.emit("world:init", { worldSeed: WORLD_SEED });
    socket.emit("chatHistory", chatHistory);

    shipInput[socket.id] = { thrust: false, targetAngle: 0, lastAt: Date.now() };

    // --------------------------------------------------
    // CHAT
    // --------------------------------------------------
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

    // --------------------------------------------------
    // IDENTIFY — bind characterId + spawn from DB
    // ✅ Restores last saved position from currentLoc
    // --------------------------------------------------
    socket.on("identify", async ({ characterId } = {}) => {
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
          { projection: { currentLoc: 1, charName: 1, class: 1 } }
        );

        if (!player) {
          socket.emit("sceneError", { error: "Character not found." });
          return;
        }

        // ✅ Restore last saved position, fall back to default spawn
        const DEFAULT_X = 11686;
        const DEFAULT_Y = 13578;
        const x = Number(player?.currentLoc?.x ?? DEFAULT_X);
        const y = Number(player?.currentLoc?.y ?? DEFAULT_Y);

        const nameRaw = String(player?.charName ?? "").trim();
        const name = nameRaw ? nameRaw.slice(0, CHAT_NAME_MAX) : null;

        const classId = String(player?.class ?? "").trim() || null;

        playerMeta[socket.id] = { characterId: String(characterId), name, classId };

        shipState[socket.id] = {
          x,
          y,
          vx: 0,
          vy: 0,
          angle: 0,
          facing: "right",
          moveTarget: null,
          lastSeenAt: Date.now(),
        };

        // Seed the save timer so we don't immediately save on join
        lastSavedAt[socket.id] = Date.now();

        socket.emit("player:self", {
          id: socket.id,
          ship: { ...shipState[socket.id], name, class: classId },
        });

        const now = Date.now();
        socket.emit("world:snapshot", {
          players: buildNearbySnapshot(socket.id, now),
          t: now,
        });
      } catch (err) {
        console.error("identify error:", err);
        socket.emit("sceneError", { error: "Server error during identify." });
      }
    });

    // --------------------------------------------------
    // MOVE TO (client can spam this while holding RMB)
    // --------------------------------------------------
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

    // --------------------------------------------------
    // MOVE CANCEL (optional "stop" key)
    // --------------------------------------------------
    socket.on("player:moveCancel", () => {
      if (!activePlayers[socket.id]) return;
      const p = shipState[socket.id];
      if (!p) return;

      p.moveTarget = null;
      p.vx = 0;
      p.vy = 0;
      p.lastSeenAt = Date.now();
    });

    // --------------------------------------------------
    // LEGACY INPUT (not used for ARPG move, kept for compat)
    // --------------------------------------------------
    socket.on("player:input", ({ thrust, targetAngle } = {}) => {
      if (!activePlayers[socket.id]) return;
      if (!shipState[socket.id]) return;

      const now = Date.now();
      const ta = Number(targetAngle);

      shipInput[socket.id] = {
        thrust: !!thrust,
        targetAngle: Number.isFinite(ta)
          ? ta
          : shipInput[socket.id]?.targetAngle,
        lastAt: now,
      };

      shipState[socket.id].lastSeenAt = now;
    });

    // --------------------------------------------------
    // DISCONNECT — save position immediately
    // --------------------------------------------------
    socket.on("disconnect", () => {
      // ✅ Final position save on disconnect so no progress is lost
      savePosition(socket.id);

      delete activePlayers[socket.id];
      delete shipState[socket.id];
      delete shipInput[socket.id];
      delete playerMeta[socket.id];
      delete lastChatAt[socket.id];
      delete lastSavedAt[socket.id];
    });
  });
};