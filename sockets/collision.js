// server/sockets/collision.js

const { getObjectDef } = require("../gameData/gameDataLoader");
const { getTileId } = require("../world/worldTiles");
const { TILE, TERRAIN_ID } = require("../world/worldConstants");

const COLLISION_DEBUG = process.env.COLLISION_DEBUG === "1";

const PLAYER_RADIUS = 5;

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
    console.log(`[collision] register solid: _id=${id} defId="${defId}" x=${doc.x} y=${doc.y} total=${solidObjects.size}`);
  }
}

function unregisterSolidObject(id) {
  const key = String(id);
  const existed = solidObjects.delete(key);
  if (COLLISION_DEBUG) {
    console.log(`[collision] unregister solid: _id=${key} existed=${existed} total=${solidObjects.size}`);
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

      console.log(`[collision] solid objects registered: ${solidObjects.size} (found ${foundSolids})`);
      if (missingDefs > 0) {
        console.log(`[collision] NOTE: ${missingDefs}/${objs.length} objects have defId missing from objects.json`);
      }
      return;
    } catch (err) {
      console.error(`[collision] loadSolidObjects attempt ${attempt}/${tries} failed:`, err.message);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  console.error("[collision] giving up loading solid objects; solidObjects will remain empty.");
}

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
function collidesWithObject(wx, wy, radius) {
  radius = radius ?? PLAYER_RADIUS;

  for (const [id, obj] of solidObjects) {
    const def = obj.def;
    const col = def?.collision;

    if (!col) {
      const half = (def?.sizePx ?? 16) * 0.5;
      if (Math.abs(wx - obj.x) < half + radius && Math.abs(wy - obj.y) < half + radius) {
        if (COLLISION_DEBUG) console.log(`[collision] HIT(fallback AABB) _id=${id} defId=${obj.defId}`);
        return true;
      }
      continue;
    }

    if (col.shape === "circle") {
      const cx = obj.x + (col.offset?.x ?? 0);
      const cy = obj.y + (col.offset?.y ?? 0);
      if (Math.hypot(wx - cx, wy - cy) < (col.radius ?? 0) + radius) {
        if (COLLISION_DEBUG) console.log(`[collision] HIT(circle) _id=${id} defId=${obj.defId}`);
        return true;
      }
      continue;
    }

    if (col.shape === "rect") {
      const ox = obj.x + (col.offset?.x ?? 0);
      const oy = obj.y + (col.offset?.y ?? 0);
      const hw = (col.w ?? def?.sizePx ?? 16) * 0.5;
      const hh = (col.h ?? def?.sizePx ?? 16) * 0.5;
      if (Math.abs(wx - ox) < hw + radius && Math.abs(wy - oy) < hh + radius) {
        if (COLLISION_DEBUG) console.log(`[collision] HIT(rect) _id=${id} defId=${obj.defId}`);
        return true;
      }
      continue;
    }
  }

  return false;
}

function canMoveToXY(wx, wy) {
  return canStandAt(wx, wy) && !collidesWithObject(wx, wy);
}

/**
 * Sweep-based circle collision response.
 *
 * Given the player's current foot position (fromX, fromY), desired foot
 * position (toX, toY), and player radius — finds the closest circle collider
 * that would be hit along that path and returns:
 *
 *   {
 *     hit:        true/false,
 *     x, y:       safe foot position (stops flush at the surface, never inside),
 *     nx, ny:     surface normal pointing away from the blocker center,
 *     slideX, slideY: unit tangent vector (movement projected onto surface),
 *   }
 *
 * The caller can use slideX/slideY to continue moving along the surface
 * with the remaining step, giving smooth roll-around with zero penetration.
 */
function sweepCircles(fromX, fromY, toX, toY, radius) {
  radius = radius ?? PLAYER_RADIUS;

  const mx   = toX - fromX;
  const my   = toY - fromY;
  const mLen = Math.hypot(mx, my);

  if (mLen < 0.0001) return { hit: false, x: toX, y: toY };

  const mdx = mx / mLen;
  const mdy = my / mLen;

  let   closestT  = 1.0;  // parametric [0..1] along movement
  let   hitNx     = 0;
  let   hitNy     = 0;
  let   didHit    = false;

  for (const [, obj] of solidObjects) {
    const def = obj.def;
    const col = def?.collision;
    if (!col || col.shape !== "circle") continue;

    const cx      = obj.x + (col.offset?.x ?? 0);
    const cy      = obj.y + (col.offset?.y ?? 0);
    const minDist = (col.radius ?? 0) + radius;

    // Vector from circle center to ray origin
    const fx = fromX - cx;
    const fy = fromY - cy;

    // Quadratic: |from + t*move - center|² = minDist²
    // a·t² + b·t + c = 0
    const a = mx * mx + my * my;
    const b = 2 * (fx * mx + fy * my);
    const c = fx * fx + fy * fy - minDist * minDist;

    const disc = b * b - 4 * a * c;
    if (disc < 0) continue; // no intersection

    const sqrtDisc = Math.sqrt(disc);
    const t0 = (-b - sqrtDisc) / (2 * a);
    const t1 = (-b + sqrtDisc) / (2 * a);

    // We want the smallest t in [0, 1] where the player first touches the circle.
    // If t0 < 0 the player is already inside — use 0 so we push back to surface.
    let t = t0 < 0 ? 0 : t0;
    if (t > 1) continue;          // hit is beyond the desired step
    if (t1 < 0) continue;         // circle is entirely behind us

    if (t < closestT) {
      closestT = t;
      didHit   = true;

      // Normal at contact point: player center → blocker center, reversed
      const hitX = fromX + mx * t;
      const hitY = fromY + my * t;
      const nnx  = hitX - cx;
      const nny  = hitY - cy;
      const nl   = Math.hypot(nnx, nny);
      hitNx = nl > 0.001 ? nnx / nl : 1;
      hitNy = nl > 0.001 ? nny / nl : 0;
    }
  }

  if (!didHit) return { hit: false, x: toX, y: toY };

  // Safe position: stop exactly at the surface (t=closestT), tiny epsilon back
  const SKIN = 0.05;
  const safeT = Math.max(0, closestT - SKIN / mLen);
  const sx = fromX + mx * safeT;
  const sy = fromY + my * safeT;

  // Slide tangent: movement minus its component along the normal
  const dot    = mdx * hitNx + mdy * hitNy;
  const slideX = mdx - dot * hitNx;
  const slideY = mdy - dot * hitNy;
  const sl     = Math.hypot(slideX, slideY);

  return {
    hit:    true,
    x:      sx,
    y:      sy,
    nx:     hitNx,
    ny:     hitNy,
    slideX: sl > 0.001 ? slideX / sl : 0,
    slideY: sl > 0.001 ? slideY / sl : 0,
    remainingFraction: 1 - closestT,
  };
}

module.exports = {
  registerSolidObjectFromDoc,
  unregisterSolidObject,
  canMoveToXY,
  sweepCircles,
};