FROM node:22-slim AS builder

WORKDIR /build
COPY package*.json tsconfig.json ./
RUN npm ci
COPY src/ ./src/
RUN npm run build

FROM node:22-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev --ignore-scripts && \
    npm rebuild better-sqlite3

COPY --from=builder /build/dist/ ./dist/
COPY docker-entrypoint.sh ./
RUN chmod +x /app/docker-entrypoint.sh

# Install docker CLI (static binary) to communicate with host Docker socket
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl && \
    curl -fsSL https://download.docker.com/linux/static/stable/x86_64/docker-28.1.1.tgz \
      | tar xz --strip-components=1 -C /usr/local/bin docker/docker && \
    rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["/app/docker-entrypoint.sh"]
