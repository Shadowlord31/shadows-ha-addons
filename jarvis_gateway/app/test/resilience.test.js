const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startGateway } = require('./helpers');

let g;
before(async () => { g = await startGateway({ ingress: true }); g.expose(['light.kueche', 'sensor.temperatur']); });
after(async () => { await g.close(); });

test('HA-Ausfall wird sauber gemeldet, Wiederaufbau automatisch, Zustand danach aktuell', async () => {
  assert.deepEqual((await g.api.get('/health')).json, { ok: true, ha_connected: true, ha_version: '2025.1.0-mock', entities_exposed: 2 });

  g.mock.pause();
  await g.waitFor(() => !g.ha.connected);

  const h = await g.api.get('/health');
  assert.equal(h.status, 200);
  assert.equal(h.json.ok, false);
  assert.equal(h.json.ha_connected, false);

  for (const r of [await g.api.get('/entities'), await g.api.get('/entities/light.kueche'), await g.api.post('/call', { entity_id: 'light.kueche', action: 'turn_on', role: 'admin' })]) {
    assert.equal(r.status, 503);
    assert.equal(r.json.code, 'ha_unavailable');
    assert.ok(!r.text.includes(g.mock.token));
  }
  assert.equal(g.mock.serviceCalls.length, 0);

  const cfg = (await g.ui.get('/entity/light.kueche')).json.config;
  const put = await g.ui.put('/entity/light.kueche', cfg);
  assert.equal(put.status, 503);
  assert.equal((await g.ui.get('/state')).json.ha_connected, false);
  assert.equal((await g.ui.get('/export')).status, 200, 'Export geht auch ohne HA');

  g.mock.setState('light.kueche', 'on'); // waehrend des Ausfalls geaendert
  g.mock.resume();
  await g.waitFor(() => g.ha.connected);

  assert.equal((await g.api.get('/health')).json.ok, true);
  assert.equal((await g.api.get('/entities/light.kueche')).json.state, 'on', 'Zustand nach Reconnect neu geladen');
  const c = await g.api.post('/call', { entity_id: 'light.kueche', action: 'turn_off', role: 'admin' });
  assert.equal(c.status, 200);
  assert.equal(c.json.state_after.state, 'off');
});

test('abgerissene Verbindung (ohne Ausfall des Dienstes) wird neu aufgebaut', async () => {
  g.mock.dropConnections();
  await g.waitFor(() => !g.ha.connected || g.mock.sockets.size > 0);
  await g.waitFor(() => g.ha.connected && g.mock.sockets.size > 0);
  g.mock.setState('sensor.temperatur', '19.9');
  await g.waitFor(() => g.ha.states.get('sensor.temperatur').state === '19.9');
  assert.equal((await g.api.get('/entities/sensor.temperatur')).json.state, '19.9', 'Events kommen nach Reconnect wieder an');
});

test('Dienst-Call scheitert in HA: 502 ohne HA-Interna, Protokoll vermerkt Fehler', async () => {
  const before = (await g.ui.get('/audit?result=error')).json.total;
  g.mock.failServices = 500;
  const r = await g.api.post('/call', { entity_id: 'light.kueche', action: 'turn_on', role: 'admin' });
  g.mock.failServices = null;
  assert.equal(r.status, 502);
  assert.equal(r.json.code, 'ha_error');
  assert.ok(!r.text.includes('geheime Interna'));
  assert.equal((await g.ui.get('/audit?result=error')).json.total, before + 1);
});

test('Entitaet in HA entfernt: 404 entity_missing statt Absturz', async () => {
  g.mock.removeState('light.kueche');
  await g.waitFor(() => !g.ha.states.has('light.kueche'));
  const r = await g.api.post('/call', { entity_id: 'light.kueche', action: 'turn_on', role: 'admin' });
  assert.ok([403, 404].includes(r.status), String(r.status));
  assert.ok((await g.ui.get('/state')).json.missing.includes('light.kueche'));
});
