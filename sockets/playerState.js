// server/sockets/playerState.js
// All per-player runtime state, physics stepping, snapshot building, and DB persistence.

const { ObjectId } = require("mongodb");
const { canMoveToXY } = require("./collision");

// ------------------------------------------------------
// STATE MAPS
// ------------------------------------------------------
const activePlayers = {}; // socket.id → characterId (string)
const playerMeta   = {}; // socket.id → { characterId, name, classId, role }
const shipState    = {}; // socket.id → { x, y, vx, vy, angle, facing, moveTarget, ... }
const lastSavedAt  = {}; // socket.id → timestamp

const SAVE_INTERVAL_MS = 5000;

// ------------------------------------------------------
// DB PERSISTENCE
// ------------------------------------------------------
async function savePosition(socketId) {
  const p    = shipState[socketId];
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

// ------------------------------------------------------
// PHYSICS
// ------------------------------------------------------
const MAX_SPEED   = 45;
const SLOW_RADIUS = 30;
const STOP_EPS    = 0.75;

function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

function stepPlayer(p, dt) {
  if (
    p.moveTarget &&
    Number.isFinite(p.moveTarget.x) &&
    Number.isFinite(p.moveTarget.y)
  ) {
    const tx   = p.moveTarget.x;
    const ty   = p.moveTarget.y;
    const dx   = tx - p.x;
    const dy   = ty - p.y;
    const dist = Math.hypot(dx, dy);

    if (dist <= STOP_EPS) {
      if (canMoveToXY(tx, ty)) { p.x = tx; p.y = ty; }
      p.vx = 0; p.vy = 0; p.moveTarget = null;
    } else {
      const dirx       = dx / dist;
      const diry       = dy / dist;
      const slowFactor = clamp01(dist / SLOW_RADIUS);
      const speed      = MAX_SPEED * slowFactor;
      const step       = speed * dt;

      p.vx     = dirx * speed;
      p.vy     = diry * speed;
      p.facing = dx < 0 ? "left" : "right";
      p.angle  = Math.atan2(dy, dx);

      if (step >= dist) {
        if (canMoveToXY(tx, ty)) { p.x = tx; p.y = ty; }
        p.vx = 0; p.vy = 0; p.moveTarget = null;
      } else {
        const newX = p.x + dirx * step;
        const newY = p.y + diry * step;

        if (canMoveToXY(newX, newY))      { p.x = newX; p.y = newY; }
        else if (canMoveToXY(newX, p.y))  { p.x = newX; }
        else if (canMoveToXY(p.x,  newY)) { p.y = newY; }
        else { p.vx = 0; p.vy = 0; p.moveTarget = null; }
      }
    }
  } else {
    p.vx = 0;
    p.vy = 0;
  }
}

// ------------------------------------------------------
// SNAPSHOT
// ------------------------------------------------------
const VIEW_RADIUS    = 2400;
const VIEW_RADIUS_SQ = VIEW_RADIUS * VIEW_RADIUS;

function buildNearbySnapshot(meId, now) {
  const me = shipState[meId];
  if (!me) return {};

  const players = {};
  const mx = me.x;
  const my = me.y;

  for (const [id, p] of Object.entries(shipState)) {
    if (!p) continue;
    const name    = playerMeta[id]?.name    || null;
    const classId = playerMeta[id]?.classId || null;

    if (id === meId) {
      players[id] = { x: p.x, y: p.y, vx: p.vx, vy: p.vy, angle: p.angle,
                      facing: p.facing || "right", name, class: classId, ts: now };
      continue;
    }

    const dx = p.x - mx;
    const dy = p.y - my;
    if (dx * dx + dy * dy <= VIEW_RADIUS_SQ) {
      players[id] = { x: p.x, y: p.y, vx: p.vx, vy: p.vy, angle: p.angle,
                      facing: p.facing || "right", name, class: classId, ts: now };
    }
  }

  return players;
}

// ------------------------------------------------------
// TICK HELPER — called from game loop
// ------------------------------------------------------
function tickAll(wallNow, dt) {
  for (const [id, p] of Object.entries(shipState)) {
    if (!p) continue;
    stepPlayer(p, dt);

    const lastSave = lastSavedAt[id] || 0;
    if (wallNow - lastSave >= SAVE_INTERVAL_MS) {
      lastSavedAt[id] = wallNow;
      savePosition(id);
    }
  }
}

// ------------------------------------------------------
// CLEANUP ON DISCONNECT
// ------------------------------------------------------
function cleanupPlayer(socketId) {
  savePosition(socketId);
  delete activePlayers[socketId];
  delete shipState[socketId];
  delete playerMeta[socketId];
  delete lastSavedAt[socketId];
}

module.exports = {
  activePlayers,
  playerMeta,
  shipState,
  lastSavedAt,
  SAVE_INTERVAL_MS,
  savePosition,
  stepPlayer,
  buildNearbySnapshot,
  tickAll,
  cleanupPlayer,
};