// Mock fuer Supervisor-REST (/core/api) und -WebSocket (/core/websocket). Beruehrt keine echten Geraete.
const http = require('http');
const { WebSocketServer } = require('ws');

const TOKEN = 'mock-supervisor-token';

function st(entity_id, state, attributes = {}) {
  const now = new Date().toISOString();
  return { entity_id, state, attributes, last_changed: now, last_updated: now, context: {} };
}

class MockHa {
  constructor() {
    this.token = TOKEN;
    this.version = '2025.1.0-mock';
    this.states = new Map();
    this.entityRegistry = [];
    this.deviceRegistry = [];
    this.areaRegistry = [];
    this.exposed = {}; // entity_id -> {conversation: bool}
    this.serviceCalls = [];
    this.restRequests = 0;
    this.failServices = null; // HTTP-Status, mit dem Service-Calls scheitern
    this.serviceDelayMs = 0;
    this.history = {}; // entity_id -> [{state, last_changed}]
    this.historyRequests = [];
    this.paused = false;
    this.sockets = new Set();
    this.subs = new Map(); // socket -> Set(event types)
  }

  seed() {
    this.areaRegistry = [
      { area_id: 'wohnzimmer', name: 'Wohnzimmer' },
      { area_id: 'kueche', name: 'Küche' },
      { area_id: 'flur', name: 'Flur' },
    ];
    this.deviceRegistry = [{ id: 'dev_tv', area_id: 'wohnzimmer' }];
    this.entityRegistry = [
      { entity_id: 'light.wohnzimmer', area_id: 'wohnzimmer' },
      { entity_id: 'light.kueche', area_id: 'kueche' },
      { entity_id: 'light.flur', area_id: 'flur' },
      { entity_id: 'light.lampe_a', area_id: 'wohnzimmer', name: 'Lampe' },
      { entity_id: 'light.lampe_b', area_id: 'kueche', name: 'Lampe' },
      { entity_id: 'light.versteckt', hidden_by: 'user' },
      { entity_id: 'light.deaktiviert', disabled_by: 'user' },
      { entity_id: 'media_player.tv', device_id: 'dev_tv' },
    ];
    const S = (id, s, a) => this.states.set(id, st(id, s, a));
    S('light.wohnzimmer', 'on', { friendly_name: 'Wohnzimmer Licht', brightness: 128, color_temp: 300, color_temp_kelvin: 3300, rgb_color: [255, 200, 100], hs_color: [30, 40], xy_color: [0.4, 0.4], supported_features: 44, entity_picture: '/secret.png', min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500 });
    S('light.kueche', 'off', { friendly_name: 'Küche Licht' });
    S('light.flur', 'off', { friendly_name: 'Flur Licht' });
    S('light.lampe_a', 'off', { friendly_name: 'Lampe' });
    S('light.lampe_b', 'off', { friendly_name: 'Lampe' });
    S('light.versteckt', 'off', { friendly_name: 'Versteckt' });
    S('switch.steckdose', 'off', { friendly_name: 'Steckdose', secret_note: 'geheim' });
    S('climate.wohnzimmer', 'heat', { friendly_name: 'Heizung Wohnzimmer', current_temperature: 20.5, temperature: 21, hvac_action: 'heating', hvac_modes: ['off', 'heat', 'auto'], preset_modes: ['eco', 'comfort'], preset_mode: 'comfort', min_temp: 7, max_temp: 28, ip_address: '192.168.1.5' });
    S('cover.rollo', 'closed', { friendly_name: 'Rollo', current_position: 0, device_class: 'shade' });
    S('media_player.tv', 'playing', { friendly_name: 'Fernseher', volume_level: 0.3, media_title: 'Tagesschau', is_volume_muted: false, entity_picture: '/api/media_player_proxy/x?token=abc', source_list: ['HDMI1'] });
    S('lock.haustuer', 'locked', { friendly_name: 'Haustür' });
    S('sensor.temperatur', '21.4', { friendly_name: 'Temperatur', unit_of_measurement: '°C', device_class: 'temperature', latitude: 1.1 });
    S('binary_sensor.tuer', 'off', { friendly_name: 'Tür', device_class: 'door' });
    S('weather.zuhause', 'sunny', { friendly_name: 'Wetter', temperature: 18, humidity: 50, forecast: [{ a: 1 }] });
    S('person.thomas', 'home', { friendly_name: 'Thomas', latitude: 52.5, longitude: 13.4, gps_accuracy: 5, source: 'device_tracker.phone' });
    S('script.gute_nacht', 'off', { friendly_name: 'Gute Nacht' });
    S('scene.film', 'unknown', { friendly_name: 'Film' });
    S('input_number.ziel', '10', { friendly_name: 'Ziel', min: 0, max: 50, step: 1 });
    S('input_select.modus', 'Zuhause', { friendly_name: 'Modus', options: ['Zuhause', 'Abwesend', 'Urlaub'] });
    S('fan.luefter', 'off', { friendly_name: 'Lüfter' });
    S('vacuum.saugi', 'docked', { friendly_name: 'Saugi', battery_level: 80, status: 'Docked' });
    this.exposed = {
      'light.wohnzimmer': { conversation: true },
      'light.kueche': { conversation: true },
      'switch.steckdose': { conversation: true },
      'sensor.temperatur': { conversation: true },
      'lock.haustuer': { conversation: true },
      'light.versteckt': { conversation: true },
      'light.flur': { conversation: false, 'cloud.alexa': true },
    };
    return this;
  }

  setState(id, state, attrs) {
    const old = this.states.get(id);
    const ns = st(id, state, attrs ?? old?.attributes ?? {});
    this.states.set(id, ns);
    this._broadcast('state_changed', { entity_id: id, old_state: old || null, new_state: ns });
  }

  removeState(id) {
    const old = this.states.get(id);
    this.states.delete(id);
    this._broadcast('state_changed', { entity_id: id, old_state: old, new_state: null });
  }

  _broadcast(type, data) {
    for (const ws of this.sockets) {
      for (const [sid, t] of this.subs.get(ws) || []) {
        if (t === type) ws.send(JSON.stringify({ id: sid, type: 'event', event: { event_type: type, data } }));
      }
    }
  }

  _applyService(domain, service, data) {
    const id = data.entity_id;
    const s = this.states.get(id);
    if (!s) return;
    const a = { ...s.attributes };
    let state = s.state;
    if (service === 'turn_on') { state = 'on'; if (data.brightness_pct !== undefined) a.brightness = Math.round(data.brightness_pct * 2.55); }
    else if (service === 'turn_off') state = 'off';
    else if (service === 'toggle') state = s.state === 'on' ? 'off' : 'on';
    else if (service === 'set_temperature') a.temperature = data.temperature;
    else if (service === 'lock') state = 'locked';
    else if (service === 'unlock') state = 'unlocked';
    else if (service === 'open_cover') state = 'open';
    else if (service === 'close_cover') state = 'closed';
    else if (service === 'set_cover_position') { a.current_position = data.position; state = data.position > 0 ? 'open' : 'closed'; }
    else if (service === 'volume_set') a.volume_level = data.volume_level;
    else if (service === 'select_option') state = data.option;
    else if (service === 'set_value') state = String(data.value);
    this.setState(id, state, a);
  }

  start() {
    this.server = http.createServer((req, res) => this._rest(req, res));
    this.wss = new WebSocketServer({ noServer: true });
    this.server.on('upgrade', (req, socket, head) => {
      if (this.paused || req.url !== '/core/websocket') return socket.destroy();
      this.wss.handleUpgrade(req, socket, head, (ws) => this._ws(ws));
    });
    return new Promise((resolve) => this.server.listen(0, '127.0.0.1', () => {
      const port = this.server.address().port;
      this.restUrl = `http://127.0.0.1:${port}/core/api`;
      this.wsUrl = `ws://127.0.0.1:${port}/core/websocket`;
      resolve(this);
    }));
  }

  async stop() {
    this.dropConnections();
    await new Promise((r) => this.server.close(r));
    this.server.closeAllConnections?.();
  }

  dropConnections() {
    for (const ws of this.sockets) ws.terminate();
    this.sockets.clear();
  }

  pause() { this.paused = true; this.dropConnections(); }
  resume() { this.paused = false; }

  _rest(req, res) {
    this.restRequests++;
    if (this.paused) { res.statusCode = 503; return res.end('down'); }
    if (req.headers.authorization !== `Bearer ${this.token}`) { res.statusCode = 401; return res.end('{}'); }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const url = req.url.replace(/^\/core\/api/, '');
      const json = (code, obj) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(obj)); };
      let hm;
      if (req.method === 'GET' && (hm = url.match(/^\/history\/period\/([^?]+)\?(.*)$/))) {
        const q = new URLSearchParams(hm[2]);
        this.historyRequests.push({ start: decodeURIComponent(hm[1]), query: Object.fromEntries(q), raw: hm[2] });
        const id = q.get('filter_entity_id');
        const from = Date.parse(decodeURIComponent(hm[1])), to = Date.parse(q.get('end_time'));
        const rows = (this.history[id] || []).filter((r) => { const t = Date.parse(r.last_changed); return t >= from && t < to; });
        return json(200, rows.length ? [rows.map((r, i) => (i === 0 ? { entity_id: id, ...r } : r))] : []);
      }
      if (req.method === 'GET' && url === '/states') return json(200, [...this.states.values()]);
      let m;
      if (req.method === 'GET' && (m = url.match(/^\/states\/(.+)$/))) {
        const s = this.states.get(decodeURIComponent(m[1]));
        return s ? json(200, s) : json(404, { message: 'Entity not found.' });
      }
      if (req.method === 'POST' && (m = url.match(/^\/services\/([^/]+)\/([^/]+)$/))) {
        const data = body ? JSON.parse(body) : {};
        if (this.serviceDelayMs) await new Promise((r) => setTimeout(r, this.serviceDelayMs));
        this.serviceCalls.push({ domain: m[1], service: m[2], data });
        if (this.failServices) return json(this.failServices, { message: 'geheime Interna' });
        this._applyService(m[1], m[2], data);
        return json(200, []);
      }
      json(404, { message: 'not found' });
    });
  }

  _ws(ws) {
    this.sockets.add(ws);
    this.subs.set(ws, new Map());
    ws.on('close', () => { this.sockets.delete(ws); this.subs.delete(ws); });
    ws.send(JSON.stringify({ type: 'auth_required', ha_version: this.version }));
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'auth') {
        if (msg.access_token === this.token) ws.send(JSON.stringify({ type: 'auth_ok', ha_version: this.version }));
        else { ws.send(JSON.stringify({ type: 'auth_invalid', message: 'bad' })); }
        return;
      }
      const ok = (result) => ws.send(JSON.stringify({ id: msg.id, type: 'result', success: true, result }));
      switch (msg.type) {
        case 'subscribe_events': this.subs.get(ws).set(msg.id, msg.event_type); return ok(null);
        case 'config/entity_registry/list': return ok(this.entityRegistry);
        case 'config/device_registry/list': return ok(this.deviceRegistry);
        case 'config/area_registry/list': return ok(this.areaRegistry);
        case 'homeassistant/expose_entity/list': return ok({ exposed_entities: this.exposed });
        default: return ws.send(JSON.stringify({ id: msg.id, type: 'result', success: false, error: { code: 'unknown_command', message: 'Unknown command' } }));
      }
    });
  }
}

module.exports = { MockHa, TOKEN };
