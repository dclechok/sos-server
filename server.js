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

const app = express();
const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: { origin: "*" },
  transports: ["websocket"],
});

io.engine.on("connection_error", (err) => {
  console.log("🚨 ENGINE ERROR:", err.code, err.message, err.req.headers);
});

app.use(cors());
app.use(express.json());

app.use(
  "/world",
  express.static(path.join(__dirname, "world"))
);

async function startServer() {
  const db = await connectDB();
  app.locals.db = db;

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
