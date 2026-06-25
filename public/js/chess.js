const socket = io();
const chess = new Chess(); // render-only; loaded from server FEN
const boardElement = document.getElementById("chessboard");

let draggedPiece = null;
let sourceSquare = null;
let myColor = null; // 'w' | 'b' | null (spectator)
let lastMove = null;

let gameMoves = { w: 0, b: 0 };
let gameTurn = "w";
let gameStarted = false;
let cooldown = {
  w: { lead: 0, blocked: false, remainingMs: 0 },
  b: { lead: 0, blocked: false, remainingMs: 0 },
};
let gameOver = null;
let myCooldownUntil = 0;
let lastAnnounced = null;

let settings = { raceEnabled: true, leadCap: 2, delaysSec: [15] };
const DEFAULT_DELAYS = [15, 15, 15, 15];

/* ── Material scoring ── */
const PIECE_VALUE = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const START_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const CAPTURE_ORDER = ["q", "r", "b", "n", "p"];

const otherColor = (c) => (c === "w" ? "b" : "w");
const fmt = (ms) => (Math.max(0, ms) / 1000).toFixed(1);
const effCap = () => (settings.raceEnabled ? settings.leadCap : 1);

function localRemaining() {
  if (!myColor) return 0;
  return Math.max(0, myCooldownUntil - Date.now());
}

function canIMove() {
  if (!myColor || gameOver) return false;
  if (!settings.raceEnabled) return gameTurn === myColor;
  if (gameMoves.w + gameMoves.b === 0 && myColor !== "w") return false;
  const lead = gameMoves[myColor] - gameMoves[otherColor(myColor)];
  if (lead >= settings.leadCap) return false;
  if (localRemaining() > 0) return false;
  return true;
}

/**
 * Render the board.
 */
const renderBoard = () => {
  const board = chess.board();
  boardElement.innerHTML = "";

  board.forEach((row, rowIndex) => {
    row.forEach((square, columnIndex) => {
      const squareElement = document.createElement("div");
      squareElement.classList.add(
        "square",
        (rowIndex + columnIndex) % 2 === 0 ? "light" : "dark"
      );
      squareElement.dataset.row = rowIndex;
      squareElement.dataset.column = columnIndex;

      if (
        lastMove &&
        ((lastMove.from.row === rowIndex &&
          lastMove.from.column === columnIndex) ||
          (lastMove.to.row === rowIndex && lastMove.to.column === columnIndex))
      ) {
        squareElement.classList.add("highlight");
      }

      if (square) {
        const pieceElement = document.createElement("div");
        pieceElement.classList.add(
          "piece",
          square.color === "w" ? "white" : "black"
        );
        pieceElement.innerText = getPieceUnicode(square);
        pieceElement.draggable = myColor === square.color && !gameOver;

        pieceElement.addEventListener("dragstart", (event) => {
          draggedPiece = pieceElement;
          sourceSquare = { row: rowIndex, column: columnIndex };
          event.dataTransfer.setData("text/plain", "");
          pieceElement.classList.add("dragging");
        });

        pieceElement.addEventListener("dragend", () => {
          draggedPiece = null;
          sourceSquare = null;
          pieceElement.classList.remove("dragging");
        });

        squareElement.appendChild(pieceElement);
      }

      squareElement.addEventListener("dragover", (event) =>
        event.preventDefault()
      );
      squareElement.addEventListener("drop", (event) => {
        event.preventDefault();
        if (draggedPiece) {
          handleMove(sourceSquare, {
            row: parseInt(squareElement.dataset.row),
            column: parseInt(squareElement.dataset.column),
          });
        }
      });

      boardElement.appendChild(squareElement);
    });
  });

  boardElement.classList.toggle("flipped", myColor === "b");
  updateScoreboard();
};

const handleMove = (fromSquare, toSquare) => {
  if (!canIMove()) {
    if (!myColor || gameOver) return;
    if (!settings.raceEnabled) {
      showMessage("Not your turn.", "error");
      return;
    }
    const lead = gameMoves[myColor] - gameMoves[otherColor(myColor)];
    if (gameMoves.w + gameMoves.b === 0 && myColor !== "w") {
      showMessage("White starts the game.", "error");
    } else if (lead >= settings.leadCap) {
      showMessage(
        `You're ${settings.leadCap} moves ahead — wait for your opponent.`,
        "error"
      );
    } else if (localRemaining() > 0) {
      showMessage(`On cooldown: ${fmt(localRemaining())}s`, "error");
    }
    return;
  }

  const from = `${String.fromCharCode(97 + fromSquare.column)}${
    8 - fromSquare.row
  }`;
  const to = `${String.fromCharCode(97 + toSquare.column)}${8 - toSquare.row}`;
  const piece = chess.get(from);
  const move = { from, to };

  if (piece && piece.type === "p" && (to.endsWith("8") || to.endsWith("1"))) {
    showPromotionUI((selectedPiece) => {
      move.promotion = selectedPiece;
      socket.emit("move", move);
    });
    return;
  }

  socket.emit("move", move);
};

const getPieceUnicode = (piece) => {
  const unicodeMap = { p: "♙", r: "♖", n: "♘", b: "♗", q: "♕", k: "♔" };
  return unicodeMap[piece.type] || "";
};

/**
 * Scoreboard — captured-material points per player.
 */
function updateScoreboard() {
  const cur = { w: {}, b: {} };
  chess.board().forEach((row) =>
    row.forEach((sq) => {
      if (sq) cur[sq.color][sq.type] = (cur[sq.color][sq.type] || 0) + 1;
    })
  );

  let scoreWhite = 0;
  let scoreBlack = 0;
  const capturedByWhite = [];
  const capturedByBlack = [];

  CAPTURE_ORDER.forEach((t) => {
    const lostBlack = Math.max(0, START_COUNT[t] - (cur.b[t] || 0));
    const lostWhite = Math.max(0, START_COUNT[t] - (cur.w[t] || 0));
    for (let i = 0; i < lostBlack; i++) {
      capturedByWhite.push(t);
      scoreWhite += PIECE_VALUE[t];
    }
    for (let i = 0; i < lostWhite; i++) {
      capturedByBlack.push(t);
      scoreBlack += PIECE_VALUE[t];
    }
  });

  setText("whitePoints", scoreWhite);
  setText("blackPoints", scoreBlack);
  renderCaptured("whiteCaptured", capturedByWhite, "cap-b");
  renderCaptured("blackCaptured", capturedByBlack, "cap-w");

  const diff = scoreWhite - scoreBlack;
  setText("whiteLead", diff > 0 ? `+${diff}` : "");
  setText("blackLead", diff < 0 ? `+${-diff}` : "");
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function renderCaptured(id, types, colorClass) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = "";
  types.forEach((t) => {
    const span = document.createElement("span");
    span.className = colorClass;
    span.textContent = getPieceUnicode({ type: t });
    el.appendChild(span);
  });
}

/**
 * Race status bar.
 */
function updateRaceUI() {
  const role = document.getElementById("raceRole");
  const status = document.getElementById("raceStatus");
  const counts = document.getElementById("raceCounts");
  const bar = document.getElementById("cooldownBar");
  const rules = document.getElementById("raceRules");
  if (!status) return;

  if (role) {
    role.textContent =
      myColor === "w"
        ? "You are White ⚪"
        : myColor === "b"
        ? "You are Black ⚫"
        : "Spectating";
  }
  if (counts) {
    counts.textContent = `Moves — White ${gameMoves.w} · Black ${gameMoves.b}`;
  }
  if (rules) {
    rules.textContent = settings.raceEnabled
      ? `Race chess: up to ${settings.leadCap} moves ahead. Leading costs time — ` +
        settings.delaysSec.map((s, i) => `+${i + 1}: ${s}s`).join(" · ") +
        ". White moves first."
      : "Classic chess: standard turn-by-turn play.";
  }

  let txt = "";
  let pct = 0;

  if (gameOver) {
    txt =
      gameOver.reason === "draw"
        ? "Game over — draw"
        : `Game over — ${gameOver.winner === "w" ? "White" : "Black"} wins`;
  } else if (!myColor) {
    txt = "Watching the game";
  } else if (!settings.raceEnabled) {
    txt = gameTurn === myColor ? "Your move" : "Opponent's move";
    pct = gameTurn === myColor ? 100 : 0;
  } else if (gameMoves.w + gameMoves.b === 0 && myColor !== "w") {
    txt = "White starts the game";
  } else {
    const lead = gameMoves[myColor] - gameMoves[otherColor(myColor)];
    const rem = localRemaining();
    if (lead >= settings.leadCap) {
      txt = `You lead by ${lead} — opponent must move`;
    } else if (rem > 0) {
      const total = (settings.delaysSec[lead - 1] || 3) * 1000;
      txt = `Next move in ${fmt(rem)}s`;
      pct = 100 * (1 - rem / total);
    } else {
      txt = lead > 0 ? `Your move — go! (lead +${lead})` : "Your move — go!";
      pct = 100;
    }
  }

  status.textContent = txt;
  if (bar) bar.style.width = Math.max(0, Math.min(100, pct)) + "%";
  boardElement.classList.toggle(
    "locked",
    !!myColor && !gameOver && !canIMove()
  );
}

setInterval(updateRaceUI, 100);

/* ── Settings dashboard ── */
let dashSig = "";

function buildDashboard() {
  const raceOptions = document.getElementById("raceOptions");
  const delayRows = document.getElementById("delayRows");
  if (!raceOptions || !delayRows) return;

  raceOptions.style.display = settings.raceEnabled ? "flex" : "none";

  delayRows.innerHTML = "";
  for (let lvl = 1; lvl < settings.leadCap; lvl++) {
    const row = document.createElement("div");
    row.className = "delay-row";

    const label = document.createElement("span");
    label.className = "dash-label";
    label.textContent = `Delay at +${lvl}`;

    const wrap = document.createElement("span");
    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.max = "120";
    input.step = "1";
    input.className = "delayInput";
    input.dataset.level = String(lvl);
    input.value = settings.delaysSec[lvl - 1] != null ? settings.delaysSec[lvl - 1] : DEFAULT_DELAYS[lvl - 1] || 8;
    input.addEventListener("change", emitSettings);

    const unit = document.createElement("span");
    unit.className = "delay-unit";
    unit.textContent = "s";

    wrap.append(input, unit);
    row.append(label, wrap);
    delayRows.appendChild(row);
  }
}

function syncDashboard() {
  const sig = `${settings.raceEnabled}|${settings.leadCap}`;
  if (sig !== dashSig) {
    dashSig = sig;
    buildDashboard();
  } else {
    document.querySelectorAll(".delayInput").forEach((inp) => {
      if (document.activeElement !== inp) {
        const lvl = parseInt(inp.dataset.level, 10);
        if (settings.delaysSec[lvl - 1] != null) inp.value = settings.delaysSec[lvl - 1];
      }
    });
  }

  const toggle = document.getElementById("raceToggle");
  if (toggle) toggle.checked = settings.raceEnabled;
  const capVal = document.getElementById("capVal");
  if (capVal) capVal.textContent = settings.leadCap;

  const dash = document.getElementById("dashboard");
  const lock = document.getElementById("dashLock");
  if (dash) dash.classList.toggle("dash-disabled", gameStarted);
  if (lock) lock.style.display = gameStarted ? "block" : "none";
}

function readDash() {
  const raceEnabled = document.getElementById("raceToggle").checked;
  const leadCap = parseInt(document.getElementById("capVal").textContent, 10) || 3;
  const delaysSec = [];
  for (let lvl = 1; lvl < leadCap; lvl++) {
    const inp = document.querySelector(`.delayInput[data-level="${lvl}"]`);
    let v = inp ? parseFloat(inp.value) : settings.delaysSec[lvl - 1];
    if (isNaN(v)) v = DEFAULT_DELAYS[lvl - 1] || 8;
    delaysSec.push(v);
  }
  return { raceEnabled, leadCap, delaysSec };
}

function emitSettings() {
  socket.emit("updateSettings", readDash());
}

function wireDashboard() {
  const toggle = document.getElementById("raceToggle");
  const capMinus = document.getElementById("capMinus");
  const capPlus = document.getElementById("capPlus");
  const capVal = document.getElementById("capVal");
  if (toggle) toggle.addEventListener("change", emitSettings);
  if (capMinus)
    capMinus.addEventListener("click", () => {
      const v = Math.max(1, (parseInt(capVal.textContent, 10) || 3) - 1);
      capVal.textContent = v;
      emitSettings();
    });
  if (capPlus)
    capPlus.addEventListener("click", () => {
      const v = Math.min(5, (parseInt(capVal.textContent, 10) || 3) + 1);
      capVal.textContent = v;
      emitSettings();
    });
}

/**
 * Promotion UI.
 */
const showPromotionUI = (onSelect) => {
  const existingUI = document.querySelector(".promotion-container");
  if (existingUI) existingUI.remove();

  const overlay = document.createElement("div");
  overlay.classList.add("overlay");

  const promotionBox = document.createElement("div");
  promotionBox.classList.add("promotion-container");

  const title = document.createElement("p");
  title.innerText = "Promote pawn to:";
  promotionBox.appendChild(title);

  const pieces = [
    { type: "q", symbol: "♛" },
    { type: "r", symbol: "♜" },
    { type: "b", symbol: "♝" },
    { type: "n", symbol: "♞" },
  ];

  pieces.forEach(({ type, symbol }) => {
    const button = document.createElement("button");
    button.classList.add("promotion-btn");
    button.innerHTML = symbol;
    button.addEventListener("click", () => {
      onSelect(type);
      document.body.removeChild(overlay);
    });
    promotionBox.appendChild(button);
  });

  overlay.appendChild(promotionBox);
  document.body.appendChild(overlay);
};

/**
 * Flash messages.
 */
const showMessage = (msg, type = "default") => {
  const existing = document.querySelector(".game-message");
  if (existing) existing.remove();

  const box = document.createElement("div");
  box.classList.add("game-message", `message-${type}`);
  box.innerText = msg;

  document.body.appendChild(box);
  setTimeout(() => box.classList.add("visible"), 10);
  setTimeout(() => {
    box.classList.remove("visible");
    setTimeout(() => box.remove(), 500);
  }, 3000);
};

/**
 * Confirmation popup.
 */
const showConfirmation = (message, yes, no, onYes, onNo) => {
  const overlay = document.createElement("div");
  overlay.classList.add("overlay");

  const box = document.createElement("div");
  box.classList.add("confirmation-box");

  const text = document.createElement("p");
  text.innerText = message;

  const btnYes = document.createElement("button");
  btnYes.innerText = yes;
  btnYes.classList.add("btn-confirm");
  btnYes.onclick = () => {
    onYes();
    document.body.removeChild(overlay);
  };

  const btnNo = document.createElement("button");
  btnNo.innerText = no;
  btnNo.classList.add("btn-cancel");
  btnNo.onclick = () => {
    onNo();
    document.body.removeChild(overlay);
  };

  box.append(text, btnYes, btnNo);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
};

/**
 * Game controls.
 */
document.getElementById("restartGame").addEventListener("click", () => {
  showConfirmation(
    "Are you sure you want to restart?",
    "Yes",
    "No",
    () => socket.emit("restartGame"),
    () => showMessage("Restart canceled.")
  );
});

document.getElementById("offerDraw").addEventListener("click", () => {
  socket.emit("offerDraw");
  showMessage("Draw offer sent.", "draw");
});

document.getElementById("resignGame").addEventListener("click", () => {
  showConfirmation(
    "Are you sure you want to resign?",
    "Yes",
    "No",
    () => socket.emit("playerResigned"),
    () => showMessage("Resignation canceled.")
  );
});

/**
 * Server events.
 */
socket.on("playerRole", (role) => {
  myColor = role;
  renderBoard();
  updateRaceUI();
});

socket.on("spectator", () => {
  myColor = null;
  renderBoard();
  updateRaceUI();
});

socket.on("gameState", (s) => {
  try {
    chess.load(s.fen);
  } catch (e) {
    console.error("Bad FEN from server", e);
  }

  lastMove = s.lastMove
    ? {
        from: { row: s.lastMove.from.row, column: s.lastMove.from.col },
        to: { row: s.lastMove.to.row, column: s.lastMove.to.col },
      }
    : null;

  gameMoves = s.moves || { w: 0, b: 0 };
  gameTurn = s.turn || "w";
  gameStarted = !!s.started;
  cooldown = s.cooldown || cooldown;
  gameOver = s.gameOver || null;
  if (s.settings) settings = s.settings;

  if (myColor) {
    const cd = cooldown[myColor];
    myCooldownUntil = cd && cd.remainingMs ? Date.now() + cd.remainingMs : 0;
  }

  renderBoard();
  syncDashboard();
  updateRaceUI();
  announceGameOver();
});

socket.on("moveRejected", (d) => {
  if (d && d.waitMs) myCooldownUntil = Date.now() + d.waitMs;
  if (d && d.reason) {
    showMessage(d.reason + (d.waitMs ? `: ${fmt(d.waitMs)}s` : ""), "error");
  }
  updateRaceUI();
});

socket.on("settingsRejected", (d) => {
  if (d && d.reason) showMessage(d.reason, "error");
  dashSig = ""; // force rebuild back to authoritative settings
  syncDashboard();
});

socket.on("notice", (n) => {
  if (n && n.text) showMessage(n.text, n.type || "default");
  if (n && n.type === "restart") lastAnnounced = null;
});

socket.on("offerDraw", () => {
  showConfirmation(
    "Opponent offered a draw.",
    "Accept",
    "Reject",
    () => socket.emit("drawAccepted"),
    () => socket.emit("drawRejected")
  );
});

socket.on("drawRejected", () => showMessage("Draw offer rejected.", "draw"));

function announceGameOver() {
  if (!gameOver) {
    lastAnnounced = null;
    return;
  }
  const key = `${gameOver.reason}:${gameOver.winner}`;
  if (key === lastAnnounced) return;
  lastAnnounced = key;

  let msg;
  let type = "draw";
  if (gameOver.reason === "checkmate") {
    type = "resign";
    msg =
      gameOver.winner === myColor
        ? "Checkmate — you win! 🎉"
        : `Checkmate — ${gameOver.winner === "w" ? "White" : "Black"} wins.`;
  } else if (gameOver.reason === "resign") {
    type = "resign";
    msg =
      gameOver.winner === myColor
        ? "Opponent resigned — you win!"
        : "You resigned.";
  } else {
    msg = "Game over — it's a draw.";
  }
  showMessage(msg, type);
}

/**
 * Init.
 */
wireDashboard();
buildDashboard();
renderBoard();
updateRaceUI();
