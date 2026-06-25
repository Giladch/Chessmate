# Chessmate

Online 1v1 chess for the shared **boost-media** server. One Node process serves
both the web client and the socket.io WebSocket on a single port (`:8080`), so a
player just opens `https://chessmate.boost-media.co.il` and the board connects on
the same origin — exactly like `hexline` and `evox`.

**Seating:** the first person to open the link takes **White**, the second takes
**Black**, and anyone after that joins as a **spectator**. Includes drag-and-drop
moves, pawn promotion, last-move highlight, and restart / offer-draw / resign.

## Run locally

```bash
npm install
npm start            # http://localhost:8080  (override with PORT=)
```

## Run in Docker

```bash
docker build -t chessmate:latest .
docker run -d --name chessmate --network bc-backend_default \
  --restart unless-stopped chessmate:latest
```

Then add the nginx server block for `chessmate.boost-media.co.il` and reload —
see [SERVER_DEPLOY.md](./SERVER_DEPLOY.md).

## Tech

Node.js · Express · socket.io · chess.js · EJS · Tailwind (CDN).

## Credit

Based on the open-source [Krutarth-2004/Chess](https://github.com/Krutarth-2004/Chess)
real-time multiplayer chess, adapted for the single-container, same-origin
boost-media deployment.
