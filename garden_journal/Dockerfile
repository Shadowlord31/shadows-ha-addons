ARG BUILD_FROM
FROM ${BUILD_FROM}

# Node.js + Build-Tools fuer better-sqlite3 (natives Modul)
RUN apk add --no-cache nodejs npm python3 make g++

WORKDIR /app
COPY app/package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY app/ ./

COPY rootfs /

ENV DATA_DIR=/data
EXPOSE 3002

CMD ["node", "/app/server.js"]
