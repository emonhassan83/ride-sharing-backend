# ---------- BUILD STAGE ----------
FROM node:22-alpine AS builder

WORKDIR /app

# Set time zone to Asia/Dhaka
RUN apk add --no-cache tzdata curl && \
    ln -sf /usr/share/zoneinfo/Asia/Dhaka /etc/localtime && \
    echo "Asia/Dhaka" > /etc/timezone

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
# . .

RUN npm run build


# ---------- RUNTIME STAGE ----------
FROM node:22-alpine

WORKDIR /app

# Set time zone to Asia/Dhaka
RUN apk add --no-cache tzdata curl && \
    ln -sf /usr/share/zoneinfo/Asia/Dhaka /etc/localtime && \
    echo "Asia/Dhaka" > /etc/timezone

COPY package*.json ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

ENV NODE_ENV=production
ENV TZ=Asia/Dhaka

EXPOSE 8080

CMD ["node", "dist/server.js"]
