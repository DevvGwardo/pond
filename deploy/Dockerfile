# Multi-stage: the builder compiles TypeScript -> JS from source (so the image
# does NOT depend on committed/locally-built .js, which are gitignored), and the
# runtime stage ships only prod deps + the compiled output.

# ---- builder ----
FROM node:22-bookworm-slim AS builder
# better-sqlite3's build fallback + node-gyp need python3 + a C++ toolchain.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 make g++ git \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
# Full install (incl. devDeps: typescript, esbuild, codemirror) — needed to build.
RUN npm ci
# Source needed to compile. .dockerignore keeps node_modules / .js out of the
# context so the build is reproducible from .ts.
COPY . .
RUN npm run build

# ---- runtime ----
FROM node:22-bookworm-slim
# gosu lets the root entrypoint drop privileges to `node` after fixing volume
# perms; tini reaps forked capsule workers.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates python3 make g++ git tini gosu \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
# Compiled JS + supporting files from the builder.
COPY --from=builder /app/src ./src
COPY --from=builder /app/client ./client
COPY --from=builder /app/bin ./bin
COPY --from=builder /app/docs ./docs
COPY README.md LICENSE ./

ENV NODE_ENV=production
ENV POND_HOST_DATA_DIR=/data

# Run as the unprivileged `node` user (uid 1000) rather than root, so a capsule
# that escapes the Node sandbox lands as a non-root user with no caps.
RUN mkdir -p /data && chown -R node:node /app /data
COPY deploy/pond-entrypoint.sh /usr/local/bin/pond-entrypoint.sh
RUN chmod +x /usr/local/bin/pond-entrypoint.sh
# NOTE: no `VOLUME` instruction — Railway rejects it (use Railway Volumes); the
# docker-compose path mounts the `pond-data` volume at /data instead.
# Stay root so the entrypoint can chown the (root-owned) volume mount; it then
# drops to `node` via gosu before exec'ing the control plane.

EXPOSE 8787

# tini (PID 1) reaps forked workers; the entrypoint fixes /data perms + drops
# privileges to `node`.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/pond-entrypoint.sh"]

# Sane defaults; override at run time (compose env / Railway startCommand).
CMD ["node", "/app/src/cli.js", "host", \
     "--port", "8787", \
     "--host", "0.0.0.0", \
     "--data-dir", "/data"]
