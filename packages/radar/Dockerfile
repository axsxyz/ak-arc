# Build from the repository root (npm workspaces share one lockfile):
#   docker build -f packages/radar/Dockerfile -t ak-arc-radar .
# The root .dockerignore keeps every .env and all non-radar sources out of the context.
FROM node:22-slim
WORKDIR /app
ENV NODE_ENV=production NODE_OPTIONS=--disable-warning=ExperimentalWarning
COPY package.json package-lock.json ./
COPY packages ./packages
RUN npm ci -w packages/radar
WORKDIR /app/packages/radar
VOLUME ["/app/packages/radar/data", "/app/packages/radar/config/watchlists"]
CMD ["npx", "tsx", "src/index.ts"]
