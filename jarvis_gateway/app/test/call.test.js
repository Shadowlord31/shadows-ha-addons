const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startGateway } = require('./helpers');

let g;
const clock = { t: Date.parse('2026-01-15T10:00:00Z') };
before(async () => { g = await startGateway({ now: () => clock.t }); });
after(async () => { await g.close(); });
beforeEach(() => {
  g.mock.serviceCalls.length = 0;
  g.mock.failServices = null;
  clock.t = Date.parse('2026-01-15T10:00:00Z');
  g.ctx.store.update((e) => { for (const k of Object.keys(e)) delete e[k]; });
});

const call = (body) => g.api.post('/call', { role: 'admin', ...body });
const noServiceCall = () => assert.equal(g.mock.serviceCalls.length, 0, 'es darf kein Servicecall erfolgen');

test('Erfolg: genau ein Servicecall, Ziel nur diese entity_id, state_after', async () => {
  g.expose('light.kueche');
  const r = await call({ entity_id: 'light.kueche', action: 'turn_on', params: { brightness_pct: 50 }, person: 'Thomas' });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.state_after.state, 'on');
  assert.deepEqual(g.mock.serviceCalls, [{ domain: 'light', service: 'turn_on', data: { entity_id: 'light.kueche', brightness_pct: 50 } }]);
});

test('Zusatzfelder (area_id, target, device_id, all) werden nie weitergereicht', async () => {
  g.expose('light.kueche');
  const r = await call({ entity_id: 'light.kueche', action: 'turn_off', area_id: 'wohnzimmer', target: { entity_id: 'all' }, device_id: 'x', service: 'homeassistant.restart', domain: 'homeassistant' });
  assert.equal(r.status, 200);
  assert.deepEqual(g.mock.serviceCalls, [{ domain: 'light', service: 'turn_off', data: { entity_id: 'light.kueche' } }]);
});

test('nicht freigegebene Entitaet: 403 not_exposed, existierend und erfunden sind nicht unterscheidbar', async () => {
  g.expose('light.kueche');
  const real = await call({ entity_id: 'switch.steckdose', action: 'turn_on' });
  const fake = await call({ entity_id: 'switch.gibt_es_nicht', action: 'turn_on' });
  const off = (g.expose('light.flur', 'off'), await call({ entity_id: 'light.flur', action: 'turn_on' }));
  for (const r of [real, fake, off]) { assert.equal(r.status, 403); assert.equal(r.json.code, 'not_exposed'); }
  assert.deepEqual(real.json, fake.json);
  const g1 = await g.api.get('/entities/switch.steckdose');
  const g2 = await g.api.get('/entities/switch.gibt_es_nicht');
  assert.equal(g1.status, 403);
  assert.deepEqual(g1.json, g2.json);
  noServiceCall();
});

test('Raten: all, Listen, Komma, Wildcards, Gross-/Sonderzeichen werden abgelehnt', async () => {
  g.expose('light.kueche');
  for (const id of ['all', 'light.all', 'light.kueche,light.flur', 'LIGHT.kueche', 'light.*', 'light.kueche ', '../x', 'light.', '.kueche', ['light.kueche'], 5, { a: 1 }]) {
    const r = await call({ entity_id: id, action: 'turn_off' });
    assert.ok([400, 403].includes(r.status), JSON.stringify(id));
    assert.ok(['invalid_entity_id', 'not_exposed'].includes(r.json.code), JSON.stringify(id) + ' -> ' + r.json.code);
  }
  noServiceCall();
});

test('read_only: Entitaet nur lesbar', async () => {
  g.expose('light.kueche', 'read');
  const r = await call({ entity_id: 'light.kueche', action: 'turn_on' });
  assert.equal(r.status, 403);
  assert.equal(r.json.code, 'read_only');
  noServiceCall();
});

test('action_not_allowed: abgewaehlt, unbekannt, fremde Domain, Servicename', async () => {
  const cfg = require('../lib/config').defaultConfig('light.kueche');
  cfg.actions.toggle.enabled = false;
  g.expose('light.kueche', 'control', { actions: cfg.actions });
  for (const action of ['toggle', 'press', 'lock', 'light.turn_on', 'homeassistant.restart', 'toString', '__proto__', 'constructor']) {
    const r = await call({ entity_id: 'light.kueche', action });
    assert.equal(r.status, 403, action);
    assert.equal(r.json.code, 'action_not_allowed', action);
  }
  noServiceCall();
});

test('Parameter: unbekannt, fehlend, falscher Typ', async () => {
  g.expose(['light.kueche', 'climate.wohnzimmer', 'media_player.tv']);
  const cases = [
    [{ entity_id: 'light.kueche', action: 'turn_on', params: { transition: 5 } }, 'unknown_param'],
    [{ entity_id: 'light.kueche', action: 'turn_on', params: { entity_id: 'light.flur' } }, 'unknown_param'],
    [{ entity_id: 'light.kueche', action: 'turn_on', params: { access_token: 'x' } }, 'unknown_param'],
    [{ entity_id: 'light.kueche', action: 'turn_off', params: { brightness_pct: 5 } }, 'unknown_param'],
    [{ entity_id: 'light.kueche', action: 'turn_on', params: { __proto__: 1, constructor: 2 } }, null],
    [{ entity_id: 'climate.wohnzimmer', action: 'set_temperature', params: {} }, 'missing_param'],
    [{ entity_id: 'light.kueche', action: 'turn_on', params: { brightness_pct: '50' } }, 'invalid_param'],
    [{ entity_id: 'light.kueche', action: 'turn_on', params: { brightness_pct: 50.5 } }, 'invalid_param'],
    [{ entity_id: 'light.kueche', action: 'turn_on', params: { brightness_pct: null } }, 'invalid_param'],
    [{ entity_id: 'light.kueche', action: 'turn_on', params: { brightness_pct: [50] } }, 'invalid_param'],
    [{ entity_id: 'light.kueche', action: 'turn_on', params: { rgb_color: [1, 2] } }, 'invalid_param'],
    [{ entity_id: 'light.kueche', action: 'turn_on', params: { rgb_color: [1, 2, '3'] } }, 'invalid_param'],
    [{ entity_id: 'light.kueche', action: 'turn_on', params: { rgb_color: [1, 2, 3], color_temp_kelvin: 3000 } }, 'invalid_param'],
    [{ entity_id: 'media_player.tv', action: 'volume_mute', params: { mute: 'true' } }, 'invalid_param'],
    [{ entity_id: 'climate.wohnzimmer', action: 'set_temperature', params: { temperature: '21' } }, 'invalid_param'],
    [{ entity_id: 'light.kueche', action: 'turn_on', params: [] }, 'invalid_request'],
  ];
  for (const [body, code] of cases) {
    const r = await call(body);
    if (code === null) { assert.equal(r.status, 400); continue; }
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(r.json.code, code, JSON.stringify(body));
  }
  noServiceCall();
});

test('Wertegrenzen: nie stillschweigend geklemmt, Grenzen pro Entitaet', async () => {
  const cfg = require('../lib/config').defaultConfig('light.kueche');
  cfg.actions.turn_on.limits.brightness_pct = { min: 10, max: 80 };
  g.expose('light.kueche', 'control', { actions: cfg.actions });
  for (const v of [0, 5, 81, 100, -1, 1000]) {
    const r = await call({ entity_id: 'light.kueche', action: 'turn_on', params: { brightness_pct: v } });
    assert.equal(r.status, 400, String(v));
    assert.equal(r.json.code, 'value_out_of_range', String(v));
    assert.deepEqual([r.json.min, r.json.max], [10, 80]);
  }
  noServiceCall();
  for (const v of [10, 45, 80]) assert.equal((await call({ entity_id: 'light.kueche', action: 'turn_on', params: { brightness_pct: v } })).status, 200);
  assert.deepEqual(g.mock.serviceCalls.map((c) => c.data.brightness_pct), [10, 45, 80]);
});

test('Wertegrenzen: Klima aus Entitaets-Grenzen, Lautstaerke-Maximum, Cover, rgb, Auswahlwerte', async () => {
  const { defaultConfig } = require('../lib/config');
  const tv = defaultConfig('media_player.tv'); tv.actions.volume_set.limits.volume_pct = { min: 0, max: 40 };
  g.expose(['climate.wohnzimmer', 'cover.rollo', 'input_select.modus', 'input_number.ziel', 'light.kueche']);
  g.expose('media_player.tv', 'control', { actions: tv.actions });
  const bad = [
    ['climate.wohnzimmer', 'set_temperature', { temperature: 30 }],
    ['climate.wohnzimmer', 'set_temperature', { temperature: 6.9 }],
    ['climate.wohnzimmer', 'set_hvac_mode', { hvac_mode: 'cool' }],
    ['climate.wohnzimmer', 'set_hvac_mode', { hvac_mode: 'heat_cool' }],
    ['climate.wohnzimmer', 'set_preset_mode', { preset_mode: 'boost' }],
    ['media_player.tv', 'volume_set', { volume_pct: 41 }],
    ['cover.rollo', 'set_cover_position', { position: 101 }],
    ['cover.rollo', 'set_cover_position', { position: -1 }],
    ['input_select.modus', 'select_option', { option: 'Hacker' }],
    ['input_number.ziel', 'set_value', { value: 51 }],
    ['input_number.ziel', 'set_value', { value: -1 }],
    ['light.kueche', 'turn_on', { rgb_color: [256, 0, 0] }],
    ['light.kueche', 'turn_on', { color_temp_kelvin: 500 }],
  ];
  for (const [entity_id, action, params] of bad) {
    const r = await call({ entity_id, action, params });
    assert.equal(r.status, 400, entity_id + JSON.stringify(params));
    assert.equal(r.json.code, 'value_out_of_range', entity_id + JSON.stringify(params));
  }
  noServiceCall();
  const good = [
    ['climate.wohnzimmer', 'set_temperature', { temperature: 21.5 }],
    ['climate.wohnzimmer', 'set_hvac_mode', { hvac_mode: 'auto' }],
    ['media_player.tv', 'volume_set', { volume_pct: 40 }],
    ['cover.rollo', 'set_cover_position', { position: 40 }],
    ['input_select.modus', 'select_option', { option: 'Urlaub' }],
    ['input_number.ziel', 'set_value', { value: 7.5 }],
  ];
  for (const [entity_id, action, params] of good) assert.equal((await call({ entity_id, action, params })).status, 200, entity_id);
  assert.equal(g.mock.serviceCalls.find((c) => c.service === 'volume_set').data.volume_level, 0.4);
});

test('Rolle: Mindestrolle der Entitaet und der Aktion wird erzwungen', async () => {
  g.expose('light.kueche', 'control', { min_role: 'erwachsen' });
  g.expose('switch.steckdose', 'control', { min_role: 'admin' });
  g.expose('light.flur'); // alle
  const ok = { entity_id: 'light.kueche', action: 'turn_on' };
  for (const role of ['kind', 'unbekannt']) {
    const r = await call({ ...ok, role });
    assert.equal(r.status, 403); assert.equal(r.json.code, 'role_too_low');
  }
  assert.equal((await call({ ...ok, role: 'erwachsen' })).status, 200);
  assert.equal((await call({ ...ok, role: 'admin' })).status, 200);
  assert.equal((await call({ entity_id: 'switch.steckdose', action: 'turn_on', role: 'erwachsen' })).json.code, 'role_too_low');
  assert.equal((await call({ entity_id: 'switch.steckdose', action: 'turn_on', role: 'admin' })).status, 200);
  assert.equal((await call({ entity_id: 'light.flur', action: 'turn_on', role: 'unbekannt' })).status, 200);
  // ohne Rolle = unbekannt, ungueltige Rolle wird abgelehnt
  assert.equal((await g.api.post('/call', { ...ok })).json.code, 'role_too_low');
  assert.equal((await call({ ...ok, role: 'root' })).status, 400);
});

test('Standard Schloss: Rueckfrage 2, Mindestrolle erwachsen, unlock nur erwachsen/admin', async () => {
  const { defaultConfig } = require('../lib/config');
  const d = defaultConfig('lock.haustuer');
  assert.equal(d.confirm, 2); assert.equal(d.min_role, 'erwachsen'); assert.equal(d.actions.unlock.min_role, 'erwachsen');
  g.expose('lock.haustuer');
  assert.equal((await call({ entity_id: 'lock.haustuer', action: 'unlock', role: 'kind' })).json.code, 'role_too_low');
  assert.equal((await call({ entity_id: 'lock.haustuer', action: 'lock', role: 'kind' })).json.code, 'role_too_low');
  assert.equal((await call({ entity_id: 'lock.haustuer', action: 'unlock', role: 'erwachsen' })).status, 200);
  assert.equal((await call({ entity_id: 'lock.haustuer', action: 'lock', role: 'admin' })).status, 200);
  const e = (await g.api.get('/entities/lock.haustuer')).json;
  assert.equal(e.confirm, 2); assert.equal(e.min_role, 'erwachsen');
});

test('Aktion-spezifische Mindestrolle hat Vorrang vor niedrigerer Entitaets-Rolle', async () => {
  const { defaultConfig } = require('../lib/config');
  const c = defaultConfig('light.kueche'); c.actions.toggle.min_role = 'admin';
  g.expose('light.kueche', 'control', { actions: c.actions });
  assert.equal((await call({ entity_id: 'light.kueche', action: 'toggle', role: 'erwachsen' })).json.code, 'role_too_low');
  assert.equal((await call({ entity_id: 'light.kueche', action: 'toggle', role: 'admin' })).status, 200);
  assert.equal((await call({ entity_id: 'light.kueche', action: 'turn_on', role: 'kind' })).status, 200);
});

test('Sperrzeit: ueber Mitternacht, Europe/Berlin inkl. Sommerzeit, Lesen bleibt erlaubt', async () => {
  g.expose('light.kueche', 'control', { quiet: { from: '22:00', to: '06:00' } });
  const at = (iso) => { clock.t = Date.parse(iso); };
  const c = () => call({ entity_id: 'light.kueche', action: 'turn_on' });
  at('2026-01-15T22:30:00Z'); // 23:30 MEZ
  let r = await c(); assert.equal(r.status, 403); assert.equal(r.json.code, 'quiet_hours');
  at('2026-01-15T21:00:00Z'); // 22:00 MEZ -> gesperrt (Beginn inklusive)
  assert.equal((await c()).json.code, 'quiet_hours');
  at('2026-01-15T20:59:00Z'); // 21:59 MEZ
  assert.equal((await c()).status, 200);
  at('2026-01-16T04:59:00Z'); // 05:59 MEZ
  assert.equal((await c()).json.code, 'quiet_hours');
  at('2026-01-16T05:00:00Z'); // 06:00 MEZ -> frei (Ende exklusiv)
  assert.equal((await c()).status, 200);
  at('2026-07-15T19:30:00Z'); // 21:30 MESZ
  assert.equal((await c()).status, 200);
  at('2026-07-15T20:30:00Z'); // 22:30 MESZ -> gesperrt (UTC allein waere noch frei)
  assert.equal((await c()).json.code, 'quiet_hours');
  assert.equal((await g.api.get('/entities/light.kueche')).status, 200);
  assert.deepEqual((await g.api.get('/entities/light.kueche')).json.quiet, { from: '22:00', to: '06:00' });
});

test('Sperrzeit am Tag (von < bis)', async () => {
  g.expose('light.kueche', 'control', { quiet: { from: '13:00', to: '15:00' } });
  clock.t = Date.parse('2026-01-15T12:30:00Z'); // 13:30
  assert.equal((await call({ entity_id: 'light.kueche', action: 'turn_on' })).json.code, 'quiet_hours');
  clock.t = Date.parse('2026-01-15T14:00:00Z'); // 15:00
  assert.equal((await call({ entity_id: 'light.kueche', action: 'turn_on' })).status, 200);
});

test('Pruefreihenfolge: freigegeben > read_only > Aktion > Parameter > Grenzen > Rolle > Sperrzeit', async () => {
  const { defaultConfig } = require('../lib/config');
  const c = defaultConfig('light.kueche'); c.actions.toggle.enabled = false;
  g.expose('light.kueche', 'control', { actions: c.actions, min_role: 'admin', quiet: { from: '00:00', to: '23:59' } });
  const b = { entity_id: 'light.kueche', role: 'kind' };
  assert.equal((await call({ ...b, entity_id: 'light.flur', action: 'nope', params: { x: 1 } })).json.code, 'not_exposed');
  assert.equal((await call({ ...b, action: 'toggle', params: { x: 1 } })).json.code, 'action_not_allowed');
  assert.equal((await call({ ...b, action: 'turn_on', params: { x: 1 } })).json.code, 'unknown_param');
  assert.equal((await call({ ...b, action: 'turn_on', params: { brightness_pct: 'a' } })).json.code, 'invalid_param');
  assert.equal((await call({ ...b, action: 'turn_on', params: { brightness_pct: 500 } })).json.code, 'value_out_of_range');
  assert.equal((await call({ ...b, action: 'turn_on', params: { brightness_pct: 5 } })).json.code, 'role_too_low');
  assert.equal((await call({ ...b, role: 'admin', action: 'turn_on', params: { brightness_pct: 5 } })).json.code, 'quiet_hours');
  g.expose('light.kueche', 'read');
  assert.equal((await call({ ...b, action: 'toggle' })).json.code, 'read_only');
  noServiceCall();
});

test('Fehlermeldungen sind deutsch und JSON mit error+code', async () => {
  g.expose('light.kueche');
  const r = await call({ entity_id: 'light.kueche', action: 'turn_on', params: { brightness_pct: 500 } });
  assert.match(r.json.error, /außerhalb des erlaubten Bereichs/);
  assert.match((await call({ entity_id: 'switch.steckdose', action: 'turn_on' })).json.error, /nicht freigegeben/);
  assert.equal((await call({ entity_id: 'light.kueche' })).json.code, 'invalid_request');
  assert.equal((await call({ action: 'turn_on' })).json.code, 'invalid_request');
});

test('Namensaufloesung: Name, Alias, Umlaute/Gross-Klein, Raum, Mehrdeutigkeit, unbekannt', async () => {
  g.expose(['light.kueche', 'light.lampe_a', 'light.lampe_b', 'light.wohnzimmer'], 'control');
  g.expose('light.flur', 'control', { aliases: ['Eingang', 'Diele'], name: 'Flurlicht' });
  const ok = async (body, id) => {
    const r = await call({ action: 'turn_off', ...body });
    assert.equal(r.status, 200, JSON.stringify(body) + r.text);
    assert.equal(r.json.entity_id, id);
  };
  await ok({ name: 'Küche Licht' }, 'light.kueche');
  await ok({ name: 'kuche licht' }, 'light.kueche');
  await ok({ name: '  KÜCHE   LICHT ' }, 'light.kueche');
  await ok({ name: 'Flurlicht' }, 'light.flur');
  await ok({ name: 'diele' }, 'light.flur');
  await ok({ name: 'Lampe', room: 'Küche' }, 'light.lampe_b');
  await ok({ name: 'Lampe', room: 'wohnzimmer' }, 'light.lampe_a');

  const amb = await call({ name: 'Lampe', action: 'turn_off' });
  assert.equal(amb.status, 409);
  assert.equal(amb.json.code, 'ambiguous_name');
  assert.deepEqual(amb.json.candidates.map((c) => c.entity_id).sort(), ['light.lampe_a', 'light.lampe_b']);
  assert.ok(amb.json.candidates.every((c) => c.area));
  const nf = await call({ name: 'Wohnzimmer', action: 'turn_off' });
  assert.equal(nf.status, 404);
  assert.ok(nf.json.suggestions.some((s) => s.entity_id === 'light.wohnzimmer'));
  // nicht freigegebene Entitaeten sind per Name nicht auffindbar
  const hidden = await call({ name: 'Steckdose', action: 'turn_on' });
  assert.equal(hidden.status, 404);
  assert.equal(hidden.json.suggestions.length, 0);
  // entity_id hat Vorrang vor name
  assert.equal((await call({ entity_id: 'light.kueche', name: 'Lampe', action: 'turn_off' })).json.entity_id, 'light.kueche');
  // GET per Name
  assert.equal((await g.api.get('/entities/' + encodeURIComponent('Küche Licht'))).json.entity_id, 'light.kueche');
  assert.equal((await g.api.get('/entities/Lampe')).status, 409);
  assert.equal((await g.api.get('/entities/Lampe?area=K%C3%BCche')).json.entity_id, 'light.lampe_b');
});

test('HA lehnt ab: 502 ha_error ohne HA-Details, Protokoll result=error', async () => {
  g.expose('light.kueche');
  g.mock.failServices = 500;
  const r = await call({ entity_id: 'light.kueche', action: 'turn_on' });
  assert.equal(r.status, 502);
  assert.equal(r.json.code, 'ha_error');
  assert.ok(!r.text.includes('geheime'));
  assert.equal(g.ctx.audit.query({ result: 'error' }).total, 1);
});

test('parallele Calls: jeder genau ein Servicecall, richtige Ziele, passendes state_after', async () => {
  g.expose(['light.kueche', 'light.flur', 'light.wohnzimmer']);
  g.mock.serviceDelayMs = 20;
  try {
    const ids = ['light.kueche', 'light.flur', 'light.wohnzimmer'];
    const jobs = [];
    for (let i = 1; i <= 12; i++) jobs.push({ entity_id: ids[i % 3], pct: i * 8 });
    const res = await Promise.all(jobs.map((j) => call({ entity_id: j.entity_id, action: 'turn_on', params: { brightness_pct: j.pct }, person: 'P' + j.pct })));
    res.forEach((r, i) => {
      assert.equal(r.status, 200);
      assert.equal(r.json.entity_id, jobs[i].entity_id);
      assert.equal(r.json.state_after.attributes.brightness_pct, jobs[i].pct, 'state_after gehoert zum eigenen Aufruf');
    });
    assert.equal(g.mock.serviceCalls.length, 12);
    for (const j of jobs) assert.equal(g.mock.serviceCalls.filter((c) => c.data.entity_id === j.entity_id && c.data.brightness_pct === j.pct).length, 1);
    assert.ok(g.mock.serviceCalls.every((c) => Object.keys(c.data).length === 2));
    const log = g.ctx.audit.query({ result: 'ok', person: 'P', limit: 100 });
    assert.equal(log.total, 12);
    assert.equal(new Set(log.items.map((e) => e.person)).size, 12);
  } finally { g.mock.serviceDelayMs = 0; }
});

test('parallele gemischte Calls: Ablehnungen verbrauchen keinen Servicecall', async () => {
  g.expose('light.kueche', 'control', { min_role: 'erwachsen' });
  const res = await Promise.all([
    call({ entity_id: 'light.kueche', action: 'turn_on', role: 'kind' }),
    call({ entity_id: 'light.kueche', action: 'turn_on', role: 'admin' }),
    call({ entity_id: 'switch.steckdose', action: 'turn_on' }),
    call({ entity_id: 'light.kueche', action: 'turn_off', role: 'erwachsen' }),
    call({ entity_id: 'light.kueche', action: 'turn_on', params: { brightness_pct: 101 } }),
  ]);
  assert.deepEqual(res.map((r) => r.status), [403, 200, 403, 200, 400]);
  assert.equal(g.mock.serviceCalls.length, 2);
});
