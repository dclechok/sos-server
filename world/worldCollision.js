// world/worldCollision.js
const fs = require("fs");
const path = require("path");
const { getTerrainDef } = require("./terrainDefs"); // your TERRAIN_DEFS file

// Load meta.json once
const meta = JSON.parse(
  fs.readFileSync(path.join(__dirname, "meta.json"), "utf8")
);

const TILE_SIZE   = meta.tileSize   ?? 16;
const CHUNK_SIZE  = meta.chunkSize  ?? 16; // tiles per chunk axis
const CHUNK_PX    = TILE_SIZE * CHUNK_SIZE;

const CHUNKS_DIR  = path.join(__dirname, "chunks");

// In-memory chunk cache  (chunkKey -> Uint8Array or parsed tile array)
const chunkCache  = new Map();

function chunkKey(cx, cy) {
  return `${cx},${cy}`;
}

function loadChunk(cx, cy) {
  const key = chunkKey(cx, cy);
  if (chunkCache.has(key)) return chunkCache.get(key);

  // adapt the filename pattern to whatever you use
  const filePath = path.join(CHUNKS_DIR, `${cx}_${cy}.json`);

  if (!fs.existsSync(filePath)) {
    chunkCache.set(key, null); // missing = treat as impassable
    return null;
  }

  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    // expecting data.tiles = flat array of terrain IDs, row-major
    chunkCache.set(key, data.tiles);
    return data.tiles;
  } catch {
    chunkCache.set(key, null);
    return null;
  }
}

/**
 * Returns true if the world coordinate is passable.
 * Unknown/missing chunks are treated as impassable (safe default).
 */
function isPassable(worldX, worldY) {
  const cx = Math.floor(worldX / CHUNK_PX);
  const cy = Math.floor(worldY / CHUNK_PX);

  const tiles = loadChunk(cx, cy);
  if (!tiles) return false; // missing chunk = blocked

  // local tile coords within the chunk
  const lx = Math.floor((worldX - cx * CHUNK_PX) / TILE_SIZE);
  const ly = Math.floor((worldY - cy * CHUNK_PX) / TILE_SIZE);

  const idx = ly * CHUNK_SIZE + lx;
  const terrainId = tiles[idx];

  const def = getTerrainDef(terrainId);
  return !def.blocksMovement;
}

module.exports = { isPassable };