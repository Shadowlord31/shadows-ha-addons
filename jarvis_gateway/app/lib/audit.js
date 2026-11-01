const fs = require('fs');
const path = require('path');

const RETENTION_DAYS = 90;
const MAX_ENTRIES = 100000;
const SECRET_KEY_RE = /token|passw|secret|authorization|api[_-]?key/i;

function redact(value, depth = 0) {
  if (depth > 3) return '…';
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value).slice(0, 20)) out[k.slice(0, 40)] = SECRET_KEY_RE.test(k) ? '[entfernt]' : redact(v, depth + 1);
    return out;
  }
  return typeof value === 'string' ? value.slice(0, 120) : value;
}

class Audit {
  constructor(dir, { now = () => Date.now(), retentionDays = RETENTION_DAYS } = {}) {
    this.file = path.join(dir, 'audit.jsonl');
    this.now = now;
    this.retentionMs = retentionDays * 86400000;
    this.items = [];
    this._load();
    this.prune();
    this.timer = setInterval(() => this.prune(), 3600000);
    this.timer.unref();
  }

  _load() {
    if (!fs.existsSync(this.file)) return;
    for (const line of fs.readFileSync(this.file, 'utf8').split('\n')) {
      if (!line) continue;
      try { this.items.push(JSON.parse(line)); } catch { /* defekte Zeile ueberspringen */ }
    }
  }

  stop() { clearInterval(this.timer); }

  add(entry) {
    const e = {
      ts: new Date(this.now()).toISOString(),
      entity_id: String(entry.entity_id ?? '').slice(0, 120),
      action: String(entry.action ?? '').slice(0, 60),
      params: redact(entry.params ?? {}),
      person: entry.person ? String(entry.person).slice(0, 80) : null,
      role: entry.role ? String(entry.role).slice(0, 20) : null,
      result: entry.result, // ok | denied | error
      code: entry.code || null,
      reason: entry.reason ? String(entry.reason).slice(0, 300) : null,
    };
    this.items.push(e);
    if (this.items.length > MAX_ENTRIES) this.items.splice(0, this.items.length - MAX_ENTRIES);
    try { fs.appendFileSync(this.file, JSON.stringify(e) + '\n'); } catch (err) { console.error('Protokoll nicht schreibbar:', err.message); }
    return e;
  }

  prune() {
    const cutoff = this.now() - this.retentionMs;
    const kept = this.items.filter((e) => Date.parse(e.ts) >= cutoff);
    if (kept.length === this.items.length && fs.existsSync(this.file)) return;
    this.items = kept;
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, kept.map((e) => JSON.stringify(e)).join('\n') + (kept.length ? '\n' : ''));
    fs.renameSync(tmp, this.file);
  }

  query({ q, result, action, person, code, since, until, limit = 100, offset = 0 } = {}) {
    const ql = q ? String(q).toLowerCase() : '';
    const sinceMs = since ? Date.parse(since) : null;
    const untilMs = until ? Date.parse(until) : null;
    const rows = [];
    for (let i = this.items.length - 1; i >= 0; i--) {
      const e = this.items[i];
      if (result && e.result !== result) continue;
      if (action && e.action !== action) continue;
      if (code && e.code !== code) continue;
      if (person && !(e.person || '').toLowerCase().includes(String(person).toLowerCase())) continue;
      if (ql && !e.entity_id.toLowerCase().includes(ql)) continue;
      const t = Date.parse(e.ts);
      if (sinceMs && t < sinceMs) continue;
      if (untilMs && t > untilMs) continue;
      rows.push(e);
    }
    const lim = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
    const off = Math.max(parseInt(offset, 10) || 0, 0);
    return { total: rows.length, items: rows.slice(off, off + lim) };
  }
}

module.exports = { Audit, RETENTION_DAYS };
