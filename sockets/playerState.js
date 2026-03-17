const { ObjectId } = require("mongodb");
const { canMoveToXY } = require("./collision");

const activePlayers = {};
const playerMeta = {};
const shipState = {};
const lastSavedAt = {};

const SAVE_INTERVAL_MS = 5000;
const FOOT_OFFSET_Y = 6;

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

function canFoot(wx, wy) {
  return canMoveToXY(wx, wy + FOOT_OFFSET_Y);
}

function stepPlayer(p, dt) {
  if (
    !p.moveTarget ||
    !Number.isFinite(p.moveTarget.x) ||
    !Number.isFinite(p.moveTarget.y)
  ) {
    p.vx = 0;
    p.vy = 0;
    return;
  }

  const tx = p.moveTarget.x;
  const ty = p.moveTarget.y;
  const dx = tx - p.x;
  const dy = ty - p.y;
  const dist = Math.hypot(dx, dy);

  if (dist <= STOP_EPS) {
    if (canFoot(tx, ty)) {
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
  const step = Math.min(speed * dt, dist);
  const newX = p.x + dirx * step;
  const newY = p.y + diry * step;

  p.facing = dx < 0 ? "left" : "right";
  p.angle = Math.atan2(dy, dx);

  if (canFoot(newX, newY)) {
    p.x = newX;
    p.y = newY;
    p.vx = dirx * speed;
    p.vy = diry * speed;
  } else if (canFoot(newX, p.y)) {
    p.x = newX;
    p.vx = dirx * speed;
    p.vy = 0;
  } else if (canFoot(p.x, newY)) {
    p.y = newY;
    p.vx = 0;
    p.vy = diry * speed;
  } else {
    p.vx = 0;
    p.vy = 0;
  }

  if (p.moveTarget && Math.hypot(tx - p.x, ty - p.y) <= STOP_EPS) {
    p.vx = 0;
    p.vy = 0;
    p.moveTarget = null;
  }
}

const VIEW_RADIUS_SQ = 2400 * 2400;

function buildNearbySnapshot(meId, now) {
  const me = shipState[meId];
  if (!me) return {};

  const out = {};

  for (const [id, p] of Object.entries(shipState)) {
    if (!p) continue;

    const meta = playerMeta[id] || {};
    const name = meta.name || null;
    const classId = meta.classId || null;
    const role = meta.role || "player";
    const appearance = meta.appearance || null;

    if (id !== meId) {
      const ddx = p.x - me.x;
      const ddy = p.y - me.y;
      if (ddx * ddx + ddy * ddy > VIEW_RADIUS_SQ) continue;
    }

    out[id] = {
      x: p.x,
      y: p.y,
      vx: p.vx,
      vy: p.vy,
      angle: p.angle,
      facing: p.facing || "right",
      name,
      class: classId,
      role,
      appearance,
      ts: now,
    };
  }

  return out;
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