const { ObjectId } = require("mongodb");
const { getClassById } = require("../gameData/classDefs");
const { computeCharacterStats } = require("../world/computeStats");

// STARTING LOCATION !!!
const DEFAULT_X = 11686;
const DEFAULT_Y = 13578;

const DEFAULT_APPEARANCE = {
  skinToneId: "light_neutral_1",
  eyeColor: "#3b271b",
  hairStyle: "none",
  hairColor: "#2b1d16",
  beardStyle: "none",
  beardColor: "#2b1d16",
};

function safeName(raw) {
  return String(raw || "")
    .replace(/[^a-zA-Z0-9 _'-]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 16);
}

function safeHexColor(raw, fallback) {
  const s = String(raw || "").trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(s) ? s : fallback;
}

function safeEnum(raw, allowed, fallback) {
  const s = String(raw || "").trim();
  return allowed.has(s) ? s : fallback;
}

function sanitizeAppearance(raw) {
  const src = raw && typeof raw === "object" ? raw : {};

  const allowedSkinToneIds = new Set([
    "fair_cool_1",
    "fair_warm_1",
    "light_neutral_1",
    "light_warm_2",
    "medium_neutral_1",
    "tan_warm_1",
    "brown_neutral_1",
    "deep_brown_1",
    "deep_brown_2",
  ]);

  return {
    skinToneId: safeEnum(
      src.skinToneId,
      allowedSkinToneIds,
      DEFAULT_APPEARANCE.skinToneId
    ),
    eyeColor: safeHexColor(src.eyeColor, DEFAULT_APPEARANCE.eyeColor),
    hairStyle: String(src.hairStyle || DEFAULT_APPEARANCE.hairStyle)
      .trim()
      .slice(0, 32) || DEFAULT_APPEARANCE.hairStyle,
    hairColor: safeHexColor(src.hairColor, DEFAULT_APPEARANCE.hairColor),
    beardStyle: String(src.beardStyle || DEFAULT_APPEARANCE.beardStyle)
      .trim()
      .slice(0, 32) || DEFAULT_APPEARANCE.beardStyle,
    beardColor: safeHexColor(src.beardColor, DEFAULT_APPEARANCE.beardColor),
  };
}

function makeNewCharacterDoc({
  email,
  charName,
  classId,
  startingStats,
  appearance,
}) {
  return {
    email: email || null,
    dateCreated: new Date(),
    currentLoc: { x: DEFAULT_X, y: DEFAULT_Y },
    visitedLocs: [],
    currency: "1",
    inventory: [],
    equipped: [],
    stats: { ...startingStats },
    skills: {},
    charName,
    exp: 1,
    class: classId,
    appearance: sanitizeAppearance(appearance),
  };
}

function attachComputedStats(character) {
  if (!character) return character;

  const { derivedStats } = computeCharacterStats(character);

  return {
    ...character,
    appearance: sanitizeAppearance(character.appearance),
    derivedStats,
  };
}

// Strips empty strings and invalid ObjectIds from a characters array
function cleanIds(arr) {
  return (arr || [])
    .map((id) => String(id || "").trim())
    .filter((id) => id.length > 0 && ObjectId.isValid(id));
}

/**
 * GET /api/characters/:id
 * Returns { characters: [...] }
 */
exports.getCharactersForAccount = async (req, res) => {
  try {
    const accountId = req.params.id;
    if (!ObjectId.isValid(accountId)) {
      return res.json({ characters: [] });
    }

    const db = req.app.locals.db;
    const usersCol = db.collection("accounts");
    const charsCol = db.collection("player_data");

    const user = await usersCol.findOne(
      { _id: new ObjectId(accountId) },
      { projection: { passwordHash: 0 } }
    );

    if (!user) {
      return res.json({ characters: [] });
    }

    // Ownership check
    const authedId = req.user?.id || req.user?._id;
    if (authedId && String(authedId) !== String(accountId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const validIds = cleanIds(user.characters);

    let resolvedChars = [];

    if (validIds.length > 0) {
      const objectIds = validIds.map((id) => new ObjectId(id));
      const found = await charsCol.find({ _id: { $in: objectIds } }).toArray();
      const byId = new Map(found.map((c) => [String(c._id), c]));
      resolvedChars = validIds.map((id) => byId.get(id)).filter(Boolean);
    }

    // Fallback: email lookup for legacy / freshly registered accounts
    if (resolvedChars.length === 0) {
      const email = String(user.email || "").trim().toLowerCase();
      if (email) {
        resolvedChars = await charsCol
          .find({ email })
          .sort({ dateCreated: 1 })
          .toArray();
      }
    }

    // Auto-repair: overwrite the array with only real IDs
    const repairedIds = resolvedChars.map((c) => String(c._id));
    const currentStored = JSON.stringify(user.characters || []);
    const repaired = JSON.stringify(repairedIds);

    if (currentStored !== repaired) {
      await usersCol.updateOne(
        { _id: new ObjectId(accountId) },
        { $set: { characters: repairedIds } }
      );
    }

    const charactersWithStats = resolvedChars.map(attachComputedStats);

    return res.json({ characters: charactersWithStats });
  } catch (err) {
    console.error("Character fetch error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

/**
 * POST /api/characters/:id
 * Body: { charName, class | classId, appearance }
 * Returns { character }
 */
exports.createCharacterForAccount = async (req, res) => {
  try {
    const accountId = req.params.id;

    if (!ObjectId.isValid(accountId)) {
      return res.status(400).json({ message: "Invalid account id" });
    }

    const db = req.app.locals.db;
    const usersCol = db.collection("accounts");
    const charsCol = db.collection("player_data");

    const user = await usersCol.findOne({ _id: new ObjectId(accountId) });
    if (!user) {
      return res.status(404).json({ message: "Account not found" });
    }

    // Ownership check
    const authedId = req.user?.id || req.user?._id;
    if (authedId && String(authedId) !== String(accountId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const charName = safeName(req.body?.charName);
    const classId = String(req.body?.class || req.body?.classId || "").trim();
    const appearance = sanitizeAppearance(req.body?.appearance);

    if (!charName || charName.length < 3) {
      return res
        .status(400)
        .json({ message: "charName must be at least 3 characters" });
    }

    if (!classId) {
      return res.status(400).json({ message: "class is required" });
    }

    const classDef = getClassById(classId);
    if (!classDef) {
      return res.status(400).json({ message: "Invalid class" });
    }

    const startingStats = classDef.stats || {};

    const MAX_SLOTS = 6;
    const existingValidIds = cleanIds(user.characters);

    if (existingValidIds.length >= MAX_SLOTS) {
      return res.status(400).json({ message: "Character slots full." });
    }

    if (existingValidIds.length > 0) {
      const dup = await charsCol.findOne({
        _id: { $in: existingValidIds.map((id) => new ObjectId(id)) },
        charName: new RegExp(`^${charName}$`, "i"),
      });

      if (dup) {
        return res
          .status(409)
          .json({ message: "That name is already used on this account." });
      }
    }

    const doc = makeNewCharacterDoc({
      email: user.email,
      charName,
      classId: classDef.id,
      startingStats,
      appearance,
    });

    const ins = await charsCol.insertOne(doc);
    const newId = String(ins.insertedId);

    await usersCol.updateOne(
      { _id: new ObjectId(accountId) },
      { $set: { characters: [...existingValidIds, newId] } }
    );

    const created = await charsCol.findOne({ _id: ins.insertedId });

    return res.json({ character: attachComputedStats(created) });
  } catch (err) {
    console.error("Character create error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};

/**
 * DELETE /api/characters/:accountId/:charId
 * Returns { ok: true }
 */
exports.deleteCharacterForAccount = async (req, res) => {
  try {
    const accountId = req.params.accountId;
    const charId = req.params.charId;

    if (!ObjectId.isValid(accountId) || !ObjectId.isValid(charId)) {
      return res.status(400).json({ message: "Invalid id" });
    }

    const db = req.app.locals.db;
    const usersCol = db.collection("accounts");
    const charsCol = db.collection("player_data");

    const user = await usersCol.findOne({ _id: new ObjectId(accountId) });
    if (!user) {
      return res.status(404).json({ message: "Account not found" });
    }

    // Ownership check
    const authedId = req.user?.id || req.user?._id;
    if (authedId && String(authedId) !== String(accountId)) {
      return res.status(403).json({ message: "Forbidden" });
    }

    const validIds = cleanIds(user.characters);

    if (!validIds.includes(String(charId))) {
      return res.status(404).json({ message: "Character not on this account" });
    }

    await usersCol.updateOne(
      { _id: new ObjectId(accountId) },
      { $set: { characters: validIds.filter((id) => id !== String(charId)) } }
    );

    await charsCol.deleteOne({ _id: new ObjectId(charId) });

    return res.json({ ok: true });
  } catch (err) {
    console.error("Character delete error:", err);
    return res.status(500).json({ message: "Server error" });
  }
};