// server/sockets/playerState.js

const { ObjectId } = require("mongodb");
const { canMoveToXY } = require("./collision");

const activePlayers = {};
const playerMeta = {};
const shipState = {};
const lastSavedAt = {};

const SAVE_INTERVAL_MS = 5000;

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

const MAX_SPEED = 45;
const SLOW_RADIUS = 30;
const STOP_EPS = 0.75;

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Smooth collision response: slide along obstacles instead of canceling moveTarget.
 *
 * Algorithm:
 * - Try full move
 * - If blocked, try X-only then Y-only (axis slide)
 * - If still blocked, try smaller steps (helps corner/edge sticking)
 * - If blocked, stop velocity BUT keep moveTarget (prevents jitter/reclick loop)
 */
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
      if (canMoveToXY(tx, ty)) {
        p.x = tx;
        p.y = ty;
      }
      p.vx = 0;
      p.vy = 0;
      p.moveTarget = null;
      return;
    }

    const dirx = dx / dist;
    const diry = dy / dist;

    const slowFactor = clamp01(dist / SLOW_RADIUS);
    const speed = MAX_SPEED * slowFactor;

    const wantedStep = Math.min(speed * dt, dist);

    function tryMoveTo(nx, ny) {
      if (canMoveToXY(nx, ny)) {
        p.x = nx;
        p.y = ny;
        return true;
      }
      return false;
    }

    // Try a few step sizes to reduce "edge snagging"
    const scales = [1, 0.5, 0.25];
    let moved = false;

    for (const s of scales) {
      const step = wantedStep * s;
      const newX = p.x + dirx * step;
      const newY = p.y + diry * step;

      // 1) Straight move
      if (tryMoveTo(newX, newY)) {
        moved = true;
        break;
      }

      // 2) Slide along X
      if (tryMoveTo(newX, p.y)) {
        moved = true;
        break;
      }

      // 3) Slide along Y
      if (tryMoveTo(p.x, newY)) {
        moved = true;
        break;
      }
    }

    if (moved) {
      // Keep facing based on target vector, not micro-slide direction
      p.vx = dirx * speed;
      p.vy = diry * speed;
      p.facing = dx < 0 ? "left" : "right";
      p.angle = Math.atan2(dy, dx);

      if (Math.hypot(tx - p.x, ty - p.y) <= STOP_EPS) {
        p.vx = 0;
        p.vy = 0;
        p.moveTarget = null;
      }
    } else {
      // Blocked: stop, but DO NOT clear target.
      // This prevents jitter and allows "hugging" obstacles when possible.
      p.vx = 0;
      p.vy = 0;

      // Optional future improvement:
      // track p.stuckMs and clear target after N ms, but not needed for now.
    }
  } else {
    p.vx = 0;
    p.vy = 0;
  }
}

const VIEW_RADIUS = 2400;
const VIEW_RADIUS_SQ = VIEW_RADIUS * VIEW_RADIUS;

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