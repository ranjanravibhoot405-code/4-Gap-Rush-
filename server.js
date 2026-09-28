
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const rooms = new Map();

app.use(express.static(path.join(__dirname, "public")));
app.get("/race", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const send = (ws, msg) => {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify(msg));
  }
};

const broadcast = (room, msg) => {
  room.players.forEach(p => send(p.ws, msg));
};

function makeCode() {
  let chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code;

  do {
    code = Array.from({ length: 6 }, () =>
      chars[Math.floor(Math.random() * chars.length)]
    ).join("");
  } while (rooms.has(code));

  return code;
}

function roomState(room) {
  return {
    type: "room_state",
    roomCode: room.code,
    hostId: room.hostId,
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      ready: p.ready,
      dist: p.dist,
      alive: p.alive,
      recovery: p.recovery,
      finished: p.finished
    }))
  };
}

function leave(ws) {
  if (!ws.player) return;

  const room = rooms.get(ws.player.room);
  const id = ws.player.id;

  if (!room) {
    ws.player = null;
    return;
  }

  room.players.delete(id);

  if (room.hostId === id) {
    room.hostId = room.players.keys().next().value || null;
  }

  if (room.players.size === 0) {
    rooms.delete(room.code);
  } else {
    broadcast(room, roomState(room));
  }

  ws.player = null;
}

wss.on("connection", ws => {

  ws.on("message", raw => {
    let m;

    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }

    // CREATE ROOM
    if (m.type === "create") {
      leave(ws);

      const room = {
        code: makeCode(),
        hostId: null,
        started: false,
        startedAt: null,
        gaps: [400, 800, 1200, 1600].map(at => ({
          at,
          width: [3, 5, 7, 9][Math.floor(Math.random() * 4)]
        })),
        players: new Map()
      };

      const id = Math.random().toString(36).slice(2, 9);

      room.hostId = id;

      room.players.set(id, {
        id,
        name: String(m.name || "Player").slice(0, 18),
        ready: true,
        dist: 0,
        recovery: 2,
        alive: true,
        finished: false,
        ws
      });

      rooms.set(room.code, room);
      ws.player = { room: room.code, id };

      send(ws, {
        type: "joined",
        room: room.code,
        id,
        host: true
      });

      return broadcast(room, roomState(room));
    }

    // JOIN ROOM
    if (m.type === "join") {
      leave(ws);

      const room = rooms.get(String(m.room || "").toUpperCase());

      if (!room) {
        return send(ws, {
          type: "error",
          message: "Room not found"
        });
      }

      if (room.started) {
        return send(ws, {
          type: "error",
          message: "Race already started"
        });
      }

      if (room.players.size >= 8) {
        return send(ws, {
          type: "error",
          message: "Room full"
        });
      }

      const id = Math.random().toString(36).slice(2, 9);

      room.players.set(id, {
        id,
        name: String(m.name || "Player").slice(0, 18),
        ready: false,
        dist: 0,
        recovery: 2,
        alive: true,
        finished: false,
        ws
      });

      ws.player = { room: room.code, id };

      send(ws, {
        type: "joined",
        room: room.code,
        id,
        host: false
      });

      return broadcast(room, roomState(room));
    }

    if (!ws.player) return;

    const room = rooms.get(ws.player.room);
    const player = room?.players.get(ws.player.id);

    if (!room || !player) return;

    // READY
    if (m.type === "ready") {
      if (room.started) return;

      player.ready = !!m.value;
      return broadcast(room, roomState(room));
    }

    // START RACE
    if (m.type === "start") {
      if (ws.player.id !== room.hostId) {
        return send(ws, {
          type: "error",
          message: "Only host can start"
        });
      }

      if (room.started) {
        return send(ws, {
          type: "error",
          message: "Race already started"
        });
      }

      if (![...room.players.values()].every(p => p.ready)) {
        return send(ws, {
          type: "error",
          message: "Everyone must be ready"
        });
      }

      room.started = true;
      room.startedAt = Date.now();
      room.players.forEach(p => { p.usedChoices = []; p.gapIndex = 0; p.dist = 0; p.recovery = 2; p.alive = true; p.finished = false; });

      return broadcast(room, {
        type: "race_start",
        startedAt: room.startedAt,
        gaps: room.gaps.map(g => g.at)
      });
    }

    // JUMP
    if (m.type === "jump") {
      if (!room.started || !player.alive || player.finished) return;
      
      player.usedChoices = player.usedChoices || [];
      player.gapIndex = player.gapIndex || 0;
      const choice = Number(m.choice);
      const remainingChoices = [3,5,7,9].filter(n => !player.usedChoices.includes(n));
      if (!remainingChoices.includes(choice)) {
        return send(ws, { type:"error", message:"That jump option is already used. Remaining: " + remainingChoices.join(", ") });
      }
      const gap = room.gaps[player.gapIndex];

// All gaps completed: finish the race
if (!gap) {
  player.dist = 2000;
  player.finished = true;
  player.finishTime = Date.now() - room.startedAt;

  send(ws, {
    type: "jump_result",
    result: "finish",
    recovery: player.recovery,
    dist: player.dist
  });

  broadcast(room, roomState(room));

  if ([...room.players.values()].every(p => p.finished || !p.alive)) {
    const results = [...room.players.values()].map(p => ({name:p.name, finished:p.finished, alive:p.alive, time:p.finishTime ?? null, dist:p.dist})).sort((a,b) => { if(a.finished!==b.finished) return a.finished?-1:1; return (a.time??Infinity)-(b.time??Infinity); });
    broadcast(room, { type:"race_over", results, winner:results.find(p=>p.finished)?.name || null });
  }

  return;
}

      if (!gap) return;

      let result;
      player.usedChoices.push(choice);
      player.gapIndex++;

      if (choice === gap.width) {
        result = "nitro";
        player.dist = gap.at + 71;
      } else if (choice > gap.width) {
        result = "skate";
        player.dist = gap.at + 36;
      } else {
        result = "fall";
        player.recovery--;
        player.dist = gap.at;

        if (player.recovery < 0) {
          player.alive = false;
        }
      }

      if (player.dist >= 2000) {
        player.dist = 2000;
        player.finished = true;
        player.finishTime = Date.now() - room.startedAt;
      }

      send(ws, {
        type: "jump_result",
        result,
        width: gap.width,
        recovery: player.recovery,
        dist: player.dist
      });

      broadcast(room, roomState(room));

      if ([...room.players.values()].every(p => p.finished || !p.alive)) {
        const results = [...room.players.values()].map(p => ({name:p.name, finished:p.finished, alive:p.alive, time:p.finishTime ?? null, dist:p.dist})).sort((a,b) => { if(a.finished!==b.finished) return a.finished?-1:1; return (a.time??Infinity)-(b.time??Infinity); });
        broadcast(room, { type:"race_over", results, winner:results.find(p=>p.finished)?.name || null });
      }
    }

  });

  ws.on("close", () => leave(ws));
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

server.listen(process.env.PORT || 3000, () => {
  console.log("4 GAP RUSH server running");
});
