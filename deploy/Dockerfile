FROM node:22-bookworm-slim

# better-sqlite3 ships prebuilt binaries, but the build fallback needs python
# + a C++ toolchain. We bake them in so a `docker build` works even when the
# prebuilt artifact is missing for the platform.
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ca-certificates python3 make g++ git tini \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install production deps first for layer caching.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Copy the compiled JS + supporting files.
COPY src ./src
COPY client ./client
COPY bin ./bin
COPY README.md LICENSE ./

ENV NODE_ENV=production
ENV POND_HOST_DATA_DIR=/data
VOLUME ["/data"]

EXPOSE 8787

# tini reaps the forked deploy workers cleanly on shutdown.
ENTRYPOINT ["/usr/bin/tini", "--"]

# Sane defaults; override at run time with -e or compose env vars.
CMD ["node", "/app/src/cli.js", "host", \
     "--port", "8787", \
     "--host", "0.0.0.0", \
     "--data-dir", "/data"]
