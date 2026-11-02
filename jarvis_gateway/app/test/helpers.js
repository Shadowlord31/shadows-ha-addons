const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { MockHa } = require('./mock-ha');
const { HaClient } = require('../lib/ha');
const { createApp } = require('../server');
const { defaultConfig, normalizeConfig } = require('../lib/config');

const API_TOKEN = 'test-api-token-123';

async function waitFor(fn, ms = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error('Zeitüberschreitung beim Warten');
}

// Startet Mock-HA + Gateway auf 127.0.0.1. ingress=true: 127.0.0.1 gilt als Supervisor-Gateway.
async function startGateway({ ingress = false, apiToken = API_TOKEN, rateLimit = 1000, now, seed = true, extra = false, configure = true, dataDir } = {}) {
  const mock = new MockHa();
  if (seed) mock.seed();
  if (extra) mock.seedExtra();
  await mock.start();
  const dir = dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'jgw-'));
  const optionsPath = path.join(dir, 'options.json');
  const setToken = (t) => fs.writeFileSync(optionsPath, JSON.stringify({ api_token: t }));
  setToken(apiToken);
  const ha = new HaClient({ restUrl: mock.restUrl, wsUrl: mock.wsUrl, token: mock.token, reconnectMinMs: 20, reconnectMaxMs: 100, heartbeatMs: 200, requestTimeoutMs: 2000, log: { warn() {}, info() {} } });
  const ctx = createApp({
    dataDir: path.join(dir, 'data'),
    ha,
    ingressIps: ingress ? ['127.0.0.1'] : ['172.30.32.2'],
    getOptions: () => JSON.parse(fs.readFileSync(optionsPath, 'utf8')),
    rateLimit,
    now,
  });
  const server = await new Promise((r) => { const s = ctx.app.listen(0, '127.0.0.1', () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  ha.start();
  await waitFor(() => ha.connected);

  async function req(method, p, { body, token = API_TOKEN, headers = {}, raw } = {}) {
    const h = { ...headers };
    if (token !== null) h['X-API-Token'] = token;
    if (body !== undefined && !raw) h['Content-Type'] = 'application/json';
    const res = await fetch(base + p, { method, headers: h, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* kein JSON */ }
    return { status: res.status, json, text, headers: res.headers };
  }

  const api = {
    get: (p, o) => req('GET', '/api/v1' + p, o),
    post: (p, body, o) => req('POST', '/api/v1' + p, { body, ...o }),
  };
  const ui = {
    get: (p) => req('GET', '/api/ui' + p, { token: null }),
    put: (p, body) => req('PUT', '/api/ui' + p, { body, token: null }),
    post: (p, body) => req('POST', '/api/ui' + p, { body, token: null }),
    del: (p) => req('DELETE', '/api/ui' + p, { token: null }),
  };

  // Entitaeten freigeben: schreibt direkt in den Store (geht auch, wenn der Port-Zugriff die UI-API sperrt)
  function expose(ids, access = 'control', patch = {}) {
    ctx.store.update((ents) => {
      for (const id of [].concat(ids)) {
        const attrs = ha.states.get(id)?.attributes;
        ents[id] = normalizeConfig(id, { ...defaultConfig(id, attrs), access, ...patch }, attrs);
      }
    });
  }

  async function close() {
    ha.stop();
    ctx.close();
    await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
    await mock.stop();
  }

  return { mock, ha, ctx, base, dir, req, api, ui, expose, setToken, close, waitFor };
}

function rawRequest(base, p, { method = 'GET', headers = {}, body } = {}) {
  const u = new URL(base);
  return new Promise((resolve, reject) => {
    const r = http.request({ host: u.hostname, port: u.port, path: p, method, headers }, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => resolve({ status: res.statusCode, text: d }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

module.exports = { startGateway, waitFor, rawRequest, API_TOKEN };
