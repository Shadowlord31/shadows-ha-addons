const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { startGateway } = require('./helpers');
const { Store, KEEP_BACKUPS } = require('../lib/store');
const { Audit } = require('../lib/audit');

let g;
const clock = { t: Date.parse('2026-03-01T12:00:00Z') };
before(async () => { g = await startGateway({ ingress: true, now: () => clock.t }); });
after(async () => { await g.close(); });
beforeEach(() => {
  g.ctx.store.update((e) => { for (const k of Object.keys(e)) delete e[k]; });
  g.mock.serviceCalls.length = 0;
});

test('Oberflaeche wird ausgeliefert, relative API-Pfade (Ingress-tauglich)', async () => {
  const page = await g.req('GET', '/', { token: null });
  assert.equal(page.status, 200);
  assert.match(page.text, /<title>[^<]*Jarvis Gateway/);
  assert.ok(!/fetch\(\s*['"`]\/api/.test(page.text), 'keine absoluten /api-Pfade');
});

test('state: Entitaeten ohne deaktivierte/versteckte, mit Bereich, Assist-Flag, Domains', async () => {
  const s = (await g.ui.get('/state')).json;
  assert.equal(s.ha_connected, true);
  assert.equal(s.assist_available, true);
  const ids = s.entities.map((e) => e.entity_id);
  assert.ok(ids.includes('light.kueche'));
  assert.ok(!ids.includes('light.versteckt'));
  assert.ok(!ids.includes('light.deaktiviert'));
  const tv = s.entities.find((e) => e.entity_id === 'media_player.tv');
  assert.equal(tv.area, 'Wohnzimmer', 'Bereich ueber das Geraet');
  assert.equal(tv.ha_name, 'Fernseher');
  assert.equal(s.entities.find((e) => e.entity_id === 'light.kueche').assist, true);
  assert.equal(s.entities.find((e) => e.entity_id === 'light.flur').assist, false, 'nur fuer Alexa freigegeben');
  assert.equal(s.entities.find((e) => e.entity_id === 'light.kueche').configured, false);
  assert.ok(s.areas.includes('Küche'));
  assert.ok(s.domains.includes('lock'));
  assert.ok(!JSON.stringify(s).includes('entity_picture'));
});

test('Standardwerte beim Anlegen', async () => {
  const d = async (id) => (await g.ui.get('/entity/' + id)).json.defaults;
  for (const id of ['sensor.temperatur', 'binary_sensor.tuer', 'weather.zuhause']) assert.equal((await d(id)).access, 'read', id);
  assert.equal((await d('person.thomas')).access, 'read');
  const light = await d('light.kueche');
  assert.equal(light.access, 'control');
  assert.deepEqual(Object.keys(light.actions).sort(), ['toggle', 'turn_off', 'turn_on']);
  assert.ok(Object.values(light.actions).every((a) => a.enabled));
  for (const id of ['switch.steckdose', 'climate.wohnzimmer', 'cover.rollo', 'media_player.tv', 'fan.luefter', 'script.gute_nacht', 'scene.film', 'input_number.ziel', 'input_select.modus', 'vacuum.saugi']) assert.equal((await d(id)).access, 'control', id);
  const clim = await d('climate.wohnzimmer');
  assert.deepEqual(clim.actions.set_temperature.limits.temperature, { min: 7, max: 28 });
  assert.deepEqual(clim.actions.set_hvac_mode.limits.hvac_mode.allowed, ['off', 'heat', 'auto']);
  assert.deepEqual((await d('input_select.modus')).actions.select_option.limits.option.allowed, ['Zuhause', 'Abwesend', 'Urlaub']);
  const lock = await d('lock.haustuer');
  assert.equal(lock.confirm, 2); assert.equal(lock.min_role, 'erwachsen');
});

test('PUT/GET/DELETE einer Entitaet; Validierung lehnt Ungueltiges ab', async () => {
  const cur = (await g.ui.get('/entity/light.kueche')).json.config;
  let r = await g.ui.put('/entity/light.kueche', { ...cur, name: 'Kuechenlampe', aliases: ['Herd', 'herd', ' Tresen '], room: 'Esszimmer', confirm: 1, min_role: 'erwachsen', quiet: { from: '22:00', to: '06:30' } });
  assert.equal(r.status, 200);
  const e = (await g.ui.get('/entity/light.kueche')).json;
  assert.equal(e.configured, true);
  assert.deepEqual(e.config.aliases, ['Herd', 'Tresen']);
  assert.deepEqual([e.config.confirm, e.config.min_role, e.config.room], [1, 'erwachsen', 'Esszimmer']);
  const bad = [
    { access: 'admin' }, { confirm: 3 }, { min_role: 'kind' }, { quiet: { from: '25:00', to: '06:00' } }, { quiet: { from: '10:00', to: '10:00' } },
    { aliases: 'x' }, { actions: { turn_on: { enabled: true, limits: { brightness_pct: { min: -5, max: 50 } } } } },
    { actions: { turn_on: { enabled: true, limits: { brightness_pct: { min: 60, max: 50 } } } } },
    { actions: { turn_on: { enabled: true, limits: { brightness_pct: { min: 0, max: 500 } } } } },
    { actions: { turn_on: { enabled: true, limits: { brightness_pct: { min: '0', max: 50 } } } } },
    { actions: { turn_on: { enabled: true, min_role: 'root' } } },
  ];
  for (const b of bad) {
    r = await g.ui.put('/entity/light.kueche', { ...cur, ...b });
    assert.equal(r.status, 400, JSON.stringify(b));
    assert.equal(r.json.code, 'validation');
  }
  assert.equal((await g.ui.put('/entity/Licht.Kueche', cur)).status, 400);
  assert.equal((await g.ui.put('/entity/light.gibtsnicht', cur)).status, 404);
  assert.equal(g.ctx.store.get('light.kueche').name, 'Kuechenlampe', 'fehlerhafte Eingaben aendern nichts');
  assert.equal((await g.ui.del('/entity/light.kueche')).status, 200);
  assert.equal(g.ctx.store.has('light.kueche'), false);
});

test('unbekannte Aktionen/Felder werden verworfen, access=control ohne Vorlage wird read', async () => {
  const cur = (await g.ui.get('/entity/sensor.temperatur')).json.config;
  await g.ui.put('/entity/sensor.temperatur', { ...cur, access: 'control', evil: 1, actions: { reboot: { enabled: true } } });
  const c = g.ctx.store.get('sensor.temperatur');
  assert.equal(c.access, 'read');
  assert.deepEqual(c.actions, {});
  assert.ok(!('evil' in c));
  const l = (await g.ui.get('/entity/light.kueche')).json.config;
  await g.ui.put('/entity/light.kueche', { ...l, actions: { turn_on: { enabled: true }, 'homeassistant.restart': { enabled: true } } });
  assert.deepEqual(Object.keys(g.ctx.store.get('light.kueche').actions), ['turn_on', 'turn_off', 'toggle']);
  assert.equal(g.ctx.store.get('light.kueche').actions.turn_off.enabled, false, 'nicht genannte Aktionen sind aus');
});

test('Sammelaktion: Zugriff setzen; vorhandene Einstellungen bleiben, unbekannte werden uebersprungen', async () => {
  const cur = (await g.ui.get('/entity/light.kueche')).json.config;
  await g.ui.put('/entity/light.kueche', { ...cur, name: 'Eigener Name', confirm: 2 });
  const r = await g.ui.post('/bulk', { entity_ids: ['light.kueche', 'switch.steckdose', 'sensor.temperatur', 'light.gibtsnicht', 'BAD'], access: 'read' });
  assert.equal(r.status, 200);
  assert.equal(r.json.changed, 3);
  assert.deepEqual(r.json.skipped.sort(), ['BAD', 'light.gibtsnicht']);
  assert.equal(g.ctx.store.get('light.kueche').access, 'read');
  assert.equal(g.ctx.store.get('light.kueche').name, 'Eigener Name');
  assert.equal(g.ctx.store.get('light.kueche').confirm, 2);
  assert.equal(g.ctx.store.get('switch.steckdose').access, 'read');
  await g.ui.post('/bulk', { entity_ids: ['switch.steckdose', 'sensor.temperatur'], access: 'control' });
  assert.equal(g.ctx.store.get('switch.steckdose').access, 'control');
  assert.equal(g.ctx.store.get('sensor.temperatur').access, 'read', 'Sensor hat nichts zu steuern');
  await g.ui.post('/bulk', { entity_ids: ['switch.steckdose'], access: 'off' });
  assert.equal(g.ctx.store.get('switch.steckdose').access, 'off');
  assert.equal((await g.api.get('/entities/switch.steckdose')).json.code, 'not_exposed');
  assert.equal((await g.ui.post('/bulk', { entity_ids: [], access: 'read' })).status, 400);
  assert.equal((await g.ui.post('/bulk', { entity_ids: ['light.kueche'], access: 'root' })).status, 400);
});

test('Assist-Vorschau: nur Assist-freigegebene, nicht versteckte, mit Standardwerten', async () => {
  const p = (await g.ui.get('/assist-preview')).json;
  const ids = p.items.map((i) => i.entity_id).sort();
  assert.deepEqual(ids, ['light.kueche', 'light.wohnzimmer', 'lock.haustuer', 'sensor.temperatur', 'switch.steckdose']);
  const by = Object.fromEntries(p.items.map((i) => [i.entity_id, i]));
  assert.equal(by['sensor.temperatur'].proposed.access, 'read');
  assert.equal(by['light.kueche'].proposed.access, 'control');
  assert.equal(by['lock.haustuer'].proposed.confirm, 2);
  assert.equal(by['lock.haustuer'].proposed.min_role, 'erwachsen');
  assert.equal(by['light.wohnzimmer'].area, 'Wohnzimmer');
  assert.equal(p.already_configured, 0);
  assert.equal(g.ctx.store.has('light.kueche'), false, 'Vorschau uebernimmt nichts');
});

test('Assist-Uebernahme erst nach Bestaetigung und ohne Ueberschreiben', async () => {
  g.expose('light.kueche', 'read', { name: 'Mein Name', confirm: 1 });
  const before = JSON.stringify(g.ctx.store.get('light.kueche'));
  const p = (await g.ui.get('/assist-preview')).json;
  assert.ok(!p.items.some((i) => i.entity_id === 'light.kueche'));
  assert.equal(p.already_configured, 1);
  const r = await g.ui.post('/assist-import', { entity_ids: [...p.items.map((i) => i.entity_id), 'light.kueche', 'light.flur', 'person.thomas', 'nonsense'] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.imported.sort(), ['light.wohnzimmer', 'lock.haustuer', 'sensor.temperatur', 'switch.steckdose']);
  const reasons = Object.fromEntries(r.json.skipped.map((s) => [s.entity_id, s.reason]));
  assert.equal(reasons['light.kueche'], 'bereits konfiguriert');
  assert.equal(reasons['light.flur'], 'nicht in Assist freigegeben');
  assert.equal(reasons['person.thomas'], 'nicht in Assist freigegeben');
  assert.equal(JSON.stringify(g.ctx.store.get('light.kueche')), before, 'bestehender Eintrag unveraendert');
  assert.equal(g.ctx.store.get('lock.haustuer').confirm, 2);
  // zweiter Lauf: nichts mehr zu tun
  const again = (await g.ui.post('/assist-import', { entity_ids: ['light.wohnzimmer'] })).json;
  assert.deepEqual(again.imported, []);
  // auch ein bewusst auf "aus" gestellter Eintrag zaehlt als konfiguriert
  g.expose('switch.steckdose', 'off', { name: 'Aus' });
  await g.ui.post('/assist-import', { entity_ids: ['switch.steckdose'] });
  assert.equal(g.ctx.store.get('switch.steckdose').access, 'off');
  assert.equal(g.ctx.store.get('switch.steckdose').name, 'Aus');
});

test('Export enthaelt keine Tokens; Import (ersetzen/zusammenfuehren) ist verlustfrei', async () => {
  g.expose(['light.kueche', 'lock.haustuer', 'climate.wohnzimmer', 'input_select.modus'], 'control', { aliases: ['Test'] });
  g.expose('sensor.temperatur', 'read');
  const ex = await g.ui.get('/export');
  assert.equal(ex.json.format, 'jarvis-gateway-settings');
  assert.ok(!ex.text.includes(g.mock.token));
  assert.ok(!ex.text.includes('api_token'));
  assert.ok(!ex.text.toLowerCase().includes('token'));
  const snapshot = JSON.stringify(g.ctx.store.entities);
  // ersetzen
  g.ctx.store.update((e) => { for (const k of Object.keys(e)) delete e[k]; e['light.flur'] = { access: 'read' }; });
  let r = await g.ui.post('/import', { ...ex.json, mode: 'replace' });
  assert.equal(r.status, 200);
  assert.equal(JSON.stringify(g.ctx.store.entities), snapshot);
  // zusammenfuehren
  g.ctx.store.update((e) => { e['light.flur'] = JSON.parse(JSON.stringify(e['light.kueche'])); e['light.kueche'].name = 'ANDERS'; });
  r = await g.ui.post('/import', { ...ex.json, mode: 'merge' });
  assert.equal(r.status, 200);
  assert.equal(g.ctx.store.get('light.kueche').name, null, 'Import ueberschreibt gleiche IDs');
  assert.ok(g.ctx.store.has('light.flur'), 'merge behaelt andere');
  assert.equal((await g.ui.get('/export?download=1')).headers.get('content-disposition').includes('attachment'), true);
});

test('Import lehnt Ungueltiges komplett ab (nichts wird halb uebernommen)', async () => {
  g.expose('light.kueche');
  const snapshot = JSON.stringify(g.ctx.store.entities);
  const cases = [
    { entities: { 'light.kueche': { access: 'control' }, 'nicht gueltig': { access: 'read' } } },
    { entities: { 'light.kueche': { access: 'superuser' } } },
    { entities: { 'light.kueche': 'x' } },
    { entities: [] },
    { format: 'etwas-anderes', entities: {} },
    {},
  ];
  for (const body of cases) {
    const r = await g.ui.post('/import', { mode: 'replace', ...body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(JSON.stringify(g.ctx.store.entities), snapshot);
  const r = await g.req('POST', '/api/ui/import', { raw: '{"mode":"replace","entities":{"__proto__":{"access":"read"}}}', headers: { 'Content-Type': 'application/json' }, token: null });
  assert.equal(r.status, 400);
  assert.equal(({}).access, undefined, 'Prototype nicht verschmutzt');
});

test('Einstellungen: atomar, Sicherung bei jeder Aenderung, nur die letzten 20', async () => {
  const dir = path.join(g.dir, 'data');
  for (let i = 0; i < 25; i++) g.ctx.store.update((e) => { e['light.kueche'] = { access: 'read', n: i }; });
  const backups = fs.readdirSync(path.join(dir, 'backups'));
  assert.equal(backups.length, KEEP_BACKUPS);
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'keine Temp-Datei uebrig');
  const newest = backups.sort().pop();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'backups', newest))).entities['light.kueche'].n, 23, 'Sicherung = Stand vor der letzten Aenderung');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'))).entities['light.kueche'].n, 24);
  // Fehler im Mutator schreibt nichts
  assert.throws(() => g.ctx.store.update(() => { throw new Error('x'); }));
  assert.equal(g.ctx.store.get('light.kueche').n, 24);
});

test('Einstellungen ueberleben Neustart; defekte settings.json faellt auf Sicherung zurueck', async () => {
  const dir = path.join(g.dir, 'data');
  g.ctx.store.update((e) => { e['light.kueche'] = { access: 'read', n: 'A' }; });
  g.ctx.store.update((e) => { e['light.kueche'] = { access: 'read', n: 'B' }; });
  assert.equal(new Store(dir).get('light.kueche').n, 'B');
  fs.writeFileSync(path.join(dir, 'settings.json'), '{kaputt');
  const s = new Store(dir);
  assert.equal(s.get('light.kueche').n, 'A');
  assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('settings.corrupt-')));
});

test('Protokoll: Steuerung, Ablehnung, Person/Rolle/Werte, Filter, kein Token', async () => {
  g.expose(['light.kueche', 'lock.haustuer']);
  const c = (b) => g.api.post('/call', b);
  await c({ entity_id: 'light.kueche', action: 'turn_on', params: { brightness_pct: 40 }, role: 'admin', person: 'Thomas' });
  await c({ entity_id: 'light.kueche', action: 'turn_on', params: { brightness_pct: 400 }, role: 'kind', person: 'Lena' });
  await c({ entity_id: 'lock.haustuer', action: 'unlock', role: 'kind', person: 'Lena' });
  await c({ entity_id: 'switch.steckdose', action: 'turn_on', role: 'unbekannt' });
  await c({ entity_id: 'light.kueche', action: 'turn_on', params: { access_token: 'geheim123', password: 'pw' }, role: 'admin' });
  const all = (await g.ui.get('/audit')).json;
  assert.equal(all.total, 5);
  assert.equal(all.items[0].code, 'unknown_param', 'neueste zuerst');
  const ok = (await g.ui.get('/audit?result=ok')).json.items;
  assert.equal(ok.length, 1);
  assert.deepEqual([ok[0].entity_id, ok[0].action, ok[0].params, ok[0].person, ok[0].role, ok[0].result], ['light.kueche', 'turn_on', { brightness_pct: 40 }, 'Thomas', 'admin', 'ok']);
  assert.equal(ok[0].ts, '2026-03-01T12:00:00.000Z');
  const lena = (await g.ui.get('/audit?person=lena')).json;
  assert.deepEqual(lena.items.map((i) => i.code).sort(), ['role_too_low', 'value_out_of_range']);
  assert.ok(lena.items.every((i) => i.reason && i.result === 'denied'));
  assert.equal((await g.ui.get('/audit?q=lock.')).json.total, 1);
  assert.equal((await g.ui.get('/audit?code=not_exposed')).json.total, 1);
  assert.equal((await g.ui.get('/audit?action=unlock')).json.total, 1);
  assert.equal((await g.ui.get('/audit?limit=2&offset=4')).json.items.length, 1);
  const raw = fs.readFileSync(path.join(g.dir, 'data', 'audit.jsonl'), 'utf8');
  for (const t of ['geheim123', '"pw"', g.mock.token, 'test-api-token']) assert.ok(!raw.includes(t), t);
  assert.match(raw, /\[entfernt\]/);
});

test('Protokoll: 90 Tage Aufbewahrung, ueberlebt Neustart', async () => {
  const dir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'aud-'));
  const t = { v: Date.parse('2026-01-01T00:00:00Z') };
  const a = new Audit(dir, { now: () => t.v });
  a.add({ entity_id: 'light.a', action: 'turn_on', result: 'ok' });
  t.v += 60 * 86400000;
  a.add({ entity_id: 'light.b', action: 'turn_on', result: 'ok' });
  t.v += 29 * 86400000; // Eintrag a ist 89 Tage alt
  a.prune();
  assert.equal(a.query().total, 2);
  assert.equal(new Audit(dir, { now: () => t.v }).query().total, 2, 'aus Datei geladen');
  t.v += 2 * 86400000; // a ist 91 Tage alt
  a.prune();
  assert.deepEqual(a.query().items.map((e) => e.entity_id), ['light.b']);
  assert.equal(new Audit(dir, { now: () => t.v }).query().total, 1);
  a.stop();
});
