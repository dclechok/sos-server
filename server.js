// server.js (or index.js) — UPDATED (CORS + Socket.IO fixed for credentials)

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { createServer } = require("http");
const { Server } = require("socket.io");
const { connectDB } = require("./config/db");
const routes = require("./routes");
const socketHandler = require("./sockets/socket");
const path = require("path");
const { startWorldTick } = require("./world/worldTick");
const { startWorldObjectsCleanup } = require("./world/worldObjectsCleanup");

// ✅ load item/object templates (JSON)
const { loadGameData } = require("./gameData/gameDataLoader");

const app = express();
const httpServer = createServer(app);

/**
 * CORS — IMPORTANT:
 * If your client uses fetch(..., { credentials: "include" }),
 * then you CANNOT use Access-Control-Allow-Origin: "*".
 * You must explicitly allow the client origin + credentials.
 */
const allowedOrigins = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "sos-client-ce1q76c6o-dclechoks-projects.vercel.app"
  // Add your production client origin(s) here:
  // "https://your-vercel-app.vercel.app",
];

// Express CORS (REST)
app.use(
  cors({
    origin: (origin, cb) => {
      // allow requests with no origin (curl/postman/health checks)
      if (!origin) return cb(null, true);

      if (allowedOrigins.includes(origin)) return cb(null, true);

      // Helpful debug if you're hitting a different origin than expected
      return cb(new Error(`CORS blocked for origin: ${origin}`));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);

app.use(express.json());

// Static world assets
app.use("/world", express.static(path.join(__dirname, "world")));

// Socket.IO CORS (WebSocket)
const io = new Server(httpServer, {
  cors: {
    origin: allowedOrigins,
    credentials: true,
  },
  transports: ["websocket"],
});

io.engine.on("connection_error", (err) => {
  console.log("🚨 ENGINE ERROR:", err.code, err.message, err.req?.headers);
});

async function startServer() {
  // ✅ Load game data templates on boot
  loadGameData({ watch: process.env.NODE_ENV !== "production" });

  const db = await connectDB();
  app.locals.db = db;
  app.locals.io = io;

  // ✅ start decay cleanup loop (campfire 2m, drops 15m, etc.)
  startWorldObjectsCleanup({ db, io });

  // REST API routes
  app.use("/api", routes);

  // SOCKET.IO HANDLER
  socketHandler(io);

  startWorldTick();

  const PORT = process.env.PORT || 5000;
  httpServer.listen(PORT, () =>
    console.log(`🚀 Server with Socket.IO running on ${PORT}`)
  );
}

startServer();