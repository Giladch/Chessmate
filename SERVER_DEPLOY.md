# Connecting a game to the shared boost-media server

איך משחק מתארח ומתחבר על השרת המשותף, ואיך להוסיף משחק חדש (chessmate) לצד hexline — על אותה כתובת/שרת.

## The model

One server (Hetzner, **157.180.116.184**). A shared nginx container **`bc-nginx`**
terminates HTTPS on ports 80/443 with a Cloudflare **origin certificate**, and
routes **each subdomain to its own game container** on the internal Docker network
**`bc-backend_default`**. Each game container serves **both** its built web client
**and** its WebSocket on a single port — so a player just opens the `https://` URL
and the client connects to the WebSocket on the **same origin**. There is no
separate API host and no `VITE_WS_URL` needed in this deployment.

Live today: `hexline.boost-media.co.il` → container **`hexline`** (listening on `:8080`).

## How a player connects (hexline = the reference)

1. Browser opens `https://hexline.boost-media.co.il` → `bc-nginx` proxies to the
   `hexline` container, which serves the client.
2. The client opens `wss://hexline.boost-media.co.il` (same host) → nginx upgrades
   the connection to the same container.

That is the entire "connection": same-origin HTTPS + WebSocket, proxied by `bc-nginx`.

## The reference nginx block

On the server, the proxy config is a single file:
`/opt/bc-backend/nginx/default.conf` (bind-mounted into `bc-nginx` at
`/etc/nginx/conf.d/default.conf`; certs come from `/opt/bc-backend/nginx/ssl`).

```nginx
server { listen 80; server_name hexline.boost-media.co.il; return 301 https://$host$request_uri; }
server {
    listen 443 ssl;
    server_name hexline.boost-media.co.il;
    ssl_certificate     /etc/nginx/ssl/origin.crt;
    ssl_certificate_key /etc/nginx/ssl/origin.key;
    location / {
        proxy_pass http://hexline:8080;          # container name on bc-backend_default
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;   # WebSocket upgrade — required
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 3600s; proxy_send_timeout 3600s;
    }
}
```

## Add a new game on the same server (chessmate)

1. **DNS — already done.** `chessmate.boost-media.co.il` → same IP, proxied by
   Cloudflare. The existing origin cert covers `*.boost-media.co.il`, so **no new
   certificate** is needed.

2. **Run the chessmate container** on the shared network, with a name nginx can
   resolve:

   ```bash
   docker run -d --name chessmate \
     --network bc-backend_default \
     --restart unless-stopped \
     chessmate:latest
   ```

   It serves client + WebSocket on its own port (e.g. `8080` *inside* the
   container). You do **not** need to publish it to the host (`-p`) — nginx reaches
   it by container name over `bc-backend_default`. (Avoid host-publishing 8080; it's
   already taken by `hexline`.)

3. **Add an nginx server block** to `/opt/bc-backend/nginx/default.conf` — copy the
   hexline block above and change two lines:
   - `server_name` → `chessmate.boost-media.co.il`
   - `proxy_pass`  → `http://chessmate:8080`  (use the container's actual port)

   Keep the SSL lines and the two WebSocket headers identical.

4. **Reload nginx:**

   ```bash
   docker exec bc-nginx nginx -t && docker exec bc-nginx nginx -s reload
   ```

Player then opens `https://chessmate.boost-media.co.il`. Done.

## Key facts

| | |
|---|---|
| Server | `root@157.180.116.184` (SSH key `bc-backend-hetzner`) |
| Reverse proxy | container `bc-nginx` · config `/opt/bc-backend/nginx/default.conf` · certs `/opt/bc-backend/nginx/ssl/origin.{crt,key}` |
| Shared network | `bc-backend_default` — nginx reaches game containers by **container name** |
| Per game | one container serving client + WebSocket on one port + one nginx server block per subdomain |

> Note: in dev, the client's WS URL is overridable via `VITE_WS_URL`; in this
> server deployment it's left unset so the client uses the same origin it was
> loaded from (which is why one container + one subdomain "just works").
