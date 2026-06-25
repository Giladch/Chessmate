# Chessmate — single container that serves the web client AND the socket.io
# WebSocket on one port (8080), matching the shared boost-media server model.
FROM node:20-alpine

WORKDIR /app

# Install production deps first (better layer caching)
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# App source
COPY index.js ./
COPY views ./views
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
