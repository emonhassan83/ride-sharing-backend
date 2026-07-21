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

RUN apk add --no-cache tzdata dumb-init && \
    ln -sf /usr/share/zoneinfo/Asia/Nicosia /etc/localtime && \
    echo "Asia/Nicosia" > /etc/timezone

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV TZ=Asia/Nicosia

ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "./dist/index.js"]
