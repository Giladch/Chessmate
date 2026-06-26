const socket = io();
const viewport = document.getElementById("viewport");
const world = document.getElementById("world");
const CELL = 64;

let panX = 0, panY = 0, centered = false;
let draggedPiece = null;
let sourceSquare = null;
let myColor = null; // 'w' | 'b' | null (spectator)
let lastMove = null;

let boardData = { cells: [], pieces: {}, bbox: { minX: 0, minY: 0, maxX: 7, maxY: 7 }, zoneRows: [3, 4] };
let cellsSet = new Set();
let gameTurn = "w";
let gameOver = null;
let credit = { w: 0, b: 0 };
let aiOn = null;
let myInCheck = false;
let builtThisTurnMe = false;

let settings = {
  squareCost: 1,
  pieceCost: { p: 1, n: 3, b: 3, r: 5, q: 9 },
  zoneIncome: { p: 1, n: 0, b: 0, r: 0, q: 0 },
};

const otherColor = (c) => (c === "w" ? "b" : "w");
const cellKey = (x, y) => x + "," + y;
const RADIAL_SYM = { q: "♛", r: "♜", b: "♝", n: "♞", p: "♟" };
const GLYPH = { p: "♙", r: "♖", n: "♘", b: "♗", q: "♕", k: "♔" };

function worldPos(x, y) {
  const flip = myColor === "b";
  return { left: (flip ? -x : x) * CELL, top: (flip ? -y : y) * CELL };
}

function canIMove() {
  return !!myColor && !gameOver && gameTurn === myColor;
}

/* ── home / pricing helpers (mirror the server) ── */
function classifyHomeClient(x, y, color) {
  if (color === "w") {
    if (y >= 7) return "all";
    if (y === 6) return "pawn";
    return "none";
  }
  if (y <= 0) return "all";
  if (y === 1) return "pawn";
  return "none";
}
function countMyPieces(color, type) {
  let n = 0;
  Object.keys(boardData.pieces).forEach((k) => {
    const p = boardData.pieces[k];
    if (p.c === color && p.t === type) n++;
  });
  return n;
}
function pieceBuyCostClient(color, type) {
  if (type === "p") return 1;
  const base = (settings.pieceCost && settings.pieceCost[type]) || 0;
  return base * (countMyPieces(color, type) + 1);
}
function queenMaxed(color) {
  return countMyPieces(color, "q") >= 2;
}
function isBuildableClient(x, y) {
  if (cellsSet.has(cellKey(x, y))) return false;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      if (dx === 0 && dy === 0) continue;
      if (cellsSet.has(cellKey(x + dx, y + dy))) return true;
    }
  }
  return false;
}

/* ── rendering ── */
function applyPan() {
  world.style.transform = `translate(${panX}px, ${panY}px)`;
}

function centerBoard() {
  const bb = boardData.bbox;
  const flip = myColor === "b";
  const cxWorld = ((flip ? -1 : 1) * (bb.minX + bb.maxX)) / 2 * CELL + CELL / 2;
  const cyWorld = ((flip ? -1 : 1) * (bb.minY + bb.maxY)) / 2 * CELL + CELL / 2;
  panX = window.innerWidth / 2 - cxWorld;
  panY = window.innerHeight / 2 - cyWorld;
  applyPan();
}

const renderBoard = () => {
  world.innerHTML = "";

  // existing cells
  boardData.cells.forEach((k) => {
    const ci = k.indexOf(",");
    const x = parseInt(k.slice(0, ci), 10);
    const y = parseInt(k.slice(ci + 1), 10);
    const pos = worldPos(x, y);

    const sq = document.createElement("div");
    const parity = (((x + y) % 2) + 2) % 2;
    sq.className = "square " + (parity === 0 ? "light" : "dark");
    if (boardData.zoneRows && boardData.zoneRows.indexOf(y) !== -1) sq.classList.add("zone");
    if (lastMove && ((lastMove.from.x === x && lastMove.from.y === y) || (lastMove.to.x === x && lastMove.to.y === y))) {
      sq.classList.add("highlight");
    }
    sq.dataset.x = x;
    sq.dataset.y = y;
    sq.style.left = pos.left + "px";
    sq.style.top = pos.top + "px";

    const p = boardData.pieces[k];
    if (p) {
      const pieceEl = document.createElement("div");
      pieceEl.className = "piece " + (p.c === "w" ? "white" : "black");
      pieceEl.innerText = GLYPH[p.t] || "";
      pieceEl.draggable = myColor === p.c && !gameOver;
      pieceEl.addEventListener("dragstart", (event) => {
        draggedPiece = pieceEl;
        sourceSquare = { x, y };
        event.dataTransfer.setData("text/plain", "");
        pieceEl.classList.add("dragging");
      });
      pieceEl.addEventListener("dragend", () => {
        draggedPiece = null;
        sourceSquare = null;
        pieceEl.classList.remove("dragging");
      });
      sq.appendChild(pieceEl);
    }

    sq.addEventListener("dragover", (e) => e.preventDefault());
    sq.addEventListener("drop", (e) => {
      e.preventDefault();
      if (draggedPiece) handleMove(sourceSquare, { x: parseInt(sq.dataset.x, 10), y: parseInt(sq.dataset.y, 10) });
    });

    world.appendChild(sq);
  });

  // buildable candidates (only at the start of your own turn)
  if (myColor && !gameOver && gameTurn === myColor && !myInCheck && !builtThisTurnMe) {
    const bb = boardData.bbox;
    const affordable = credit[myColor] >= (settings.squareCost || 0);
    for (let y = bb.minY - 1; y <= bb.maxY + 1; y++) {
      for (let x = bb.minX - 1; x <= bb.maxX + 1; x++) {
        if (!isBuildableClient(x, y)) continue;
        const pos = worldPos(x, y);
        const cand = document.createElement("div");
        cand.className = "square buildable" + (affordable ? "" : " bad");
        cand.style.left = pos.left + "px";
        cand.style.top = pos.top + "px";
        cand.title = `Build (${settings.squareCost || 0}₵)`;
        cand.addEventListener("click", () => {
          if (suppressClick) return;
          handleBuild(x, y);
        });
        world.appendChild(cand);
      }
    }
  }

  if (!centered) {
    centerBoard();
    centered = true;
  }
  updateCredits();
};

/* ── moves / building ── */
const handleMove = (from, to) => {
  if (!canIMove()) {
    if (myColor && !gameOver) showMessage("Not your turn.", "error");
    return;
  }
  const move = { from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } };
  const p = boardData.pieces[cellKey(from.x, from.y)];
  if (p && p.t === "p") {
    const f = myColor === "w" ? -1 : 1;
    if (!cellsSet.has(cellKey(to.x, to.y + f))) {
      showPromotionUI((sel) => {
        move.promotion = sel;
        socket.emit("move", move);
      });
      return;
    }
  }
  socket.emit("move", move);
};

const handleBuild = (x, y) => {
  if (!myColor || gameOver) return;
  if (gameTurn !== myColor) { showMessage("You can only expand on your turn.", "error"); return; }
  if (myInCheck) { showMessage("Your king is in check — move first.", "error"); return; }
  if (builtThisTurnMe) { showMessage("Only one square per turn.", "error"); return; }
  if (credit[myColor] < (settings.squareCost || 0)) { showMessage("Not enough credit for a new square.", "error"); return; }
  socket.emit("buildSquare", { x, y });
};

/* ── buy-pieces radial (right-click long-press) ── */
let radialLayer = null;
function closeRadial() { if (radialLayer) { radialLayer.remove(); radialLayer = null; } }

function openRadial(x, y) {
  closeRadial();
  if (!myColor || gameOver) return;
  if (gameTurn !== myColor) { showMessage("You can only buy on your turn.", "error"); return; }
  if (myInCheck) { showMessage("Your king is in check — move first.", "error"); return; }
  const key = cellKey(x, y);
  if (!cellsSet.has(key) || boardData.pieces[key]) return;
  const tier = classifyHomeClient(x, y, myColor);
  if (tier === "none") return;
  const types = tier === "pawn" ? ["p"] : ["q", "r", "b", "n", "p"];

  const sqEl = world.querySelector(`.square[data-x="${x}"][data-y="${y}"]`);
  if (!sqEl) return;
  const rect = sqEl.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  const layer = document.createElement("div");
  layer.className = "radial-capture";
  const menu = document.createElement("div");
  menu.className = "radial-menu";
  menu.style.left = cx + "px";
  menu.style.top = cy + "px";

  const opts = [];
  const n = types.length;
  types.forEach((t, i) => {
    const ang = -Math.PI / 2 + i * ((2 * Math.PI) / n);
    const R = n === 1 ? 0 : 64;
    const ox = Math.cos(ang) * R;
    const oy = Math.sin(ang) * R;
    const maxed = t === "q" && queenMaxed(myColor);
    const cost = pieceBuyCostClient(myColor, t);
    const affordable = !maxed && credit[myColor] >= cost;
    const el = document.createElement("div");
    el.className = "radial-option" + (affordable ? "" : " disabled");
    el.style.left = ox + "px";
    el.style.top = oy + "px";
    el.dataset.t = t;
    el.innerHTML =
      `<span class="ro-glyph ${myColor === "w" ? "ro-w" : "ro-b"}">${RADIAL_SYM[t]}</span>` +
      `<span class="ro-cost">${maxed ? "MAX" : cost + "₵"}</span>`;
    el.addEventListener("click", () => {
      if (affordable) socket.emit("buyPiece", { x, y, type: t });
      else if (maxed) showMessage("You already have 2 queens.", "error");
      else showMessage("Not enough credit for that piece.", "error");
      closeRadial();
    });
    menu.appendChild(el);
    opts.push({ el, ox, oy });
  });

  layer.appendChild(menu);
  layer.addEventListener("mousemove", (e) => {
    let best = null, bestd = Infinity;
    opts.forEach((o) => {
      o.el.classList.remove("hover");
      const dx = e.clientX - (cx + o.ox);
      const dy = e.clientY - (cy + o.oy);
      const d = dx * dx + dy * dy;
      if (d < bestd) { bestd = d; best = o; }
    });
    if (best && bestd < 60 * 60) best.el.classList.add("hover");
  });
  layer.addEventListener("mouseup", (e) => {
    if (e.button !== 2) return;
    const hovered = menu.querySelector(".radial-option.hover");
    if (hovered) {
      const t = hovered.dataset.t;
      const maxed = t === "q" && queenMaxed(myColor);
      const cost = pieceBuyCostClient(myColor, t);
      if (!maxed && credit[myColor] >= cost) socket.emit("buyPiece", { x, y, type: t });
      else if (maxed) showMessage("You already have 2 queens.", "error");
      else showMessage("Not enough credit for that piece.", "error");
    }
    closeRadial();
  });
  layer.addEventListener("mousedown", (e) => { if (e.target === layer) closeRadial(); });
  layer.addEventListener("contextmenu", (e) => e.preventDefault());
  document.body.appendChild(layer);
  radialLayer = layer;
}

function wireBuyMenu() {
  let pressTimer = null, pressCell = null;
  world.addEventListener("contextmenu", (e) => e.preventDefault());
  world.addEventListener("mousedown", (e) => {
    if (e.button !== 2) return;
    const sq = e.target.closest(".square");
    if (!sq || sq.classList.contains("buildable")) return;
    const x = parseInt(sq.dataset.x, 10), y = parseInt(sq.dataset.y, 10);
    if (isNaN(x) || isNaN(y)) return;
    pressCell = { x, y };
    pressTimer = setTimeout(() => { pressTimer = null; openRadial(x, y); }, 280);
  });
  world.addEventListener("mouseup", (e) => {
    if (e.button !== 2) return;
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; if (pressCell) openRadial(pressCell.x, pressCell.y); }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeRadial(); });
}

/* ── HUD: credits + turn edges ── */
function updateCredits() {
  const me = myColor || "w";
  const opp = otherColor(me);
  const myEl = document.getElementById("myCredit");
  const enEl = document.getElementById("enemyCredit");
  if (myEl) myEl.textContent = credit[me] != null ? credit[me] : 0;
  if (enEl) enEl.textContent = credit[opp] != null ? credit[opp] : 0;
}

function updateEdges() {
  const top = document.getElementById("edgeTop");
  const bot = document.getElementById("edgeBottom");
  top.className = "edge";
  bot.className = "edge";
  if (gameOver) return;
  const turnC = gameTurn;
  const colorClass = turnC === "w" ? "c-white" : "c-black";
  let edge;
  if (myColor) edge = turnC === myColor ? bot : top;
  else edge = turnC === "w" ? bot : top;
  edge.className = "edge " + colorClass + " active";
}

function flashKing() {
  if (!myColor) return;
  let kk = null;
  Object.keys(boardData.pieces).forEach((k) => {
    const p = boardData.pieces[k];
    if (p.t === "k" && p.c === myColor) kk = k;
  });
  if (!kk) return;
  const ci = kk.indexOf(",");
  const sq = world.querySelector(`.square[data-x="${kk.slice(0, ci)}"][data-y="${kk.slice(ci + 1)}"]`);
  if (!sq) return;
  sq.classList.remove("king-flash");
  void sq.offsetWidth;
  sq.classList.add("king-flash");
  setTimeout(() => sq.classList.remove("king-flash"), 900);
}

/* ── popups ── */
const showPromotionUI = (onSelect) => {
  const existing = document.querySelector(".promotion-container");
  if (existing) existing.parentElement.remove();
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const box = document.createElement("div");
  box.className = "promotion-container";
  const title = document.createElement("p");
  title.innerText = "Promote pawn to:";
  box.appendChild(title);
  [["q", "♛"], ["r", "♜"], ["b", "♝"], ["n", "♞"]].forEach(([type, sym]) => {
    const b = document.createElement("button");
    b.className = "promotion-btn";
    b.innerHTML = sym;
    b.addEventListener("click", () => { onSelect(type); document.body.removeChild(overlay); });
    box.appendChild(b);
  });
  overlay.appendChild(box);
  document.body.appendChild(overlay);
};

const showMessage = (msg, type = "default") => {
  const existing = document.querySelector(".game-message");
  if (existing) existing.remove();
  const box = document.createElement("div");
  box.className = "game-message message-" + type;
  box.innerText = msg;
  document.body.appendChild(box);
  setTimeout(() => box.classList.add("visible"), 10);
  setTimeout(() => { box.classList.remove("visible"); setTimeout(() => box.remove(), 400); }, 3000);
};

const showConfirmation = (message, yes, no, onYes) => {
  const overlay = document.createElement("div");
  overlay.className = "overlay";
  const box = document.createElement("div");
  box.className = "confirmation-box";
  const text = document.createElement("p");
  text.innerText = message;
  const btnYes = document.createElement("button");
  btnYes.innerText = yes; btnYes.className = "btn-confirm";
  btnYes.onclick = () => { onYes(); document.body.removeChild(overlay); };
  const btnNo = document.createElement("button");
  btnNo.innerText = no; btnNo.className = "btn-cancel";
  btnNo.onclick = () => document.body.removeChild(overlay);
  box.append(text, btnYes, btnNo);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
};

/* ── controls ── */
document.getElementById("restartGame").addEventListener("click", () =>
  showConfirmation("Restart the game?", "Yes", "No", () => socket.emit("restartGame"))
);
document.getElementById("offerDraw").addEventListener("click", () => {
  socket.emit("offerDraw");
  showMessage("Draw offer sent.", "draw");
});
document.getElementById("resignGame").addEventListener("click", () =>
  showConfirmation("Resign the game?", "Yes", "No", () => socket.emit("playerResigned"))
);
document.getElementById("addAI").addEventListener("click", () => socket.emit("addAI"));

/* ── panning ── */
let panning = false, moved = false, startX = 0, startY = 0, panStartX = 0, panStartY = 0;
let suppressClick = false;
viewport.addEventListener("pointerdown", (e) => {
  if (e.button !== 0) return;
  if (e.target.closest(".piece")) return; // piece drag handles itself
  panning = true; moved = false;
  startX = e.clientX; startY = e.clientY; panStartX = panX; panStartY = panY;
  viewport.classList.add("panning");
});
window.addEventListener("pointermove", (e) => {
  if (!panning) return;
  const dx = e.clientX - startX, dy = e.clientY - startY;
  if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
  panX = panStartX + dx; panY = panStartY + dy;
  applyPan();
});
window.addEventListener("pointerup", () => {
  if (!panning) return;
  panning = false;
  viewport.classList.remove("panning");
  if (moved) { suppressClick = true; setTimeout(() => (suppressClick = false), 0); }
});

/* ── server events ── */
socket.on("playerRole", (role) => { myColor = role; centered = false; renderBoard(); updateEdges(); });
socket.on("spectator", () => { myColor = null; centered = false; renderBoard(); updateEdges(); });

let lastAnnounced = null;
socket.on("gameState", (s) => {
  if (s.board) { boardData = s.board; cellsSet = new Set(s.board.cells); }
  lastMove = s.lastMove
    ? { from: { x: s.lastMove.from.x, y: s.lastMove.from.y }, to: { x: s.lastMove.to.x, y: s.lastMove.to.y } }
    : null;
  gameTurn = s.turn || "w";
  gameOver = s.gameOver || null;
  if (s.credit) credit = s.credit;
  if (s.settings) settings = s.settings;
  aiOn = s.ai || null;
  const ic = s.inCheck || { w: false, b: false };
  const bt = s.builtThisTurn || { w: false, b: false };
  myInCheck = myColor ? !!ic[myColor] : false;
  builtThisTurnMe = myColor ? !!bt[myColor] : false;

  renderBoard();
  updateEdges();
  // hide the AI button once a computer opponent is active or for spectators
  const aiBtn = document.getElementById("addAI");
  if (aiBtn) aiBtn.style.display = !myColor || aiOn ? "none" : "flex";
  announceGameOver();
});

socket.on("moveRejected", (d) => {
  if (d && d.reason) showMessage(d.reason, "error");
  if (d && d.kingThreat) flashKing();
});
socket.on("buildRejected", (d) => { if (d && d.reason) showMessage(d.reason, "error"); });
socket.on("buyRejected", (d) => { if (d && d.reason) showMessage(d.reason, "error"); });
socket.on("notice", (n) => {
  if (n && n.text) showMessage(n.text, n.type || "default");
  if (n && n.type === "restart") { lastAnnounced = null; centered = false; }
});
socket.on("offerDraw", () => showConfirmation("Opponent offered a draw.", "Accept", "Reject",
  () => socket.emit("drawAccepted")));
socket.on("drawRejected", () => showMessage("Draw offer rejected.", "draw"));

function announceGameOver() {
  if (!gameOver) { lastAnnounced = null; return; }
  const key = `${gameOver.reason}:${gameOver.winner}`;
  if (key === lastAnnounced) return;
  lastAnnounced = key;
  let msg, type = "draw";
  if (gameOver.reason === "checkmate") {
    type = "resign";
    msg = gameOver.winner === myColor ? "Checkmate — you win! 🎉" : `Checkmate — ${gameOver.winner === "w" ? "White" : "Black"} wins.`;
  } else if (gameOver.reason === "resign") {
    type = "resign";
    msg = gameOver.winner === myColor ? "Opponent resigned — you win!" : "You resigned.";
  } else {
    msg = "Game over — it's a draw.";
  }
  showMessage(msg, type);
}

window.addEventListener("resize", () => { if (centered) centerBoard(); });

/* ── init ── */
wireBuyMenu();
renderBoard();
updateEdges();
