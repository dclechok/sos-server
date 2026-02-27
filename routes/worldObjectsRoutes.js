// routes/worldObjectsRoutes.js
const router = require("express").Router();

const {
  chunkKeysInRadius,
  chunkKeyFromWorld,
  ttlMsForDefId,
  CHUNK_PX,
} = require("../world/worldObjects");

/**
 * ✅ Decay rule (server authoritative):
 * - decayTimeMs (or legacy ttlMs/defaultTTLms) <= 0 OR missing => never decays (no expiresAt field)
 * - decayTimeMs > 0 => expires after that many ms (expiresAt set)
 */
function resolveDecayTimeMsFromReq({ defId, body }) {
  const raw =
    body?.decayTimeMs ?? // ✅ new
    body?.ttlMs ?? // legacy
    body?.defaultTTLms; // legacy

  const n = Number(raw);

  // explicitly provided
  if (Number.isFinite(n)) {
    if (n <= 0) return 0;
    return Math.floor(n);
  }

  // fallback by defId
  const fallback = Number(ttlMsForDefId(defId));
  if (!Number.isFinite(fallback) || fallback <= 0) return 0;
  return Math.floor(fallback);
}

function liveExpiryClause(now) {
  return {
    $or: [
      { expiresAt: { $exists: false } }, // immortal
      { expiresAt: { $type: "date", $gt: now } }, // not expired
    ],
  };
}

// ✅ NEW
// GET /api/world/objects/near?x=123&y=456&r=2400&worldId=main
router.get("/objects/near", async (req, res) => {
  try {
    const db = req.app.locals.db;
    if (!db) return res.status(500).json({ error: "DB not ready" });

    const worldId = String(req.query.worldId || "main");
    const x = Number(req.query.x);
    const y = Number(req.query.y);
    const r = Math.max(0, Number(req.query.r || 2400));

    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return res.status(400).json({ error: "x and y are required numbers" });
    }

    // Convert world x/y -> chunk cx/cy
    const key = chunkKeyFromWorld(x, y);
    const [cx, cy] = String(key).split(",").map((n) => Number(n));

    // Convert pixel radius -> chunk radius
    const radiusChunks = Math.min(6, Math.max(0, Math.ceil(r / CHUNK_PX)));

    const now = new Date();
    const keys = chunkKeysInRadius(cx, cy, radiusChunks);

    const objects = await db
      .collection("world_objects")
      .find({
        worldId,
        chunkKey: { $in: keys },
        deletedAt: { $exists: false },
        ...liveExpiryClause(now), // ✅ include immortals
      })
      .toArray();

    res.json({ objects, cx, cy, radius: radiusChunks });
  } catch (e) {
    console.error("GET /api/world/objects/near failed:", e);
    res.status(500).json({ error: "failed" });
  }
});

// GET /api/world/objects?cx=0&cy=0&radius=2&worldId=main
router.get("/objects", async (req, res) => {
  try {
    const db = req.app.locals.db;
    if (!db) return res.status(500).json({ error: "DB not ready" });

    const worldId = String(req.query.worldId || "main");
    const cx = Number(req.query.cx);
    const cy = Number(req.query.cy);
    const radius = Math.min(6, Math.max(0, Number(req.query.radius || 2)));

    if (!Number.isFinite(cx) || !Number.isFinite(cy)) {
      return res.status(400).json({ error: "cx and cy are required numbers" });
    }

    const now = new Date();
    const keys = chunkKeysInRadius(cx, cy, radius);

    const objects = await db
      .collection("world_objects")
      .find({
        worldId,
        chunkKey: { $in: keys },
        deletedAt: { $exists: false },
        ...liveExpiryClause(now), // ✅ include immortals
      })
      .toArray();

    res.json({ objects });
  } catch (e) {
    console.error("GET /api/world/objects failed:", e);
    res.status(500).json({ error: "failed" });
  }
});

// POST /api/world/objects/spawn
// body: { worldId?, defId, x, y, state?, ownerId?, decayTimeMs?, ttlMs? }
router.post("/objects/spawn", async (req, res) => {
  try {
    const db = req.app.locals.db;
    if (!db) return res.status(500).json({ error: "DB not ready" });

    const io = req.app.locals.io;

    const worldId = String(req.body.worldId || "main");
    const defId = String(req.body.defId || "");
    const x = Number(req.body.x);
    const y = Number(req.body.y);
    const state = req.body.state || {};
    const ownerId = req.body.ownerId || null;

    if (!defId || !Number.isFinite(x) || !Number.isFinite(y)) {
      return res.status(400).json({ error: "defId, x, y are required" });
    }

    const decayTimeMs = resolveDecayTimeMsFromReq({ defId, body: req.body });

    const now = new Date();

    const doc = {
      worldId,
      kind: "dynamic",
      defId,
      x,
      y,
      chunkKey: chunkKeyFromWorld(x, y),
      ownerId,
      state: {
        ...(state || {}),
        // ✅ normalize into the new name
        decayTimeMs,
      },
      createdAt: now,
      // expiresAt only if decayTimeMs > 0
    };

    if (decayTimeMs > 0) {
      doc.expiresAt = new Date(now.getTime() + decayTimeMs);
    }

    const result = await db.collection("world_objects").insertOne(doc);
    const saved = { ...doc, _id: result.insertedId };

    if (io) io.emit("obj:spawn", saved);

    res.json({ ok: true, object: saved });
  } catch (e) {
    console.error("POST /api/world/objects/spawn failed:", e);
    res.status(500).json({ error: "failed" });
  }
});

module.exports = router;