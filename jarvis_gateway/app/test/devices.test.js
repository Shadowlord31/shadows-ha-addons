const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startGateway } = require('./helpers');
const { normalizeConfig, defaultConfig, ValidationError } = require('../lib/config');

let g;
const clock = { t: Date.parse('2026-01-15T10:00:00Z') };
before(async () => { g = await startGateway({ ingress: true, extra: true, now: () => clock.t }); });
after(async () => { await g.close(); });
beforeEach(() => {
  g.mock.serviceCalls.length = 0;
  g.mock.failServices = null;
  g.auditBase = auditTotal();
  clock.t = Date.parse('2026-01-15T10:00:00Z');
  g.ctx.store.update((e) => { for (const k of Object.keys(e)) delete e[k]; });
});

const call = (body) => g.api.post('/call', { role: 'admin', ...body });
const many = (body) => g.api.post('/call_many', { role: 'admin', ...body });
const auditTotal = () => g.ctx.audit.query({ limit: 1 }).total;
const newLog = () => g.ctx.audit.query({ limit: Math.max(1, auditTotal() - g.auditBase) });
const noServiceCall = () => assert.equal(g.mock.serviceCalls.length, 0, 'es darf kein Servicecall erfolgen');
const limit = (id, action, param, lim) => g.ctx.store.update((e) => { e[id].actions[action].limits[param] = lim; });
const setCfg = (id, fn) => g.ctx.store.update((e) => fn(e[id]));
const lastCall = () => g.mock.serviceCalls.at(-1);

// ---- Auswahl-Domains: select, media_player.select_source, climate.set_fan_mode, fan.set_preset_mode, humidifier.set_mode, remote.turn_on, light.effect ----
const CHOICES = [
  { id: 'select.waschmodus', action: 'select_option', param: 'option', ok: 'Intensiv', other: 'Schnell', ha: ['select', 'select_option'], listed: ['Eco', 'Intensiv', 'Schnell'] },
  { id: 'media_player.radio', action: 'select_source', param: 'source', ok: 'Bad', other: 'Küche', ha: ['media_player', 'select_source'], listed: ['Küche', 'Bad'] },
  { id: 'climate.bad', action: 'set_fan_mode', param: 'fan_mode', ok: 'high', other: 'low', ha: ['climate', 'set_fan_mode'], listed: ['low', 'high'] },
  { id: 'fan.ventilator', action: 'set_preset_mode', param: 'preset_mode', ok: 'sleep', other: 'auto', ha: ['fan', 'set_preset_mode'], listed: ['auto', 'sleep'] },
  { id: 'humidifier.bad', action: 'set_mode', param: 'mode', ok: 'eco', other: 'boost', ha: ['humidifier', 'set_mode'], listed: ['normal', 'eco', 'boost'] },
  { id: 'remote.harmony', action: 'turn_on', param: 'activity', ok: 'Musik', other: 'Fernsehen', ha: ['remote', 'turn_on'], listed: ['Fernsehen', 'Musik'], optional: true },
  { id: 'light.effektlicht', action: 'turn_on', param: 'effect', ok: 'fire', other: 'rainbow', ha: ['light', 'turn_on'], listed: ['rainbow', 'fire'], optional: true },
];
for (const c of CHOICES) {
  test(`${c.id}: ${c.action}/${c.param} aus Attribut, einschraenkbar, option_hints, unbekannte Option abgelehnt`, async () => {
    g.expose(c.id);
    const p = (await g.api.get('/entities/' + c.id)).json.actions[c.action].params[c.param];
    assert.equal(p.type, 'choice');
    assert.deepEqual(p.allowed, c.listed);
    assert.equal(p.required, !c.optional);
    const r = await call({ entity_id: c.id, action: c.action, params: { [c.param]: c.ok } });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual([lastCall().domain, lastCall().service], c.ha);
    assert.equal(lastCall().data.entity_id, c.id);
    assert.equal(lastCall().data[c.param], c.ok);
    g.mock.serviceCalls.length = 0;
    const bad = await call({ entity_id: c.id, action: c.action, params: { [c.param]: 'gibt_es_nicht' } });
    assert.equal(bad.status, 400); assert.equal(bad.json.code, 'value_out_of_range');
    assert.equal((await call({ entity_id: c.id, action: c.action, params: { [c.param]: 5 } })).json.code, 'invalid_param');
    noServiceCall();
    // pro Entitaet einschraenken + Hinweis je Option
    limit(c.id, c.action, c.param, { allowed: [c.ok] });
    setCfg(c.id, (cfg) => { cfg.actions[c.action].option_hints = { [c.param]: { [c.ok]: 'Hinweistext' } }; });
    const v = (await g.api.get('/entities/' + c.id)).json.actions[c.action].params[c.param];
    assert.deepEqual(v.allowed, [c.ok]);
    assert.deepEqual(v.option_hints, { [c.ok]: 'Hinweistext' });
    const no = await call({ entity_id: c.id, action: c.action, params: { [c.param]: c.other } });
    assert.equal(no.status, 400); assert.equal(no.json.code, 'value_out_of_range');
    assert.deepEqual(no.json.allowed, [c.ok]);
    noServiceCall();
    assert.equal((await call({ entity_id: c.id, action: c.action, params: { [c.param]: c.ok } })).status, 200);
  });
}

test('Pflicht-Auswahl ohne Wert: missing_param; optionale (activity, effect) duerfen fehlen', async () => {
  g.expose(['select.waschmodus', 'remote.harmony', 'light.effektlicht']);
  assert.equal((await call({ entity_id: 'select.waschmodus', action: 'select_option' })).json.code, 'missing_param');
  noServiceCall();
  assert.equal((await call({ entity_id: 'remote.harmony', action: 'turn_on' })).status, 200);
  assert.deepEqual(lastCall().data, { entity_id: 'remote.harmony' });
  assert.equal((await call({ entity_id: 'light.effektlicht', action: 'turn_on', params: { brightness_pct: 40 } })).status, 200);
  assert.deepEqual(lastCall().data, { entity_id: 'light.effektlicht', brightness_pct: 40 });
});

test('Effekt nur bei light.turn_on; bei turn_off unbekannter Parameter; alte Konfiguration ohne Effekt-Grenze lehnt Effekte ab', async () => {
  g.expose('light.effektlicht');
  const r = await call({ entity_id: 'light.effektlicht', action: 'turn_off', params: { effect: 'fire' } });
  assert.equal(r.json.code, 'unknown_param');
  noServiceCall();
  setCfg('light.effektlicht', (cfg) => { delete cfg.actions.turn_on.limits.effect; });
  const e = (await g.api.get('/entities/light.effektlicht')).json;
  assert.ok(!('effect' in e.actions.turn_on.params), 'leere optionale Auswahl wird nicht angeboten');
  const bad = await call({ entity_id: 'light.effektlicht', action: 'turn_on', params: { effect: 'fire' } });
  assert.equal(bad.json.code, 'value_out_of_range');
  noServiceCall();
});

test('Auswahl: nur Werte, die auch gerade in HA angeboten werden', async () => {
  g.expose('select.waschmodus');
  g.mock.setState('select.waschmodus', 'Eco', { friendly_name: 'Waschmodus', options: ['Eco'] });
  await g.waitFor(() => g.ha.states.get('select.waschmodus').attributes.options.length === 1);
  const r = await call({ entity_id: 'select.waschmodus', action: 'select_option', params: { option: 'Intensiv' } });
  assert.equal(r.json.code, 'value_out_of_range');
  noServiceCall();
});

// ---- Zahlen: number, humidifier.set_humidity ----
test('number.set_value: Grenzen aus Attributen, einschraenkbar, nicht klemmen', async () => {
  g.expose('number.heizkurve');
  let p = (await g.api.get('/entities/number.heizkurve')).json.actions.set_value.params.value;
  assert.deepEqual([p.min, p.max], [0, 20]);
  let r = await call({ entity_id: 'number.heizkurve', action: 'set_value', params: { value: 12.5 } });
  assert.equal(r.status, 200);
  assert.deepEqual(lastCall(), { domain: 'number', service: 'set_value', data: { entity_id: 'number.heizkurve', value: 12.5 } });
  g.mock.serviceCalls.length = 0;
  for (const v of [21, -1]) {
    r = await call({ entity_id: 'number.heizkurve', action: 'set_value', params: { value: v } });
    assert.equal(r.json.code, 'value_out_of_range');
  }
  assert.equal((await call({ entity_id: 'number.heizkurve', action: 'set_value', params: { value: '5' } })).json.code, 'invalid_param');
  noServiceCall();
  limit('number.heizkurve', 'set_value', 'value', { min: 2, max: 8 });
  assert.equal((await call({ entity_id: 'number.heizkurve', action: 'set_value', params: { value: 9 } })).json.code, 'value_out_of_range');
  assert.equal((await call({ entity_id: 'number.heizkurve', action: 'set_value', params: { value: 8 } })).status, 200);
  p = (await g.api.get('/entities/number.heizkurve')).json.attributes;
  assert.deepEqual(Object.keys(p).sort(), ['max', 'min', 'step', 'unit_of_measurement']);
});

test('humidifier.set_humidity 0-100 einschraenkbar; turn_on/turn_off', async () => {
  g.expose('humidifier.bad');
  limit('humidifier.bad', 'set_humidity', 'humidity', { min: 30, max: 60 });
  assert.equal((await call({ entity_id: 'humidifier.bad', action: 'set_humidity', params: { humidity: 61 } })).json.code, 'value_out_of_range');
  assert.equal((await call({ entity_id: 'humidifier.bad', action: 'set_humidity', params: { humidity: 50.5 } })).json.code, 'invalid_param');
  noServiceCall();
  const r = await call({ entity_id: 'humidifier.bad', action: 'set_humidity', params: { humidity: 55 } });
  assert.equal(r.status, 200);
  assert.deepEqual(lastCall(), { domain: 'humidifier', service: 'set_humidity', data: { entity_id: 'humidifier.bad', humidity: 55 } });
  assert.equal(r.json.state_after.attributes.humidity, 55);
  assert.equal((await call({ entity_id: 'humidifier.bad', action: 'turn_on' })).json.state_after.state, 'on');
  assert.equal((await call({ entity_id: 'humidifier.bad', action: 'turn_off' })).json.state_after.state, 'off');
  const attrs = (await g.api.get('/entities/humidifier.bad')).json.attributes;
  assert.deepEqual(Object.keys(attrs).sort(), ['available_modes', 'current_humidity', 'humidity', 'mode']);
});

// ---- input_datetime ----
test('input_datetime.set_datetime: HH:MM, Zeitraum einschraenkbar', async () => {
  g.expose('input_datetime.wecker');
  limit('input_datetime.wecker', 'set_datetime', 'time', { from: '05:00', to: '09:30' });
  const p = (await g.api.get('/entities/input_datetime.wecker')).json.actions.set_datetime.params.time;
  assert.deepEqual([p.type, p.from, p.to, p.required], ['time', '05:00', '09:30', true]);
  for (const t of ['04:59', '09:31']) assert.equal((await call({ entity_id: 'input_datetime.wecker', action: 'set_datetime', params: { time: t } })).json.code, 'value_out_of_range');
  for (const t of ['7:00', '25:00', '07:00:00', 700, '', 'abc', null]) assert.equal((await call({ entity_id: 'input_datetime.wecker', action: 'set_datetime', params: { time: t } })).json.code, 'invalid_param', String(t));
  assert.equal((await call({ entity_id: 'input_datetime.wecker', action: 'set_datetime' })).json.code, 'missing_param');
  noServiceCall();
  const r = await call({ entity_id: 'input_datetime.wecker', action: 'set_datetime', params: { time: '09:30' } });
  assert.equal(r.status, 200);
  assert.deepEqual(lastCall(), { domain: 'input_datetime', service: 'set_datetime', data: { entity_id: 'input_datetime.wecker', time: '09:30:00' } });
});

test('Zeitgrenzen in der Konfiguration werden geprueft', () => {
  const attrs = {};
  const cfg = defaultConfig('input_datetime.wecker', attrs);
  assert.deepEqual(cfg.actions.set_datetime.limits.time, { from: '00:00', to: '23:59' });
  const mk = (lim) => { const c = JSON.parse(JSON.stringify(cfg)); c.actions.set_datetime.limits.time = lim; return normalizeConfig('input_datetime.wecker', c, attrs); };
  assert.deepEqual(mk({ from: '06:00', to: '08:00' }).actions.set_datetime.limits.time, { from: '06:00', to: '08:00' });
  for (const bad of [{ from: '08:00', to: '06:00' }, { from: '6:00', to: '8:00' }, { from: 5, to: '8:00' }, { from: '00:00', to: '24:00' }]) assert.throws(() => mk(bad), ValidationError);
});

// ---- einfache Aktionen ----
const SIMPLE = [
  ['remote.harmony', 'turn_off', 'remote', 'turn_off'],
  ['input_button.klingel', 'press', 'input_button', 'press'],
  ['siren.alarm', 'turn_on', 'siren', 'turn_on'],
  ['siren.alarm', 'turn_off', 'siren', 'turn_off'],
  ['humidifier.bad', 'turn_on', 'humidifier', 'turn_on'],
  ['automation.licht_auto', 'turn_off', 'automation', 'turn_off'],
  ['automation.licht_auto', 'turn_on', 'automation', 'turn_on'],
  ['media_player.radio', 'turn_on', 'media_player', 'turn_on'],
  ['media_player.radio', 'turn_off', 'media_player', 'turn_off'],
  ['media_player.radio', 'volume_up', 'media_player', 'volume_up'],
  ['media_player.radio', 'volume_down', 'media_player', 'volume_down'],
  ['climate.bad', 'turn_on', 'climate', 'turn_on'],
  ['climate.bad', 'turn_off', 'climate', 'turn_off'],
  ['vacuum.saugi', 'stop', 'vacuum', 'stop'],
  ['vacuum.saugi', 'locate', 'vacuum', 'locate'],
];
for (const [id, action, dom, svc] of SIMPLE) {
  test(`${id}.${action}: genau ein Servicecall ${dom}.${svc}, Zusatzparameter abgelehnt, nur freigegeben`, async () => {
    const before = await call({ entity_id: id, action });
    assert.equal(before.json.code, 'not_exposed');
    noServiceCall();
    g.expose(id);
    const r = await call({ entity_id: id, action });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.deepEqual(g.mock.serviceCalls, [{ domain: dom, service: svc, data: { entity_id: id } }]);
    g.mock.serviceCalls.length = 0;
    assert.equal((await call({ entity_id: id, action, params: { x: 1 } })).json.code, 'unknown_param');
    noServiceCall();
    setCfg(id, (cfg) => { cfg.actions[action].enabled = false; });
    assert.equal((await call({ entity_id: id, action })).json.code, 'action_not_allowed');
    assert.ok(!(action in (await g.api.get('/entities/' + id)).json.actions));
    noServiceCall();
  });
}

test('Standard-Mindestrolle erwachsen: Sirene, automation.turn_on/off (trigger bleibt fuer alle); Rolle wird durchgesetzt', async () => {
  g.expose(['siren.alarm', 'automation.licht_auto']);
  const acts = (await g.api.get('/entities/automation.licht_auto')).json.actions;
  assert.equal(acts.trigger.min_role, 'all');
  assert.equal(acts.turn_on.min_role, 'erwachsen');
  assert.equal(acts.turn_off.min_role, 'erwachsen');
  assert.equal((await g.api.get('/entities/siren.alarm')).json.actions.turn_on.min_role, 'erwachsen');
  for (const [id, action] of [['siren.alarm', 'turn_on'], ['siren.alarm', 'turn_off'], ['automation.licht_auto', 'turn_on'], ['automation.licht_auto', 'turn_off']]) {
    for (const role of ['kind', 'unbekannt']) {
      const r = await call({ entity_id: id, action, role });
      assert.equal(r.status, 403); assert.equal(r.json.code, 'role_too_low'); assert.equal(r.json.min_role, 'erwachsen');
    }
    assert.equal((await call({ entity_id: id, action, role: 'erwachsen' })).status, 200);
  }
  g.mock.serviceCalls.length = 0;
  assert.equal((await call({ entity_id: 'automation.licht_auto', action: 'trigger', role: 'unbekannt' })).status, 200);
});

test('Rolle gilt auch fuer weitere neue Aktionen (Entitaets-Mindestrolle admin)', async () => {
  g.expose(['select.waschmodus', 'number.heizkurve'], 'control', { min_role: 'admin' });
  for (const body of [{ entity_id: 'select.waschmodus', action: 'select_option', params: { option: 'Eco' } }, { entity_id: 'number.heizkurve', action: 'set_value', params: { value: 3 } }]) {
    assert.equal((await call({ ...body, role: 'erwachsen' })).json.code, 'role_too_low');
  }
  noServiceCall();
});

test('Ruhezeiten gelten fuer alle neuen Domains', async () => {
  const cases = [
    ['select.waschmodus', 'select_option', { option: 'Eco' }], ['number.heizkurve', 'set_value', { value: 1 }],
    ['remote.harmony', 'turn_off'], ['input_button.klingel', 'press'], ['humidifier.bad', 'set_humidity', { humidity: 50 }],
    ['siren.alarm', 'turn_on'], ['input_datetime.wecker', 'set_datetime', { time: '07:00' }], ['media_player.radio', 'volume_up'],
    ['climate.bad', 'set_fan_mode', { fan_mode: 'low' }], ['vacuum.saugi', 'locate'], ['fan.ventilator', 'set_preset_mode', { preset_mode: 'auto' }], ['automation.licht_auto', 'turn_off'],
  ];
  for (const [id] of cases) g.expose(id, 'control', { quiet: { from: '22:00', to: '06:00' } });
  clock.t = Date.parse('2026-01-15T22:30:00Z'); // 23:30 Berlin
  for (const [id, action, params] of cases) {
    const r = await call({ entity_id: id, action, params });
    assert.equal(r.status, 403, id); assert.equal(r.json.code, 'quiet_hours', id);
  }
  noServiceCall();
  clock.t = Date.parse('2026-01-15T12:00:00Z');
  for (const [id, action, params] of cases) assert.equal((await call({ entity_id: id, action, params })).status, 200, id);
});

test('Protokoll: je neue Aktion ein Eintrag, abgelehnte als denied, Parameter protokolliert', async () => {
  g.expose(['select.waschmodus', 'siren.alarm']);
  await call({ entity_id: 'select.waschmodus', action: 'select_option', params: { option: 'Eco' }, person: 'Anna' });
  await call({ entity_id: 'select.waschmodus', action: 'select_option', params: { option: 'xx' }, person: 'Anna' });
  await call({ entity_id: 'siren.alarm', action: 'turn_on', role: 'kind' });
  const log = newLog();
  assert.equal(log.total - g.auditBase, 3);
  const ok = log.items.find((e) => e.result === 'ok');
  assert.equal(ok.entity_id, 'select.waschmodus'); assert.equal(ok.action, 'select_option'); assert.deepEqual(ok.params, { option: 'Eco' });
  assert.deepEqual(log.items.filter((e) => e.result === 'denied').map((e) => e.code).sort(), ['role_too_low', 'value_out_of_range']);
});

// ---- Sichtbarkeit, Lesen, Attribute, Vorlagen ----
test('Sichtbarkeit: nicht freigegebene neue Entitaeten sind weder lesbar noch steuerbar', async () => {
  g.expose('select.waschmodus', 'off');
  assert.equal((await g.api.get('/entities/select.waschmodus')).status, 403);
  assert.equal((await g.api.get('/entities/siren.alarm')).status, 403);
  const list = (await g.api.get('/entities')).json.entities;
  assert.ok(!list.some((e) => ['select.waschmodus', 'siren.alarm'].includes(e.entity_id)));
  g.expose('select.waschmodus', 'read');
  const e = (await g.api.get('/entities/select.waschmodus')).json;
  assert.deepEqual(e.actions, {});
  assert.equal((await call({ entity_id: 'select.waschmodus', action: 'select_option', params: { option: 'Eco' } })).json.code, 'read_only');
  noServiceCall();
});

test('lesbare Attribute der neuen Domains und Aktionen', async () => {
  g.expose(['remote.harmony', 'select.waschmodus', 'media_player.radio', 'climate.bad', 'light.effektlicht', 'fan.ventilator']);
  const a = async (id) => Object.keys((await g.api.get('/entities/' + id)).json.attributes).sort();
  assert.deepEqual(await a('remote.harmony'), ['activity_list', 'current_activity']);
  assert.deepEqual(await a('select.waschmodus'), ['options']);
  // neue Attribute bestehender Domains sind waehlbar, aber standardmaessig aus
  assert.ok(!(await a('media_player.radio')).includes('source'));
  setCfg('media_player.radio', (c) => { c.attributes.push('source', 'source_list'); });
  setCfg('climate.bad', (c) => { c.attributes.push('fan_mode', 'fan_modes'); });
  setCfg('light.effektlicht', (c) => { c.attributes.push('effect', 'effect_list'); });
  assert.ok((await a('media_player.radio')).includes('source_list'));
  assert.ok((await a('climate.bad')).includes('fan_modes'));
  assert.deepEqual((await a('light.effektlicht')).filter((x) => x.startsWith('effect')), ['effect', 'effect_list']);
});

test('UI: Vorlagen, Standardwerte und Auswahllisten der neuen Typen', async () => {
  const meta = (await g.ui.get('/meta')).json;
  for (const d of ['select', 'number', 'remote', 'input_button', 'humidifier', 'siren', 'input_datetime']) assert.ok(meta.actions[d], d);
  assert.equal(meta.actions.script.turn_on.dynamic, 'script_fields');
  assert.equal(meta.actions.input_datetime.set_datetime.params.time.type, 'time');
  assert.equal(JSON.stringify(meta).includes('toHa'), false);
  const e = (await g.ui.get('/entity/media_player.radio')).json;
  assert.deepEqual(e.choices.source_list, ['Küche', 'Bad']);
  assert.deepEqual(e.defaults.actions.select_source.limits.source.allowed, ['Küche', 'Bad']);
  assert.equal(e.defaults.access, 'control');
  const sir = (await g.ui.get('/entity/siren.alarm')).json.defaults;
  assert.equal(sir.actions.turn_on.min_role, 'erwachsen');
  const num = (await g.ui.get('/entity/number.heizkurve')).json.defaults;
  assert.deepEqual(num.actions.set_value.limits.value, { min: 0, max: 20 });
  assert.equal((await g.ui.get('/entity/remote.harmony')).json.defaults.actions.turn_on.limits.activity.allowed.length, 2);
});

test('nicht steuerbare Domains: nur Lesen, in der Oberflaeche gekennzeichnet, steuern wird zu lesen', async () => {
  const st = (await g.ui.get('/state')).json;
  for (const id of ['text.notiz', 'camera.eingang', 'alarm_control_panel.haus']) {
    assert.equal(st.entities.find((x) => x.entity_id === id).controllable, false, id);
    assert.equal(defaultConfig(id, {}).access, 'read');
    const put = await g.ui.put('/entity/' + id, { access: 'control' });
    assert.equal(put.status, 200);
    assert.equal(put.json.config.access, 'read');
  }
  assert.equal(st.entities.find((x) => x.entity_id === 'siren.alarm').controllable, true);
  const bulk = (await g.ui.post('/bulk', { entity_ids: ['text.notiz', 'camera.eingang', 'siren.alarm'], access: 'control' })).json;
  assert.equal(bulk.downgraded, 2);
  g.expose('text.notiz', 'read');
  assert.equal((await call({ entity_id: 'text.notiz', action: 'set_value', params: { value: 'x' } })).json.code, 'read_only');
  noServiceCall();
  const html = require('fs').readFileSync(require('path').join(__dirname, '../public/index.html'), 'utf8');
  assert.ok(html.includes('nur Lesen') && html.includes('kann über das Gateway nicht gesteuert werden'));
});

test('Assist-Vorschlag: neue Domains steuerbar, nicht steuerbare als nur lesbar markiert', async () => {
  g.mock.exposed['siren.alarm'] = { conversation: true };
  g.mock.exposed['text.notiz'] = { conversation: true };
  const p = (await g.ui.get('/assist-preview')).json;
  const sir = p.items.find((i) => i.entity_id === 'siren.alarm');
  assert.deepEqual([sir.controllable, sir.proposed.access], [true, 'control']);
  const txt = p.items.find((i) => i.entity_id === 'text.notiz');
  assert.deepEqual([txt.controllable, txt.proposed.access], [false, 'read']);
});

// ---- Skript-Felder ----
const FIELDS = [
  { name: 'modus', type: 'choice', allowed: ['hell', 'dunkel'], required: true },
  { name: 'dauer', type: 'number', min: 1, max: 60 },
  { name: 'leise', type: 'bool' },
];
const withFields = async (fields) => {
  g.expose('script.mit_feldern');
  const cur = (await g.ui.get('/entity/script.mit_feldern')).json.config;
  return g.ui.put('/entity/script.mit_feldern', { ...cur, fields });
};
const run = (params) => call({ entity_id: 'script.mit_feldern', action: 'turn_on', params });

test('Skript-Felder: speichern, in /entities wie Parameter, Aufruf mit variables', async () => {
  assert.equal((await withFields(FIELDS)).status, 200);
  const params = (await g.api.get('/entities/script.mit_feldern')).json.actions.turn_on.params;
  assert.deepEqual(params, {
    modus: { type: 'choice', required: true, allowed: ['hell', 'dunkel'], option_hints: {} },
    dauer: { type: 'number', required: false, min: 1, max: 60 },
    leise: { type: 'bool', required: false },
  });
  const r = await run({ modus: 'hell', dauer: 5.5, leise: true });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(g.mock.serviceCalls, [{ domain: 'script', service: 'turn_on', data: { entity_id: 'script.mit_feldern', variables: { modus: 'hell', dauer: 5.5, leise: true } } }]);
  g.mock.serviceCalls.length = 0;
  assert.equal((await run({ modus: 'dunkel' })).status, 200);
  assert.deepEqual(lastCall().data.variables, { modus: 'dunkel' });
});

test('Skript-Felder: Auswahl, Grenzen, Typ, unbekanntes Feld, Pflichtfeld', async () => {
  await withFields(FIELDS);
  assert.equal((await run({ modus: 'bunt' })).json.code, 'value_out_of_range');
  assert.equal((await run({ modus: 'hell', dauer: 61 })).json.code, 'value_out_of_range');
  assert.equal((await run({ modus: 'hell', dauer: 0 })).json.code, 'value_out_of_range');
  assert.equal((await run({ modus: 'hell', dauer: '5' })).json.code, 'invalid_param');
  assert.equal((await run({ modus: 'hell', leise: 'ja' })).json.code, 'invalid_param');
  assert.equal((await run({ modus: 1 })).json.code, 'invalid_param');
  assert.equal((await run({ modus: 'hell', extra: 1 })).json.code, 'unknown_param');
  assert.equal((await run({ modus: 'hell', variables: { a: 1 } })).json.code, 'unknown_param');
  assert.equal((await run({ modus: 'hell', entity_id: 'light.x' })).json.code, 'unknown_param');
  assert.equal((await run({ dauer: 3 })).json.code, 'missing_param');
  assert.equal((await run({})).json.code, 'missing_param');
  noServiceCall();
  const raw = await g.req('POST', '/api/v1/call', { raw: '{"role":"admin","entity_id":"script.mit_feldern","action":"turn_on","params":{"modus":"hell","__proto__":{"x":1}}}' });
  assert.ok([400].includes(raw.status));
  noServiceCall();
});

test('Skript ohne Felder: wie bisher, jeder Parameter abgelehnt, kein variables', async () => {
  g.expose('script.gute_nacht');
  const r = await call({ entity_id: 'script.gute_nacht', action: 'turn_on' });
  assert.equal(r.status, 200);
  assert.deepEqual(lastCall().data, { entity_id: 'script.gute_nacht' });
  assert.equal((await call({ entity_id: 'script.gute_nacht', action: 'turn_on', params: { a: 1 } })).json.code, 'unknown_param');
});

test('Skript-Felder: Konfiguration wird streng geprueft', async () => {
  g.expose('script.mit_feldern');
  const bad = [
    [{ name: 'Gross', type: 'bool' }], [{ name: '_x', type: 'bool' }], [{ name: '__proto__', type: 'bool' }], [{ name: 'a b', type: 'bool' }], [{ name: '', type: 'bool' }],
    [{ name: 'a', type: 'text' }], [{ name: 'a', type: 'choice', allowed: [] }], [{ name: 'a', type: 'choice' }], [{ name: 'a', type: 'choice', allowed: [1] }],
    [{ name: 'a', type: 'number', min: 5, max: 1 }], [{ name: 'a', type: 'number', min: 'x', max: 1 }], [{ name: 'a', type: 'number' }], [{ name: 'a', type: 'number', min: 0, max: 1e12 }],
    [{ name: 'a', type: 'bool' }, { name: 'a', type: 'bool' }], [{ name: 'a', type: 'bool', required: 'ja' }], ['a'], 'a', { a: 1 },
    Array.from({ length: 21 }, (_, i) => ({ name: 'f' + i, type: 'bool' })),
  ];
  for (const fields of bad) {
    const cur = (await g.ui.get('/entity/script.mit_feldern')).json.config;
    const r = await g.ui.put('/entity/script.mit_feldern', { ...cur, fields });
    assert.equal(r.status, 400, JSON.stringify(fields).slice(0, 80)); assert.equal(r.json.code, 'validation');
  }
  assert.deepEqual(g.ctx.store.get('script.mit_feldern').fields, []);
  // unbekannte Schluessel werden verworfen, Felder gibt es nur bei Skripten
  await withFields([{ name: 'a', type: 'bool', evil: 'x', min: 3 }]);
  assert.deepEqual(g.ctx.store.get('script.mit_feldern').fields, [{ name: 'a', type: 'bool', required: false }]);
  assert.ok(!('fields' in normalizeConfig('light.kueche', { fields: [{ name: 'a', type: 'bool' }] }, {})));
});

test('Skript-Felder: entfernen, ueberleben Export/Import und Sammel-Aenderung', async () => {
  await withFields(FIELDS);
  await g.ui.post('/bulk', { entity_ids: ['script.mit_feldern'], access: 'read' });
  await g.ui.post('/bulk', { entity_ids: ['script.mit_feldern'], access: 'control' });
  assert.equal(g.ctx.store.get('script.mit_feldern').fields.length, 3);
  const exp = (await g.ui.get('/export')).json;
  await g.ui.post('/import', { ...exp, mode: 'replace' });
  assert.equal(g.ctx.store.get('script.mit_feldern').fields.length, 3);
  assert.equal((await withFields([])).status, 200);
  assert.deepEqual((await g.api.get('/entities/script.mit_feldern')).json.actions.turn_on.params, {});
  assert.equal((await run({ modus: 'hell' })).json.code, 'unknown_param');
});

test('Skript-Felder: Mindestrolle, Ruhezeit und Protokoll gelten wie sonst', async () => {
  await withFields(FIELDS);
  setCfg('script.mit_feldern', (c) => { c.min_role = 'erwachsen'; c.quiet = { from: '22:00', to: '06:00' }; });
  assert.equal((await call({ entity_id: 'script.mit_feldern', action: 'turn_on', role: 'kind', params: { modus: 'hell' } })).json.code, 'role_too_low');
  clock.t = Date.parse('2026-01-15T22:30:00Z');
  assert.equal((await run({ modus: 'hell' })).json.code, 'quiet_hours');
  noServiceCall();
  const log = newLog();
  assert.equal(log.total - g.auditBase, 2);
  assert.deepEqual(log.items[0].params, { modus: 'hell' });
});

// ---- Sammelaufruf ----
test('call_many: Teilerfolg, ein Servicecall je Entitaet, ein Protokolleintrag je Entitaet', async () => {
  g.expose(['light.kueche', 'light.lampe_c']);
  g.expose('light.lampe_d', 'read');
  const r = await many({ entity_ids: ['light.kueche', 'light.lampe_d', 'light.flur', 'light.lampe_c', 'light.gibt_es_nicht'], action: 'turn_on', params: { brightness_pct: 30 }, person: 'Anna' });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json), ['results']);
  const by = Object.fromEntries(r.json.results.map((x) => [x.entity_id, x]));
  assert.equal(r.json.results.length, 5);
  assert.equal(by['light.kueche'].ok, true); assert.equal(by['light.kueche'].state_after.state, 'on');
  assert.equal(by['light.lampe_c'].ok, true);
  assert.deepEqual([by['light.lampe_d'].ok, by['light.lampe_d'].code], [false, 'read_only']);
  assert.deepEqual([by['light.flur'].ok, by['light.flur'].code], [false, 'not_exposed']);
  assert.equal(by['light.gibt_es_nicht'].code, 'not_exposed');
  assert.equal(typeof by['light.lampe_d'].error, 'string');
  assert.deepEqual(g.mock.serviceCalls.map((c) => c.data), [{ entity_id: 'light.kueche', brightness_pct: 30 }, { entity_id: 'light.lampe_c', brightness_pct: 30 }]);
  const log = newLog();
  assert.equal(log.total - g.auditBase, 5);
  assert.equal(log.items.filter((e) => e.result === 'ok').length, 2);
  assert.ok(log.items.every((e) => e.person === 'Anna' && e.action === 'turn_on'));
  assert.deepEqual([...new Set(log.items.map((e) => e.entity_id))].sort(), ['light.flur', 'light.gibt_es_nicht', 'light.kueche', 'light.lampe_c', 'light.lampe_d']);
});

test('call_many: Fehler einer Entitaet stoppt die anderen nicht (HA-Fehler, Grenzen, Aktion)', async () => {
  g.expose(['light.kueche', 'light.lampe_c', 'light.lampe_d']);
  setCfg('light.lampe_c', (c) => { c.actions.turn_on.limits.brightness_pct = { min: 0, max: 20 }; });
  setCfg('light.lampe_d', (c) => { c.actions.turn_on.enabled = false; });
  const r = await many({ entity_ids: ['light.lampe_c', 'light.lampe_d', 'light.kueche'], action: 'turn_on', params: { brightness_pct: 50 } });
  assert.deepEqual(r.json.results.map((x) => [x.entity_id, x.ok, x.code]), [
    ['light.lampe_c', false, 'value_out_of_range'], ['light.lampe_d', false, 'action_not_allowed'], ['light.kueche', true, undefined]]);
  g.mock.serviceCalls.length = 0;
  g.mock.failServices = 500;
  const f = await many({ entity_ids: ['light.kueche', 'light.lampe_c'], action: 'turn_off' });
  assert.equal(f.status, 200);
  assert.deepEqual(f.json.results.map((x) => x.code), ['ha_error', 'ha_error']);
  assert.ok(!JSON.stringify(f.json).includes('geheime'));
  assert.equal(g.mock.serviceCalls.length, 2);
});

test('call_many: Rollen und Ruhezeiten je Entitaet', async () => {
  g.expose('light.kueche');
  g.expose('light.lampe_c', 'control', { min_role: 'erwachsen' });
  g.expose('light.lampe_d', 'control', { quiet: { from: '22:00', to: '06:00' } });
  const ids = ['light.kueche', 'light.lampe_c', 'light.lampe_d'];
  const kind = await many({ entity_ids: ids, action: 'turn_off', role: 'kind' });
  assert.deepEqual(kind.json.results.map((x) => x.ok), [true, false, true]);
  assert.equal(kind.json.results[1].code, 'role_too_low');
  g.mock.serviceCalls.length = 0;
  const unknown = await g.api.post('/call_many', { entity_ids: ids, action: 'turn_off' });
  assert.deepEqual(unknown.json.results.map((x) => x.code), [undefined, 'role_too_low', undefined]);
  clock.t = Date.parse('2026-01-15T22:30:00Z');
  g.mock.serviceCalls.length = 0;
  const q = await many({ entity_ids: ids, action: 'turn_off' });
  assert.deepEqual(q.json.results.map((x) => x.code), [undefined, undefined, 'quiet_hours']);
  assert.equal(g.mock.serviceCalls.length, 2);
});

test('call_many: Bereich + Domain nur freigegebene, Treffer 404 wenn keine', async () => {
  g.expose(['light.kueche', 'light.lampe_c', 'light.lampe_d', 'switch.steckdose']);
  g.expose('light.lampe_b', 'off');
  const r = await many({ area: 'Küche', domain: 'light', action: 'turn_on' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.results.map((x) => x.entity_id), ['light.kueche', 'light.lampe_c', 'light.lampe_d']);
  assert.ok(r.json.results.every((x) => x.ok));
  assert.deepEqual(g.mock.serviceCalls.map((c) => c.data.entity_id), ['light.kueche', 'light.lampe_c', 'light.lampe_d']);
  g.mock.serviceCalls.length = 0;
  const none = await many({ area: 'Flur', domain: 'light', action: 'turn_on' });
  assert.equal(none.status, 404); assert.equal(none.json.code, 'not_found');
  noServiceCall();
});

test('call_many: Limit 30, ungueltige Anfragen, kein Servicecall', async () => {
  g.expose('light.kueche');
  const thirty = Array.from({ length: 30 }, (_, i) => 'light.x' + i);
  const ok = await many({ entity_ids: thirty, action: 'turn_off' });
  assert.equal(ok.status, 200); assert.equal(ok.json.results.length, 30);
  const over = await many({ entity_ids: [...thirty, 'light.y'], action: 'turn_off' });
  assert.equal(over.status, 400); assert.equal(over.json.code, 'too_many_entities');
  const bad = [
    { action: 'turn_off' }, { entity_ids: [], action: 'turn_off' }, { entity_ids: 'light.kueche', action: 'turn_off' }, { entity_ids: ['light.kueche', 5], action: 'turn_off' },
    { entity_ids: ['light.kueche'] }, { entity_ids: ['light.kueche'], action: 'turn_off', role: 'chef' }, { entity_ids: ['light.kueche'], action: 'turn_off', params: [] },
    { entity_ids: ['light.kueche'], area: 'Küche', domain: 'light', action: 'turn_off' }, { area: 'Küche', action: 'turn_off' }, { domain: 'light', action: 'turn_off' },
    { entity_ids: ['light.kueche'], action: 'turn_off', person: 'x'.repeat(81) },
  ];
  for (const b of bad) { const r = await many(b); assert.equal(r.status, 400, JSON.stringify(b)); assert.equal(r.json.code, 'invalid_request', JSON.stringify(b)); }
  assert.equal((await g.api.post('/call_many', null)).status, 400);
  noServiceCall();
  assert.equal(auditTotal() - g.auditBase, 30);
});

test('call_many: gleiche Zugriffsregeln wie /call (Token, Wildcards, Duplikate)', async () => {
  const body = { entity_ids: ['light.kueche'], action: 'turn_off', role: 'admin' };
  const direct = await startGateway({ extra: true });
  try {
    assert.equal((await direct.req('POST', '/api/v1/call_many', { body, token: null })).status, 401);
    assert.equal((await direct.req('POST', '/api/v1/call_many', { body, token: 'falsch' })).status, 401);
    direct.expose('light.kueche');
    assert.equal((await direct.api.post('/call_many', body)).status, 200);
    assert.equal((await direct.req('POST', '/api/ui/bulk', { body: {}, token: null })).status, 401);
  } finally { await direct.close(); }
  g.expose('light.kueche');
  const r = await many({ entity_ids: ['all', 'light.*', 'light.kueche', 'light.kueche', 'light.kueche,light.flur'], action: 'turn_off' });
  assert.deepEqual(r.json.results.map((x) => [x.entity_id, x.code]), [['all', 'invalid_entity_id'], ['light.*', 'invalid_entity_id'], ['light.kueche', undefined], ['light.kueche,light.flur', 'invalid_entity_id']]);
  assert.equal(g.mock.serviceCalls.length, 1);
  assert.equal(g.mock.serviceCalls[0].data.entity_id, 'light.kueche');
});

test('call_many: Zusatzfelder (service, target) werden ignoriert, nie durchgereicht; Parameter wie /call', async () => {
  g.expose(['select.waschmodus', 'select.nicht_da']);
  const r = await many({ entity_ids: ['select.waschmodus'], action: 'select_option', params: { option: 'Eco' }, service: 'homeassistant.restart', target: { entity_id: 'all' } });
  assert.equal(r.json.results[0].ok, true);
  assert.deepEqual(g.mock.serviceCalls, [{ domain: 'select', service: 'select_option', data: { entity_id: 'select.waschmodus', option: 'Eco' } }]);
  const u = await many({ entity_ids: ['select.waschmodus'], action: 'select_option', params: { option: 'Eco', x: 1 } });
  assert.equal(u.json.results[0].code, 'unknown_param');
});
