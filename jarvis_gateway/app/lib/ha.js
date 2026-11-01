const { EventEmitter } = require('events');
const WebSocket = require('ws');

class HaError extends Error {
  constructor(message, { status = null, unavailable = false } = {}) {
    super(message);
    this.status = status;
    this.unavailable = unavailable;
  }
}

// Verbindung zu Home Assistant ueber den Supervisor-Proxy: REST fuer Zustaende/Services,
// WebSocket fuer Registries, Assist-Freigaben und Zustandsaenderungen. Baut sich bei Abbruch selbst neu auf.
class HaClient extends EventEmitter {
  constructor({ restUrl, wsUrl, token, reconnectMinMs = 1000, reconnectMaxMs = 30000, heartbeatMs = 20000, requestTimeoutMs = 15000, log = console } = {}) {
    super();
    Object.assign(this, { restUrl: restUrl.replace(/\/+$/, ''), wsUrl, token, reconnectMinMs, reconnectMaxMs, heartbeatMs, requestTimeoutMs, log });
    this.connected = false;
    this.version = null;
    this.lastError = null;
    this.states = new Map();
    this.registry = { entities: new Map(), devices: new Map(), areas: new Map() };
    this.stopped = true;
    this.attempt = 0;
    this.ws = null;
    this.pending = new Map();
    this.nextId = 1;
  }

  start() {
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.hbTimer);
    clearTimeout(this.regTimer);
    if (this.ws) { try { this.ws.terminate(); } catch { /* egal */ } }
    this._setConnected(false);
  }

  _setConnected(v) {
    if (this.connected === v) return;
    this.connected = v;
    this.emit(v ? 'connected' : 'disconnected');
  }

  _connect() {
    if (this.stopped) return;
    let ws;
    try { ws = new WebSocket(this.wsUrl); } catch (e) { this._fail(null, e); return; }
    this.ws = ws;
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      this._onMessage(ws, msg);
    });
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', (e) => { this.lastError = e.message || String(e); });
    ws.on('close', () => this._fail(ws));
  }

  _fail(ws, err) {
    if (ws && ws !== this.ws) return;
    if (err) this.lastError = err.message;
    clearInterval(this.hbTimer);
    this._setConnected(false);
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new HaError('Home Assistant nicht erreichbar', { unavailable: true })); }
    this.pending.clear();
    this.ws = null;
    if (this.stopped) return;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectMinMs * 2 ** Math.min(this.attempt, 10));
    this.attempt++;
    this.log.warn?.(`Home Assistant getrennt (${this.lastError || 'unbekannt'}), neuer Versuch in ${delay} ms`);
    this.retryTimer = setTimeout(() => this._connect(), delay);
  }

  _onMessage(ws, msg) {
    if (msg.type === 'auth_required') {
      ws.send(JSON.stringify({ type: 'auth', access_token: this.token }));
    } else if (msg.type === 'auth_ok') {
      this.version = msg.ha_version || this.version;
      this._onAuthed(ws).catch((e) => {
        this.lastError = e.message;
        try { ws.terminate(); } catch { /* egal */ }
      });
    } else if (msg.type === 'auth_invalid') {
      this.lastError = 'Authentifizierung bei Home Assistant fehlgeschlagen';
      ws.close();
    } else if (msg.type === 'result' && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.success) p.resolve(msg.result);
      else p.reject(new HaError(msg.error?.message || 'Befehl fehlgeschlagen'));
    } else if (msg.type === 'event') {
      this._onEvent(msg.event);
    }
  }

  _send(payload) {
    return new Promise((resolve, reject) => {
      const ws = this.ws;
      if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new HaError('Home Assistant nicht erreichbar', { unavailable: true }));
      const id = this.nextId++;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new HaError('Zeitüberschreitung bei Home Assistant', { unavailable: true })); }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, ...payload }));
    });
  }

  async _onAuthed(ws) {
    this.states = new Map();
    await this._send({ type: 'subscribe_events', event_type: 'state_changed' });
    for (const t of ['entity_registry_updated', 'area_registry_updated', 'device_registry_updated']) {
      await this._send({ type: 'subscribe_events', event_type: t });
    }
    const [states] = await Promise.all([this.rest('GET', '/states'), this.loadRegistries()]);
    for (const s of states) this._applyState(s.entity_id, s);
    if (ws !== this.ws) return;
    this.attempt = 0;
    this.lastError = null;
    ws.alive = true;
    clearInterval(this.hbTimer);
    this.hbTimer = setInterval(() => {
      if (!ws.alive) { try { ws.terminate(); } catch { /* egal */ } return; }
      ws.alive = false;
      try { ws.ping(); } catch { /* egal */ }
    }, this.heartbeatMs);
    this.hbTimer.unref?.();
    this._setConnected(true);
  }

  _applyState(id, s) {
    const old = this.states.get(id);
    if (old && s && Date.parse(old.last_updated) > Date.parse(s.last_updated)) return;
    this.states.set(id, s);
  }

  _onEvent(ev) {
    if (!ev) return;
    if (ev.event_type === 'state_changed') {
      const { entity_id: id, new_state: ns } = ev.data || {};
      if (!id) return;
      if (ns) this.states.set(id, ns); else this.states.delete(id);
    } else if (/_registry_updated$/.test(ev.event_type)) {
      clearTimeout(this.regTimer);
      this.regTimer = setTimeout(() => this.loadRegistries().catch(() => {}), 500);
    }
  }

  async loadRegistries() {
    const [ents, devs, areas] = await Promise.allSettled([
      this._send({ type: 'config/entity_registry/list' }),
      this._send({ type: 'config/device_registry/list' }),
      this._send({ type: 'config/area_registry/list' }),
    ]);
    const toMap = (r, key) => new Map(r.status === 'fulfilled' ? r.value.map((x) => [x[key], x]) : []);
    if (ents.status === 'fulfilled') this.registry.entities = toMap(ents, 'entity_id');
    if (devs.status === 'fulfilled') this.registry.devices = toMap(devs, 'id');
    if (areas.status === 'fulfilled') this.registry.areas = toMap(areas, 'area_id');
    const failed = [ents, devs, areas].find((r) => r.status === 'rejected');
    if (failed) this.log.warn?.('Registry nur teilweise geladen: ' + failed.reason.message);
  }

  async rest(method, path, body) {
    let res;
    try {
      res = await fetch(this.restUrl + path, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.requestTimeoutMs),
      });
    } catch (e) {
      throw new HaError('Home Assistant nicht erreichbar', { unavailable: true });
    }
    if (!res.ok) throw new HaError(`Home Assistant antwortete mit HTTP ${res.status}`, { status: res.status, unavailable: res.status >= 502 });
    try { return await res.json(); } catch { return null; }
  }

  callService(domain, service, data) {
    return this.rest('POST', `/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`, data);
  }

  async getState(entityId) {
    return this.rest('GET', `/states/${encodeURIComponent(entityId)}`);
  }

  // Entitaeten, die in Assist (Assistent "conversation") freigegeben sind
  async assistExposed() {
    const res = await this._send({ type: 'homeassistant/expose_entity/list' });
    const out = new Set();
    for (const [id, a] of Object.entries(res?.exposed_entities || {})) if (a && a.conversation === true) out.add(id);
    return out;
  }

  areaOf(entityId) {
    const reg = this.registry.entities.get(entityId);
    const areaId = reg?.area_id || (reg?.device_id && this.registry.devices.get(reg.device_id)?.area_id);
    return areaId ? this.registry.areas.get(areaId)?.name || null : null;
  }

  haName(entityId) {
    const s = this.states.get(entityId);
    const reg = this.registry.entities.get(entityId);
    return s?.attributes?.friendly_name || reg?.name || reg?.original_name || entityId;
  }

  isHidden(entityId) {
    const reg = this.registry.entities.get(entityId);
    return !!(reg && (reg.disabled_by || reg.hidden_by));
  }
}

module.exports = { HaClient, HaError };
