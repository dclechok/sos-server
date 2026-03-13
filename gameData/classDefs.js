/**
 * server/data/characterClasses.js
 *
 * Authoritative class definitions used by the server.
 * The backend uses this file to:
 *  - validate classId sent by clients
 *  - assign starting stats
 *  - prevent tampering
 */

const CHARACTER_CLASSES = [
  {
    id: "adept_necromancer",
    role: "Caster",
    stats: {
      strength: 4,
      dexterity: 6,
      vitality: 6,
      perception: 7,
      intelligence: 10,
      luck: 5,
    },
  },
  {
    id: "corrupted_treant",
    role: "Tank",
    stats: {
      strength: 9,
      dexterity: 3,
      vitality: 10,
      perception: 5,
      intelligence: 4,
      luck: 4,
    },
  },
  {
    id: "deft_sorceress",
    role: "Caster",
    stats: {
      strength: 3,
      dexterity: 8,
      vitality: 5,
      perception: 8,
      intelligence: 9,
      luck: 5,
    },
  },
  {
    id: "novice_pyromancer",
    role: "Caster",
    stats: {
      strength: 4,
      dexterity: 5,
      vitality: 5,
      perception: 6,
      intelligence: 8,
      luck: 7,
    },
  },
  {
    id: "vile_witch",
    role: "Support",
    stats: {
      strength: 2,
      dexterity: 6,
      vitality: 5,
      perception: 9,
      intelligence: 8,
      luck: 8,
    },
  },
];

/**
 * Legacy DB class name support
 * (keeps old characters working)
 */
const LEGACY_CLASS_MAP = {
  Nullmancer: "adept_necromancer",
  Scavenger: "novice_pyromancer",
};

function normalizeClassId(classId) {
  const raw = String(classId || "").trim();
  if (!raw) return "";
  return LEGACY_CLASS_MAP[raw] || raw;
}

function getClassById(classId) {
  const norm = normalizeClassId(classId);
  return CHARACTER_CLASSES.find((c) => c.id === norm) || null;
}

function getStartingStats(classId) {
  const cls = getClassById(classId);
  return cls?.stats || null;
}

module.exports = {
  CHARACTER_CLASSES,
  normalizeClassId,
  getClassById,
  getStartingStats,
};