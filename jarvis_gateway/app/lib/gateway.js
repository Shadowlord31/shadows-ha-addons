const D = require('./domains');
const { HaError } = require('./ha');

class ApiError extends Error {
  constructor(status, code, message, extra) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function fold(s) {
  return String(s).toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u').replace(/[^a-z0-9]+/g, ' ').trim();
}

const TZ = 'Europe/Berlin';
function berlinMinutes(ms) {
  const parts = new Intl.DateTimeFormat('de-DE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return get('hour') * 60 + get('minute');
}
function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function inQuiet(quiet, nowMs) {
  if (!quiet) return false;
  const now = berlinMinutes(nowMs);
  const from = toMinutes(quiet.from);
  const to = toMinutes(quiet.to);
  return from < to ? now >= from && now < to : now >= from || now < to;
}

class Gateway {
  constructor({ ha, store, audit, now = () => Date.now() }) {
    Object.assign(this, { ha, store, audit, now });
    this.locks = new Map();
  }

  // ---- Sichten ----
  exposedIds() {
    return Object.entries(this.store.entities).filter(([, c]) => c.access === 'read' || c.access === 'control').map(([id]) => id);
  }

  effectiveName(id, cfg) { return cfg.name || this.ha.haName(id); }
  effectiveRoom(id, cfg) { return cfg.room || this.ha.areaOf(id) || null; }

  filteredAttributes(id, cfg, state) {
    const domain = D.domainOf(id);
    const allowed = D.attributesFor(domain).filter((a) => (cfg.attributes || []).includes(a));
    const attrs = {};
    const src = state?.attributes || {};
    for (const a of allowed) {
      const v = src[a];
      if (v === undefined || v === null) continue;
      if (['string', 'number', 'boolean'].includes(typeof v)) attrs[a] = v;
      else if (Array.isArray(v) && v.length <= 50 && v.every((x) => ['string', 'number', 'boolean'].includes(typeof x))) attrs[a] = v;
    }
    if (allowed.includes('brightness') && typeof attrs.brightness === 'number') attrs.brightness_pct = Math.round((attrs.brightness / 255) * 100);
    return attrs;
  }

  actionsView(id, cfg, state) {
    const domain = D.domainOf(id);
    const out = {};
    if (cfg.access !== 'control') return out;
    for (const [name, tmpl] of Object.entries(D.actionsFor(domain))) {
      const a = cfg.actions?.[name];
      if (!a || !a.enabled) continue;
      const params = {};
      for (const [pn, spec] of Object.entries(tmpl.params)) {
        const p = { type: spec.type, required: !!spec.required };
        if (spec.type === 'int' || spec.type === 'number') Object.assign(p, a.limits?.[pn] || { min: spec.min, max: spec.max });
        else if (spec.type === 'choice') {
          p.allowed = this.allowedChoices(spec, a.limits?.[pn], state);
          const oh = a.option_hints?.[pn] || {};
          p.option_hints = Object.fromEntries(p.allowed.filter((o) => Object.hasOwn(oh, o)).map((o) => [o, oh[o]]));
        }
        else if (spec.type === 'rgb') p.range = [0, 255];
        params[pn] = p;
      }
      out[name] = { params, min_role: D.MIN_ROLE_RANK[a.min_role] > D.MIN_ROLE_RANK[cfg.min_role] ? a.min_role : cfg.min_role };
    }
    return out;
  }

  allowedChoices(spec, limits, state) {
    let allowed = limits?.allowed || [];
    const live = state?.attributes?.[spec.attr];
    if (Array.isArray(live) && live.length) allowed = allowed.filter((x) => live.includes(x));
    return allowed;
  }

  view(id) {
    const cfg = this.store.get(id);
    const state = this.ha.states.get(id);
    if (!cfg || !state) return null;
    return {
      entity_id: id,
      name: this.effectiveName(id, cfg),
      aliases: cfg.aliases || [],
      hint: cfg.hint || null,
      area: this.effectiveRoom(id, cfg),
      domain: D.domainOf(id),
      state: state.state,
      attributes: this.filteredAttributes(id, cfg, state),
      access: cfg.access,
      actions: this.actionsView(id, cfg, state),
      confirm: cfg.confirm,
      min_role: cfg.min_role,
      quiet: cfg.quiet || null,
    };
  }

  requireHa() {
    if (!this.ha.connected) throw new ApiError(503, 'ha_unavailable', 'Home Assistant ist derzeit nicht erreichbar');
  }

  list({ area, domain, q } = {}) {
    this.requireHa();
    const af = area ? fold(area) : null;
    const qf = q ? fold(q) : null;
    const out = [];
    for (const id of this.exposedIds()) {
      const v = this.view(id);
      if (!v) continue;
      if (domain && v.domain !== domain) continue;
      if (af && fold(v.area || '') !== af) continue;
      if (qf && ![v.name, ...v.aliases, v.area || '', id].some((s) => fold(s).includes(qf))) continue;
      out.push(v);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, 'de'));
  }

  areas() {
    this.requireHa();
    const groups = new Map();
    for (const v of this.list()) {
      const key = v.area || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ entity_id: v.entity_id, name: v.name, domain: v.domain });
    }
    return [...groups.entries()]
      .sort(([a], [b]) => (a === '' ? 1 : b === '' ? -1 : a.localeCompare(b, 'de')))
      .map(([name, entities]) => ({ area: name || null, entities }));
  }

  // entity_id oder Name -> Konfig-ID (nur freigegebene Entitaeten sind auffindbar)
  resolve({ entity_id, name, room }) {
    if (entity_id !== undefined && entity_id !== null && entity_id !== '') {
      if (typeof entity_id !== 'string' || !D.ENTITY_ID_RE.test(entity_id)) throw new ApiError(400, 'invalid_entity_id', 'Ungültige entity_id');
      const cfg = this.store.get(entity_id);
      if (!cfg || cfg.access === 'off') throw new ApiError(403, 'not_exposed', 'Diese Entität ist nicht freigegeben');
      return entity_id;
    }
    if (typeof name !== 'string' || !name.trim()) throw new ApiError(400, 'invalid_request', 'entity_id oder name ist erforderlich');
    const nf = fold(name);
    const rf = room ? fold(room) : null;
    const exposed = this.exposedIds().filter((id) => this.ha.states.has(id));
    const named = (id) => {
      const c = this.store.get(id);
      return [this.effectiveName(id, c), ...(c.aliases || [])].map(fold);
    };
    let hits = exposed.filter((id) => named(id).includes(nf));
    if (rf) hits = hits.filter((id) => fold(this.effectiveRoom(id, this.store.get(id)) || '') === rf);
    if (hits.length === 1) return hits[0];
    const brief = (id) => ({ entity_id: id, name: this.effectiveName(id, this.store.get(id)), area: this.effectiveRoom(id, this.store.get(id)) });
    if (hits.length > 1) {
      throw new ApiError(409, 'ambiguous_name', `Der Name „${name}“ ist mehrdeutig`, { candidates: hits.slice(0, 10).map(brief) });
    }
    const near = exposed.filter((id) => named(id).some((n) => n.includes(nf) || (nf.length > 2 && nf.includes(n)))).slice(0, 5).map(brief);
    throw new ApiError(404, 'not_found', `Keine freigegebene Entität mit dem Namen „${name}“ gefunden`, { suggestions: near });
  }

  getOne(ref) {
    const id = this.resolve(ref);
    this.requireHa();
    const v = this.view(id);
    if (!v) throw new ApiError(404, 'entity_missing', 'Die Entität existiert in Home Assistant nicht (mehr)');
    return v;
  }

  // ---- Steuern ----
  validateParams(id, actionName, tmpl, actCfg, params, state) {
    for (const k of Object.keys(params)) {
      if (!Object.hasOwn(tmpl.params, k)) throw new ApiError(400, 'unknown_param', `Unbekannter Parameter „${k.slice(0, 40)}“ für ${actionName}`);
    }
    const data = {};
    for (const [pn, spec] of Object.entries(tmpl.params)) {
      const given = Object.hasOwn(params, pn) ? params[pn] : undefined;
      if (given === undefined) {
        if (spec.required) throw new ApiError(400, 'missing_param', `Parameter „${pn}“ fehlt`);
        continue;
      }
      const bad = (msg) => new ApiError(400, 'invalid_param', `Parameter „${pn}“: ${msg}`);
      let value = given;
      if (spec.type === 'int' || spec.type === 'number') {
        if (typeof given !== 'number' || !Number.isFinite(given)) throw bad('Zahl erwartet');
        if (spec.type === 'int' && !Number.isInteger(given)) throw bad('ganze Zahl erwartet');
        const lim = actCfg.limits?.[pn] || { min: spec.min, max: spec.max };
        if (given < lim.min || given > lim.max) throw new ApiError(400, 'value_out_of_range', `Parameter „${pn}“: ${given} liegt außerhalb des erlaubten Bereichs ${lim.min} bis ${lim.max}`, { min: lim.min, max: lim.max });
      } else if (spec.type === 'bool') {
        if (typeof given !== 'boolean') throw bad('true oder false erwartet');
      } else if (spec.type === 'rgb') {
        if (!Array.isArray(given) || given.length !== 3 || !given.every((x) => Number.isInteger(x))) throw bad('Liste mit drei ganzen Zahlen erwartet');
        if (!given.every((x) => x >= 0 && x <= 255)) throw new ApiError(400, 'value_out_of_range', `Parameter „${pn}“: Werte müssen zwischen 0 und 255 liegen`);
      } else if (spec.type === 'choice') {
        if (typeof given !== 'string') throw bad('Text erwartet');
        const allowed = this.allowedChoices(spec, actCfg.limits?.[pn], state);
        if (!allowed.includes(given)) throw new ApiError(400, 'value_out_of_range', `Parameter „${pn}“: „${given.slice(0, 60)}“ ist nicht erlaubt (erlaubt: ${allowed.join(', ') || 'nichts'})`, { allowed });
      }
      data[spec.ha || pn] = spec.toHa ? spec.toHa(value) : value;
    }
    for (const group of tmpl.exclusive || []) {
      if (group.filter((k) => Object.hasOwn(params, k)).length > 1) throw new ApiError(400, 'invalid_param', `Parameter ${group.join(' und ')} können nicht zusammen verwendet werden`);
    }
    return data;
  }

  async call(body) {
    const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
    const role = typeof b.role === 'string' ? b.role : 'unbekannt';
    const meta = {
      entity_id: typeof b.entity_id === 'string' ? b.entity_id : (typeof b.name === 'string' ? `name:${b.name}` : ''),
      action: typeof b.action === 'string' ? b.action : '',
      params: b.params && typeof b.params === 'object' ? b.params : {},
      person: typeof b.person === 'string' ? b.person : null,
      role,
    };
    try {
      const result = await this._call(b, role, meta);
      this.audit.add({ ...meta, entity_id: result.entity_id, result: 'ok' });
      return result;
    } catch (e) {
      if (e instanceof ApiError) {
        this.audit.add({ ...meta, result: e.status >= 500 ? 'error' : 'denied', code: e.code, reason: e.message });
      } else {
        this.audit.add({ ...meta, result: 'error', code: 'internal', reason: 'Interner Fehler' });
      }
      throw e;
    }
  }

  async _call(b, role, meta) {
    if (typeof b.action !== 'string' || !b.action) throw new ApiError(400, 'invalid_request', 'action ist erforderlich');
    if (b.params !== undefined && (b.params === null || typeof b.params !== 'object' || Array.isArray(b.params))) throw new ApiError(400, 'invalid_request', 'params muss ein Objekt sein');
    if (!Object.hasOwn(D.ROLE_RANK, role)) throw new ApiError(400, 'invalid_request', 'role muss admin, erwachsen, kind oder unbekannt sein');
    if (b.person !== undefined && b.person !== null && (typeof b.person !== 'string' || b.person.length > 80)) throw new ApiError(400, 'invalid_request', 'person muss ein Text bis 80 Zeichen sein');
    const params = b.params || {};

    // 1. freigegeben?
    const id = this.resolve({ entity_id: b.entity_id, name: b.name, room: b.room });
    meta.entity_id = id;
    const cfg = this.store.get(id);
    this.requireHa();
    const state = this.ha.states.get(id);
    if (!state) throw new ApiError(404, 'entity_missing', 'Die Entität existiert in Home Assistant nicht (mehr)');
    // 2. Zugriff steuern?
    if (cfg.access !== 'control') throw new ApiError(403, 'read_only', 'Diese Entität ist nur lesbar, Steuern ist nicht erlaubt');
    // 3. Aktion erlaubt?
    const tmpls = D.actionsFor(D.domainOf(id));
    if (!Object.hasOwn(tmpls, b.action) || !cfg.actions?.[b.action]?.enabled) throw new ApiError(403, 'action_not_allowed', `Die Aktion „${b.action.slice(0, 40)}“ ist für diese Entität nicht erlaubt`);
    const tmpl = tmpls[b.action];
    const actCfg = cfg.actions[b.action];
    // 4. Parameter, Typen, Grenzen
    const data = this.validateParams(id, b.action, tmpl, actCfg, params, state);
    // 5. Rolle
    const need = D.MIN_ROLE_RANK[actCfg.min_role] > D.MIN_ROLE_RANK[cfg.min_role] ? actCfg.min_role : cfg.min_role;
    if (D.ROLE_RANK[role] < D.MIN_ROLE_RANK[need]) throw new ApiError(403, 'role_too_low', `Dafür ist mindestens die Rolle „${D.MIN_ROLE_LABEL[need]}“ nötig`, { min_role: need });
    // 6. Sperrzeit
    if (inQuiet(cfg.quiet, this.now())) throw new ApiError(403, 'quiet_hours', `Steuern ist zwischen ${cfg.quiet.from} und ${cfg.quiet.to} Uhr gesperrt`, { quiet: cfg.quiet });

    return this.withLock(id, async () => {
      const [domain, service] = tmpl.service.split('.');
      try {
        // genau ein Servicecall, Ziel ist ausschliesslich diese eine entity_id
        await this.ha.callService(domain, service, { entity_id: id, ...data });
      } catch (e) {
        if (e instanceof HaError) {
          if (e.unavailable) throw new ApiError(503, 'ha_unavailable', 'Home Assistant ist derzeit nicht erreichbar');
          throw new ApiError(502, 'ha_error', `Home Assistant hat den Aufruf abgelehnt (${e.status ?? 'Fehler'})`);
        }
        throw e;
      }
      let st = null;
      try { st = await this.ha.getState(id); } catch { st = this.ha.states.get(id) || null; }
      const after = st ? { state: st.state, attributes: this.filteredAttributes(id, cfg, st) } : null;
      return { ok: true, entity_id: id, action: b.action, state_after: after };
    });
  }

  // Aufrufe auf dieselbe Entitaet laufen nacheinander, damit state_after zum eigenen Aufruf passt
  async withLock(id, fn) {
    const prev = this.locks.get(id) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.locks.set(id, tail);
    try { return await run; } finally { if (this.locks.get(id) === tail) this.locks.delete(id); }
  }
}

module.exports = { Gateway, ApiError, fold, inQuiet };
