const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startGateway } = require('./helpers');

let g;
before(async () => { g = await startGateway({ ingress: true }); });
after(async () => { await g.close(); });

test('health: Aufbau und Zaehler der freigegebenen Entitaeten', async () => {
  let r = await g.api.get('/health');
  assert.deepEqual(Object.keys(r.json).sort(), ['entities_exposed', 'ha_connected', 'ha_version', 'ok']);
  assert.equal(r.json.entities_exposed, 0);
  g.expose(['light.kueche', 'sensor.temperatur']);
  g.expose('light.flur', 'off');
  r = await g.api.get('/health');
  assert.equal(r.json.entities_exposed, 2);
  assert.equal(r.json.ha_version, '2025.1.0-mock');
});

test('Liste enthaelt NUR freigegebene Entitaeten', async () => {
  const r = await g.api.get('/entities');
  assert.deepEqual(r.json.entities.map((e) => e.entity_id).sort(), ['light.kueche', 'sensor.temperatur']);
  assert.ok(!r.text.includes('light.wohnzimmer'));
  assert.ok(!r.text.includes('person.thomas'));
});

test('Eintrag: Felder, Raum aus HA-Bereich, Standardname, actions mit Parametern/Grenzen', async () => {
  g.expose('light.wohnzimmer');
  const e = (await g.api.get('/entities/light.wohnzimmer')).json;
  assert.equal(e.name, 'Wohnzimmer Licht');
  assert.equal(e.area, 'Wohnzimmer');
  assert.equal(e.domain, 'light');
  assert.equal(e.state, 'on');
  assert.equal(e.access, 'control');
  assert.equal(e.confirm, 0);
  assert.equal(e.min_role, 'all');
  assert.equal(e.quiet, null);
  assert.deepEqual(Object.keys(e.actions).sort(), ['toggle', 'turn_off', 'turn_on']);
  assert.deepEqual(e.actions.turn_on.params.brightness_pct, { type: 'int', required: false, min: 0, max: 100 });
  assert.equal(e.actions.turn_on.params.rgb_color.type, 'rgb');
  assert.deepEqual(e.actions.turn_off.params, {});
});

test('Sprachname, Aliase, Raum aus den Einstellungen ueberschreiben HA-Werte', async () => {
  g.expose('light.kueche', 'control', { name: 'Kuechenlampe', aliases: ['Herdlicht'], room: 'Esszimmer' });
  const e = (await g.api.get('/entities/light.kueche')).json;
  assert.equal(e.name, 'Kuechenlampe');
  assert.deepEqual(e.aliases, ['Herdlicht']);
  assert.equal(e.area, 'Esszimmer');
});

test('nur lesen: keine actions', async () => {
  g.expose('light.flur', 'read');
  const e = (await g.api.get('/entities/light.flur')).json;
  assert.equal(e.access, 'read');
  assert.deepEqual(e.actions, {});
});

test('Attribut-Positivliste: nur Erlaubtes, nichts darueber hinaus', async () => {
  g.expose('light.wohnzimmer');
  const l = (await g.api.get('/entities/light.wohnzimmer')).json;
  assert.deepEqual(Object.keys(l.attributes).sort(), ['brightness', 'brightness_pct', 'color_temp', 'color_temp_kelvin', 'max_color_temp_kelvin', 'min_color_temp_kelvin', 'rgb_color']);
  for (const bad of ['hs_color', 'xy_color', 'supported_features', 'entity_picture', 'friendly_name']) assert.ok(!(bad in l.attributes), bad);

  g.expose(['climate.wohnzimmer', 'media_player.tv', 'sensor.temperatur', 'cover.rollo', 'switch.steckdose', 'weather.zuhause', 'person.thomas', 'binary_sensor.tuer']);
  const attrs = async (id) => Object.keys((await g.api.get('/entities/' + id)).json.attributes).sort();
  assert.deepEqual(await attrs('climate.wohnzimmer'), ['current_temperature', 'hvac_action', 'hvac_modes', 'max_temp', 'min_temp', 'preset_mode', 'preset_modes', 'temperature']);
  assert.deepEqual(await attrs('media_player.tv'), ['is_volume_muted', 'media_title', 'volume_level']);
  assert.deepEqual(await attrs('sensor.temperatur'), ['device_class', 'unit_of_measurement']);
  assert.deepEqual(await attrs('cover.rollo'), ['current_position']);
  assert.deepEqual(await attrs('switch.steckdose'), []);
  assert.deepEqual(await attrs('weather.zuhause'), ['humidity', 'temperature']);
  assert.deepEqual(await attrs('binary_sensor.tuer'), ['device_class']);
});

test('person: nur der Zustand, keine GPS-Daten, nirgends', async () => {
  const r = await g.api.get('/entities/person.thomas');
  assert.equal(r.json.state, 'home');
  assert.deepEqual(r.json.attributes, {});
  for (const t of ['latitude', 'longitude', 'gps', '52.5', '13.4', 'device_tracker.phone']) assert.ok(!r.text.includes(t), t);
  const list = (await g.api.get('/entities')).text;
  for (const t of ['"latitude"', '52.5', 'gps_accuracy', 'secret_note', 'geheim', '192.168.1.5', 'media_player_proxy', '/secret.png', 'forecast']) assert.ok(!list.includes(t), t);
});

test('Attribut-Positivliste gilt auch bei manipulierter settings.json und im state_after', async () => {
  g.ctx.store.update((e) => { e['person.thomas'].attributes = ['latitude', 'longitude', 'source']; e['switch.steckdose'].attributes = ['secret_note']; e['light.wohnzimmer'].attributes = ['brightness', 'entity_picture']; });
  assert.deepEqual((await g.api.get('/entities/person.thomas')).json.attributes, {});
  assert.deepEqual((await g.api.get('/entities/switch.steckdose')).json.attributes, {});
  assert.deepEqual(Object.keys((await g.api.get('/entities/light.wohnzimmer')).json.attributes).sort(), ['brightness', 'brightness_pct']);
  const r = await g.api.post('/call', { entity_id: 'switch.steckdose', action: 'turn_on', role: 'admin' });
  assert.deepEqual(r.json.state_after, { state: 'on', attributes: {} });
});

test('Einzelne Attribute lassen sich pro Entitaet abwaehlen; Nicht-Whitelist-Attribute werden beim Speichern verworfen', async () => {
  const cur = (await g.ui.get('/entity/sensor.temperatur')).json.config;
  assert.deepEqual(cur.attributes.sort(), ['device_class', 'unit_of_measurement']);
  await g.ui.put('/entity/sensor.temperatur', { ...cur, attributes: ['unit_of_measurement', 'latitude'] });
  assert.deepEqual(g.ctx.store.get('sensor.temperatur').attributes, ['unit_of_measurement']);
  assert.deepEqual(Object.keys((await g.api.get('/entities/sensor.temperatur')).json.attributes), ['unit_of_measurement']);
});

test('Filter area / domain / q und Sortierung', async () => {
  g.expose(['light.kueche', 'light.lampe_a', 'light.lampe_b', 'light.flur']);
  const ids = async (qs) => (await g.api.get('/entities' + qs)).json.entities.map((e) => e.entity_id).sort();
  assert.deepEqual(await ids('?domain=sensor'), ['sensor.temperatur']);
  assert.deepEqual(await ids('?area=' + encodeURIComponent('Küche')), ['light.kueche', 'light.lampe_b']);
  assert.deepEqual(await ids('?area=kueche&domain=light'), ['light.kueche', 'light.lampe_b']);
  assert.deepEqual(await ids('?q=lampe'), ['light.lampe_a', 'light.lampe_b']);
  assert.deepEqual(await ids('?q=flur'), ['light.flur']);
  assert.deepEqual(await ids('?q=gibtsnicht'), []);
  assert.deepEqual(await ids('?domain=switch'), ['switch.steckdose']);
});

test('areas: Bereiche mit freigegebenen Entitaeten', async () => {
  const a = (await g.api.get('/areas')).json.areas;
  const wz = a.find((x) => x.area === 'Wohnzimmer');
  assert.ok(wz.entities.some((e) => e.entity_id === 'light.wohnzimmer'));
  assert.ok(!JSON.stringify(a).includes('person.thomas') || g.ctx.store.has('person.thomas'));
  assert.ok(!a.some((x) => x.entities.some((e) => e.entity_id === 'light.versteckt')));
  assert.ok(a.every((x) => x.entities.length > 0));
});

test('Zustandsaenderungen in HA erscheinen live', async () => {
  g.mock.setState('sensor.temperatur', '23.9');
  await g.waitFor(async () => (await g.api.get('/entities/sensor.temperatur')).json.state === '23.9');
});

test('in HA entfernte Entitaet: 404 entity_missing statt Absturz', async () => {
  g.mock.removeState('switch.steckdose');
  await g.waitFor(() => !g.ha.states.has('switch.steckdose'));
  const r = await g.api.get('/entities/switch.steckdose');
  assert.equal(r.status, 404);
  assert.equal(r.json.code, 'entity_missing');
  const c = await g.api.post('/call', { entity_id: 'switch.steckdose', action: 'turn_on', role: 'admin' });
  assert.equal(c.status, 404);
  assert.ok(!(await g.api.get('/entities')).json.entities.some((e) => e.entity_id === 'switch.steckdose'));
});
