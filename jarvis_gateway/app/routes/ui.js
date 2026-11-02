const express = require('express');
const D = require('../lib/domains');
const { normalizeConfig, defaultConfig, ValidationError } = require('../lib/config');
const { ApiError } = require('../lib/gateway');

const EXPORT_FORMAT = 'jarvis-gateway-settings';
const CHOICE_ATTRS = ['hvac_modes', 'preset_modes', 'options', 'min_temp', 'max_temp', 'min', 'max', 'fan_modes', 'source_list', 'effect_list', 'activity_list', 'available_modes'];

function wrap(fn) {
  return async (req, res, next) => {
    try { res.json(await fn(req, res)); } catch (e) { next(e instanceof ValidationError ? new ApiError(400, 'validation', e.message) : e); }
  };
}

module.exports = function ui({ gateway, ha, store, audit }) {
  const r = express.Router();

  const needHa = () => { if (!ha.connected) throw new ApiError(503, 'ha_unavailable', 'Home Assistant ist derzeit nicht erreichbar'); };
  const attrsOf = (id) => ha.states.get(id)?.attributes;
  const assistOrNull = async () => {
    if (!ha.connected) return null;
    try { return await ha.assistExposed(); } catch { return null; }
  };
  const idParam = (req) => {
    const id = req.params.id;
    if (!D.ENTITY_ID_RE.test(id)) throw new ApiError(400, 'invalid_entity_id', 'Ungültige entity_id');
    return id;
  };

  r.get('/meta', wrap(() => ({ ...D.templates(), roles: D.MIN_ROLES, retention_days: 90 })));

  r.get('/state', wrap(async () => {
    const assist = await assistOrNull();
    const entities = [];
    for (const [id, s] of ha.states) {
      if (ha.isHidden(id)) continue;
      const cfg = store.get(id);
      entities.push({
        entity_id: id,
        domain: D.domainOf(id),
        ha_name: ha.haName(id),
        area: ha.areaOf(id),
        state: s.state,
        configured: !!cfg,
        access: cfg ? cfg.access : null,
        name: cfg?.name || null,
        room: cfg?.room || null,
        assist: assist ? assist.has(id) : null,
        controllable: D.isControllable(D.domainOf(id)),
      });
    }
    const missing = Object.keys(store.entities).filter((id) => ha.connected && !ha.states.has(id));
    return {
      ha_connected: ha.connected,
      ha_version: ha.version,
      ha_error: ha.connected ? null : ha.lastError,
      assist_available: assist !== null,
      areas: [...new Set(entities.map((e) => e.area).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'de')),
      domains: [...new Set(entities.map((e) => e.domain))].sort(),
      entities,
      missing,
    };
  }));

  r.get('/entity/:id', wrap((req) => {
    const id = idParam(req);
    const cfg = store.get(id);
    const attrs = attrsOf(id);
    if (!cfg && !attrs) throw new ApiError(404, 'not_found', 'Entität unbekannt');
    const choices = {};
    for (const a of CHOICE_ATTRS) if (attrs && attrs[a] !== undefined && attrs[a] !== null) choices[a] = attrs[a];
    return {
      entity_id: id,
      domain: D.domainOf(id),
      ha_name: ha.haName(id),
      area: ha.areaOf(id),
      state: ha.states.get(id)?.state ?? null,
      configured: !!cfg,
      choices,
      config: cfg || defaultConfig(id, attrs),
      defaults: defaultConfig(id, attrs),
    };
  }));

  r.put('/entity/:id', wrap((req) => {
    const id = idParam(req);
    needHa();
    if (!ha.states.has(id) && !store.has(id)) throw new ApiError(404, 'not_found', 'Entität unbekannt');
    const cfg = normalizeConfig(id, req.body, attrsOf(id));
    store.update((ents) => { ents[id] = cfg; });
    return { ok: true, config: cfg };
  }));

  r.delete('/entity/:id', wrap((req) => {
    const id = idParam(req);
    store.update((ents) => { delete ents[id]; });
    return { ok: true };
  }));

  r.post('/bulk', wrap((req) => {
    needHa();
    const { entity_ids: ids, access } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 5000) throw new ApiError(400, 'validation', 'entity_ids: Liste mit 1 bis 5000 Einträgen erwartet');
    if (!['off', 'read', 'control'].includes(access)) throw new ApiError(400, 'validation', 'access muss off, read oder control sein');
    const skipped = [];
    let changed = 0;
    let downgraded = 0;
    store.update((ents) => {
      for (const id of ids) {
        if (typeof id !== 'string' || !D.ENTITY_ID_RE.test(id) || (!ha.states.has(id) && !Object.hasOwn(ents, id))) { skipped.push(String(id).slice(0, 80)); continue; }
        const base = Object.hasOwn(ents, id) ? ents[id] : defaultConfig(id, attrsOf(id));
        ents[id] = normalizeConfig(id, { ...base, access }, attrsOf(id));
        if (access === 'control' && ents[id].access !== 'control') downgraded++;
        changed++;
      }
    });
    return { ok: true, changed, skipped, downgraded };
  }));

  // ---- Assist-Uebernahme ----
  r.get('/assist-preview', wrap(async () => {
    needHa();
    const assist = await ha.assistExposed();
    const items = [];
    let alreadyConfigured = 0;
    for (const id of assist) {
      if (!ha.states.has(id) || ha.isHidden(id)) continue;
      if (store.has(id)) { alreadyConfigured++; continue; }
      const p = defaultConfig(id, attrsOf(id));
      items.push({
        entity_id: id,
        name: ha.haName(id),
        area: ha.areaOf(id),
        domain: D.domainOf(id),
        controllable: D.isControllable(D.domainOf(id)),
        proposed: { access: p.access, confirm: p.confirm, min_role: p.min_role, actions: Object.keys(p.actions) },
      });
    }
    items.sort((a, b) => a.name.localeCompare(b.name, 'de'));
    return { items, already_configured: alreadyConfigured };
  }));

  r.post('/assist-import', wrap(async (req) => {
    needHa();
    const ids = req.body?.entity_ids;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 5000) throw new ApiError(400, 'validation', 'entity_ids: Liste mit 1 bis 5000 Einträgen erwartet');
    const assist = await ha.assistExposed();
    const imported = [];
    const skipped = [];
    store.update((ents) => {
      for (const id of ids) {
        if (typeof id !== 'string' || !D.ENTITY_ID_RE.test(id)) { skipped.push({ entity_id: String(id).slice(0, 80), reason: 'ungültig' }); continue; }
        if (Object.hasOwn(ents, id)) { skipped.push({ entity_id: id, reason: 'bereits konfiguriert' }); continue; }
        if (!assist.has(id) || !ha.states.has(id)) { skipped.push({ entity_id: id, reason: 'nicht in Assist freigegeben' }); continue; }
        ents[id] = normalizeConfig(id, defaultConfig(id, attrsOf(id)), attrsOf(id));
        imported.push(id);
      }
    });
    return { ok: true, imported, skipped };
  }));

  // ---- Protokoll ----
  r.get('/audit', wrap((req) => audit.query(req.query)));

  // ---- Export / Import ----
  r.get('/export', (req, res) => {
    const body = { format: EXPORT_FORMAT, version: 1, exported_at: new Date().toISOString(), entities: store.entities };
    if (req.query.download) res.set('Content-Disposition', 'attachment; filename="jarvis-gateway-einstellungen.json"');
    res.json(body);
  });

  r.post('/import', wrap((req) => {
    const body = req.body || {};
    const mode = body.mode === 'replace' ? 'replace' : 'merge';
    const src = body.entities;
    if (!src || typeof src !== 'object' || Array.isArray(src)) throw new ApiError(400, 'validation', 'entities: Objekt erwartet');
    if (body.format !== undefined && body.format !== EXPORT_FORMAT) throw new ApiError(400, 'validation', 'Unbekanntes Dateiformat');
    const ids = Object.keys(src);
    if (ids.length > 5000) throw new ApiError(400, 'validation', 'Zu viele Einträge');
    const clean = {};
    const errors = [];
    for (const id of ids) {
      try {
        const cfg = src[id];
        // Import ist eine vollstaendige Konfiguration: fehlende Felder bekommen Standardwerte, unbekannte werden verworfen
        clean[id] = normalizeConfig(id, cfg, attrsOf(id));
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
        errors.push(e.message);
      }
    }
    if (errors.length) throw new ApiError(400, 'validation', 'Import abgelehnt: ' + errors.slice(0, 5).join('; '), { details: errors.slice(0, 50) });
    store.update((ents) => {
      if (mode === 'replace') for (const k of Object.keys(ents)) delete ents[k];
      Object.assign(ents, clean);
    });
    return { ok: true, mode, imported: ids.length };
  }));

  r.use((req, res, next) => next(new ApiError(404, 'not_found', 'Unbekannter Endpunkt')));
  return r;
};
