const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startGateway } = require('./helpers');

const NOW = Date.parse('2026-11-02T12:00:00Z');
let g;
const q = (p) => '/history?' + Object.entries(p).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
const rows = (...a) => a.map(([t, state]) => ({ state, last_changed: t }));
const H = (p) => g.api.get(q({ entity_id: 'sensor.temperatur', ...p }));

before(async () => { g = await startGateway({ now: () => NOW }); g.expose('sensor.temperatur', 'read'); g.expose('light.kueche', 'control'); });
after(async () => { await g.close(); });
beforeEach(() => { g.mock.history = {}; g.mock.historyRequests.length = 0; });

test('Zugriffsschutz: ohne Token 401, leeres api_token 403', async () => {
  assert.equal((await g.req('GET', '/api/v1' + q({ entity_id: 'sensor.temperatur' }), { token: null })).status, 401);
  assert.equal((await g.req('GET', '/api/v1' + q({ entity_id: 'sensor.temperatur' }), { token: 'falsch' })).status, 401);
  g.setToken('');
  assert.equal((await H({})).status, 403);
  g.setToken('test-api-token-123');
});

test('nicht freigegebene, ausgeschaltete und erratene Entitaeten: 403 not_exposed, HA wird nicht gefragt', async () => {
  g.expose('switch.steckdose', 'off');
  for (const id of ['light.flur', 'switch.steckdose', 'light.gibtsnicht', 'person.thomas']) {
    const r = await g.api.get(q({ entity_id: id }));
    assert.equal(r.status, 403, id);
    assert.equal(r.json.code, 'not_exposed');
  }
  assert.equal(g.mock.historyRequests.length, 0);
});

test('entity_id wird geprueft, Parameter validiert', async () => {
  for (const id of ['', 'SENSOR.x', 'sensor.a/../b', 'sensor.a&filter_entity_id=light.flur', 'all']) {
    const r = await g.api.get(q({ entity_id: id }));
    assert.equal(r.status, 400, id);
    assert.equal(r.json.code, 'invalid_entity_id');
  }
  assert.equal((await g.api.get('/history')).json.code, 'invalid_entity_id');
  assert.equal((await H({ interval: 'week' })).json.code, 'invalid_request');
  assert.equal((await H({ start: 'gestern' })).json.code, 'invalid_request');
  assert.equal((await H({ start: '2026-02-30' })).json.code, 'invalid_request');
  assert.equal((await H({ end: '2026-13-01' })).json.code, 'invalid_request');
  assert.equal((await H({ start: '2026-11-02T10:00:00Z', end: '2026-11-02T10:00:00Z' })).json.code, 'invalid_request');
  assert.equal((await H({ start: '2026-11-02T10:00:00Z', end: '2026-11-01T10:00:00Z' })).json.code, 'invalid_request');
  assert.equal((await g.api.get('/history?entity_id=sensor.temperatur&interval=raw&interval=day')).status, 400);
  assert.equal(g.mock.historyRequests.length, 0);
});

test('Zeitraum: Standard letzte 24 h, Maximum 31 Tage', async () => {
  const r = await H({});
  assert.equal(r.status, 200);
  const req = g.mock.historyRequests[0];
  assert.equal(req.start, '2026-11-01T12:00:00.000Z');
  assert.equal(req.query.end_time, '2026-11-02T12:00:00.000Z');
  assert.equal(req.query.filter_entity_id, 'sensor.temperatur');
  assert.ok('minimal_response' in req.query);
  assert.equal(req.query.significant_changes_only, '0');
  assert.equal(r.json.timezone, 'Europe/Berlin');

  assert.equal((await H({ start: '2026-10-02T12:00:00Z', end: '2026-11-02T12:00:00Z' })).status, 200, 'genau 31 Tage');
  const big = await H({ start: '2026-10-02T11:59:59Z', end: '2026-11-02T12:00:00Z' });
  assert.equal(big.status, 400);
  assert.equal(big.json.code, 'range_too_large');
  assert.equal((await H({ start: '2025-01-01' })).json.code, 'range_too_large');
});

test('Zeitangaben: Offset, Leerzeichen statt + (Query-Dekodierung), ohne Zone = Europe/Berlin', async () => {
  await g.api.get('/history?entity_id=sensor.temperatur&start=2026-11-02T10:00:00+01:00&end=2026-11-02T11:00:00%2B01:00');
  assert.equal(g.mock.historyRequests[0].start, '2026-11-02T09:00:00.000Z');
  assert.equal(g.mock.historyRequests[0].query.end_time, '2026-11-02T10:00:00.000Z');
  await H({ start: '2026-07-01', end: '2026-07-02T12:00' });
  assert.equal(g.mock.historyRequests[1].start, '2026-06-30T22:00:00.000Z', 'Sommerzeit +02:00');
  assert.equal(g.mock.historyRequests[1].query.end_time, '2026-07-02T10:00:00.000Z');
});

test('raw: Zustand/Zeitstempel ohne Attribute, Einheit im Kopf', async () => {
  g.mock.history['sensor.temperatur'] = rows(['2026-11-02T08:00:00Z', '20.5'], ['2026-11-02T09:30:00Z', 'unavailable'], ['2026-11-02T10:00:00Z', '21.0']);
  const r = await H({});
  assert.equal(r.status, 200);
  assert.equal(r.json.entity_id, 'sensor.temperatur');
  assert.equal(r.json.interval, 'raw');
  assert.equal(r.json.unit_of_measurement, '°C');
  assert.deepEqual(r.json.points, [
    { t: '2026-11-02T09:00:00+01:00', state: '20.5' },
    { t: '2026-11-02T10:30:00+01:00', state: 'unavailable' },
    { t: '2026-11-02T11:00:00+01:00', state: '21.0' },
  ]);
  assert.ok(!/attributes|friendly_name|entity_picture/.test(r.text));
});

test('Einheit nur, wenn das Attribut freigegeben ist; nicht numerische Domains liefern raw', async () => {
  g.expose('sensor.temperatur', 'read', { attributes: [] });
  assert.ok(!('unit_of_measurement' in (await H({})).json));
  g.expose('sensor.temperatur', 'read');
  g.mock.history['light.kueche'] = rows(['2026-11-02T08:00:00Z', 'on'], ['2026-11-02T09:00:00Z', 'off']);
  const r = await g.api.get(q({ entity_id: 'light.kueche' }));
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.points.map((p) => p.state), ['on', 'off']);
  const agg = await g.api.get(q({ entity_id: 'light.kueche', interval: 'hour' }));
  assert.equal(agg.status, 400);
  assert.equal(agg.json.code, 'not_numeric');
});

test('raw-Limit: 5000 Punkte gehen, 5001 -> 413 mit Hinweis', async () => {
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ state: String(i), last_changed: new Date(Date.parse('2026-11-02T00:00:00Z') + i * 1000).toISOString() }));
  g.mock.history['sensor.temperatur'] = mk(5000);
  const ok = await H({});
  assert.equal(ok.status, 200);
  assert.equal(ok.json.points.length, 5000);
  g.mock.history['sensor.temperatur'] = mk(5001);
  const r = await H({});
  assert.equal(r.status, 413);
  assert.equal(r.json.code, 'too_many_points');
  assert.match(r.json.error, /interval=hour/);
  assert.match(r.json.error, /interval=day/);
  const agg = await H({ interval: 'hour' });
  assert.equal(agg.status, 200, 'Aggregation ist nicht auf 5000 Rohpunkte begrenzt');
});

test('Stundenaggregation: min/max/mean/first/last/count, nicht numerische Zustaende ignoriert', async () => {
  g.mock.history['sensor.temperatur'] = rows(
    ['2026-11-02T08:05:00Z', '10'], ['2026-11-02T08:20:00Z', 'unavailable'], ['2026-11-02T08:30:00Z', '14'],
    ['2026-11-02T08:50:00Z', '12'], ['2026-11-02T08:55:00Z', 'unknown'], ['2026-11-02T10:10:00Z', '-3.5'],
  );
  const r = await H({ interval: 'hour' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.points, [
    { t: '2026-11-02T09:00:00+01:00', min: 10, max: 14, mean: 12, first: 10, last: 12, count: 3 },
    { t: '2026-11-02T11:00:00+01:00', min: -3.5, max: -3.5, mean: -3.5, first: -3.5, last: -3.5, count: 1 },
  ]);
  assert.equal(r.json.unit_of_measurement, '°C');
});

test('Tagesaggregation in Europe/Berlin (Winter: Tagesgrenze 23:00 UTC)', async () => {
  g.mock.history['sensor.temperatur'] = rows(
    ['2026-11-01T22:59:00Z', '1'], ['2026-11-01T23:00:00Z', '2'], ['2026-11-02T10:00:00Z', '4'],
  );
  const r = await H({ interval: 'day', start: '2026-11-01T12:00:00Z', end: '2026-11-02T22:00:00Z' });
  assert.deepEqual(r.json.points, [
    { t: '2026-11-01T00:00:00+01:00', min: 1, max: 1, mean: 1, first: 1, last: 1, count: 1 },
    { t: '2026-11-02T00:00:00+01:00', min: 2, max: 4, mean: 3, first: 2, last: 4, count: 2 },
  ]);
});

test('Zeitumstellung Fruehjahr (29.03.2026, Tag hat 23 h): Tagesfenster und Offsets', async () => {
  g.mock.history['sensor.temperatur'] = rows(
    ['2026-03-28T12:00:00Z', '1'],
    ['2026-03-28T23:30:00Z', '2'],  // 29.03. 00:30 +01:00
    ['2026-03-29T21:30:00Z', '3'],  // 29.03. 23:30 +02:00
    ['2026-03-29T22:30:00Z', '4'],  // 30.03. 00:30 +02:00
  );
  const r = await H({ interval: 'day', start: '2026-03-28', end: '2026-03-31' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.points.map((p) => [p.t, p.count, p.min, p.max]), [
    ['2026-03-28T00:00:00+01:00', 1, 1, 1],
    ['2026-03-29T00:00:00+01:00', 2, 2, 3],
    ['2026-03-30T00:00:00+02:00', 1, 4, 4],
  ]);
  assert.equal(r.json.start, '2026-03-28T00:00:00+01:00');
  assert.equal(r.json.end, '2026-03-31T00:00:00+02:00');
  assert.equal(g.mock.historyRequests[0].start, '2026-03-27T23:00:00.000Z');
  assert.equal(g.mock.historyRequests[0].query.end_time, '2026-03-30T22:00:00.000Z');
});

test('Zeitumstellung Herbst (25.10.2026, Tag hat 25 h): Tag und doppelte Stunde 02:00', async () => {
  g.mock.history['sensor.temperatur'] = rows(
    ['2026-10-24T21:59:00Z', '1'],  // 23:59 +02:00, 24.10.
    ['2026-10-24T22:00:00Z', '2'],  // 25.10. 00:00 +02:00
    ['2026-10-25T00:30:00Z', '5'],  // 02:30 +02:00
    ['2026-10-25T01:30:00Z', '7'],  // 02:30 +01:00 (zweite 02-Uhr-Stunde)
    ['2026-10-25T22:59:00Z', '9'],  // 25.10. 23:59 +01:00
    ['2026-10-25T23:00:00Z', '3'],  // 26.10. 00:00 +01:00
  );
  const day = await H({ interval: 'day', start: '2026-10-24', end: '2026-10-27' });
  assert.deepEqual(day.json.points.map((p) => [p.t, p.count, p.min, p.max]), [
    ['2026-10-24T00:00:00+02:00', 1, 1, 1],
    ['2026-10-25T00:00:00+02:00', 4, 2, 9],
    ['2026-10-26T00:00:00+01:00', 1, 3, 3],
  ]);
  const hour = await H({ interval: 'hour', start: '2026-10-25T00:00:00+02:00', end: '2026-10-26T00:00:00+01:00' });
  const labels = hour.json.points.map((p) => p.t);
  assert.ok(labels.includes('2026-10-25T02:00:00+02:00') && labels.includes('2026-10-25T02:00:00+01:00'), labels.join());
  assert.equal(new Set(labels).size, labels.length, 'doppelte Stunde bleibt getrennt');
});

test('leerer Verlauf und nur nicht numerische Zustaende: leere Liste, 200', async () => {
  for (const interval of ['raw', 'hour', 'day']) {
    const r = await H({ interval });
    assert.equal(r.status, 200, interval);
    assert.deepEqual(r.json.points, []);
  }
  g.mock.history['sensor.temperatur'] = rows(['2026-11-02T08:00:00Z', 'unavailable'], ['2026-11-02T09:00:00Z', 'unknown']);
  assert.deepEqual((await H({ interval: 'day' })).json.points, []);
});

test('Text in numerischem Verlauf: 400 not_numeric', async () => {
  g.mock.history['sensor.temperatur'] = rows(['2026-11-02T08:00:00Z', '3'], ['2026-11-02T09:00:00Z', 'abc']);
  const r = await H({ interval: 'day' });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, 'not_numeric');
});

test('Audit: genau ein Eintrag je Abfrage (read), auch bei Ablehnung, ohne Token', async () => {
  const before = g.ctx.audit.query({ action: 'read_history' }).total;
  await H({ interval: 'hour' });
  await g.api.get(q({ entity_id: 'light.flur' }));
  await H({ interval: 'week' });
  const a = g.ctx.audit.query({ action: 'read_history', limit: 10 });
  assert.equal(a.total, before + 3);
  const [bad, denied, ok] = a.items;
  assert.deepEqual([ok.result, ok.entity_id, ok.params.interval], ['ok', 'sensor.temperatur', 'hour']);
  assert.deepEqual([denied.result, denied.code], ['denied', 'not_exposed']);
  assert.deepEqual([bad.result, bad.code], ['denied', 'invalid_request']);
  assert.ok(!JSON.stringify(a.items).includes('test-api-token'));
  assert.ok(!JSON.stringify(a.items).includes(g.mock.token));
});

test('Rate-Limit gilt auch fuer /history', async () => {
  const g2 = await startGateway({ rateLimit: 3 });
  g2.expose('sensor.temperatur', 'read');
  const codes = [];
  for (let i = 0; i < 5; i++) codes.push((await g2.api.get(q({ entity_id: 'sensor.temperatur' }))).status);
  assert.deepEqual(codes, [200, 200, 200, 429, 429]);
  await g2.close();
});

test('HA-Ausfall: 503 ha_unavailable; Verlauf-Fehler von HA: 502 ohne Interna', async () => {
  g.mock.pause();
  await g.waitFor(() => !g.ha.connected);
  const r = await H({});
  assert.equal(r.status, 503);
  assert.equal(r.json.code, 'ha_unavailable');
  assert.ok(!r.text.includes(g.mock.token));
  g.mock.resume();
  await g.waitFor(() => g.ha.connected);
  assert.equal((await H({})).status, 200, 'danach wieder verfuegbar');

  const orig = g.ha.rest.bind(g.ha);
  g.ha.rest = async () => { const { HaError } = require('../lib/ha'); throw new HaError('x', { status: 500 }); };
  const e = await H({});
  g.ha.rest = async () => { const { HaError } = require('../lib/ha'); throw new HaError('x', { unavailable: true }); };
  const u = await H({});
  g.ha.rest = orig;
  assert.deepEqual([e.status, e.json.code], [502, 'ha_error']);
  assert.deepEqual([u.status, u.json.code], [503, 'ha_unavailable']);
});
