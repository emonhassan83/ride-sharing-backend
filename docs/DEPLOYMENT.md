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
