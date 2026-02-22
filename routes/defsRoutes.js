// routes/defsRoutes.js
const router = require("express").Router();
const { getGameDataSnapshot } = require("../gameData/gameDataLoader");

// GET /api/defs/objects
// Returns all placeable object templates from objectDefs.json
router.get("/objects", (req, res) => {
  try {
    const snap = getGameDataSnapshot();
    const objects = snap.objects || {};

    const list = Object.entries(objects).map(([id, def]) => ({
      id,
      name: def.name || id,
      label: def.label || def.name || id,
      ...def,
    }));

    list.sort((a, b) => String(a.label).localeCompare(String(b.label)));

    res.json({ objects: list });
  } catch (e) {
    console.error("defs route failed:", e);
    res.status(500).json({ error: "failed" });
  }
});

module.exports = router;