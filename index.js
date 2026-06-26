const express = require("express");
const socket = require("socket.io");
const http = require("http");
const { standardSetup } = require("./engine");

const app = express();
const server = http.createServer(app);
const io = socket(server);

/**
 * ── Chessmate (released ruleset) ─────────────────────────────────────────────
 * Classic turn-by-turn chess on a board that can grow. A shared per-player
 * points wallet (credit) is earned from captures and from the central "zone"
 * income, and spent on building new squares and buying pieces. Rules are fixed
 * (no in-game settings UI):
 *   • Starting credit 0; a new square costs 1.
 *   • Piece cost = material value (P1 N3 B3 R5 Q9).
 *   • Zone income/turn: pawn 1, everything else 0; only for a piece that BOTH
 *     started and ended the acting player's turn inside the zone.
 *   • You may expand the board (one square) only at the start of your own turn,
 *     and not while your king is in check.
 *   • Buying a piece costs a turn (only on your turn, not while in check).
 *   • Win by checkmate.
 */
const MATERIAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const PTYPES = ["p", "n", "b", "r", "q"];
const settings = {
  squareCost: 1,
  startingCredit: 0,
  pieceCost: { p: 1, n: 3, b: 3, r: 5, q: 9 },
  zoneIncome: { p: 1, n: 0, b: 0, r: 0, q: 0 },
};

let engine = standardSetup();
let players = {};
let moves = { w: 0, b: 0 };
let gameOver = null; // { winner: 'w'|'b'|null, reason }
let credit = { w: 0, b: 0 };
let builtThisTurn = { w: false, b: false }; // at most one square built per turn
let squaresBuilt = { w: 0, b: 0 }; // cumulative squares each player has built this game
let aiColor = null; // if set ('w'|'b'), the server plays that colour as a basic AI
// Move history: one entry per board-changing action (move/castle/build/buy),
// each carrying a full snapshot of the game state so any past position can be
// rendered read-only on the client without replaying the engine.
let history = [];

function safe(fn, fallback) {
  try {
    return fn();
  } catch (e) {
    return fallback;
  }
}

function canAfford(color, cost) {
  return credit[color] >= cost;
}
function spend(color, cost) {
  if (!canAfford(color, cost)) return false;
  credit[color] -= cost;
  return true;
}
function earn(color, amount) {
  credit[color] += Math.max(0, amount || 0);
}

// How many pieces of a given type a colour currently owns on the board.
function countPieces(color, type) {
  let n = 0;
  engine.pieces.forEach((p) => {
    if (p.color === color && p.type === type) n++;
  });
  return n;
}

// Dynamic buy cost: pawns always 1; every other type costs base * (owned + 1),
// so each additional unit of a type gets more expensive (queen: 9, then 18…).
function pieceBuyCost(color, type) {
  if (type === "p") return 1;
  const base = (settings.pieceCost && settings.pieceCost[type]) || 0;
  return base * (countPieces(color, type) + 1);
}

const MAX_QUEENS = 2;

// Zone income is awarded per turn, but only for pieces that BOTH started and
// ended the acting player's turn inside the zone (a piece that just moved in,
// or one just bought, earns nothing this turn).
function awardZoneIncomeForMove(from, to) {
  engine.pieces.forEach((p, k) => {
    const ci = k.indexOf(",");
    const x = parseInt(k.slice(0, ci), 10);
    const y = parseInt(k.slice(ci + 1), 10);
    if (!engine.isInZone(x, y)) return;
    if (x === to.x && y === to.y && !engine.isInZone(from.x, from.y)) return;
    earn(p.color, settings.zoneIncome[p.type] || 0);
  });
}
function awardZoneIncomeForBuy(bx, by) {
  engine.pieces.forEach((p, k) => {
    const ci = k.indexOf(",");
    const x = parseInt(k.slice(0, ci), 10);
    const y = parseInt(k.slice(ci + 1), 10);
    if (!engine.isInZone(x, y)) return;
    if (x === bx && y === by) return;
    earn(p.color, settings.zoneIncome[p.type] || 0);
  });
}

function colorOf(socketId) {
  if (players.white === socketId) return "w";
  if (players.black === socketId) return "b";
  return null;
}

function buildState(lastMove) {
  return {
    board: engine.serialize(),
    lastMove: lastMove || null,
    moves: { w: moves.w, b: moves.b },
    turn: engine.turn,
    check: safe(() => engine.inCheck(engine.turn), false),
    inCheck: {
      w: safe(() => engine.inCheck("w"), false),
      b: safe(() => engine.inCheck("b"), false),
    },
    builtThisTurn: { w: builtThisTurn.w, b: builtThisTurn.b },
    squaresBuilt: { w: squaresBuilt.w, b: squaresBuilt.b },
    gameOver,
    started: moves.w + moves.b > 0,
    credit: { w: credit.w, b: credit.b },
    ai: aiColor,
    settings,
  };
}

function broadcastState(lastMove) {
  io.emit("gameState", buildState(lastMove));
}

/* ── move-history notation + recording ───────────────────────────────────── */
const HGLYPH = { p: "♟", n: "♞", b: "♝", r: "♜", q: "♛", k: "♚" };
// File label: a..z for 0..25; bracketed number for out-of-range (infinite board).
function fileLabel(x) {
  return x >= 0 && x < 26 ? String.fromCharCode(97 + x) : "(" + x + ")";
}
// Rank label mirrors classic chess: white back rank (y=7) reads as 1.
function rankLabel(y) {
  return String(8 - y);
}
function sqLabel(x, y) {
  return fileLabel(x) + rankLabel(y);
}
// '+' if the move leaves the opponent in check, '#' if it's checkmate.
function checkSuffix(mover) {
  const opp = mover === "w" ? "b" : "w";
  if (gameOver && gameOver.reason === "checkmate" && gameOver.winner === mover) return "#";
  return safe(() => engine.inCheck(opp), false) ? "+" : "";
}
// Append a timeline entry (with a full post-action snapshot) and notify clients.
function pushHistory(color, kind, text, from, to) {
  const entry = {
    i: history.length,
    color,
    kind, // 'move' | 'castle' | 'build' | 'buy'
    text,
    from: from || null,
    to: to || null,
    snapshot: buildState(from && to ? { from, to } : null),
  };
  history.push(entry);
  io.emit("historyAppend", entry);
}

function resetGame() {
  engine = standardSetup();
  moves = { w: 0, b: 0 };
  gameOver = null;
  credit = { w: settings.startingCredit || 0, b: settings.startingCredit || 0 };
  builtThisTurn = { w: false, b: false };
  squaresBuilt = { w: 0, b: 0 };
  history = [];
}

// An illegal move is "king-threatening" if the mover is currently in check or
// the attempted move would leave its own king in check (a pin).
function illegalThreat(mv, c) {
  return (
    safe(() => engine.inCheck(c), false) ||
    safe(() => engine.wouldExposeKing(mv, c), false)
  );
}

// After `mover` acts, evaluate the opponent for checkmate / stalemate.
function finishOutcome(mover) {
  const opp = mover === "w" ? "b" : "w";
  if (safe(() => engine.isCheckmate(opp), false)) {
    gameOver = { winner: mover, reason: "checkmate" };
  } else if (safe(() => engine.isStalemate(opp), false)) {
    gameOver = { winner: null, reason: "draw" };
  }
}

// Bookkeeping for a turn-consuming action that isn't a board move (piece-buy):
// count the turn, refresh the build allowance, pass the turn, check for mate.
function commitTurn(c) {
  moves[c] += 1;
  builtThisTurn[c] = false;
  engine.setTurn(c === "w" ? "b" : "w");
  finishOutcome(c);
}

// Apply a board move for `color` (turn already verified). Handles earnings,
// zone income, mate check, broadcast, and triggers the AI if it is next.
function performMove(c, move) {
  const movingPiece = engine.getPiece(move.from.x, move.from.y);
  const mtype = movingPiece ? movingPiece.type : "p";
  const result = engine.move(move, c);
  if (!result) return null;
  moves[c] += 1;
  builtThisTurn[c] = false;
  if (result.captured) earn(c, MATERIAL[result.captured] || 0);
  awardZoneIncomeForMove(result.from, result.to);
  finishOutcome(c);
  // notation for the move list
  let text;
  if (result.castle) {
    text = result.castle === "k" ? "O-O" : "O-O-O";
  } else {
    text =
      HGLYPH[mtype] +
      " " +
      sqLabel(result.from.x, result.from.y) +
      (result.captured ? "×" : "–") +
      sqLabel(result.to.x, result.to.y) +
      (result.promotion ? "=" + HGLYPH[result.promotion] : "");
  }
  text += checkSuffix(c);
  pushHistory(c, result.castle ? "castle" : "move", text, result.from, result.to);
  broadcastState({ from: result.from, to: result.to });
  maybeAiMove();
  return result;
}

// Very basic AI: greedily take the highest-value capture / promotion, else a
// random legal move. (Does not build or buy.)
function pickAiMove(color) {
  const ms = engine.legalMoves(color);
  if (!ms.length) return null;
  let best = [];
  let bestVal = -1;
  for (const m of ms) {
    const tp = engine.getPiece(m.to.x, m.to.y);
    let v = tp ? MATERIAL[tp.type] || 0 : 0;
    if (m.promotion) v += 8;
    if (v > bestVal) {
      bestVal = v;
      best = [m];
    } else if (v === bestVal) {
      best.push(m);
    }
  }
  return best[Math.floor(Math.random() * best.length)];
}
function doAiMove() {
  if (!aiColor || gameOver || engine.turn !== aiColor) return;
  const mv = pickAiMove(aiColor);
  if (mv) performMove(aiColor, mv);
}
function maybeAiMove() {
  if (aiColor && !gameOver && engine.turn === aiColor) setTimeout(doAiMove, 500);
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
  socket.emit("historyFull", history);

  socket.on("disconnect", () => {
    if (players.white === socket.id) delete players.white;
    else if (players.black === socket.id) delete players.black;
  });

  socket.on("move", (move) => {
    const c = colorOf(socket.id);
    if (!c) return;
    if (gameOver) {
      socket.emit("moveRejected", { reason: "Game over" });
      return;
    }
    if (engine.turn !== c) {
      socket.emit("moveRejected", { reason: "Not your turn" });
      return;
    }
    const result = performMove(c, move);
    if (!result) {
      socket.emit("moveRejected", { reason: "Illegal move", kingThreat: illegalThreat(move, c) });
    }
  });

  socket.on("addAI", () => {
    const c = colorOf(socket.id);
    if (!c) return;
    const opp = c === "w" ? "b" : "w";
    const seat = opp === "w" ? "white" : "black";
    if (players[seat] && players[seat] !== "__AI__") return; // a human holds it
    players[seat] = "__AI__";
    aiColor = opp;
    io.emit("notice", { type: "default", text: "Added a computer opponent" });
    broadcastState(null);
    maybeAiMove();
  });

  socket.on("buildSquare", (pos) => {
    const c = colorOf(socket.id);
    if (!c) return;
    if (gameOver) {
      socket.emit("buildRejected", { reason: "Game over" });
      return;
    }
    if (engine.turn !== c) {
      socket.emit("buildRejected", { reason: "Only at the start of your turn" });
      return;
    }
    if (safe(() => engine.inCheck(c), false)) {
      socket.emit("buildRejected", { reason: "Your king is in check — move first" });
      return;
    }
    if (builtThisTurn[c]) {
      socket.emit("buildRejected", { reason: "Only one square per turn" });
      return;
    }
    const x = parseInt(pos && pos.x, 10);
    const y = parseInt(pos && pos.y, 10);
    if (!Number.isInteger(x) || !Number.isInteger(y)) {
      socket.emit("buildRejected", { reason: "Bad request" });
      return;
    }
    if (!engine.isBuildable(x, y)) {
      socket.emit("buildRejected", { reason: "Can't build there" });
      return;
    }
    const sqCost = (settings.squareCost || 0) + squaresBuilt[c]; // linear: +1 each square built
    if (!spend(c, sqCost)) {
      socket.emit("buildRejected", { reason: "Not enough credit" });
      return;
    }
    engine.addCell(x, y);
    builtThisTurn[c] = true;
    squaresBuilt[c] += 1;
    pushHistory(c, "build", "⊕ " + sqLabel(x, y), { x, y }, { x, y });
    broadcastState(null);
  });

  socket.on("buyPiece", (req) => {
    const c = colorOf(socket.id);
    if (!c) return;
    if (gameOver) {
      socket.emit("buyRejected", { reason: "Game over" });
      return;
    }
    const x = parseInt(req && req.x, 10);
    const y = parseInt(req && req.y, 10);
    const type = req && req.type;
    if (!Number.isInteger(x) || !Number.isInteger(y) || PTYPES.indexOf(type) === -1) {
      socket.emit("buyRejected", { reason: "Bad request" });
      return;
    }
    if (safe(() => engine.inCheck(c), false)) {
      socket.emit("buyRejected", { reason: "Your king is in check — move first" });
      return;
    }
    if (engine.turn !== c) {
      socket.emit("buyRejected", { reason: "Not your turn" });
      return;
    }
    if (!engine.hasCell(x, y)) {
      socket.emit("buyRejected", { reason: "No such square" });
      return;
    }
    if (engine.getPiece(x, y)) {
      socket.emit("buyRejected", { reason: "Square occupied" });
      return;
    }
    const tier = engine.classifyHome(x, y, c);
    if (tier === "none") {
      socket.emit("buyRejected", { reason: "Not your home area" });
      return;
    }
    if (tier === "pawn" && type !== "p") {
      socket.emit("buyRejected", { reason: "Only pawns on the second row" });
      return;
    }
    if (type === "q" && countPieces(c, "q") >= MAX_QUEENS) {
      socket.emit("buyRejected", { reason: `Max ${MAX_QUEENS} queens` });
      return;
    }
    const cost = pieceBuyCost(c, type);
    if (!canAfford(c, cost)) {
      socket.emit("buyRejected", { reason: "Not enough credit" });
      return;
    }
    const placed = engine.placePiece(x, y, type, c);
    if (!placed.ok) {
      socket.emit("buyRejected", { reason: "Cannot place there" });
      return;
    }
    spend(c, cost);
    awardZoneIncomeForBuy(x, y); // existing zone pieces earn; the new one does not
    commitTurn(c); // counts as a turn: increments moves, passes turn, mate check
    pushHistory(c, "buy", HGLYPH[type] + "+ " + sqLabel(x, y) + checkSuffix(c), { x, y }, { x, y });
    broadcastState(null);
    maybeAiMove();
  });

  socket.on("restartGame", () => {
    resetGame();
    io.emit("historyFull", history);
    broadcastState(null);
    io.emit("notice", { type: "restart", text: "Game restarted" });
    maybeAiMove();
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
  console.log(`🚀 Chessmate running on :${PORT}`)
);
