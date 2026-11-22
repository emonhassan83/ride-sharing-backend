# ---------- BUILD STAGE ----------
FROM node:22-alpine AS builder

WORKDIR /app

RUN apk add --no-cache curl

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
# . .

RUN npm run build


# ---------- RUNTIME STAGE ----------
FROM node:22-alpine

WORKDIR /app

# tzdata only; the zone itself comes from TIME_ZONE in .env at runtime.
RUN apk add --no-cache tzdata curl

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production

EXPOSE 8080

CMD ["node", "dist/server.js"]
