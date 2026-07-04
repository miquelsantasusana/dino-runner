"use strict";

/*
 * Dino Runner multiplayer server.
 * Serves the static client from ./public and hosts WebSocket rooms.
 * The server is deliberately thin: it manages lobbies, picks the shared
 * course seed, relays per-player state, and declares the winner.
 * All game physics runs on the clients (same seed = same obstacle course).
 */

const http = require("http");
const fs = require("fs");
const path = require("path");
const { WebSocketServer } = require("ws");

const PORT = process.env.PORT || 8642;
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_PLAYERS = 8;
const COUNTDOWN_MS = 3000;
const GRACE_MS = 5 * 60 * 1000; // disconnected players (and their rooms) survive this long

const PALETTE = [
  "#4caf50", // green
  "#2196f3", // blue
  "#ff9800", // orange
  "#9c27b0", // purple
  "#e91e63", // pink
  "#00bcd4", // teal
  "#f44336", // red
  "#8d6e63", // brown
];

// ---------------------------------------------------------------------------
// Static file server
// ---------------------------------------------------------------------------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const server = http.createServer((req, res) => {
  let urlPath = decodeURIComponent(req.url.split("?")[0]);
  if (urlPath === "/") urlPath = "/index.html";
  const filePath = path.join(PUBLIC_DIR, path.normalize(urlPath));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end("forbidden");
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end("not found");
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-cache", // clients must revalidate so deploys reach every phone
    });
    res.end(data);
  });
});

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------
const rooms = new Map(); // code -> room
let nextPlayerId = 1;

function makeCode() {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ"; // no I/L/O — unambiguous
  let code;
  do {
    code = Array.from({ length: 4 }, () => alphabet[(Math.random() * alphabet.length) | 0]).join("");
  } while (rooms.has(code));
  return code;
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptId = null) {
  for (const p of room.players.values()) {
    if (p.id !== exceptId) send(p.ws, msg);
  }
}

function lobbyMsg(room) {
  return {
    t: "lobby",
    code: room.code,
    hostId: room.hostId,
    phase: room.phase,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      avatar: p.avatar,
      connected: p.connected !== false,
    })),
  };
}

// small data-URL image or nothing — never trust client sizes
function cleanAvatar(a) {
  return typeof a === "string" && a.startsWith("data:image/") && a.length <= 64000 ? a : null;
}

function freeColor(room) {
  const used = new Set([...room.players.values()].map((p) => p.color));
  return PALETTE.find((c) => !used.has(c)) || PALETTE[room.players.size % PALETTE.length];
}

function startRace(room) {
  room.phase = "playing";
  room.seed = (Math.random() * 2 ** 31) | 0;
  room.deathSeq = 0;
  for (const p of room.players.values()) {
    p.alive = true;
    p.score = 0;
    p.deathSeq = null;
  }
  broadcast(room, {
    t: "start",
    seed: room.seed,
    countdown: COUNTDOWN_MS,
    players: [...room.players.values()].map((p) => ({ id: p.id, name: p.name, color: p.color, avatar: p.avatar })),
  });
}

function checkRaceEnd(room) {
  if (room.phase !== "playing") return;
  const alive = [...room.players.values()].filter((p) => p.alive);
  const needed = room.players.size > 1 ? 1 : 0; // solo room: race ends when its player dies
  if (alive.length > needed) return;

  room.phase = "over";
  const winner = alive[0] || null;
  // standings kept on the room so a player who reconnects can still see them
  // standings: survivor first, then by who lasted longest (later death = better), score breaks ties
  const standings = [...room.players.values()]
    .sort((a, b) => {
      const ra = a.alive ? Infinity : a.deathSeq;
      const rb = b.alive ? Infinity : b.deathSeq;
      return rb - ra || b.score - a.score;
    })
    .map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score, alive: p.alive }));
  room.lastOver = { t: "over", winnerId: winner ? winner.id : standings[0]?.id ?? null, standings };
  broadcast(room, room.lastOver);
}

// remove a stale entry left by the same device (page reload, second tab)
function evictToken(token, except) {
  if (!token) return;
  for (const room of rooms.values()) {
    for (const p of room.players.values()) {
      if (p.token === token && p !== except) {
        leaveRoom(p);
        return;
      }
    }
  }
}

function leaveRoom(player) {
  const room = player.room;
  if (!room) return;
  room.players.delete(player.id);
  player.room = null;

  if (room.players.size === 0) {
    rooms.delete(room.code);
    return;
  }
  if (room.hostId === player.id) {
    room.hostId = room.players.keys().next().value; // promote oldest member
  }
  if (room.phase === "playing" && player.alive) {
    player.alive = false;
    player.deathSeq = ++room.deathSeq;
    broadcast(room, { t: "died", id: player.id, score: player.score });
    checkRaceEnd(room);
  }
  broadcast(room, lobbyMsg(room));
}

// ---------------------------------------------------------------------------
// WebSocket handling
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  // `player` may later be swapped for an existing entry on rejoin
  let player = {
    id: nextPlayerId++,
    ws,
    name: "anon",
    color: null,
    token: null,
    connected: true,
    disconnectedAt: 0,
    room: null,
    alive: false,
    score: 0,
    deathSeq: null,
  };

  ws.on("message", (raw) => {
    if (player.ws !== ws) return; // superseded socket
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    const room = player.room;

    switch (msg.t) {
      case "create": {
        if (room) leaveRoom(player);
        player.name = String(msg.name || "anon").slice(0, 12);
        player.avatar = cleanAvatar(msg.avatar);
        player.token = String(msg.token || "").slice(0, 64) || null;
        evictToken(player.token, player);
        const newRoom = {
          code: makeCode(),
          players: new Map(),
          hostId: player.id,
          phase: "lobby",
          seed: 0,
          deathSeq: 0,
        };
        player.color = PALETTE[0];
        newRoom.players.set(player.id, player);
        player.room = newRoom;
        rooms.set(newRoom.code, newRoom);
        send(ws, { ...lobbyMsg(newRoom), t: "joined", you: player.id });
        break;
      }

      case "join": {
        if (room) leaveRoom(player);
        player.token = String(msg.token || "").slice(0, 64) || null;
        evictToken(player.token, player);
        const target = rooms.get(String(msg.code || "").toUpperCase());
        if (!target) return send(ws, { t: "error", msg: "Room not found" });
        if (target.phase !== "lobby") return send(ws, { t: "error", msg: "Race already in progress" });
        if (target.players.size >= MAX_PLAYERS) return send(ws, { t: "error", msg: "Room is full" });
        player.name = String(msg.name || "anon").slice(0, 12);
        player.avatar = cleanAvatar(msg.avatar);
        player.color = freeColor(target);
        target.players.set(player.id, player);
        player.room = target;
        send(ws, { ...lobbyMsg(target), t: "joined", you: player.id });
        broadcast(target, lobbyMsg(target), player.id);
        break;
      }

      case "rejoin": {
        // reclaim an existing seat after a dropped socket or page reload
        const tok = String(msg.token || "").slice(0, 64);
        let found = null;
        if (tok) {
          outer: for (const r of rooms.values()) {
            for (const p of r.players.values()) {
              if (p.token === tok) { found = p; break outer; }
            }
          }
        }
        if (!found) return send(ws, { t: "error", msg: "Room expired" });
        if (found.ws && found.ws !== ws && found.ws.readyState === found.ws.OPEN) {
          const stale = found.ws;
          found.ws = ws; // detach before closing so the close handler ignores it
          try { stale.close(); } catch {}
        }
        found.ws = ws;
        found.connected = true;
        player = found;
        send(ws, { ...lobbyMsg(found.room), t: "joined", you: found.id });
        if (found.room.phase === "over" && found.room.lastOver) send(ws, found.room.lastOver);
        broadcast(found.room, lobbyMsg(found.room), found.id);
        break;
      }

      case "start": {
        if (!room || room.hostId !== player.id || room.phase === "playing") return;
        startRace(room);
        break;
      }

      case "state": {
        if (!room || room.phase !== "playing" || !player.alive) return;
        player.score = msg.score | 0;
        broadcast(room, { t: "state", id: player.id, y: msg.y, duck: !!msg.duck, score: player.score, d: msg.d | 0 }, player.id);
        break;
      }

      case "died": {
        if (!room || room.phase !== "playing" || !player.alive) return;
        player.alive = false;
        player.score = msg.score | 0;
        player.deathSeq = ++room.deathSeq;
        broadcast(room, { t: "died", id: player.id, score: player.score }, player.id);
        checkRaceEnd(room);
        break;
      }

      case "rematch": {
        if (!room || room.hostId !== player.id || room.phase !== "over") return;
        startRace(room);
        break;
      }

      case "leave": {
        leaveRoom(player);
        break;
      }
    }
  });

  ws.on("close", () => {
    if (player.ws !== ws) return; // this socket was superseded by a rejoin
    player.connected = false;
    player.disconnectedAt = Date.now();
    const room = player.room;
    if (!room) return;
    // don't remove them — keep the seat (and the room) for GRACE_MS so a
    // backgrounded phone can come back; mid-race the dino dies immediately
    if (room.phase === "playing" && player.alive) {
      player.alive = false;
      player.deathSeq = ++room.deathSeq;
      broadcast(room, { t: "died", id: player.id, score: player.score });
      checkRaceEnd(room);
    }
    broadcast(room, lobbyMsg(room));
  });
  ws.on("error", () => {});
});

// sweep out players whose grace period expired (leaveRoom deletes empty rooms)
setInterval(() => {
  for (const room of [...rooms.values()]) {
    for (const p of [...room.players.values()]) {
      if (p.connected === false && Date.now() - p.disconnectedAt > GRACE_MS) {
        leaveRoom(p);
      }
    }
  }
}, 30 * 1000);

// keepalive so proxies don't cut idle lobby sockets
setInterval(() => {
  for (const client of wss.clients) {
    try { client.ping(); } catch {}
  }
}, 30 * 1000);

server.listen(PORT, () => {
  console.log(`Dino Runner server on http://localhost:${PORT}`);
});
