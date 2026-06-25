const express = require("express");
const socket = require("socket.io");
const http = require("http");
const { standardSetup } = require("./engine");

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
const MATERIAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const PTYPES = ["p", "n", "b", "r", "q"];

let settings = {
  raceEnabled: true,
  leadCap: 2,
  delaysSec: [15],
  // economy
  startingCredit: 0,
  squareCost: 2,
  pieceCost: { p: 1, n: 3, b: 3, r: 5, q: 9 },
  zoneIncome: { p: 1, n: 2, b: 2, r: 3, q: 4 },
};
const DEFAULT_DELAYS = [15, 15, 15, 15];
const DEFAULT_PIECE_COST = { p: 1, n: 3, b: 3, r: 5, q: 9 };
const DEFAULT_ZONE_INCOME = { p: 1, n: 2, b: 2, r: 3, q: 4 };

function clampNum(v, fallback, min, max) {
  let n = parseFloat(v);
  if (isNaN(n)) n = fallback;
  return Math.max(min, Math.min(max, n));
}

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
  const inPC = (s && s.pieceCost) || {};
  const inZI = (s && s.zoneIncome) || {};
  const pieceCost = {};
  const zoneIncome = {};
  PTYPES.forEach((t) => {
    pieceCost[t] = clampNum(inPC[t], settings.pieceCost[t] != null ? settings.pieceCost[t] : DEFAULT_PIECE_COST[t], 0, 999);
    zoneIncome[t] = clampNum(inZI[t], settings.zoneIncome[t] != null ? settings.zoneIncome[t] : DEFAULT_ZONE_INCOME[t], 0, 999);
  });
  const startingCredit = clampNum(s && s.startingCredit, settings.startingCredit || 0, 0, 9999);
  const squareCost = clampNum(s && s.squareCost, settings.squareCost != null ? settings.squareCost : 2, 0, 999);
  return { raceEnabled, leadCap, delaysSec, startingCredit, squareCost, pieceCost, zoneIncome };
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

let engine = standardSetup();
let players = {};
let moves = { w: 0, b: 0 };
let lastMoveAt = { w: 0, b: 0 };
let gameOver = null; // { winner: 'w'|'b'|null, reason }
let credit = { w: 0, b: 0 }; // shared per-player points wallet

// ── wallet API (used by capture/income now; squares/pieces in later phases) ──
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

// Each move is a "turn tick": every piece standing in the central zone earns
// its per-turn income for its owner.
function awardZoneIncome() {
  engine.pieces.forEach((p, k) => {
    const ci = k.indexOf(",");
    const x = parseInt(k.slice(0, ci), 10);
    const y = parseInt(k.slice(ci + 1), 10);
    if (engine.isInZone(x, y)) earn(p.color, settings.zoneIncome[p.type] || 0);
  });
}

// Allow the same colour to move again (race mode) by forcing whose turn it is.
function forceTurn(color) {
  engine.setTurn(color);
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
    board: engine.serialize(),
    lastMove: lastMove || null,
    moves: { w: moves.w, b: moves.b },
    turn: engine.turn,
    cooldown: cooldownState(Date.now()),
    check: safe(() => engine.inCheck(engine.turn), false),
    gameOver,
    started: moves.w + moves.b > 0,
    credit: { w: credit.w, b: credit.b },
    settings,
  };
}

function broadcastState(lastMove) {
  io.emit("gameState", buildState(lastMove));
}

function resetGame() {
  engine = standardSetup();
  moves = { w: 0, b: 0 };
  lastMoveAt = { w: 0, b: 0 };
  gameOver = null;
  credit = { w: settings.startingCredit || 0, b: settings.startingCredit || 0 };
}

// After `mover` plays, evaluate the opponent for checkmate / stalemate.
function finishOutcome(mover) {
  const opp = mover === "w" ? "b" : "w";
  if (safe(() => engine.isCheckmate(opp), false)) {
    gameOver = { winner: mover, reason: "checkmate" };
  } else if (safe(() => engine.isStalemate(opp), false)) {
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
      if (engine.turn !== c) {
        socket.emit("moveRejected", { reason: "Not your turn" });
        return;
      }
      const result = engine.move(move, c);
      if (!result) {
        socket.emit("moveRejected", { reason: "Illegal move" });
        return;
      }
      moves[c] += 1;
      lastMoveAt[c] = now;
      if (result.captured) earn(c, MATERIAL[result.captured] || 0);
      awardZoneIncome();
      finishOutcome(c);
      broadcastState({ from: result.from, to: result.to });
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
    const result = engine.move(move, c);
    if (!result) {
      socket.emit("moveRejected", { reason: "Illegal move" });
      return;
    }
    moves[c] += 1;
    lastMoveAt[c] = now;
    if (result.captured) earn(c, MATERIAL[result.captured] || 0);
    awardZoneIncome();
    finishOutcome(c);
    broadcastState({ from: result.from, to: result.to });
  });

  socket.on("buildSquare", (pos) => {
    const c = colorOf(socket.id);
    if (!c) return;
    if (gameOver) {
      socket.emit("buildRejected", { reason: "Game over" });
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
    const cost = settings.squareCost || 0;
    if (!spend(c, cost)) {
      socket.emit("buildRejected", { reason: "Not enough credit" });
      return;
    }
    engine.addCell(x, y);
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
    const cost = (settings.pieceCost && settings.pieceCost[type]) || 0;
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
    finishOutcome(c); // a bought piece may deliver check/mate
    broadcastState(null);
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
