// server/sockets/collision.js
// Manages solid object registry and all collision detection logic.

const { getObjectDef } = require("../gameData/gameDataLoader");
const { getTileId } = require("../world/worldTiles");
const { TILE, TERRAIN_ID } = require("../world/worldConstants");

const COLLISION_DEBUG = process.env.COLLISION_DEBUG === "1";
const PLAYER_RADIUS = 5;

// _id string → { x, y, defId, def }
const solidObjects = new Map();

// ------------------------------------------------------
// SOLID OBJECT REGISTRY
// ------------------------------------------------------
function registerSolidObjectFromDoc(doc) {
  if (!doc?._id) return;

  const defId = String(doc.defId || "");
  const def = getObjectDef(defId);
  if (!def?.blocksMovement) return;

  const id = String(doc._id);
  solidObjects.set(id, { x: Number(doc.x), y: Number(doc.y), defId, def });

  if (COLLISION_DEBUG) {
    console.log(
      `[collision] register solid: _id=${id} defId="${defId}" x=${doc.x} y=${doc.y} total=${solidObjects.size}`
    );
  }
}

function unregisterSolidObject(id) {
  const key = String(id);
  const existed = solidObjects.delete(key);
  if (COLLISION_DEBUG) {
    console.log(
      `[collision] unregister solid: _id=${key} existed=${existed} total=${solidObjects.size}`
    );
  }
}

async function loadSolidObjectsWithRetry(tries = 30, delayMs = 500) {
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      const db = require("../config/db").getDB();
      if (!db) throw new Error("Database not initialized");

      solidObjects.clear();
      const objs = await db.collection("world_objects").find({}).toArray();
      console.log(`[collision] total world_objects in DB: ${objs.length}`);

      let foundSolids = 0;
      let missingDefs = 0;

      for (const obj of objs) {
        const def = getObjectDef(obj.defId);
        if (!def) missingDefs++;
        if (def?.blocksMovement) {
          foundSolids++;
          registerSolidObjectFromDoc(obj);
        }
      }

      console.log(
        `[collision] solid objects registered: ${solidObjects.size} (found ${foundSolids})`
      );

      if (missingDefs > 0) {
        console.log(
          `[collision] NOTE: ${missingDefs}/${objs.length} objects have defId missing from objects.json (they will never block).`
        );
      }

      return;
    } catch (err) {
      console.error(
        `[collision] loadSolidObjects attempt ${attempt}/${tries} failed:`,
        err.message
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  console.error(
    "[collision] giving up loading solid objects; solidObjects will remain empty."
  );
}

// Kick off async load once DB is connected
loadSolidObjectsWithRetry();

// ------------------------------------------------------
// TERRAIN COLLISION
// ------------------------------------------------------
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

// ------------------------------------------------------
// OBJECT COLLISION
// ------------------------------------------------------
function collidesWithObject(wx, wy, radius = PLAYER_RADIUS) {
  if (solidObjects.size === 0) {
    if (COLLISION_DEBUG) console.log("[collision] solidObjects is EMPTY");
    return false;
  }

  for (const [id, obj] of solidObjects) {
    const def = obj.def;
    const col = def?.collision;

    if (!col) {
      const half = (def?.sizePx ?? 16) * 0.5;
      const hit =
        Math.abs(wx - obj.x) < half + radius &&
        Math.abs(wy - obj.y) < half + radius;
      if (hit) {
        if (COLLISION_DEBUG)
          console.log(`[collision] HIT(fallback AABB) _id=${id} defId=${obj.defId}`);
        return true;
      }
      continue;
    }

    if (col.shape === "circle") {
      const cx = obj.x + (col.offset?.x ?? 0);
      const cy = obj.y + (col.offset?.y ?? 0);
      const hit = Math.hypot(wx - cx, wy - cy) < (col.radius ?? 0) + radius;
      if (hit) {
        if (COLLISION_DEBUG)
          console.log(`[collision] HIT(circle) _id=${id} defId=${obj.defId}`);
        return true;
      }
      continue;
    }

    if (col.shape === "rect") {
      const ox = obj.x + (col.offset?.x ?? 0);
      const oy = obj.y + (col.offset?.y ?? 0);
      const hw = (col.w ?? def?.sizePx ?? 16) * 0.5;
      const hh = (col.h ?? def?.sizePx ?? 16) * 0.5;
      const hit = Math.abs(wx - ox) < hw + radius && Math.abs(wy - oy) < hh + radius;
      if (hit) {
        if (COLLISION_DEBUG)
          console.log(`[collision] HIT(rect) _id=${id} defId=${obj.defId}`);
        return true;
      }
      continue;
    }

    if (COLLISION_DEBUG)
      console.log(`[collision] unknown shape "${col.shape}" for defId=${obj.defId}`);
  }

  return false;
}

function canMoveToXY(wx, wy) {
  return canStandAt(wx, wy) && !collidesWithObject(wx, wy);
}

module.exports = {
  registerSolidObjectFromDoc,
  unregisterSolidObject,
  canMoveToXY,
};