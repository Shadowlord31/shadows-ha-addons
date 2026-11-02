const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { startGateway } = require('./helpers');
const { normalizeConfig, defaultConfig, ValidationError } = require('../lib/config');

let g;
before(async () => { g = await startGateway({ ingress: true }); });
after(async () => { await g.close(); });
beforeEach(() => g.ctx.store.update((e) => { for (const k of Object.keys(e)) delete e[k]; }));

const put = async (id, patch) => {
  const cur = (await g.ui.get('/entity/' + id)).json.config;
  return g.ui.put('/entity/' + id, { ...cur, ...patch });
};
const withHints = async (id, action, param, hints, extra = {}) => {
  const cur = (await g.ui.get('/entity/' + id)).json.config;
  cur.actions[action].option_hints = { [param]: hints };
  return g.ui.put('/entity/' + id, { ...cur, ...extra });
};

test('Standardwert: hint null, keine option_hints; alte Konfiguration ohne neue Felder bleibt gueltig', async () => {
  assert.equal(defaultConfig('light.kueche', {}).hint, null);
  assert.ok(!('option_hints' in defaultConfig('input_select.modus', { options: ['A'] }).actions.select_option));
  const old = JSON.parse(JSON.stringify(defaultConfig('light.kueche', {})));
  delete old.hint;
  assert.equal(normalizeConfig('light.kueche', old, {}).hint, null);
  g.expose('light.kueche');
  const e = (await g.api.get('/entities/light.kueche')).json;
  assert.equal(e.hint, null);
});

test('hint wird gespeichert und in /entities und /entities/{id} und per Name ausgeliefert', async () => {
  const text = 'Startet das Radio im Wohnzimmer, der Verstärker geht dabei von selbst an';
  g.expose('media_player.tv');
  assert.equal((await put('media_player.tv', { hint: text })).status, 200);
  assert.equal((await g.api.get('/entities/media_player.tv')).json.hint, text);
  assert.equal((await g.api.get('/entities/Fernseher')).json.hint, text);
  const list = (await g.api.get('/entities')).json.entities;
  assert.equal(list.find((x) => x.entity_id === 'media_player.tv').hint, text);
  assert.equal((await put('media_player.tv', { hint: '' })).status, 200);
  assert.equal((await g.api.get('/entities/media_player.tv')).json.hint, null);
});

test('hint: Laengenlimit 300, Bereinigung (Steuerzeichen, HTML), nur reiner Text', async () => {
  g.expose('light.kueche');
  assert.equal((await put('light.kueche', { hint: 'x'.repeat(300) })).status, 200);
  const long = await put('light.kueche', { hint: 'x'.repeat(301) });
  assert.equal(long.status, 400);
  assert.equal(long.json.code, 'validation');
  assert.match(long.json.error, /300/);
  assert.equal((await put('light.kueche', { hint: 5 })).status, 400);
  assert.equal((await put('light.kueche', { hint: ['a'] })).status, 400);

  await put('light.kueche', { hint: '  Zeile1\r\n\tZeile2\u0000\u0007 <script>alert(1)</script><b>fett</b> a < b  ' });
  const h = (await g.api.get('/entities/light.kueche')).json.hint;
  assert.ok(!/[\u0000-\u001f\u007f]/.test(h));
  assert.ok(!/<[a-z/]/i.test(h), h);
  assert.equal(h, 'Zeile1 Zeile2 alert(1) fett a < b');
  assert.equal((await put('light.kueche', { hint: '<p></p>' })).status, 200);
  assert.equal((await g.api.get('/entities/light.kueche')).json.hint, null, 'nur Markup -> leer');
  // Laenge wird nach der Bereinigung geprueft
  assert.equal((await put('light.kueche', { hint: '<b>' + 'x'.repeat(300) + '</b>' })).status, 200);
});

test('option_hints: nur erlaubte Optionen, Laenge 80, Ausgabe an Parameter', async () => {
  g.expose('input_select.modus');
  const r = await withHints('input_select.modus', 'select_option', 'option', { Zuhause: 'Alle da', Urlaub: 'Alarm scharf', Unbekannt: 'gibt es nicht' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.config.actions.select_option.option_hints, { option: { Zuhause: 'Alle da', Urlaub: 'Alarm scharf' } }, 'unbekannte Optionen verworfen');
  const p = (await g.api.get('/entities/input_select.modus')).json.actions.select_option.params.option;
  assert.deepEqual(p.allowed, ['Zuhause', 'Abwesend', 'Urlaub']);
  assert.deepEqual(p.option_hints, { Zuhause: 'Alle da', Urlaub: 'Alarm scharf' });

  const ok = await withHints('input_select.modus', 'select_option', 'option', { Zuhause: 'x'.repeat(80) });
  assert.equal(ok.status, 200);
  const bad = await withHints('input_select.modus', 'select_option', 'option', { Zuhause: 'x'.repeat(81) });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /80/);
  assert.equal((await withHints('input_select.modus', 'select_option', 'option', ['a'])).status, 400);
  assert.equal((await withHints('input_select.modus', 'select_option', 'option', { Zuhause: 1 })).status, 400);
  const clean = await withHints('input_select.modus', 'select_option', 'option', { Zuhause: ' <i>Ruhig</i>\n\u0001bitte ' });
  assert.equal(clean.json.config.actions.select_option.option_hints.option.Zuhause, 'Ruhig bitte');
});

test('option_hints folgen den erlaubten Optionen (abgewaehlte Option wird nicht ausgeliefert/gespeichert)', async () => {
  g.expose('climate.wohnzimmer');
  const cur = (await g.ui.get('/entity/climate.wohnzimmer')).json.config;
  cur.actions.set_hvac_mode.limits.hvac_mode.allowed = ['heat', 'off'];
  cur.actions.set_hvac_mode.option_hints = { hvac_mode: { heat: 'Heizen', off: 'Aus', auto: 'Automatik' } };
  const r = await g.ui.put('/entity/climate.wohnzimmer', cur);
  assert.deepEqual(r.json.config.actions.set_hvac_mode.option_hints.hvac_mode, { heat: 'Heizen', off: 'Aus' });
  const p = (await g.api.get('/entities/climate.wohnzimmer')).json.actions.set_hvac_mode.params.hvac_mode;
  assert.deepEqual(p.option_hints, { heat: 'Heizen', off: 'Aus' });
  // Option verschwindet live aus HA -> auch der Hinweis
  g.mock.setState('climate.wohnzimmer', 'heat', { ...g.mock.states.get('climate.wohnzimmer').attributes, hvac_modes: ['off'] });
  await g.waitFor(() => g.ha.states.get('climate.wohnzimmer').attributes.hvac_modes.length === 1);
  const p2 = (await g.api.get('/entities/climate.wohnzimmer')).json.actions.set_hvac_mode.params.hvac_mode;
  assert.deepEqual(p2.allowed, ['off']);
  assert.deepEqual(p2.option_hints, { off: 'Aus' });
});

test('option_hints nur bei choice-Parametern, nicht bei Zahlen/Aktionen ohne choice', async () => {
  g.expose('light.kueche');
  const cur = (await g.ui.get('/entity/light.kueche')).json.config;
  cur.actions.turn_on.option_hints = { brightness_pct: { 50: 'halb' }, evil: { a: 'b' } };
  const r = await g.ui.put('/entity/light.kueche', cur);
  assert.equal(r.status, 200);
  assert.ok(!('option_hints' in r.json.config.actions.turn_on));
  const v = (await g.api.get('/entities/light.kueche')).json;
  for (const p of Object.values(v.actions.turn_on.params)) assert.ok(!('option_hints' in p));
});

test('nur fuer aktivierte Aktionen sichtbar; nicht freigegebene Entitaeten liefern nichts', async () => {
  g.expose('input_select.modus');
  await withHints('input_select.modus', 'select_option', 'option', { Zuhause: 'Alle da' }, {});
  const cur = (await g.ui.get('/entity/input_select.modus')).json.config;
  cur.actions.select_option.enabled = false;
  await g.ui.put('/entity/input_select.modus', cur);
  assert.deepEqual((await g.api.get('/entities/input_select.modus')).json.actions, {});
  await g.ui.post('/bulk', { entity_ids: ['input_select.modus'], access: 'off' });
  assert.equal((await g.api.get('/entities/input_select.modus')).status, 403);
  assert.ok(!(await g.api.get('/entities')).text.includes('Alle da'));
});

test('Sammelaktion und /call lassen Hinweise unveraendert', async () => {
  g.expose('input_select.modus');
  await put('input_select.modus', { hint: 'Hausmodus' });
  await withHints('input_select.modus', 'select_option', 'option', { Zuhause: 'Alle da' });
  await g.ui.post('/bulk', { entity_ids: ['input_select.modus'], access: 'read' });
  await g.ui.post('/bulk', { entity_ids: ['input_select.modus'], access: 'control' });
  const c = g.ctx.store.get('input_select.modus');
  assert.equal(c.hint, 'Hausmodus');
  assert.deepEqual(c.actions.select_option.option_hints, { option: { Zuhause: 'Alle da' } });
  const r = await g.api.post('/call', { entity_id: 'input_select.modus', action: 'select_option', params: { option: 'Urlaub' }, role: 'admin' });
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.json).sort(), ['action', 'entity_id', 'ok', 'state_after']);
  assert.deepEqual(g.mock.serviceCalls.at(-1).data, { entity_id: 'input_select.modus', option: 'Urlaub' }, 'Hinweise gelangen nie an HA');
});

test('Export/Import mit und ohne die neuen Felder', async () => {
  g.expose(['input_select.modus', 'light.kueche']);
  await put('input_select.modus', { hint: 'Hausmodus' });
  await withHints('input_select.modus', 'select_option', 'option', { Zuhause: 'Alle da' });
  const ex = (await g.ui.get('/export')).json;
  assert.equal(ex.entities['input_select.modus'].hint, 'Hausmodus');
  assert.deepEqual(ex.entities['input_select.modus'].actions.select_option.option_hints, { option: { Zuhause: 'Alle da' } });
  const snapshot = JSON.stringify(g.ctx.store.entities);
  g.ctx.store.update((e) => { for (const k of Object.keys(e)) delete e[k]; });
  assert.equal((await g.ui.post('/import', { ...ex, mode: 'replace' })).status, 200);
  assert.equal(JSON.stringify(g.ctx.store.entities), snapshot, 'Round-Trip verlustfrei');

  // Export einer aelteren Version ohne die neuen Felder
  const oldFmt = JSON.parse(JSON.stringify(ex));
  for (const c of Object.values(oldFmt.entities)) { delete c.hint; for (const a of Object.values(c.actions)) delete a.option_hints; }
  assert.equal((await g.ui.post('/import', { ...oldFmt, mode: 'replace' })).status, 200);
  assert.equal(g.ctx.store.get('input_select.modus').hint, null);
  assert.ok(!('option_hints' in g.ctx.store.get('input_select.modus').actions.select_option));
  assert.equal((await g.api.get('/entities/input_select.modus')).json.hint, null);

  // Ungueltige Hinweise im Import lehnen alles ab
  const bad = JSON.parse(JSON.stringify(ex));
  bad.entities['light.kueche'].hint = 'x'.repeat(301);
  const before = JSON.stringify(g.ctx.store.entities);
  assert.equal((await g.ui.post('/import', { ...bad, mode: 'replace' })).status, 400);
  assert.equal(JSON.stringify(g.ctx.store.entities), before);
});

test('normalizeConfig: Fehlerklasse und Prototype-Schluessel in option_hints', () => {
  assert.throws(() => normalizeConfig('light.kueche', { hint: 'x'.repeat(301) }, {}), ValidationError);
  const cfg = JSON.parse('{"actions":{"select_option":{"enabled":true,"limits":{"option":{"allowed":["a","__proto__"]}},"option_hints":{"option":{"__proto__":"x","a":"ok"}}}}}');
  const out = normalizeConfig('input_select.modus', cfg, { options: ['a'] });
  assert.deepEqual(out.actions.select_option.option_hints.option, { a: 'ok' });
  assert.equal(({}).x, undefined);
});
