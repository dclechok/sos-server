// sockets/socket.js (OPEN WORLD MMO + GLOBAL CHAT) — ARPG CLICK/DRAG MOVE

const { ObjectId } = require("mongodb");
const { WORLD_SEED } = require("../world/worldSeed");
const { getTileId } = require("../world/worldTiles");
const { TILE, TERRAIN_ID } = require("../world/worldConstants");

// ✅ IMPORT the chunk + TTL helpers you already wrote
const { chunkKeyFromWorld, ttlMsForDefId } = require("../world/worldObjects");

const activePlayers = {}; // socket.id -> characterId
const playerMeta = {}; // socket.id -> { characterId, name, classId, role }

// Authoritative state
const shipState = {};

// Last input per player
const shipInput = {};

// Position save throttle
const lastSavedAt = {}; // socket.id -> timestamp
const SAVE_INTERVAL_MS = 5000;

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

  const insetN = isPassable(worldX, worldY + SHORE_INSET);
  const insetS = isPassable(worldX, worldY - SHORE_INSET);
  const insetE = isPassable(worldX - SHORE_INSET, worldY);
  const insetW = isPassable(worldX + SHORE_INSET, worldY);

  return insetN || insetS || insetE || insetW;
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

module.exports = function socketHandler(io) {
  // ======================================================
  // Tunables
  // ======================================================
  const TICK_HZ = 20;
  const DT = 1 / TICK_HZ;

  const SNAPSHOT_HZ = 20;

  const MAX_SPEED = 45;
  const SLOW_RADIUS = 30;
  const STOP_EPS = 0.75;

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
      if (dx * dx + dy * dy <= VIEW_RADIUS_SQ) {
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
  // Authoritative physics tick
  // ======================================================
  setInterval(() => {
    const now = Date.now();

    for (const [id, p] of Object.entries(shipState)) {
      if (!p) continue;

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

        const dirx = dist > 0 ? dx / dist : 0;
        const diry = dist > 0 ? dy / dist : 0;

        if (dist <= STOP_EPS) {
          if (canStandAt(tx, ty)) {
            p.x = tx;
            p.y = ty;
          }
          p.vx = 0;
          p.vy = 0;
          p.moveTarget = null;
        } else {
          const slowFactor = clamp01(dist / SLOW_RADIUS);
          const speed = MAX_SPEED * slowFactor;

          p.vx = dirx * speed;
          p.vy = diry * speed;
          p.facing = dx < 0 ? "left" : "right";
          p.angle = Math.atan2(dy, dx);

          const step = speed * DT;

          if (step >= dist) {
            if (canStandAt(tx, ty)) {
              p.x = tx;
              p.y = ty;
            }
            p.vx = 0;
            p.vy = 0;
            p.moveTarget = null;
          } else {
            const newX = p.x + dirx * step;
            const newY = p.y + diry * step;

            if (canStandAt(newX, newY)) {
              p.x = newX;
              p.y = newY;
            } else if (canStandAt(newX, p.y)) {
              p.x = newX;
            } else if (canStandAt(p.x, newY)) {
              p.y = newY;
            } else {
              p.vx = 0;
              p.vy = 0;
              p.moveTarget = null;
            }
          }
        }
      } else {
        p.vx = 0;
        p.vy = 0;
      }

      const lastSave = lastSavedAt[id] || 0;
      if (now - lastSave >= SAVE_INTERVAL_MS) {
        lastSavedAt[id] = now;
        savePosition(id);
      }
    }
  }, 1000 / TICK_HZ);

  // ======================================================
  // Snapshot tick
  // ======================================================
  setInterval(() => {
    const now = Date.now();

    for (const [socketId] of Object.entries(activePlayers)) {
      const sock = io.sockets.sockets.get(socketId);
      if (!sock || !shipState[socketId]) continue;

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

      const cleanMsg = String(message ?? "")
        .trim()
        .slice(0, CHAT_MSG_MAX);
      if (!cleanMsg) return;

      const serverName = safeNameFromMeta(socket.id) || "Unknown";
      const payload = { user: serverName, message: cleanMsg, at: now };

      pushChat(payload);
      io.emit("newMessage", payload);
    });

    // --------------------------------------------------
    // SPAWN OBJECT (admin or system) — realtime
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

        const ttlMs = ttlMsForDefId(defId);

        const doc = {
          worldId: "main",
          kind: "dynamic",
          defId: String(defId),
          x: tx,
          y: ty,
          chunkKey: chunkKeyFromWorld(tx, ty), // ✅ now defined
          ownerId: meta.characterId || null,
          state: state || {},
          createdAt: now,
          expiresAt: new Date(now.getTime() + ttlMs),
        };

        const result = await db.collection("world_objects").insertOne(doc);
        const saved = { ...doc, _id: result.insertedId };

        io.emit("obj:spawn", saved);
      } catch (e) {
        console.error("world:spawnObject failed:", e);
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
          name,
          classId,
          role: resolvedRole,
        };

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
      p.vx = 0;
      p.vy = 0;
      p.lastSeenAt = Date.now();
    });

    // --------------------------------------------------
    // ADMIN TELEPORT
    // --------------------------------------------------
    socket.on("teleport", ({ x, y } = {}) => {
      const meta = playerMeta[socket.id];
      console.log("teleport received:", { x, y, role: meta?.role, socketId: socket.id });

      if (!meta?.role || !ADMIN_ROLES.has(meta.role)) {
        console.log("teleport BLOCKED — role not in ADMIN_ROLES:", meta?.role);
        return;
      }

      const p = shipState[socket.id];
      if (!p) return;

      const tx = Number(x);
      const ty = Number(y);
      if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;

      p.x = tx;
      p.y = ty;
      p.vx = 0;
      p.vy = 0;
      p.moveTarget = null;
      p.lastSeenAt = Date.now();

      console.log("teleport SUCCESS → snapped to:", { x: tx, y: ty });

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