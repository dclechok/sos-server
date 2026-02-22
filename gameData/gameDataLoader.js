// server/gameData/gameDataLoader.js
//
// Loads item + world-object templates from JSON files into memory.
// - Templates live in JSON (version-controlled)
// - Instances live in DB (world_objects, inventories, etc.)
//
// Usage:
//   const { loadGameData, getItemDef, getObjectDef } = require("./gameData/gameDataLoader");
//   loadGameData(); // call once on server boot
//   const sword = getItemDef("iron_sword");
//
// Optional hot reload in dev:
//   loadGameData({ watch: process.env.NODE_ENV !== "production" });

const fs = require("fs");
const path = require("path");

const DEFAULT_PATHS = {
  items: path.join(__dirname, "items.json"),
  objects: path.join(__dirname, "objects.json"),
};

let _loaded = false;
let _paths = { ...DEFAULT_PATHS };

let _items = Object.create(null);
let _objects = Object.create(null);

let _watchers = [];
let _lastLoadAt = 0;

function readJsonFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  // Allow comments? (No.) Keep strict JSON.
  return JSON.parse(raw);
}

function assertPlainObject(name, v) {
  const ok =
    v &&
    typeof v === "object" &&
    !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype;

  if (!ok) {
    throw new Error(`${name} must be a JSON object map (e.g. { "id": {...}, ... })`);
  }
}

function validateKey(name, key) {
  // keep IDs simple and stable
  const s = String(key);
  if (!/^[a-z0-9_:-]{1,64}$/i.test(s)) {
    throw new Error(`${name} id "${s}" is invalid. Use letters/numbers/_/:- up to 64 chars.`);
  }
}

function validateDefsMap(mapName, defs) {
  assertPlainObject(mapName, defs);
  for (const [id, def] of Object.entries(defs)) {
    validateKey(mapName, id);
    if (!def || typeof def !== "object") {
      throw new Error(`${mapName}["${id}"] must be an object`);
    }
  }
}

function loadGameData(options = {}) {
  const {
    itemsPath = DEFAULT_PATHS.items,
    objectsPath = DEFAULT_PATHS.objects,
    watch = false,
    onReload = null, // function({ items, objects, loadedAt })
  } = options;

  _paths = { items: itemsPath, objects: objectsPath };

  const items = readJsonFile(_paths.items);
  const objects = readJsonFile(_paths.objects);

  validateDefsMap("items", items);
  validateDefsMap("objectDefs", objects);

  _items = items;
  _objects = objects;

  _loaded = true;
  _lastLoadAt = Date.now();

  if (watch) {
    startWatching({ onReload });
  }

  return { items: _items, objects: _objects, loadedAt: _lastLoadAt };
}

function startWatching({ onReload } = {}) {
  stopWatching();

  const debounceMs = 150;
  let t = null;

  function reloadSoon() {
    if (t) clearTimeout(t);
    t = setTimeout(() => {
      try {
        // reload with same paths, keep watch on
        const out = loadGameData({
          itemsPath: _paths.items,
          objectsPath: _paths.objects,
          watch: false, // prevent recursive watcher creation
        });
        if (typeof onReload === "function") onReload(out);
        // eslint-disable-next-line no-console
        console.log("🔄 gameData reloaded:", new Date(out.loadedAt).toISOString());
      } catch (e) {
        console.error("❌ gameData reload failed:", e.message);
      }
    }, debounceMs);
  }

  for (const p of [_paths.items, _paths.objects]) {
    try {
      const w = fs.watch(p, { persistent: true }, (evt) => {
        if (evt === "change" || evt === "rename") reloadSoon();
      });
      _watchers.push(w);
    } catch (e) {
      console.error("Failed to watch gameData file:", p, e.message);
    }
  }
}

function stopWatching() {
  for (const w of _watchers) {
    try {
      w.close();
    } catch {}
  }
  _watchers = [];
}

function ensureLoaded() {
  if (_loaded) return;
  throw new Error(
    "Game data not loaded. Call loadGameData() once on server startup."
  );
}

function getItemDef(id) {
  ensureLoaded();
  return _items[String(id)] || null;
}

function getObjectDef(id) {
  ensureLoaded();
  return _objects[String(id)] || null;
}

function requireItemDef(id) {
  const def = getItemDef(id);
  if (!def) throw new Error(`Unknown item defId: ${id}`);
  return def;
}

function requireObjectDef(id) {
  const def = getObjectDef(id);
  if (!def) throw new Error(`Unknown object defId: ${id}`);
  return def;
}

function listItemIds() {
  ensureLoaded();
  return Object.keys(_items);
}

function listObjectIds() {
  ensureLoaded();
  return Object.keys(_objects);
}

function getGameDataSnapshot() {
  ensureLoaded();
  // Shallow copy to avoid accidental mutation
  return {
    items: { ..._items },
    objects: { ..._objects },
    loadedAt: _lastLoadAt,
  };
}

module.exports = {
  loadGameData,
  startWatching,
  stopWatching,

  getItemDef,
  getObjectDef,
  requireItemDef,
  requireObjectDef,

  listItemIds,
  listObjectIds,
  getGameDataSnapshot,
};