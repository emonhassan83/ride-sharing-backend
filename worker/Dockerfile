# ---------- BUILD STAGE ----------
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src

RUN npx tsc --project tsconfig.json && npx tsc-alias --project tsconfig.json

# ---------- RUNTIME STAGE ----------
FROM node:22-alpine

WORKDIR /app

# tzdata only; the zone itself comes from TIME_ZONE in .env at runtime.
RUN apk add --no-cache tzdata dumb-init

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "./dist/index.js"]
