ARG BUILD_FROM=node:20-bookworm-slim
FROM ${BUILD_FROM}

# glibc-Basis statt Alpine/musl: better-sqlite3s vorgebaute Binaries (und
# das SQLite-Amalgam) verlangen aktuell 'fcntl64', das musl >=1.2.4 nicht
# mehr bereitstellt und auch gcompat (Stand Alpine-Paket) noch nicht abdeckt.
#
# python3/make/g++: node-gyp-Fallback fuer better-sqlite3, falls der Download
# der vorgebauten Binary (prebuild-install) fehlschlaegt/timeoutet - ohne
# diese Pakete bricht der Build dann komplett ab ("Could not find any Python
# installation"), da bookworm-slim kein Python enthaelt.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY app/package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY app/ ./

ENV DATA_DIR=/data
EXPOSE 3003

CMD ["node", "/app/server.js"]
