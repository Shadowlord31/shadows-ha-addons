const express = require('express');
const path = require('path');
const fs = require('fs');
const { createAccessGate } = require('./middleware/access');
const { HaClient } = require('./lib/ha');
const { Store } = require('./lib/store');
const { Audit } = require('./lib/audit');
const { Gateway, ApiError } = require('./lib/gateway');

const VERSION = require('./package.json').version;

// Einfaches Fenster-Limit je Quelladresse (gilt auch fuer fehlgeschlagene Anmeldungen)
function rateLimiter({ limit, windowMs = 60000, now = () => Date.now() }) {
  const hits = new Map();
  return (req, res, next) => {
    const t = now();
    const key = req.socket.remoteAddress || '?';
    let e = hits.get(key);
    if (!e || t - e.start >= windowMs) { e = { start: t, n: 0 }; hits.set(key, e); }
    e.n++;
    if (hits.size > 1000) for (const [k, v] of hits) if (t - v.start >= windowMs) hits.delete(k);
    if (e.n > limit) {
      res.set('Retry-After', String(Math.ceil((e.start + windowMs - t) / 1000)));
      return res.status(429).json({ error: 'Zu viele Anfragen, bitte kurz warten', code: 'rate_limited' });
    }
    next();
  };
}

function createApp({ dataDir, ha, ingressIps, getOptions, rateLimit = 120, now = () => Date.now() } = {}) {
  fs.mkdirSync(dataDir, { recursive: true });
  const store = new Store(dataDir);
  const audit = new Audit(dataDir, { now });
  const gateway = new Gateway({ ha, store, audit, now });

  const app = express();
  app.disable('x-powered-by');
  app.set('case sensitive routing', true);
  app.set('strict routing', true);

  // Ingress bleibt offen; direkter Port-Zugriff nur auf /api/v1/* mit X-API-Token.
  app.use('/api/v1', rateLimiter({ limit: rateLimit, now }));
  app.use(createAccessGate({ ingressIps, getOptions }));
  app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  app.use('/api/v1', express.json({ limit: '16kb' }), require('./routes/v1')({ gateway, ha, store, audit, now }));
  app.use('/api/ui', express.json({ limit: '2mb' }), require('./routes/ui')({ gateway, ha, store, audit }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.use((req, res, next) => next(new ApiError(404, 'not_found', 'Nicht gefunden')));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = 500, code = 'internal', message = 'Interner Fehler', extra = {};
    if (err instanceof ApiError) ({ status, code, message } = err), extra = err.extra || {};
    else if (err.type === 'entity.parse.failed') [status, code, message] = [400, 'invalid_json', 'Ungültiges JSON'];
    else if (err.type === 'entity.too.large') [status, code, message] = [413, 'body_too_large', 'Anfrage zu groß'];
    else if (err.status >= 400 && err.status < 500) [status, code, message] = [400, 'invalid_request', 'Ungültige Anfrage'];
    else console.error(err);
    res.status(status).json({ error: message, code, ...extra });
  });

  return { app, store, audit, gateway, close: () => audit.stop() };
}

function main() {
  const log = { warn: (m) => console.warn(m), info: (m) => console.log(m) };
  const ha = new HaClient({
    restUrl: process.env.HA_REST_URL || 'http://supervisor/core/api',
    wsUrl: process.env.HA_WS_URL || 'ws://supervisor/core/websocket',
    token: process.env.SUPERVISOR_TOKEN || '',
    log,
  });
  const ctx = createApp({ dataDir: process.env.DATA_DIR || '/data', ha });
  const port = process.env.PORT || 3003;
  const server = ctx.app.listen(port, () => console.log(`Jarvis Gateway ${VERSION} listening on :${port}`));
  ha.start();
  const stop = () => { ha.stop(); ctx.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

if (require.main === module) main();

module.exports = { createApp, rateLimiter };
