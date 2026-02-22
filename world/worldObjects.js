// world/worldObjects.js

// IMPORTANT:
// Set CHUNK_TILES to match your existing world chunk system.
// If your world chunks are 32x32 tiles and TILE=16px, then CHUNK_PX=512.
const { TILE } = require("./worldConstants");

// ✅ CHANGE THIS if your chunk size differs
const CHUNK_TILES = 32;

const CHUNK_PX = TILE * CHUNK_TILES;

const TTL = {
  CAMPFIRE_MS: 2 * 60 * 1000,
  DROP_MS: 15 * 60 * 1000,
};

function chunkKeyFromWorld(x, y) {
  const cx = Math.floor(x / CHUNK_PX);
  const cy = Math.floor(y / CHUNK_PX);
  return `${cx},${cy}`;
}

function chunkKeysInRadius(cx, cy, r) {
  const keys = [];
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      keys.push(`${cx + dx},${cy + dy}`);
    }
  }
  return keys;
}

function ttlMsForDefId(defId) {
  const s = String(defId || "").toLowerCase();
  if (s.includes("campfire")) return TTL.CAMPFIRE_MS;
  return TTL.DROP_MS;
}

module.exports = {
  CHUNK_TILES,
  CHUNK_PX,
  TTL,
  chunkKeyFromWorld,
  chunkKeysInRadius,
  ttlMsForDefId,
};