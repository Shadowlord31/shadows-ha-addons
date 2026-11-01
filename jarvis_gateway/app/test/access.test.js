const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startGateway, rawRequest, API_TOKEN } = require('./helpers');
const { tokensEqual } = require('../middleware/access');

let direct, ingress;
before(async () => {
  direct = await startGateway();
  ingress = await startGateway({ ingress: true });
});
after(async () => { await direct.close(); await ingress.close(); });

test('direkt: ohne Token 401 mit JSON {error, code}', async () => {
  const r = await direct.api.get('/health', { token: null });
  assert.equal(r.status, 401);
  assert.equal(r.json.code, 'unauthorized');
  assert.ok(r.json.error);
});

test('direkt: falsches Token 401, auch bei gleicher Laenge', async () => {
  assert.equal((await direct.api.get('/health', { token: 'falsch' })).status, 401);
  assert.equal((await direct.api.get('/health', { token: API_TOKEN.replace(/.$/, 'X') })).status, 401);
  assert.equal((await direct.api.get('/health', { token: '' })).status, 401);
});

test('direkt: richtiges Token funktioniert', async () => {
  const r = await direct.api.get('/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.ha_connected, true);
});

test('direkt: leeres api_token in der Konfiguration -> 403, auch mit Header', async () => {
  direct.setToken('');
  try {
    for (const token of [null, '', 'irgendwas', API_TOKEN]) {
      const r = await direct.api.get('/health', { token });
      assert.equal(r.status, 403);
      assert.equal(r.json.code, 'no_token_configured');
    }
  } finally { direct.setToken(API_TOKEN); }
  direct.setToken('   ');
  assert.equal((await direct.api.get('/health', { token: '   ' })).status, 403);
  direct.setToken(API_TOKEN);
});

test('direkt: Oberflaeche und UI-API sind gesperrt, auch mit gueltigem Token', async () => {
  for (const p of ['/', '/index.html', '/api/ui/state', '/api/ui/export', '/api/ui/meta']) {
    const r = await direct.req('GET', p);
    assert.equal(r.status, 401, p);
  }
  assert.equal((await direct.req('PUT', '/api/ui/entity/light.kueche', { body: {} })).status, 401);
  assert.equal((await direct.req('GET', '/API/V1/health')).status, 401);
});

test('direkt: Pfad-Tricks fuehren nicht in die UI-API', async () => {
  const r = await rawRequest(direct.base, '/api/v1/../ui/state', { headers: { 'X-API-Token': API_TOKEN } });
  assert.equal(r.status, 404);
  assert.ok(!r.text.includes('entities'));
});

test('direkt: gefaelschte Ingress-/Remote-User-Header ersetzen das Token nicht', async () => {
  const r = await direct.api.get('/health', { token: null, headers: { 'X-Ingress-Path': '/api/hassio_ingress/abc', 'X-Remote-User-Id': 'x', 'X-Forwarded-For': '172.30.32.2' } });
  assert.equal(r.status, 401);
  const ui = await direct.req('GET', '/api/ui/state', { token: null, headers: { 'X-Remote-User-Id': 'x', 'X-Forwarded-For': '172.30.32.2' } });
  assert.equal(ui.status, 401);
});

test('Ingress: Oberflaeche, UI-API und v1 ohne Token offen', async () => {
  const page = await ingress.req('GET', '/', { token: null });
  assert.equal(page.status, 200);
  assert.match(page.text, /Jarvis Gateway/);
  assert.equal((await ingress.ui.get('/state')).status, 200);
  assert.equal((await ingress.api.get('/health', { token: null })).status, 200);
});

test('tokensEqual: zeitkonstanter Vergleich, keine Exception bei unterschiedlicher Laenge', () => {
  assert.equal(tokensEqual('a', 'a'), true);
  assert.equal(tokensEqual('a', 'ab'), false);
  assert.equal(tokensEqual('', 'x'), false);
});

test('Antworten enthalten nie Supervisor-/API-Token', async () => {
  await direct.expose('light.kueche');
  const texts = [
    (await direct.api.get('/health')).text,
    (await direct.api.get('/entities')).text,
    (await direct.api.get('/entities/light.kueche')).text,
    (await direct.api.post('/call', { entity_id: 'light.kueche', action: 'turn_on', role: 'admin' })).text,
    (await direct.api.post('/call', { entity_id: 'light.kueche', action: 'nope', role: 'admin' })).text,
    (await direct.ui.get('/state')).text,
  ];
  for (const t of texts) {
    assert.ok(!t.includes(direct.mock.token));
    assert.ok(!t.includes(API_TOKEN));
  }
});

test('Body-Limit, ungueltiges JSON und falsche Formen liefern JSON-Fehler', async () => {
  const big = await direct.api.post('/call', { entity_id: 'light.kueche', action: 'turn_on', params: { x: 'a'.repeat(20000) } });
  assert.equal(big.status, 413);
  assert.equal(big.json.code, 'body_too_large');
  const bad = await direct.req('POST', '/api/v1/call', { raw: '{kaputt', headers: { 'Content-Type': 'application/json' } });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, 'invalid_json');
  const arr = await direct.api.post('/call', [1, 2]);
  assert.equal(arr.status, 400);
  const txt = await direct.req('POST', '/api/v1/call', { raw: 'hallo', headers: { 'Content-Type': 'text/plain' } });
  assert.equal(txt.status, 400);
  assert.equal(txt.json.code, 'invalid_request');
  const nf = await direct.api.get('/gibtsnicht');
  assert.equal(nf.status, 404);
  assert.equal(nf.json.code, 'not_found');
});

test('Rate-Limit: ab dem Limit 429, auch fuer falsche Tokens', async () => {
  const g = await startGateway({ rateLimit: 5 });
  try {
    const codes = [];
    for (let i = 0; i < 7; i++) codes.push((await g.api.get('/health', { token: i % 2 ? 'falsch' : API_TOKEN })).status);
    assert.deepEqual(codes.slice(0, 5), [200, 401, 200, 401, 200]);
    assert.deepEqual(codes.slice(5), [429, 429]);
    const r = await g.api.get('/health');
    assert.equal(r.json.code, 'rate_limited');
  } finally { await g.close(); }
});
