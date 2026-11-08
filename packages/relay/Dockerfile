# Workhub Remote relay. Build context is the repository root:
#   docker build -f packages/relay/Dockerfile -t workhub-relay .
# The web client (packages/app's web build) is copied in when present, so one container serves both.
FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/protocol/package.json packages/protocol/
COPY packages/relay/package.json packages/relay/
# Only what the relay needs: no Electron, no node-pty.
RUN npm ci --workspace @workhub/relay --workspace @workhub/protocol --ignore-scripts --no-audit --no-fund
COPY tsconfig.base.json ./
COPY packages/protocol packages/protocol
COPY packages/relay packages/relay
RUN npm run build -w @workhub/relay

FROM node:22-alpine
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data
RUN addgroup -S relay && adduser -S relay -G relay && mkdir -p /data /web && chown relay:relay /data
WORKDIR /app
COPY --from=build /src/packages/relay/dist/relay.cjs ./relay.cjs
# Optional: the built web client. An empty folder means the relay serves none.
COPY packages/relay/web-client/ /web/
USER relay
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8787/healthz || exit 1
CMD ["node", "relay.cjs"]
