// world/worldObjectsCleanup.js

function startWorldObjectsCleanup({ db, io, intervalMs = 30000 }) {
  if (!db) throw new Error("startWorldObjectsCleanup: missing db");

  setInterval(async () => {
    try {
      const now = new Date();

      const expired = await db
        .collection("world_objects")
        .find({ expiresAt: { $type: "date", $lte: now } })
        .project({ _id: 1 })
        .limit(1000)
        .toArray();

      if (!expired.length) return;

      const ids = expired.map((d) => d._id);

      await db.collection("world_objects").deleteMany({ _id: { $in: ids } });

      // ✅ Tell clients to remove them instantly (send strings)
      if (io) io.emit("obj:despawn", { ids: ids.map(String) });
    } catch (e) {
      console.error("worldObjects cleanup failed:", e);
    }
  }, intervalMs);
}

module.exports = { startWorldObjectsCleanup };