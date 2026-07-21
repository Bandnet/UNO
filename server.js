const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { Room, MAX_PLAYERS } = require("./game");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

// In-memory room storage. No accounts, no persistence beyond process lifetime —
// rooms disappear if the server restarts, which is fine for casual play with friends.
const rooms = new Map(); // code -> Room

function generateCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no confusing chars (0/O, 1/I)
  let code;
  do {
    code = Array.from({ length: 4 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
  } while (rooms.has(code));
  return code;
}

function broadcastState(room) {
  for (const p of room.players) {
    if (p.socketId) io.to(p.socketId).emit("state", room.viewFor(p.id));
  }
}

function socketIdsInRoom(room) {
  return room.players.filter((p) => p.socketId).map((p) => p.socketId);
}

io.on("connection", (socket) => {
  let currentRoomCode = null;
  let currentPlayerId = null;

  socket.on("createRoom", ({ name, rules }, cb) => {
    try {
      const code = generateCode();
      const room = new Room(code, name || "Host", rules);
      const hostPlayer = room.players[0];
      hostPlayer.socketId = socket.id;
      rooms.set(code, room);
      socket.join(code);
      currentRoomCode = code;
      currentPlayerId = hostPlayer.id;
      cb({ ok: true, code, playerId: hostPlayer.id });
      broadcastState(room);
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  socket.on("joinRoom", ({ code, name }, cb) => {
    try {
      code = (code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) throw new Error("Room not found");
      const playerId = room.addPlayer(name || "Player", socket.id);
      socket.join(code);
      currentRoomCode = code;
      currentPlayerId = playerId;
      cb({ ok: true, code, playerId });
      broadcastState(room);
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  socket.on("rejoin", ({ code, playerId }, cb) => {
    try {
      code = (code || "").toUpperCase().trim();
      const room = rooms.get(code);
      if (!room) throw new Error("Room not found");
      const player = room.players.find((p) => p.id === playerId);
      if (!player) throw new Error("Player not found in room");
      player.socketId = socket.id;
      player.connected = true;
      socket.join(code);
      currentRoomCode = code;
      currentPlayerId = playerId;
      cb({ ok: true, code, playerId });
      broadcastState(room);
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  socket.on("startGame", (_, cb) => {
    try {
      const room = rooms.get(currentRoomCode);
      if (!room) throw new Error("Room not found");
      room.start();
      cb({ ok: true });
      broadcastState(room);
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  socket.on("playCard", ({ cardId, chosenColor, swapTargetId, calledUno }, cb) => {
    try {
      const room = rooms.get(currentRoomCode);
      if (!room) throw new Error("Room not found");
      const events = room.playCard(currentPlayerId, cardId, { chosenColor, swapTargetId, calledUno });
      cb({ ok: true });
      broadcastState(room);
      io.to(currentRoomCode).emit("events", events);
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  socket.on("drawCard", (_, cb) => {
    try {
      const room = rooms.get(currentRoomCode);
      if (!room) throw new Error("Room not found");
      const events = room.drawCard(currentPlayerId);
      cb({ ok: true });
      broadcastState(room);
      io.to(currentRoomCode).emit("events", events);
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  socket.on("passTurn", (_, cb) => {
    try {
      const room = rooms.get(currentRoomCode);
      if (!room) throw new Error("Room not found");
      const events = room.passTurn(currentPlayerId);
      cb({ ok: true });
      broadcastState(room);
      io.to(currentRoomCode).emit("events", events);
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  socket.on("catchUno", ({ targetId }, cb) => {
    try {
      const room = rooms.get(currentRoomCode);
      if (!room) throw new Error("Room not found");
      const events = room.catchUno(currentPlayerId, targetId);
      cb({ ok: true });
      broadcastState(room);
      io.to(currentRoomCode).emit("events", events);
    } catch (err) {
      cb({ ok: false, error: err.message });
    }
  });

  socket.on("chat", ({ text }) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const player = room.players.find((p) => p.id === currentPlayerId);
    io.to(currentRoomCode).emit("chat", { name: player ? player.name : "?", text: String(text).slice(0, 300) });
  });

  socket.on("disconnect", () => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const disconnectRoomCode = currentRoomCode;
    room.removePlayerBySocket(socket.id);
    broadcastState(room);
    // Clean up empty, unstarted rooms after a delay.
    setTimeout(() => {
      const r = rooms.get(disconnectRoomCode);
      if (r && !r.started && r.players.every((p) => !p.connected)) {
        rooms.delete(disconnectRoomCode);
      }
    }, 5 * 60 * 1000);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`UNO server running on port ${PORT}`));