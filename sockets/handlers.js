// server/sockets/handlers.js
// Registers all per-socket event handlers. Called once per connection.

const { ObjectId } = require("mongodb");
const { chunkKeyFromWorld, ttlMsForDefId } = require("../world/worldObjects");
const { registerSolidObjectFromDoc, unregisterSolidObject, canMoveToXY } = require("./collision");
const { chatHistory, tryChat, cleanupChat, CHAT_NAME_MAX } = require("./chat");
const {
  activePlayers, playerMeta, shipState, lastSavedAt,
  buildNearbySnapshot, cleanupPlayer,
} = require("./playerState");

const ADMIN_ROLES = new Set(["admin", "owner"]);

function resolveDecayTimeMs({ defId, state }) {
  const raw = state?.decayTimeMs ?? state?.defaultTTLms;
  const n   = Number(raw);
  if (Number.isFinite(n)) {
    if (n <= 0) return 0;
    return Math.floor(n);
  }
  const fallback = Number(ttlMsForDefId(defId));
  if (!Number.isFinite(fallback) || fallback <= 0) return 0;
  return Math.floor(fallback);
}

function safeNameFromMeta(socketId) {
  const n = playerMeta[socketId]?.name;
  if (!n) return null;
  const s = String(n).trim();
  return s ? s.slice(0, CHAT_NAME_MAX) : null;
}

/**
 * Register all handlers for a single socket.
 * @param {import('socket.io').Socket} socket
 * @param {import('socket.io').Server} io
 */
function registerHandlers(socket, io) {

  // ── CHAT ────────────────────────────────────────────
  socket.on("sendMessage", ({ message } = {}) => {
    const name    = safeNameFromMeta(socket.id) || "Unknown";
    const payload = tryChat(socket.id, message, name);
    if (payload) io.emit("newMessage", payload);
  });

  // ── SPAWN OBJECT (admin) ─────────────────────────────
  socket.on("world:spawnObject", async ({ defId, x, y, state } = {}) => {
    const meta = playerMeta[socket.id];
    if (!meta?.role || !ADMIN_ROLES.has(meta.role)) return;

    const tx = Number(x);
    const ty = Number(y);
    if (!defId || !Number.isFinite(tx) || !Number.isFinite(ty)) return;

    try {
      const db  = require("../config/db").getDB();
      const now = new Date();
      const decayTimeMs = resolveDecayTimeMs({ defId, state });

      const doc = {
        worldId:  "main",
        kind:     "dynamic",
        defId:    String(defId),
        x:        tx,
        y:        ty,
        chunkKey: chunkKeyFromWorld(tx, ty),
        ownerId:  meta.characterId || null,
        state:    { ...(state || {}), decayTimeMs },
        createdAt: now,
      };
      if (decayTimeMs > 0) doc.expiresAt = new Date(now.getTime() + decayTimeMs);

      const result   = await db.collection("world_objects").insertOne(doc);
      const inserted = { ...doc, _id: result.insertedId };

      registerSolidObjectFromDoc(inserted);
      io.emit("obj:spawn", inserted);
    } catch (e) {
      console.error("world:spawnObject failed:", e);
    }
  });

  // ── DELETE OBJECT (admin) ────────────────────────────
  socket.on("world:deleteObject", async ({ id } = {}) => {
    const meta = playerMeta[socket.id];
    if (!meta?.role || !ADMIN_ROLES.has(meta.role)) return;

    let oid;
    try { oid = new ObjectId(String(id)); }
    catch { socket.emit("sceneError", { error: "Invalid object id." }); return; }

    try {
      const db  = require("../config/db").getDB();
      const res = await db.collection("world_objects").deleteOne({ _id: oid });

      if (!res?.deletedCount) {
        socket.emit("sceneError", { error: "Object not found (already deleted?)." });
        return;
      }

      unregisterSolidObject(String(oid));
      io.emit("obj:delete", { id: String(oid) });
    } catch (e) {
      console.error("world:deleteObject failed:", e);
    }
  });

  // ── IDENTIFY ─────────────────────────────────────────
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
      const db     = require("../config/db").getDB();
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

      const nameRaw      = String(player?.charName ?? "").trim();
      const name         = nameRaw ? nameRaw.slice(0, CHAT_NAME_MAX) : null;
      const classId      = String(player?.class ?? "").trim() || null;
      const dbRole       = String(player?.role  ?? "").trim() || null;
      const resolvedRole = dbRole || String(clientRole ?? "").trim() || null;

      playerMeta[socket.id] = { characterId: String(characterId), name, classId, role: resolvedRole };

      shipState[socket.id] = {
        x, y, vx: 0, vy: 0, angle: 0,
        facing: "right", moveTarget: null, lastSeenAt: Date.now(),
      };

      lastSavedAt[socket.id] = Date.now();

      socket.emit("player:self", {
        id:   socket.id,
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

  // ── MOVE TO ───────────────────────────────────────────
  socket.on("player:moveTo", ({ x, y } = {}) => {
    if (!activePlayers[socket.id]) return;
    const p = shipState[socket.id];
    if (!p) return;

    const tx = Number(x);
    const ty = Number(y);
    if (!Number.isFinite(tx) || !Number.isFinite(ty)) return;
    if (!canMoveToXY(tx, ty)) return;

    p.moveTarget    = { x: tx, y: ty };
    p.lastSeenAt    = Date.now();
  });

  // ── MOVE CANCEL ────────────────────────────────────────
  socket.on("player:moveCancel", () => {
    if (!activePlayers[socket.id]) return;
    const p = shipState[socket.id];
    if (!p) return;
    p.moveTarget = null;
    p.vx = 0; p.vy = 0;
    p.lastSeenAt = Date.now();
  });

  // ── ADMIN TELEPORT ─────────────────────────────────────
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

  // ── LEGACY INPUT ───────────────────────────────────────
  socket.on("player:input", ({ thrust, targetAngle } = {}) => {
    if (!activePlayers[socket.id]) return;
    if (!shipState[socket.id]) return;
    // legacy; physics is now target-based but we keep lastSeenAt fresh
    shipState[socket.id].lastSeenAt = Date.now();
  });

  // ── DISCONNECT ─────────────────────────────────────────
  socket.on("disconnect", () => {
    cleanupPlayer(socket.id);
    cleanupChat(socket.id);
  });
}

module.exports = { registerHandlers };