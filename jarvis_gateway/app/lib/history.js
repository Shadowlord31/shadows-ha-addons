const D = require('./domains');
const { ApiError } = require('./gateway');

const TZ = 'Europe/Berlin';
const MAX_SPAN_MS = 31 * 86400000;
const DEFAULT_SPAN_MS = 24 * 3600000;
const MAX_POINTS = 5000;
const INTERVALS = ['raw', 'hour', 'day'];
const IGNORED_STATES = new Set(['unavailable', 'unknown', '']);

const partsFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const offFmt = new Intl.DateTimeFormat('en-US', { timeZone: TZ, timeZoneName: 'longOffset', year: 'numeric' });

function localParts(ms) {
  const p = {};
  for (const x of partsFmt.formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return p;
}
// Offset (Minuten) von Europe/Berlin gegenueber UTC zum Zeitpunkt ms
function offsetMin(ms) {
  const name = offFmt.formatToParts(new Date(ms)).find((x) => x.type === 'timeZoneName').value; // "GMT+02:00" / "GMT"
  const m = /GMT([+-])(\d\d):(\d\d)/.exec(name);
  return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
}
const pad = (n) => String(n).padStart(2, '0');
function offsetStr(ms) {
  const o = offsetMin(ms);
  const a = Math.abs(o);
  return `${o < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}
function label(ms) {
  const p = localParts(ms);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${offsetStr(ms)}`;
}
// Lokale Berliner Wandzeit -> Epoch-ms
function berlinToEpoch(y, mo, d, h = 0, mi = 0, s = 0) {
  const guess = Date.UTC(y, mo - 1, d, h, mi, s);
  let t = guess - offsetMin(guess) * 60000;
  t = guess - offsetMin(t) * 60000;
  return t;
}
function dayStart(ms) {
  const p = localParts(ms);
  return berlinToEpoch(p.year, p.month, p.day);
}

const ISO_RE = /^(\d{4})-(\d\d)-(\d\d)(?:[T ](\d\d):(\d\d)(?::(\d\d)(?:\.\d{1,3})?)?)?(Z|[+-]\d\d:?\d\d)?$/;
function parseTime(raw, name) {
  if (typeof raw !== 'string') throw new ApiError(400, 'invalid_request', `${name} muss ein ISO-8601-Zeitpunkt sein`);
  // "+" im Query-String wird oft als Leerzeichen dekodiert
  const s = raw.trim().replace(/ (\d\d:?\d\d)$/, '+$1');
  const m = ISO_RE.exec(s);
  const bad = () => new ApiError(400, 'invalid_request', `${name} muss ein ISO-8601-Zeitpunkt sein`);
  if (!m) throw bad();
  const [y, mo, d, h = 0, mi = 0, sec = 0] = m.slice(1, 7).map((v) => (v === undefined ? 0 : Number(v)));
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) throw bad();
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1) throw bad();
  let ms;
  if (m[7]) {
    ms = Date.parse(s.replace(' ', 'T').replace(/([+-]\d\d)(\d\d)$/, '$1:$2'));
  } else {
    ms = berlinToEpoch(y, mo, d, h, mi, sec); // ohne Zonenangabe gilt Europe/Berlin
  }
  if (!Number.isFinite(ms)) throw bad();
  return ms;
}

function numeric(state) {
  if (typeof state !== 'string' || IGNORED_STATES.has(state.toLowerCase())) return null;
  const v = Number(state);
  return Number.isFinite(v) ? v : NaN;
}

function aggregate(points, interval) {
  const buckets = new Map();
  let sawText = false;
  for (const p of points) {
    const v = numeric(p.state);
    if (v === null) continue;
    if (Number.isNaN(v)) { sawText = true; continue; }
    const key = interval === 'hour' ? Math.floor(p.ms / 3600000) * 3600000 : dayStart(p.ms);
    let b = buckets.get(key);
    if (!b) { b = { t: key, min: v, max: v, sum: 0, first: v, last: v, count: 0 }; buckets.set(key, b); }
    b.min = Math.min(b.min, v);
    b.max = Math.max(b.max, v);
    b.sum += v;
    b.last = v;
    b.count++;
  }
  if (sawText) throw new ApiError(400, 'not_numeric', 'Dieser Verlauf hat nicht numerische Zustände; nur interval=raw ist möglich');
  const round = (x) => Math.round(x * 1e6) / 1e6;
  return [...buckets.values()].sort((a, b) => a.t - b.t).map((b) => ({ t: label(b.t), min: b.min, max: b.max, mean: round(b.sum / b.count), first: b.first, last: b.last, count: b.count }));
}

class History {
  constructor({ ha, store, gateway, audit, now = () => Date.now() }) {
    Object.assign(this, { ha, store, gateway, audit, now });
  }

  async get(q) {
    const raw = typeof q.entity_id === 'string' ? q.entity_id : '';
    const meta = { entity_id: raw, action: 'read_history', params: { interval: q.interval, start: q.start, end: q.end } };
    try {
      const res = await this._get(q);
      this.audit.add({ ...meta, entity_id: res.entity_id, result: 'ok' });
      return res;
    } catch (e) {
      if (e instanceof ApiError) this.audit.add({ ...meta, result: e.status >= 500 ? 'error' : 'denied', code: e.code, reason: e.message });
      else this.audit.add({ ...meta, result: 'error', code: 'internal', reason: 'Interner Fehler' });
      throw e;
    }
  }

  async _get(q) {
    const id = q.entity_id;
    if (typeof id !== 'string' || !D.ENTITY_ID_RE.test(id)) throw new ApiError(400, 'invalid_entity_id', 'entity_id fehlt oder ist ungültig');
    const cfg = this.store.get(id);
    if (!cfg || (cfg.access !== 'read' && cfg.access !== 'control')) throw new ApiError(403, 'not_exposed', 'Diese Entität ist nicht freigegeben');
    const interval = q.interval === undefined ? 'raw' : q.interval;
    if (!INTERVALS.includes(interval)) throw new ApiError(400, 'invalid_request', 'interval muss raw, hour oder day sein');
    const nowMs = this.now();
    const end = q.end === undefined ? nowMs : parseTime(q.end, 'end');
    const start = q.start === undefined ? end - DEFAULT_SPAN_MS : parseTime(q.start, 'start');
    if (end <= start) throw new ApiError(400, 'invalid_request', 'end muss nach start liegen');
    if (end - start > MAX_SPAN_MS) throw new ApiError(400, 'range_too_large', 'Der Zeitraum darf höchstens 31 Tage umfassen');

    if (!this.ha.connected) throw new ApiError(503, 'ha_unavailable', 'Home Assistant ist derzeit nicht erreichbar');
    if (!this.ha.states.has(id)) throw new ApiError(404, 'entity_missing', 'Entität existiert in Home Assistant nicht mehr');

    const path = `/history/period/${encodeURIComponent(new Date(start).toISOString())}?filter_entity_id=${encodeURIComponent(id)}`
      + `&end_time=${encodeURIComponent(new Date(end).toISOString())}&minimal_response&no_attributes&significant_changes_only=0`;
    let data;
    try {
      data = await this.ha.rest('GET', path);
    } catch (e) {
      if (e.unavailable) throw new ApiError(503, 'ha_unavailable', 'Home Assistant ist derzeit nicht erreichbar');
      throw new ApiError(502, 'ha_error', `Home Assistant hat den Aufruf abgelehnt (${e.status ?? 'Fehler'})`);
    }
    const series = Array.isArray(data) && Array.isArray(data[0]) ? data[0] : [];
    const points = [];
    for (const s of series) {
      if (!s || typeof s.state !== 'string') continue;
      const ms = Date.parse(s.last_changed || s.last_updated);
      if (!Number.isFinite(ms)) continue;
      points.push({ ms: Math.max(ms, start), state: s.state });
    }

    const unit = this.gateway.filteredAttributes(id, cfg, this.ha.states.get(id)).unit_of_measurement;
    const head = { entity_id: id, interval, start: label(start), end: label(end), timezone: TZ };
    if (unit !== undefined) head.unit_of_measurement = unit;

    if (interval === 'raw') {
      if (points.length > MAX_POINTS) throw new ApiError(413, 'too_many_points', `Zu viele Datenpunkte (${points.length}, erlaubt ${MAX_POINTS}); bitte interval=hour oder interval=day verwenden oder den Zeitraum verkleinern`);
      return { ...head, points: points.map((p) => ({ t: label(p.ms), state: p.state })) };
    }
    return { ...head, points: aggregate(points, interval) };
  }
}

module.exports = { History, parseTime, label, MAX_POINTS };
