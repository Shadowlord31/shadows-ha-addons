ARG BUILD_FROM
FROM ${BUILD_FROM}

# Build-Tools fuer better-sqlite3 (natives Modul)
RUN apk add --no-cache python3 make g++

WORKDIR /app
COPY app/package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY app/ ./

ENV DATA_DIR=/data
EXPOSE 3002

CMD ["node", "/app/server.js"]
