const express = require("express");
const socket = require("socket.io");
const http = require("http");
const { Chess } = require("chess.js");

const app = express();
const server = http.createServer(app);
const io = socket(server);

/**
 * ── Race-chess variant ──────────────────────────────────────────────────────
 * Instead of strict alternation, a player may get up to LEAD_CAP moves ahead of
 * the opponent. The further ahead you are, the longer you must wait before your
 * next move (cooldown grows with your lead). White makes the first move; after
 * that it is a free race under the lead cap + delay. Standard chess legality is
 * preserved (no moving into check, no king capture); a game ends by checkmate,
 * stalemate/insufficient material (draw), resignation, or an agreed draw.
 */
const LEAD_CAP = 3;
const DELAY_BY_LEAD = { 0: 0, 1: 3000, 2: 8000 }; // ms; lead >= LEAD_CAP is blocked

function delayForLead(lead) {
  if (lead <= 0) return 0;
  if (lead >= LEAD_CAP) return Infinity;
  return DELAY_BY_LEAD[lead] != null ? DELAY_BY_LEAD[lead] : 8000;
}

const chess = new Chess();
let players = {};
let moves = { w: 0, b: 0 };
let lastMoveAt = { w: 0, b: 0 };
let gameOver = null; // { winner: 'w'|'b'|null, reason: 'checkmate'|'stalemate'|'draw'|'resign' }

// Flip the side-to-move in the FEN so the same colour can move again. En-passant
// target is cleared because it only ever applies to the immediate reply.
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

function cooldownState(now) {
  const out = {};
  ["w", "b"].forEach((c) => {
    const other = c === "w" ? "b" : "w";
    const lead = moves[c] - moves[other];
    const required = delayForLead(lead);
    const blocked = lead >= LEAD_CAP;
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
    cooldown: cooldownState(Date.now()),
    check: safe(() => chess.isCheck(), false),
    gameOver,
    firstMove: moves.w + moves.b === 0,
  };
}

function safe(fn, fallback) {
  try {
    return fn();
  } catch (e) {
    return fallback;
  }
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

  socket.on("move", (move) => {
    const c = colorOf(socket.id);
    if (!c) return; // spectators cannot move
    if (gameOver) {
      socket.emit("moveRejected", { reason: "Game over" });
      return;
    }
    const other = c === "w" ? "b" : "w";
    const now = Date.now();

    // White makes the very first move of the game.
    if (moves.w + moves.b === 0 && c !== "w") {
      socket.emit("moveRejected", { reason: "White starts" });
      return;
    }

    const lead = moves[c] - moves[other];
    if (lead >= LEAD_CAP) {
      socket.emit("moveRejected", {
        reason: `Max ${LEAD_CAP} moves ahead — wait for your opponent`,
      });
      return;
    }

    const required = delayForLead(lead);
    const waited = now - lastMoveAt[c];
    if (waited < required) {
      socket.emit("moveRejected", { reason: "On cooldown", waitMs: required - waited });
      return;
    }

    // Validate + apply with the mover's colour forced to move.
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

    if (safe(() => chess.isCheckmate(), false)) {
      gameOver = { winner: c, reason: "checkmate" };
    } else if (
      safe(() => chess.isStalemate(), false) ||
      safe(() => chess.isInsufficientMaterial(), false)
    ) {
      gameOver = { winner: null, reason: "draw" };
    }

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
  console.log(`🚀 Chessmate (race variant) running on :${PORT}`)
);
