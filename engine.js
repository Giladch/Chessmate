/**
 * Chessmate dynamic-board engine (pure, no socket/express deps).
 *
 * The board is an infinite integer grid (x,y). A "cell" exists if it is in the
 * `cells` Set. Pieces live only on existing cells. Movement uses standard chess
 * vectors but is restricted to existing cells: sliding pieces are blocked by
 * gaps (missing cells) and by pieces; knights must land on an existing cell.
 *
 * Coordinates: x = file (increases right), y = rank-row (increases DOWN).
 * White starts at large y and advances toward y=0 (forward dy = -1);
 * Black advances toward larger y (forward dy = +1). This matches the original
 * 8x8 board: x,y in [0,7], black back rank y=0, white back rank y=7.
 */

const KEY = (x, y) => x + "," + y;
const PARSE = (k) => {
  const i = k.indexOf(",");
  return { x: parseInt(k.slice(0, i), 10), y: parseInt(k.slice(i + 1), 10) };
};

const ROOK_DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const BISHOP_DIRS = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const QUEEN_DIRS = ROOK_DIRS.concat(BISHOP_DIRS);
const KNIGHT_STEPS = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
const PROMO_TYPES = ["q", "r", "b", "n"];

const other = (c) => (c === "w" ? "b" : "w");
const forward = (c) => (c === "w" ? -1 : 1);

// Home rows (base board): white back rank y=7 / pawn row y=6; black back y=0 / pawn y=1.
const WHITE_BACK = 7;
const BLACK_BACK = 0;
const ZONE_ROWS = [3, 4]; // the two central rows = orange income zone

function createEngine() {
  const cells = new Set();
  const pieces = new Map(); // "x,y" -> { type, color }

  const eng = {
    cells,
    pieces,
    turn: "w",

    /* ── cell / piece primitives ── */
    hasCell: (x, y) => cells.has(KEY(x, y)),
    addCell(x, y) {
      cells.add(KEY(x, y));
    },
    removeCell(x, y) {
      const k = KEY(x, y);
      const p = pieces.get(k);
      if (p && p.type === "k") return { ok: false, reason: "king-cell" };
      pieces.delete(k);
      cells.delete(k);
      return { ok: true };
    },
    getPiece: (x, y) => pieces.get(KEY(x, y)) || null,
    placePiece(x, y, type, color) {
      const k = KEY(x, y);
      if (!cells.has(k)) return { ok: false, reason: "no-cell" };
      if (pieces.has(k)) return { ok: false, reason: "occupied" };
      if (type === "k") return { ok: false, reason: "no-king" };
      pieces.set(k, { type, color });
      return { ok: true };
    },
    removePiece(x, y) {
      pieces.delete(KEY(x, y));
    },
    setTurn(c) {
      eng.turn = c;
    },

    /* ── geometry helpers (used by later phases) ── */
    isInZone: (x, y) => cells.has(KEY(x, y)) && ZONE_ROWS.indexOf(y) !== -1,
    zoneRows: () => ZONE_ROWS.slice(),
    classifyHome(x, y, color) {
      // 'all' = back rank or behind it; 'pawn' = second rank; 'none' otherwise.
      if (color === "w") {
        if (y >= WHITE_BACK) return "all";
        if (y === WHITE_BACK - 1) return "pawn";
        return "none";
      }
      if (y <= BLACK_BACK) return "all";
      if (y === BLACK_BACK + 1) return "pawn";
      return "none";
    },
    isBuildable(x, y) {
      if (cells.has(KEY(x, y))) return false;
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          if (dx === 0 && dy === 0) continue;
          if (cells.has(KEY(x + dx, y + dy))) return true;
        }
      }
      return false;
    },

    /* ── serialization ── */
    bbox() {
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      cells.forEach((k) => {
        const { x, y } = PARSE(k);
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      });
      if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
      return { minX, minY, maxX, maxY };
    },
    serialize() {
      const cellArr = [];
      cells.forEach((k) => cellArr.push(k));
      const pieceObj = {};
      pieces.forEach((p, k) => {
        pieceObj[k] = { t: p.type, c: p.color };
      });
      return { cells: cellArr, pieces: pieceObj, bbox: eng.bbox(), zoneRows: ZONE_ROWS.slice() };
    },

    /* ── attack / check ── */
    findKing(color) {
      let found = null;
      pieces.forEach((p, k) => {
        if (!found && p.type === "k" && p.color === color) found = PARSE(k);
      });
      return found;
    },

    isAttacked(x, y, byColor) {
      // sliders along rays from the target
      const rayHit = (dirs, types) => {
        for (const [dx, dy] of dirs) {
          let i = 1;
          while (true) {
            const cx = x + dx * i, cy = y + dy * i;
            if (!cells.has(KEY(cx, cy))) break; // gap blocks
            const p = pieces.get(KEY(cx, cy));
            if (p) {
              if (p.color === byColor && types.indexOf(p.type) !== -1) return true;
              break; // any piece blocks the ray
            }
            i++;
          }
        }
        return false;
      };
      if (rayHit(ROOK_DIRS, ["r", "q"])) return true;
      if (rayHit(BISHOP_DIRS, ["b", "q"])) return true;
      // knights
      for (const [dx, dy] of KNIGHT_STEPS) {
        const k = KEY(x + dx, y + dy);
        if (!cells.has(k)) continue;
        const p = pieces.get(k);
        if (p && p.color === byColor && p.type === "n") return true;
      }
      // king
      for (const [dx, dy] of QUEEN_DIRS) {
        const k = KEY(x + dx, y + dy);
        if (!cells.has(k)) continue;
        const p = pieces.get(k);
        if (p && p.color === byColor && p.type === "k") return true;
      }
      // pawns: a byColor pawn at (x±1, y - f) attacks (x,y)
      const f = forward(byColor);
      for (const sx of [x - 1, x + 1]) {
        const k = KEY(sx, y - f);
        if (!cells.has(k)) continue;
        const p = pieces.get(k);
        if (p && p.color === byColor && p.type === "p") return true;
      }
      return false;
    },

    inCheck(color) {
      const k = eng.findKing(color);
      if (!k) return false;
      return eng.isAttacked(k.x, k.y, other(color));
    },

    /* ── move generation (pseudo-legal, restricted to existing cells) ── */
    pseudoMoves(color) {
      const moves = [];
      pieces.forEach((p, key) => {
        if (p.color !== color) return;
        const { x, y } = PARSE(key);
        if (p.type === "p") {
          const f = forward(color);
          // forward 1
          if (cells.has(KEY(x, y + f)) && !pieces.get(KEY(x, y + f))) {
            pushPawn(moves, x, y, x, y + f);
            // forward 2 from start rank
            const startRank = color === "w" ? WHITE_BACK - 1 : BLACK_BACK + 1;
            if (y === startRank && cells.has(KEY(x, y + 2 * f)) && !pieces.get(KEY(x, y + 2 * f))) {
              moves.push({ from: { x, y }, to: { x, y: y + 2 * f } });
            }
          }
          // captures
          for (const cx of [x - 1, x + 1]) {
            const tk = KEY(cx, y + f);
            if (!cells.has(tk)) continue;
            const tp = pieces.get(tk);
            if (tp && tp.color !== color) pushPawn(moves, x, y, cx, y + f);
          }
        } else if (p.type === "n") {
          for (const [dx, dy] of KNIGHT_STEPS) {
            const tk = KEY(x + dx, y + dy);
            if (!cells.has(tk)) continue;
            const tp = pieces.get(tk);
            if (!tp || tp.color !== color) moves.push({ from: { x, y }, to: { x: x + dx, y: y + dy } });
          }
        } else if (p.type === "k") {
          for (const [dx, dy] of QUEEN_DIRS) {
            const tk = KEY(x + dx, y + dy);
            if (!cells.has(tk)) continue;
            const tp = pieces.get(tk);
            if (!tp || tp.color !== color) moves.push({ from: { x, y }, to: { x: x + dx, y: y + dy } });
          }
        } else {
          const dirs = p.type === "r" ? ROOK_DIRS : p.type === "b" ? BISHOP_DIRS : QUEEN_DIRS;
          for (const [dx, dy] of dirs) {
            let i = 1;
            while (true) {
              const cx = x + dx * i, cy = y + dy * i;
              if (!cells.has(KEY(cx, cy))) break;
              const tp = pieces.get(KEY(cx, cy));
              if (!tp) {
                moves.push({ from: { x, y }, to: { x: cx, y: cy } });
              } else {
                if (tp.color !== color) moves.push({ from: { x, y }, to: { x: cx, y: cy } });
                break;
              }
              i++;
            }
          }
        }
      });
      return moves;

      function pushPawn(arr, fx, fy, tx, ty) {
        // promotion if no forward cell beyond destination
        const f = forward(color);
        if (!cells.has(KEY(tx, ty + f))) {
          arr.push({ from: { x: fx, y: fy }, to: { x: tx, y: ty }, promotion: "q" });
        } else {
          arr.push({ from: { x: fx, y: fy }, to: { x: tx, y: ty } });
        }
      }
    },

    // make/unmake to test self-check, returns true if move leaves `color` safe
    _safe(move, color) {
      const fromK = KEY(move.from.x, move.from.y);
      const toK = KEY(move.to.x, move.to.y);
      const moving = pieces.get(fromK);
      const captured = pieces.get(toK);
      pieces.delete(fromK);
      pieces.set(toK, move.promotion ? { type: move.promotion, color } : moving);
      const safe = !eng.inCheck(color);
      // revert
      pieces.set(fromK, moving);
      if (captured) pieces.set(toK, captured);
      else pieces.delete(toK);
      return safe;
    },

    legalMoves(color) {
      return eng.pseudoMoves(color).filter((m) => eng._safe(m, color));
    },

    // true if mv is a pseudo-legal move for `color` that would leave its own
    // king in check (i.e. rejected specifically because the king is threatened)
    wouldExposeKing(mv, color) {
      const cand = eng.pseudoMoves(color).find(
        (m) =>
          m.from.x === mv.from.x &&
          m.from.y === mv.from.y &&
          m.to.x === mv.to.x &&
          m.to.y === mv.to.y
      );
      if (!cand) return false;
      return !eng._safe({ from: mv.from, to: mv.to, promotion: cand.promotion }, color);
    },

    isCheckmate: (color) => eng.inCheck(color) && eng.legalMoves(color).length === 0,
    isStalemate: (color) => !eng.inCheck(color) && eng.legalMoves(color).length === 0,

    /**
     * Apply a move for `color` if legal. Returns the result object or null.
     * Sets turn to the opponent on success. (Race mode calls setTurn first.)
     */
    move(mv, color) {
      const fromK = KEY(mv.from.x, mv.from.y);
      const moving = pieces.get(fromK);
      if (!moving || moving.color !== color) return null;

      // find the matching pseudo-legal move (by from/to)
      const candidates = eng.pseudoMoves(color).filter(
        (m) =>
          m.from.x === mv.from.x &&
          m.from.y === mv.from.y &&
          m.to.x === mv.to.x &&
          m.to.y === mv.to.y
      );
      if (candidates.length === 0) return null;
      const base = candidates[0];

      // promotion handling
      let promotion = null;
      if (base.promotion) {
        promotion = PROMO_TYPES.indexOf(mv.promotion) !== -1 ? mv.promotion : "q";
      }
      const applied = { from: mv.from, to: mv.to, promotion };

      if (!eng._safe(applied, color)) return null; // would leave own king in check

      const toK = KEY(mv.to.x, mv.to.y);
      const captured = pieces.get(toK) || null;
      pieces.delete(fromK);
      pieces.set(toK, promotion ? { type: promotion, color } : moving);
      eng.turn = other(color);

      return {
        from: { x: mv.from.x, y: mv.from.y },
        to: { x: mv.to.x, y: mv.to.y },
        color,
        captured: captured ? captured.type : null,
        promotion,
      };
    },
  };

  return eng;
}

function standardSetup() {
  const eng = createEngine();
  for (let x = 0; x < 8; x++) {
    for (let y = 0; y < 8; y++) eng.addCell(x, y);
  }
  const back = ["r", "n", "b", "q", "k", "b", "n", "r"];
  for (let x = 0; x < 8; x++) {
    eng.pieces.set(x + "," + BLACK_BACK, { type: back[x], color: "b" });
    eng.pieces.set(x + "," + (BLACK_BACK + 1), { type: "p", color: "b" });
    eng.pieces.set(x + "," + WHITE_BACK, { type: back[x], color: "w" });
    eng.pieces.set(x + "," + (WHITE_BACK - 1), { type: "p", color: "w" });
  }
  eng.turn = "w";
  return eng;
}

module.exports = { createEngine, standardSetup, KEY, forward, ZONE_ROWS };
