// server/world/worldTiles.js
const fs = require("fs");
const path = require("path");

const { TERRAIN_ID } = require("./worldConstants");

// Adjust these paths if your server serves /public/world
const META_PATH = path.join(__dirname, "..", "public", "world", "meta.json");
const CHUNKS_DIR = path.join(__dirname, "..", "public", "world", "chunks");

// cache: "cx,cy" -> Uint8Array
const cache = new Map();

let meta = null;
function loadMeta() {
  if (meta) return meta;
  meta = JSON.parse(fs.readFileSync(META_PATH, "utf8"));
  return meta;
}

function keyOf(cx, cy) {
  return `${cx},${cy}`;
}

function getChunk(cx, cy) {
  const m = loadMeta();

  if (cx < 0 || cy < 0 || cx >= m.chunks_x || cy >= m.chunks_y) return null;

  const key = keyOf(cx, cy);
  if (cache.has(key)) return cache.get(key);

  const file = path.join(CHUNKS_DIR, `${cx}_${cy}.bin`);
  if (!fs.existsSync(file)) return null;

  const buf = fs.readFileSync(file);
  const arr = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  cache.set(key, arr);
  return arr;
}

function getTileId(tileX, tileY) {
  const m = loadMeta();

  // out of bounds = ocean edge
  if (
    tileX < 0 ||
    tileY < 0 ||
    tileX >= m.width_tiles ||
    tileY >= m.height_tiles
  ) {
    return TERRAIN_ID.DEEP_OCEAN;
  }

  const cs = m.chunk_size;
  const cx = Math.floor(tileX / cs);
  const cy = Math.floor(tileY / cs);

  const chunk = getChunk(cx, cy);

  // Server should NOT return UNKNOWN for unloaded — it loads from disk.
  // But if a chunk file is missing, treat as DEEP_OCEAN or UNKNOWN (your choice).
  if (!chunk) return TERRAIN_ID.DEEP_OCEAN;

  const lx = tileX - cx * cs;
  const ly = tileY - cy * cs;

  return chunk[ly * cs + lx] ?? TERRAIN_ID.DEEP_OCEAN;
}

module.exports = { getTileId, loadMeta };