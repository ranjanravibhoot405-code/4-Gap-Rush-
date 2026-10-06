
const path = require("path");
const http = require("http");
const express = require("express");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, clientTracking: true });
const rooms = new Map();

app.use(express.static(path.join(__dirname, "public")));
app.get("/race", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

let humanGlbCache = null;
let humanGlbLoading = null;
let humanGlbSource = null;
let humanGlbLastError = null;

const HUMAN_GLB_SOURCES = [
  "https://raw.githubusercontent.com/kunalkushwaha/vsim/main/packages/assets/library/human.glb",
  "https://raw.githubusercontent.com/Richardengle/3dfiles/main/human.glb"
];

// Always serve the model from this game's own origin. The browser therefore
// never has to solve cross-origin/CORS problems for the GLB or its embedded
// textures.
app.get("/assets/human.glb", async (req, res) => {
  try {
    if (humanGlbCache) {
      res.set("Content-Type", "model/gltf-binary");
      res.set("Cache-Control", "public, max-age=86400, immutable");
      return res.send(humanGlbCache);
    }

    if (!humanGlbLoading) {
      humanGlbLoading = (async () => {
        let lastErr = null;
        for (const source of HUMAN_GLB_SOURCES) {
          try {
            const r = await fetch(source, { redirect: "follow" });
            if (!r.ok) throw new Error("HTTP " + r.status);
            const ab = await r.arrayBuffer();
            const buf = Buffer.from(ab);
            if (buf.length < 100000 || buf.toString("ascii",0,4) !== "glTF") {
              throw new Error("response is not a valid GLB");
            }
            humanGlbCache = buf;
            humanGlbSource = source;
            humanGlbLastError = null;
            console.log("4 GAP RUSH: human GLB ready from", source, "bytes:", buf.length);
            return buf;
          } catch (err) {
            lastErr = err;
            console.warn("4 GAP RUSH: human source failed:", source, err.message);
          }
        }
        throw lastErr || new Error("all human sources failed");
      })().finally(() => { humanGlbLoading = null; });
    }

    const buf = await humanGlbLoading;
    res.set("Content-Type", "model/gltf-binary");
    res.set("Cache-Control", "public, max-age=86400, immutable");
    res.send(buf);
  } catch (err) {
    humanGlbLastError = String(err?.message || err);
    console.error("Human GLB proxy failed:", humanGlbLastError);
    res.status(502).json({ ok:false, error:"Human model unavailable", detail:humanGlbLastError });
  }
});

app.get("/assets/human-status", (req,res) => {
  res.json({
    ok: !!humanGlbCache,
    loading: !!humanGlbLoading,
    source: humanGlbSource,
    bytes: humanGlbCache?.length || 0,
    error: humanGlbLastError
  });
});

const send = (ws, msg) => {
  if (!ws || ws.readyState !== 1) return;
  try {
    ws.send(JSON.stringify(msg));
  } catch (err) {
    console.error("WebSocket send failed:", err.message);
  }
};

const broadcast = (room, msg) => {
  room.players.forEach(p => send(p.ws, msg));
};

function raceSnapshot(room) {
  return {
    type: "race_positions",
    gaps: room.gaps.map(g => ({ at: g.at, width: g.width })),
    players: [...room.players.values()].map(p => ({
      id: p.id,
      name: p.name,
      dist: p.dist,
      alive: p.alive,
      finished: p.finished,
      lane: p.lane,
      dress: p.dress || "starter"
    }))
  };
}

function racePoints(finishTime, finished){
  if(!finished || !Number.isFinite(Number(finishTime))) return 0;
  // Faster official finish time = more points. The score is intentionally
  // deterministic so every device sees the same reward for the same time.
  const seconds=Math.max(0,Number(finishTime)/1000);
  return Math.max(100, Math.min(1600, Math.round(1600 - seconds*7)));
}

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
      finished: p.finished,
      lane: p.lane,
      dress: p.dress || "starter"
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
  ws.isAlive = true;
  ws.on("error", err => console.error("WebSocket error:", err.message));
  ws.on("pong", () => { ws.isAlive = true; });

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
        players: new Map(),
        ended: false
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
        lane: room.players.size % 4,
        dress: String(m.dress || "starter"),
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
        ready: true,
        dist: 0,
        recovery: 2,
        alive: true,
        finished: false,
        lane: room.players.size % 4,
        dress: String(m.dress || "starter"),
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
      room.winner = null;
      room.players.forEach(p => { p.usedChoices = []; p.gapIndex = 0; p.dist = 0; p.recovery = 2; p.alive = true; p.finished = false; p.finishTime = null; });

      const racePlayers = [...room.players.values()].map(p => ({
        id: p.id,
        name: p.name,
        dist: 0,
        alive: true,
        finished: false,
        lane: p.lane,
        dress: p.dress || "starter"
      }));

      // Send the complete initial race snapshot in the same packet.
      // This prevents the joining/opponent phone from creating its race scene
      // before it knows the authoritative gap widths and all player lanes.
      broadcast(room, {
        type: "race_start",
        startedAt: room.startedAt,
        gaps: room.gaps.map(g => ({ at: g.at, width: g.width })),
        players: racePlayers
      });

      // Keep a short race-start handshake available. If a phone misses the
      // first WebSocket packet while its browser is rendering the lobby,
      // race_sync lets it enter the same race without requiring a refresh.
      room.raceSyncUntil = Date.now() + 8000;
    }

    // CLIENT DISTANCE PROGRESS: server only accepts progress toward the next gap.
    if (m.type === "progress") {
      if (!room.started || room.ended || !player.alive || player.finished) return;
      player.gapIndex = player.gapIndex || 0;
      const nextGap = room.gaps[player.gapIndex];
      const reported = Number(m.dist);
      if (!Number.isFinite(reported)) return;
      const ceiling = nextGap ? nextGap.at : 2000;
      player.dist = Math.max(player.dist, Math.min(reported, ceiling));

      if(Number.isFinite(Number(m.lane))){
        player.lane=Math.max(0,Math.min(3,Math.floor(Number(m.lane))));
      }

      // Send an immediate authoritative snapshot after each progress update.
      broadcast(room, raceSnapshot(room));

      // Finish only when the runner actually reaches the finish line at 2000 m.
      if (!nextGap && player.dist >= 2000) {
        player.dist = 2000;
        player.finished = true;
        player.finishTime = Date.now() - room.startedAt;
        send(ws, { type: "jump_result", result: "finish", recovery: player.recovery, dist: 2000, usedChoices: player.usedChoices || [], finished: true });
        if(!room.winner) {
          room.winner = player.name;
          broadcast(room, { type:"winner_update", winner:player.name, time:player.finishTime });
        }
        broadcast(room, roomState(room));
        const terminal=[...room.players.values()].every(p => p.finished || !p.alive);
        if(terminal){
          room.ended = true;
          const results = [...room.players.values()]
            .map(p => ({
              id:p.id,
              name:p.name,
              finished:p.finished,
              alive:p.alive,
              time:p.finishTime ?? null,
              dist:p.dist,
              points:racePoints(p.finishTime, p.finished)
            }))
            .sort((a,b) => a.finished !== b.finished ? (a.finished ? -1 : 1) : (a.time ?? Infinity) - (b.time ?? Infinity));
          broadcast(room,{type:"race_over",results,winner:room.winner});
        }
      }
      return;
    }

    // If the runner ignores the jump prompt, treat it as a missed jump/fall
    // and allow the race to continue after the recovery animation.
    if (m.type === "skip_gap") {
      if (!room.started || room.ended || !player.alive || player.finished) return;
      player.gapIndex = player.gapIndex || 0;
      const gap = room.gaps[player.gapIndex];
      if (!gap || player.dist < gap.at - 18 || player.dist > gap.at + 2) return;
      player.gapIndex++;
      const hadRecovery = player.recovery > 0;
      if (hadRecovery) player.recovery--;
      player.dist = hadRecovery ? gap.at + 20 : gap.at;
      if (!hadRecovery) player.alive = false;
      send(ws, { type: "jump_result", result: "fall", recovery: Math.max(0, player.recovery), dist: player.dist, alive: player.alive, usedChoices: player.usedChoices || [] });
      broadcast(room, roomState(room));
      if ([...room.players.values()].every(p => p.finished || !p.alive)) {
        const results = [...room.players.values()]
          .map(p => ({ name: p.name, finished: p.finished, alive: p.alive, time: p.finishTime ?? null, dist: p.dist }))
          .sort((a, b) => a.finished !== b.finished ? (a.finished ? -1 : 1) : (a.time ?? Infinity) - (b.time ?? Infinity));
        broadcast(room, { type: "race_over", results, winner: results.find(p => p.finished)?.name || null });
      }
      return;
    }

    // JUMP: only allow the choice at the matching 400 m checkpoint.
    if (m.type === "jump") {
      if (!room.started || !player.alive || player.finished) return;
      player.usedChoices = player.usedChoices || [];
      player.gapIndex = player.gapIndex || 0;
      const gap = room.gaps[player.gapIndex];
      if (!gap) {
        // No more gaps: the player must continue through the final straight.
        // The progress handler declares the finish only at the real 2000 m line.
        return;
      }

      // A jump is valid only when the runner reaches the 400 m checkpoint
      // (within 2 m before it, through 5 m after it).
      if (player.dist < gap.at - 18 || player.dist > gap.at + 2) {
        return send(ws, { type:"error", message:"Jump is available from 18 m before to 2 m after the " + gap.at + " m gap." });
      }

      const choice = Number(m.choice);
      const remainingChoices = [3,5,7,9].filter(n => !player.usedChoices.includes(n));
      if (!remainingChoices.includes(choice)) {
        return send(ws, { type:"error", message:"That jump option is already used. Remaining: " + remainingChoices.join(", ") });
      }

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
        const hadRecovery = player.recovery > 0;
        if (hadRecovery) player.recovery--;
        player.dist = hadRecovery ? gap.at + 20 : gap.at;
        if (!hadRecovery) player.alive = false;
      }

      // After the fourth gap, keep racing through the final straight to 2000 m.
      // The progress handler will declare the finish only when the runner reaches it.
      send(ws, { type:"jump_result", result, width:gap.width, recovery:Math.max(0, player.recovery), dist:player.dist, alive:player.alive, usedChoices:player.usedChoices });
      broadcast(room, roomState(room));

      const terminal=[...room.players.values()].every(p=>p.finished||!p.alive);
      if(terminal){
        room.ended=true;
        const results=[...room.players.values()].map(p=>({
          id:p.id,
          name:p.name,
          finished:p.finished,
          alive:p.alive,
          time:p.finishTime??null,
          dist:p.dist,
          points:racePoints(p.finishTime,p.finished)
        }))
          .sort((a,b)=>a.finished!==b.finished?(a.finished?-1:1):(a.time??Infinity)-(b.time??Infinity));
        broadcast(room,{type:"race_over",results,winner:room.winner||results.find(p=>p.finished)?.name||null});
      }
    }

  });

  ws.on("close", () => leave(ws));
});

app.get("/health", (req,res) => {
  res.status(200).json({ok:true,service:"4-gap-rush",rooms:rooms.size});
});

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Keep multiplayer state synchronized independently of browser animation timing.
// A phone that renders slowly, pauses briefly, or misses a progress packet still
// receives the current track checkpoints and every opponent's position.
setInterval(() => {
  rooms.forEach(room => {
    if(room.started && !room.ended) {
      broadcast(room, raceSnapshot(room));
      if(room.raceSyncUntil && Date.now() < room.raceSyncUntil){
        broadcast(room, {
          type:"race_sync",
          startedAt:room.startedAt,
          gaps:room.gaps.map(g => ({at:g.at,width:g.width})),
          players:[...room.players.values()].map(p=>({
            id:p.id,name:p.name,dist:p.dist,alive:p.alive,finished:p.finished,lane:p.lane,dress:p.dress || "starter"
          }))
        });
      }
    }
  });
}, 200);

server.on("error", err => {
  console.error("HTTP server error:", err);
});

process.on("unhandledRejection", err => {
  console.error("Unhandled promise rejection:", err);
});

server.listen(process.env.PORT || 3000, () => {
  console.log("4 GAP RUSH server running");
});

// Render/WebSocket connections can occasionally become stale on mobile networks.
// ws handles pong automatically; periodic ping detects dead sockets early.
setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);
