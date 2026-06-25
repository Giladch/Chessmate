const express = require("express");
const socket = require("socket.io");
const http = require("http");
const { Chess } = require("chess.js");

const app = express();
const server = http.createServer(app);
const io = socket(server);

/**
 * ── Race-chess variant (configurable) ───────────────────────────────────────
 * Settings are shared between both players and editable from the dashboard, but
 * only before the game starts (no moves made yet). When `raceEnabled` is on, a
 * player may get up to `leadCap` moves ahead of the opponent, and the further
 * ahead they are the longer they must wait before the next move (`delaysSec`,
 * one value per lead level 1..leadCap-1). When off, it is classic alternating
 * chess. Standard chess legality is always preserved (no king capture); a game
 * ends by checkmate, stalemate/insufficient material, resignation or draw.
 */
let settings = {
  raceEnabled: true,
  leadCap: 3,
  delaysSec: [3, 8],
};
const DEFAULT_DELAYS = [3, 8, 13, 20];

function sanitizeSettings(s) {
  const raceEnabled = !!(s && s.raceEnabled);
  let leadCap = parseInt(s && s.leadCap, 10);
  if (isNaN(leadCap)) leadCap = 3;
  leadCap = Math.max(1, Math.min(5, leadCap));
  const incoming = Array.isArray(s && s.delaysSec) ? s.delaysSec : [];
  const delaysSec = [];
  for (let i = 0; i < leadCap - 1; i++) {
    let v = parseFloat(incoming[i]);
    if (isNaN(v)) v = settings.delaysSec[i] != null ? settings.delaysSec[i] : DEFAULT_DELAYS[i] || 8;
    v = Math.max(0, Math.min(120, v));
    delaysSec.push(v);
  }
  return { raceEnabled, leadCap, delaysSec };
}

function effectiveCap() {
  return settings.raceEnabled ? settings.leadCap : 1;
}

function delayForLead(lead) {
  if (lead <= 0) return 0;
  if (lead >= effectiveCap()) return Infinity;
  if (!settings.raceEnabled) return Infinity;
  const sec = settings.delaysSec[lead - 1];
  return (sec != null ? sec : 8) * 1000;
}

const chess = new Chess();
let players = {};
let moves = { w: 0, b: 0 };
let lastMoveAt = { w: 0, b: 0 };
let gameOver = null; // { winner: 'w'|'b'|null, reason }

// Flip the side-to-move in the FEN so the same colour can move again (race mode).
function forceTurn(color) {
  const parts = chess.fen().split(" ");
  parts[1] = color;
  parts[3] = "-";
  chess.load(parts.join(" "));
}

function colorOf(socketId) {
  if (players.white === socketId) return "w";
  if (players.black === socketId) return "b";
  return null;
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch (e) {
    return fallback;
  }
}

function cooldownState(now) {
  const out = {};
  ["w", "b"].forEach((c) => {
    const other = c === "w" ? "b" : "w";
    const lead = moves[c] - moves[other];
    const required = delayForLead(lead);
    const blocked = lead >= effectiveCap();
    out[c] = {
      lead,
      blocked,
      remainingMs: blocked ? null : Math.max(0, required - (now - lastMoveAt[c])),
    };
  });
  return out;
}

function buildState(lastMove) {
  return {
    fen: chess.fen(),
    lastMove: lastMove || null,
    moves: { w: moves.w, b: moves.b },
    turn: safe(() => chess.turn(), "w"),
    cooldown: cooldownState(Date.now()),
    check: safe(() => chess.isCheck(), false),
    gameOver,
    started: moves.w + moves.b > 0,
    settings,
  };
}

function broadcastState(lastMove) {
  io.emit("gameState", buildState(lastMove));
}

function resetGame() {
  chess.reset();
  moves = { w: 0, b: 0 };
  lastMoveAt = { w: 0, b: 0 };
  gameOver = null;
}

function squareToRC(sq) {
  return { col: sq.charCodeAt(0) - 97, row: 8 - parseInt(sq[1]) };
}

function finishOutcome(mover) {
  if (safe(() => chess.isCheckmate(), false)) {
    gameOver = { winner: mover, reason: "checkmate" };
  } else if (
    safe(() => chess.isStalemate(), false) ||
    safe(() => chess.isInsufficientMaterial(), false)
  ) {
    gameOver = { winner: null, reason: "draw" };
  }
}

app.set("view engine", "ejs");
app.use(express.static("public"));
app.get("/", (req, res) => res.render("index", { title: "Chessmate" }));

io.on("connection", (socket) => {
  if (!players.white) {
    players.white = socket.id;
    socket.emit("playerRole", "w");
  } else if (!players.black) {
    players.black = socket.id;
    socket.emit("playerRole", "b");
  } else {
    socket.emit("spectator");
  }
  socket.emit("gameState", buildState(null));

  socket.on("disconnect", () => {
    if (players.white === socket.id) delete players.white;
    else if (players.black === socket.id) delete players.black;
  });

  socket.on("updateSettings", (incoming) => {
    if (moves.w + moves.b !== 0) {
      socket.emit("settingsRejected", {
        reason: "Game in progress — Restart to change settings",
      });
      return;
    }
    settings = sanitizeSettings(incoming);
    broadcastState(null);
    io.emit("notice", { type: "restart", text: "Settings updated" });
  });

  socket.on("move", (move) => {
    const c = colorOf(socket.id);
    if (!c) return;
    if (gameOver) {
      socket.emit("moveRejected", { reason: "Game over" });
      return;
    }
    const other = c === "w" ? "b" : "w";
    const now = Date.now();

    if (!settings.raceEnabled) {
      // Classic alternating chess.
      if (safe(() => chess.turn(), "w") !== c) {
        socket.emit("moveRejected", { reason: "Not your turn" });
        return;
      }
      let result = null;
      try {
        result = chess.move(move);
      } catch (e) {
        result = null;
      }
      if (!result) {
        socket.emit("moveRejected", { reason: "Illegal move" });
        return;
      }
      moves[c] += 1;
      lastMoveAt[c] = now;
      finishOutcome(c);
      broadcastState({ from: squareToRC(result.from), to: squareToRC(result.to) });
      return;
    }

    // Race mode.
    if (moves.w + moves.b === 0 && c !== "w") {
      socket.emit("moveRejected", { reason: "White starts" });
      return;
    }
    const lead = moves[c] - moves[other];
    if (lead >= effectiveCap()) {
      socket.emit("moveRejected", {
        reason: `Max ${effectiveCap()} moves ahead — wait for your opponent`,
      });
      return;
    }
    const required = delayForLead(lead);
    const waited = now - lastMoveAt[c];
    if (waited < required) {
      socket.emit("moveRejected", { reason: "On cooldown", waitMs: required - waited });
      return;
    }

    forceTurn(c);
    let result = null;
    try {
      result = chess.move(move);
    } catch (e) {
      result = null;
    }
    if (!result) {
      socket.emit("moveRejected", { reason: "Illegal move" });
      return;
    }
    moves[c] += 1;
    lastMoveAt[c] = now;
    finishOutcome(c);
    broadcastState({ from: squareToRC(result.from), to: squareToRC(result.to) });
  });

  socket.on("restartGame", () => {
    resetGame();
    broadcastState(null);
    io.emit("notice", { type: "restart", text: "Game restarted" });
  });

  socket.on("offerDraw", () => socket.broadcast.emit("offerDraw"));
  socket.on("drawAccepted", () => {
    gameOver = { winner: null, reason: "draw" };
    broadcastState(null);
    io.emit("notice", { type: "draw", text: "Game ended in a draw" });
  });
  socket.on("drawRejected", () => socket.broadcast.emit("drawRejected"));
  socket.on("playerResigned", () => {
    const c = colorOf(socket.id);
    if (c) {
      gameOver = { winner: c === "w" ? "b" : "w", reason: "resign" };
      broadcastState(null);
    }
    io.emit("notice", { type: "resign", text: "A player resigned" });
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Chessmate (configurable race variant) running on :${PORT}`)
);
