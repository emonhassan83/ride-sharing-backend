# Deployment and Containerization Guide

This document describes how to deploy, configure, and orchestrate the Split Ride system.

## 1. Docker Compose Infrastructure
The project is containerized using Docker, with services orchestrated via `docker-compose.yml`:

- **`redis`**: Redis instance used for application caching, OTP storage, and the BullMQ job queue. Uses password authentication (`myStrongRedisPassword`).
- **`redis-ui`**: Redis Commander dashboard exposed on port `8081` to monitor Redis keys.
- **`server`**: Main Express API backend application container (binds to port `8080`).
- **`worker`**: Background worker container processing BullMQ queues.

---

## 2. Docker Files
We maintain separate environments for local development and production deployment:
- **`Dockerfile.dev`**: Uses node-dev or nodemon volume mounts for live reloading.
- **`Dockerfile`**: Builds optimized production builds by compiling TypeScript source code to `/dist` and stripping out development dependencies.

---

## 3. Environment Variables
Ensure the following variables are configured in your `.env` file before running the containers:

| Variable | Description |
|---|---|
| `PORT` | Main API listening port (e.g. `8080`). |
| `MONGODB_URL` | MongoDB connection URL. |
| `REDIS_HOST` | Redis service host (e.g. `redis` inside docker network, or `localhost` locally). |
| `REDIS_PORT` | Redis service port (default: `6379`). |
| `REDIS_PASSWORD` | Password authorization for Redis connection. |
| `STRIPE_SECRET_KEY` | Stripe integration key for booking payments. |
| `JWT_ACCESS_SECRET` | JWT signature key for authentication. |

---

## 4. Run Locally using Docker
Build and run the entire environment in the background:
```bash
docker-compose up --build -d
```

Shut down containers and clean up network resources:
```bash
docker-compose down
```

`docker-compose.yml` is for **development only**: it sets `NODE_ENV=development`, which returns
OTP codes in API responses and skips real SMS. Never expose it publicly.

---

## 5. Production (HTTPS + WSS)

`docker-compose.prod.yml` runs the production builds with `NODE_ENV=production` behind
[Caddy](https://caddyserver.com), which gets and renews a Let's Encrypt certificate automatically.
REST becomes `https://<domain>/api/v1` and Socket.io becomes `wss://<domain>` (same port 443).

**Before the first start**
1. Point a DNS `A` record for the API domain (for example `api.splitride.app`) at the server.
2. Open ports **80** and **443** (80 is needed for the certificate challenge and the redirect).
   Close 8080, 6380 and 8081 to the internet.
3. Fill in `server/.env` and `worker/.env` (production Mongo, Stripe live keys, Twilio, Firebase).
   Set `BACKEND_IP=0.0.0.0` so the server listens inside the container. `NODE_ENV`, `REDIS_*`
   and `TRUST_PROXY` are set by the compose file.

**Start**
```bash
export DOMAIN=api.splitride.app ACME_EMAIL=ops@splitride.app REDIS_PASSWORD='<long random>'
docker compose -f docker-compose.prod.yml up --build -d
docker compose -f docker-compose.prod.yml logs -f caddy server
```

**Check**
- `curl -I http://$DOMAIN` returns a redirect to `https://`.
- `curl https://$DOMAIN/api/v1/setting/generals` returns JSON over a valid certificate.
- The server log must **not** show `OTP codes are returned in API responses`. If it does,
  `NODE_ENV` is not `production`.
- Update the apps' base URL to `https://<domain>/api/v1` and the socket URL to `https://<domain>`.
  (Socket.io clients upgrade to `wss` themselves.) Remove any Android `usesCleartextTraffic` /
  iOS ATS exceptions added for the IP.

**Safety nets in the code**
- Mock OTPs are enabled only when `NODE_ENV` is exactly `development` or `test`. An unset or
  misspelled value behaves like production (codes are never returned), and the server logs a
  warning at start.
- `TRUST_PROXY=1` makes `req.ip`/`req.secure` reflect the client behind Caddy. It is off unless set.

Using nginx or a cloud load balancer instead of Caddy works too. Proxy to `server:8080`, forward
`Upgrade`/`Connection` headers for WebSockets, and keep `TRUST_PROXY=1`. See `deploy/Caddyfile`
for the headers to set.
