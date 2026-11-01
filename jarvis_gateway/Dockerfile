ARG BUILD_FROM=node:20-alpine
FROM ${BUILD_FROM}

WORKDIR /app
COPY app/package.json ./
RUN npm install --omit=dev && npm cache clean --force
COPY app/ ./

ENV DATA_DIR=/data
EXPOSE 3003

CMD ["node", "/app/server.js"]
