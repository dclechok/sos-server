import { TERRAIN_ID } from "./worldConstants";

export const TERRAIN_DEFS = {
  [TERRAIN_ID.GRASS]: {
    key: "grass",
    blocksMovement: false,
    moveCost: 1,
  },

  [TERRAIN_ID.DEEP_OCEAN]: {
    key: "deep_ocean",
    blocksMovement: true,   // ✅ impassable
    moveCost: Infinity,
  },

  // later:
  // [TERRAIN_ID.SHALLOW_WATER]: { blocksMovement: false, moveCost: 2 },
  // [TERRAIN_ID.MOUNTAIN]: { blocksMovement: true },
};

export function getTerrainDef(id) {
  return TERRAIN_DEFS[id] || { key: "unknown", blocksMovement: true, moveCost: Infinity };
}