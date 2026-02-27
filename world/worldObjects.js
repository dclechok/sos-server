// world/worldObjects.js
const { TILE } = require("./worldConstants");

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

  if (s.includes("drop") || s.includes("loot") || s.includes("bag")) {
    return TTL.DROP_MS;
  }

  // everything else (trees/rocks/deco) never decays by default
  return 0;
}

module.exports = {
  CHUNK_TILES,
  CHUNK_PX,
  TTL,
  chunkKeyFromWorld,
  chunkKeysInRadius,
  ttlMsForDefId,
};