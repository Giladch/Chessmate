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

// Artwork tiers reflect pieces acquired BEYOND the original count of that type.
// The first `ORIG_COUNT` copies stay tier 1; every 2 extra copies bump the tier.
//   knight (orig 2): 1-2 -> t1, 3-4 -> t2, 5-6 -> t3, 7-8 -> t4
//   pawn  (orig 8): 1-8 -> t1, 9-10 -> t2, 11-12 -> t3, 13-14 -> t4
//   queen (orig 1): 1 -> t1, 2 -> t2
const ORIG_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };
function tierFromCount(newCount, type) {
  const extra = newCount - (ORIG_COUNT[type] || 1);
  if (extra <= 0) return 1;
  return Math.min(4, 1 + Math.ceil(extra / 2));
}

// Home rows (base board): white back rank y=7 / pawn row y=6; black back y=0 / pawn y=1.
const WHITE_BACK = 7;
const BLACK_BACK = 0;
const ZONE_ROWS = [3, 4]; // the two central rows = orange income zone

function createEngine() {
  const cells = new Set();
  const pieces = new Map(); // "x,y" -> { type, color }

  // castling rights: kingside (h-rook, +x) and queenside (a-rook, -x) per colour
  const castling = { w: { k: true, q: true }, b: { k: true, q: true } };

  function countOf(color, type) {
    let n = 0;
    pieces.forEach((p) => {
      if (p.color === color && p.type === type) n++;
    });
    return n;
  }
  // tier of a NEW piece = based on the count the colour will have once it's added
  function tierForNew(color, type) {
    return tierFromCount(countOf(color, type) + 1, type);
  }
  // The king upgrades (and only ratchets up) when the player owns at least one
  // piece of tier >= K in EACH of the five other types.
  function updateKingTier(color) {
    let king = null;
    pieces.forEach((p) => {
      if (p.type === "k" && p.color === color) king = p;
    });
    if (!king) return;
    let achieved = 1;
    for (let level = 4; level >= 2; level--) {
      const allHave = ["p", "n", "b", "r", "q"].every((type) => {
        let found = false;
        pieces.forEach((p) => {
          if (p.color === color && p.type === type && (p.tier || 1) >= level) found = true;
        });
        return found;
      });
      if (allHave) {
        achieved = level;
        break;
      }
    }
    if (achieved > (king.tier || 1)) king.tier = achieved;
  }

  const eng = {
    cells,
    pieces,
    turn: "w",
    castling,

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
      pieces.set(k, { type, color, tier: tierForNew(color, type) });
      updateKingTier(color);
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
        pieceObj[k] = { t: p.type, c: p.color, tier: p.tier || 1 };
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
          // castling: king on its home square (e-file, back rank), rights intact,
          // path cells exist & empty, and the corner rook present. (Through-check
          // safety is checked separately in isCastleLegal / legalMoves.)
          const by = color === "w" ? WHITE_BACK : BLACK_BACK;
          if (x === 4 && y === by) {
            const empty = (cx) => cells.has(KEY(cx, by)) && !pieces.get(KEY(cx, by));
            const rookAt = (cx) => {
              const rp = pieces.get(KEY(cx, by));
              return rp && rp.type === "r" && rp.color === color;
            };
            if (castling[color].k && rookAt(7) && empty(5) && empty(6)) {
              moves.push({ from: { x: 4, y: by }, to: { x: 6, y: by }, castle: "k" });
            }
            if (castling[color].q && rookAt(0) && empty(1) && empty(2) && empty(3)) {
              moves.push({ from: { x: 4, y: by }, to: { x: 2, y: by }, castle: "q" });
            }
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

    // Castling-specific legality: not in check, and the king does not pass
    // through or land on an attacked square.
    isCastleLegal(color, side) {
      const by = color === "w" ? WHITE_BACK : BLACK_BACK;
      const opp = other(color);
      if (eng.inCheck(color)) return false;
      if (side === "k") return !eng.isAttacked(5, by, opp) && !eng.isAttacked(6, by, opp);
      return !eng.isAttacked(3, by, opp) && !eng.isAttacked(2, by, opp);
    },

    legalMoves(color) {
      return eng.pseudoMoves(color).filter((m) =>
        m.castle ? eng.isCastleLegal(color, m.castle) : eng._safe(m, color)
      );
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

      // castling: validate through-check safety, then move king + rook together
      if (base.castle) {
        if (!eng.isCastleLegal(color, base.castle)) return null;
        const by = mv.from.y;
        const king = pieces.get(KEY(4, by));
        pieces.delete(KEY(4, by));
        pieces.set(KEY(mv.to.x, by), king);
        if (base.castle === "k") {
          const rook = pieces.get(KEY(7, by));
          pieces.delete(KEY(7, by));
          pieces.set(KEY(5, by), rook); // preserve the rook (and its tier)
        } else {
          const rook = pieces.get(KEY(0, by));
          pieces.delete(KEY(0, by));
          pieces.set(KEY(3, by), rook);
        }
        castling[color].k = false;
        castling[color].q = false;
        eng.turn = other(color);
        return {
          from: { x: 4, y: by },
          to: { x: mv.to.x, y: by },
          color,
          captured: null,
          promotion: null,
          castle: base.castle,
        };
      }

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
      pieces.set(toK, promotion ? { type: promotion, color, tier: tierForNew(color, promotion) } : moving);
      if (promotion) updateKingTier(color);
      eng.turn = other(color);

      // update castling rights
      const by = color === "w" ? WHITE_BACK : BLACK_BACK;
      const opp = other(color);
      const oy = opp === "w" ? WHITE_BACK : BLACK_BACK;
      if (moving.type === "k") {
        castling[color].k = false;
        castling[color].q = false;
      } else if (moving.type === "r" && mv.from.y === by) {
        if (mv.from.x === 0) castling[color].q = false;
        if (mv.from.x === 7) castling[color].k = false;
      }
      if (captured && mv.to.y === oy) {
        if (mv.to.x === 0) castling[opp].q = false;
        if (mv.to.x === 7) castling[opp].k = false;
      }

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
  const cnt = {}; // "color,type" -> running count, to assign starting tiers
  const put = (x, y, type, color) => {
    const ck = color + "," + type;
    cnt[ck] = (cnt[ck] || 0) + 1;
    eng.pieces.set(x + "," + y, { type, color, tier: tierFromCount(cnt[ck], type) });
  };
  for (let x = 0; x < 8; x++) {
    put(x, BLACK_BACK, back[x], "b");
    put(x, BLACK_BACK + 1, "p", "b");
    put(x, WHITE_BACK, back[x], "w");
    put(x, WHITE_BACK - 1, "p", "w");
  }
  eng.turn = "w";
  return eng;
}

module.exports = { createEngine, standardSetup, KEY, forward, ZONE_ROWS };
