// server/sockets/playerState.js
// All per-player runtime state, physics stepping, snapshot building, and DB persistence.

const { ObjectId } = require("mongodb");
const { canMoveToXY, resolveSlide } = require("./collision");

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
      // Close enough — snap to target if passable, then stop
      if (canMoveToXY(tx, ty)) { p.x = tx; p.y = ty; }
      p.vx = 0; p.vy = 0; p.moveTarget = null;
      return;
    }

    const dirx       = dx / dist;
    const diry       = dy / dist;
    const slowFactor = clamp01(dist / SLOW_RADIUS);
    const speed      = MAX_SPEED * slowFactor;
    const step       = Math.min(speed * dt, dist);

    p.vx     = dirx * speed;
    p.vy     = diry * speed;
    p.facing = dx < 0 ? "left" : "right";
    p.angle  = Math.atan2(dy, dx);

    const newX = p.x + dirx * step;
    const newY = p.y + diry * step;

    // ── Slide resolution ──────────────────────────────────────────────────
    // resolveSlide tries the full move, then X-only, then Y-only, then stops.
    // This makes the player glide smoothly around circle and rect obstacles
    // instead of snagging on them.
    const resolved = resolveSlide(p.x, p.y, newX, newY);
    p.x = resolved.x;
    p.y = resolved.y;

    if (resolved.blocked) {
      // Fully blocked — kill velocity but keep moveTarget so the player
      // keeps trying (lets them slide around a corner by holding the button)
      p.vx = 0;
      p.vy = 0;
    }

    // If we arrived close enough after sliding, clear the target
    const remainDx = tx - p.x;
    const remainDy = ty - p.y;
    if (Math.hypot(remainDx, remainDy) <= STOP_EPS) {
      p.vx = 0; p.vy = 0; p.moveTarget = null;
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