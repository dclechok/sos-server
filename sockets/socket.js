// sockets/socket.js (OPEN WORLD MMO + GLOBAL CHAT) — ARPG CLICK/DRAG MOVE

const { ObjectId } = require("mongodb");
const { WORLD_SEED } = require("../world/worldSeed");
const { getTileId } = require("../world/worldTiles");
const { TILE, TERRAIN_ID } = require("../world/worldConstants");

const {
  chunkKeyFromWorld,
  ttlMsForDefId,
} = require("../world/worldObjects");

const activePlayers = {};
const playerMeta = {};
const shipState = {};
const shipInput = {};
const lastSavedAt = {};
const SAVE_INTERVAL_MS = 5000;

// ------------------------------
// GLOBAL CHAT
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
const lastChatAt = {};

// ------------------------------
// TERRAIN COLLISION
// ------------------------------
const BLOCKS_MOVEMENT = new Set([TERRAIN_ID.DEEP_OCEAN, TERRAIN_ID.UNKNOWN]);
const SHORE_INSET = TILE * 0.5;

function isPassable(worldX, worldY) {
  const tileX = Math.floor(worldX / TILE);
  const tileY = Math.floor(worldY / TILE);
  const id = getTileId(tileX, tileY);
  return !BLOCKS_MOVEMENT.has(id);
}

function canStandAt(worldX, worldY) {
  if (isPassable(worldX, worldY)) return true;
  return (
    isPassable(worldX, worldY + SHORE_INSET) ||
    isPassable(worldX, worldY - SHORE_INSET) ||
    isPassable(worldX - SHORE_INSET, worldY) ||
    isPassable(worldX + SHORE_INSET, worldY)
  );
}

// ------------------------------
// HELPERS
// ------------------------------
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

const ADMIN_ROLES = new Set(["admin", "owner"]);

function resolveDecayTimeMs({ defId, state }) {
  const raw = state?.decayTimeMs ?? state?.defaultTTLms;
  const n = Number(raw);
  if (Number.isFinite(n)) {
    if (n <= 0) return 0;
    return Math.floor(n);
  }
  const fallback = Number(ttlMsForDefId(defId));
  if (!Number.isFinite(fallback) || fallback <= 0) return 0;
  return Math.floor(fallback);
}

module.exports = function socketHandler(io) {
  // ======================================================
  // Tunables
  // ======================================================
  const TICK_HZ = 30;           // ✅ raised from 20 → 30 for smoother movement
  const TICK_MS = 1000 / TICK_HZ;
  const DT = 1 / TICK_HZ;

  const MAX_SPEED = 45;
  const SLOW_RADIUS = 30;
  const STOP_EPS = 0.75;

  const VIEW_RADIUS = 2400;
  const VIEW_RADIUS_SQ = VIEW_RADIUS * VIEW_RADIUS;

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  function safeNameFromMeta(socketId) {
    const n = playerMeta[socketId]?.name;
    if (!n) return null;
    const s = String(n).trim();
    return s ? s.slice(0, CHAT_NAME_MAX) : null;
  }

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
          x: p.x, y: p.y,
          vx: p.vx, vy: p.vy,
          angle: p.angle,
          facing: p.facing || "right",
          name, class: classId, ts: now,
        };
        continue;
      }

      const dx = p.x - mx;
      const dy = p.y - my;
      if (dx * dx + dy * dy <= VIEW_RADIUS_SQ) {
        players[id] = {
          x: p.x, y: p.y,
          vx: p.vx, vy: p.vy,
          angle: p.angle,
          facing: p.facing || "right",
          name, class: classId, ts: now,
        };
      }
    }
    return players;
  }

  // ======================================================
  // Physics step (pure function, no I/O)
  // ======================================================
  function stepPlayer(p, dt) {
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
        if (canStandAt(tx, ty)) { p.x = tx; p.y = ty; }
        p.vx = 0; p.vy = 0;
        p.moveTarget = null;
      } else {
        const dirx = dx / dist;
        const diry = dy / dist;
        const slowFactor = clamp01(dist / SLOW_RADIUS);
        const speed = MAX_SPEED * slowFactor;
        const step = speed * dt;

        p.vx = dirx * speed;
        p.vy = diry * speed;
        p.facing = dx < 0 ? "left" : "right";
        p.angle = Math.atan2(dy, dx);

        if (step >= dist) {
          if (canStandAt(tx, ty)) { p.x = tx; p.y = ty; }
          p.vx = 0; p.vy = 0;
          p.moveTarget = null;
        } else {
          const newX = p.x + dirx * step;
          const newY = p.y + diry * step;

          if (canStandAt(newX, newY)) {
            p.x = newX; p.y = newY;
          } else if (canStandAt(newX, p.y)) {
            p.x = newX;
          } else if (canStandAt(p.x, newY)) {
            p.y = newY;
          } else {
            p.vx = 0; p.vy = 0;
            p.moveTarget = null;
          }
        }
      }
    } else {
      p.vx = 0; p.vy = 0;
    }
  }

  // ======================================================
  // ✅ UNIFIED game loop — physics + snapshot in one tick
  //
  // Why: two separate setInterval calls drift against each other,
  // so snapshots were sometimes sent with stale positions from the
  // previous tick. Merging them guarantees snapshots always contain
  // the freshest physics state.
  //
  // Why hrtime accumulator instead of setInterval:
  // setInterval on Node.js fires late and bunches up under load.
  // At 30hz that means gaps of 25ms, 45ms, 55ms instead of a steady
  // 33ms — the client sees irregular jumps. An hrtime accumulator
  // fires with sub-millisecond accuracy regardless of event loop load.
  // ======================================================
  let lastHrtime = process.hrtime.bigint();
  let accumMs = 0;

  const gameLoop = setInterval(() => {
    const now = process.hrtime.bigint();
    // elapsed in ms, capped at 200ms to prevent spiral-of-death on lag spike
    const elapsedMs = Math.min(Number(now - lastHrtime) / 1_000_000, 200);
    lastHrtime = now;

    accumMs += elapsedMs;

    // Fixed-timestep: consume accumulated time in TICK_MS chunks
    let ticked = false;
    while (accumMs >= TICK_MS) {
      accumMs -= TICK_MS;
      ticked = true;

      const wallNow = Date.now();

      // Physics
      for (const [id, p] of Object.entries(shipState)) {
        if (!p) continue;
        stepPlayer(p, DT);

        // Position save throttle
        const lastSave = lastSavedAt[id] || 0;
        if (wallNow - lastSave >= SAVE_INTERVAL_MS) {
          lastSavedAt[id] = wallNow;
          savePosition(id);
        }
      }
    }

    // ✅ Send snapshot once per real-world interval, immediately after physics
    // This guarantees zero stale-frame lag between physics and what clients see.
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

  // Run the outer interval at ~2x tick rate so the accumulator always has
  // fresh elapsed time to work with. The actual tick rate is controlled by
  // TICK_MS above — this interval is just a timer source.
  }, Math.floor(TICK_MS / 2));

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
    // SPAWN OBJECT (admin)
    // --------------------------------------------------
    socket.on("world:spawnObject", async ({ defId, x, y, state } = {}) => {
      const meta = playerMeta[socket.id];
      if (!meta?.role || !ADMIN_ROLES.has(meta.role)) return;

      const tx = Number(x);
      const ty = Number(y);
      if (!defId || !Number.isFinite(tx) || !Number.isFinite(ty)) return;

      try {
        const db = require("../config/db").getDB();
        const now = new Date();
        const decayTimeMs = resolveDecayTimeMs({ defId, state });
        const doc = {
          worldId: "main",
          kind: "dynamic",
          defId: String(defId),
          x: tx, y: ty,
          chunkKey: chunkKeyFromWorld(tx, ty),
          ownerId: meta.characterId || null,
          state: { ...(state || {}), decayTimeMs },
          createdAt: now,
        };
        if (decayTimeMs > 0) doc.expiresAt = new Date(now.getTime() + decayTimeMs);

        const result = await db.collection("world_objects").insertOne(doc);
        io.emit("obj:spawn", { ...doc, _id: result.insertedId });
      } catch (e) {
        console.error("world:spawnObject failed:", e);
      }
    });

    // --------------------------------------------------
    // DELETE OBJECT (admin)
    // --------------------------------------------------
    socket.on("world:deleteObject", async ({ id } = {}) => {
      const meta = playerMeta[socket.id];
      if (!meta?.role || !ADMIN_ROLES.has(meta.role)) return;

      let oid;
      try { oid = new ObjectId(String(id)); }
      catch { socket.emit("sceneError", { error: "Invalid object id." }); return; }

      try {
        const db = require("../config/db").getDB();
        const res = await db.collection("world_objects").deleteOne({ _id: oid });
        if (!res?.deletedCount) {
          socket.emit("sceneError", { error: "Object not found (already deleted?)." });
          return;
        }
        io.emit("obj:delete", { id: String(oid) });
      } catch (e) {
        console.error("world:deleteObject failed:", e);
      }
    });

    // --------------------------------------------------
    // IDENTIFY
    // --------------------------------------------------
    socket.on("identify", async ({ characterId, role: clientRole } = {}) => {
      if (!characterId) {
        socket.emit("sceneError", { error: "Missing characterId." });
        return;
      }

      let oid;
      try { oid = new ObjectId(String(characterId)); }
      catch { socket.emit("sceneError", { error: "Invalid characterId." }); return; }

      activePlayers[socket.id] = String(characterId);

      try {
        const db = require("../config/db").getDB();
        const player = await db.collection("player_data").findOne(
          { _id: oid },
          { projection: { currentLoc: 1, charName: 1, class: 1, role: 1 } }
        );

        if (!player) {
          socket.emit("sceneError", { error: "Character not found." });
          return;
        }

        const DEFAULT_X = 11686;
        const DEFAULT_Y = 13578;
        const x = Number(player?.currentLoc?.x ?? DEFAULT_X);
        const y = Number(player?.currentLoc?.y ?? DEFAULT_Y);

        const nameRaw = String(player?.charName ?? "").trim();
        const name = nameRaw ? nameRaw.slice(0, CHAT_NAME_MAX) : null;
        const classId = String(player?.class ?? "").trim() || null;
        const dbRole = String(player?.role ?? "").trim() || null;
        const resolvedRole = dbRole || String(clientRole ?? "").trim() || null;

        playerMeta[socket.id] = {
          characterId: String(characterId),
          name, classId, role: resolvedRole,
        };

        shipState[socket.id] = {
          x, y, vx: 0, vy: 0,
          angle: 0, facing: "right",
          moveTarget: null,
          lastSeenAt: Date.now(),
        };

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
    // MOVE TO
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
    // MOVE CANCEL
    // --------------------------------------------------
    socket.on("player:moveCancel", () => {
      if (!activePlayers[socket.id]) return;
      const p = shipState[socket.id];
      if (!p) return;
      p.moveTarget = null;
      p.vx = 0; p.vy = 0;
      p.lastSeenAt = Date.now();
    });

    // --------------------------------------------------
    // ADMIN TELEPORT
    // --------------------------------------------------
    socket.on("teleport", ({ x, y } = {}) => {
      const meta = playerMeta[socket.id];
      if (!meta?.role || !ADMIN_ROLES.has(meta.role)) return;

      const p = shipState[socket.id];
      if (!p) return;

      const tx = Number(x);
      const ty = Number(y);
      if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;

      p.x = tx; p.y = ty;
      p.vx = 0; p.vy = 0;
      p.moveTarget = null;
      p.lastSeenAt = Date.now();

      socket.emit("teleported", { x: tx, y: ty });
    });

    // --------------------------------------------------
    // LEGACY INPUT
    // --------------------------------------------------
    socket.on("player:input", ({ thrust, targetAngle } = {}) => {
      if (!activePlayers[socket.id]) return;
      if (!shipState[socket.id]) return;

      const now = Date.now();
      const ta = Number(targetAngle);
      shipInput[socket.id] = {
        thrust: !!thrust,
        targetAngle: Number.isFinite(ta) ? ta : shipInput[socket.id]?.targetAngle,
        lastAt: now,
      };
      shipState[socket.id].lastSeenAt = now;
    });

    // --------------------------------------------------
    // DISCONNECT
    // --------------------------------------------------
    socket.on("disconnect", () => {
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