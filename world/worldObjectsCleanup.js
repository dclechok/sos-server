// world/worldObjectsCleanup.js

function startWorldObjectsCleanup({ db, io, intervalMs = 30000 }) {
  setInterval(async () => {
    try {
      const now = new Date();

      const expired = await db
        .collection("world_objects")
        .find({ expiresAt: { $lte: now } })
        .project({ _id: 1 })
        .limit(1000)
        .toArray();

      if (!expired.length) return;

      const ids = expired.map((d) => d._id);

      await db.collection("world_objects").deleteMany({ _id: { $in: ids } });

      // Tell clients to remove them instantly
      if (io) io.emit("obj:despawn", { ids });
    } catch (e) {
      console.error("worldObjects cleanup failed:", e);
    }
  }, intervalMs);
}

module.exports = { startWorldObjectsCleanup };