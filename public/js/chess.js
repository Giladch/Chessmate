const socket = io();
const chess = new Chess();
const boardElement = document.getElementById("chessboard");

let draggedPiece = null;
let sourceSquare = null;
let playerRole = "w"; // Default role
let lastMove = null;

/**
 * Render the chessboard based on FEN state.
 */
const renderBoard = () => {
  const board = chess.board();
  boardElement.innerHTML = "";
  document
    .querySelectorAll(".square.highlight")
    .forEach((sq) => sq.classList.remove("highlight"));

  board.forEach((row, rowIndex) => {
    row.forEach((square, columnIndex) => {
      const squareElement = document.createElement("div");
      squareElement.classList.add(
        "square",
        (rowIndex + columnIndex) % 2 === 0 ? "light" : "dark"
      );
      squareElement.dataset.row = rowIndex;
      squareElement.dataset.column = columnIndex;

      // Highlight last move
      if (
        lastMove &&
        ((lastMove.from.row === rowIndex &&
          lastMove.from.column === columnIndex) ||
          (lastMove.to.row === rowIndex && lastMove.to.column === columnIndex))
      ) {
        squareElement.classList.add("highlight");
      }

      // Render piece
      if (square) {
        const pieceElement = document.createElement("div");
        pieceElement.classList.add(
          "piece",
          square.color === "w" ? "white" : "black"
        );
        pieceElement.innerText = getPieceUnicode(square);
        pieceElement.draggable = playerRole === square.color;

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
          const targetSquare = {
            row: parseInt(squareElement.dataset.row),
            column: parseInt(squareElement.dataset.column),
          };
          handleMove(sourceSquare, targetSquare);
        }
      });

      boardElement.appendChild(squareElement);
    });
  });

  boardElement.classList.toggle("flipped", playerRole === "b");
};

/**
 * Handle piece move.
 */
const handleMove = (fromSquare, toSquare) => {
  const from = `${String.fromCharCode(97 + fromSquare.column)}${
    8 - fromSquare.row
  }`;
  const to = `${String.fromCharCode(97 + toSquare.column)}${8 - toSquare.row}`;
  const piece = chess.get(from);

  let move = { from, to };

  // Handle promotion
  if (piece && piece.type === "p" && (to.endsWith("8") || to.endsWith("1"))) {
    showPromotionUI((selectedPiece) => {
      move.promotion = selectedPiece;
      socket.emit("move", move);
    });
    return;
  }

  socket.emit("move", move);
};

/**
 * Handle move results from server.
 */
socket.on("move", (moveResult) => {
  try {
    chess.move(moveResult);
    lastMove = {
      from: parseSquare(moveResult.from),
      to: parseSquare(moveResult.to),
    };
    renderBoard();
  } catch (err) {
    console.error("Invalid move received from server", err);
  }
});

/**
 * Convert piece notation to Unicode.
 */
const getPieceUnicode = (piece) => {
  const unicodeMap = {
    p: "♙",
    r: "♖",
    n: "♘",
    b: "♗",
    q: "♕",
    k: "♔",
    P: "♟",
    R: "♜",
    N: "♞",
    B: "♝",
    Q: "♛",
    K: "♚",
  };
  return unicodeMap[piece.type] || "";
};

/**
 * Parse algebraic square (e.g., 'e4') to row/column.
 */
const parseSquare = (notation) => ({
  column: notation.charCodeAt(0) - 97,
  row: 8 - parseInt(notation[1]),
});

/**
 * Promotion UI
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
 * Flash messages
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
 * Confirmation popup
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
 * Game control listeners
 */
document.getElementById("restartGame").addEventListener("click", () => {
  showConfirmation(
    "Are you sure you want to restart?",
    "Yes",
    "No",
    () => {
      socket.emit("restartGame");
      showMessage("Game restarted!", "restart");
    },
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
    () => {
      socket.emit("playerResigned");
      showMessage("You resigned. Opponent wins!", "resign");
    },
    () => showMessage("Resignation canceled.")
  );
});

/**
 * Server events
 */
socket.on("restartGame", () => {
  chess.reset();
  lastMove = null;
  renderBoard();
  showMessage("Game restarted!", "restart");
});

socket.on("offerDraw", () => {
  showConfirmation(
    "Opponent offered a draw.",
    "Accept",
    "Reject",
    () => {
      socket.emit("drawAccepted");
      showMessage("Game ended in a draw.", "draw");
    },
    () => {
      socket.emit("drawRejected");
      showMessage("You rejected the draw.", "draw");
    }
  );
});

socket.on("drawAccepted", () => showMessage("Game ended in a draw.", "draw"));
socket.on("drawRejected", () => showMessage("Draw offer rejected.", "draw"));
socket.on("playerResigned", () =>
  showMessage("Opponent resigned. You win!", "resign")
);

socket.on("Invalid move", () => showMessage("Invalid move!", "error"));

socket.on("playerRole", (role) => {
  playerRole = role;
});
socket.on("spectator", () => {
  playerRole = null;
});

socket.on("boardState", (fen) => {
  chess.load(fen);
  renderBoard();
});

/**
 * Initial render
 */
renderBoard();
