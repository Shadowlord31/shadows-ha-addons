const fs = require('fs');
const path = require('path');
const { ENTITY_ID_RE } = require('./domains');

const KEEP_BACKUPS = 20;

class Store {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'settings.json');
    this.backupDir = path.join(dir, 'backups');
    this.seq = 0;
    fs.mkdirSync(this.backupDir, { recursive: true });
    this.data = this._load();
  }

  _parse(file) {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const entities = {};
    for (const [id, cfg] of Object.entries(raw.entities || {})) {
      if (ENTITY_ID_RE.test(id) && cfg && typeof cfg === 'object') entities[id] = cfg;
    }
    return { version: 1, entities };
  }

  _load() {
    if (fs.existsSync(this.file)) {
      try { return this._parse(this.file); } catch (e) {
        console.error('settings.json unlesbar, versuche Sicherung:', e.message);
        try { fs.renameSync(this.file, path.join(this.dir, `settings.corrupt-${Date.now()}.json`)); } catch { /* ignorieren */ }
        const backups = this.listBackups().reverse();
        for (const b of backups) {
          try { return this._parse(path.join(this.backupDir, b)); } catch { /* naechste */ }
        }
      }
    }
    return { version: 1, entities: {} };
  }

  listBackups() {
    return fs.readdirSync(this.backupDir).filter((f) => /^settings-.*\.json$/.test(f)).sort();
  }

  get entities() { return this.data.entities; }

  has(id) { return Object.hasOwn(this.data.entities, id); }
  get(id) { return this.has(id) ? this.data.entities[id] : null; }

  // mutator bekommt eine Kopie; erst nach Rueckkehr ohne Fehler wird gesichert und geschrieben
  update(mutator) {
    const draft = structuredClone(this.data);
    mutator(draft.entities);
    this._save(draft);
    this.data = draft;
  }

  _save(data) {
    if (fs.existsSync(this.file)) {
      const ts = new Date().toISOString().replace(/[-:TZ.]/g, '');
      const name = `settings-${ts}-${String(this.seq++ % 10000).padStart(4, '0')}.json`;
      fs.copyFileSync(this.file, path.join(this.backupDir, name));
      const all = this.listBackups();
      for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) fs.rmSync(path.join(this.backupDir, old), { force: true });
    }
    const tmp = `${this.file}.tmp`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, JSON.stringify({ ...data, updated_at: new Date().toISOString() }, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
  }
}

module.exports = { Store, KEEP_BACKUPS };
