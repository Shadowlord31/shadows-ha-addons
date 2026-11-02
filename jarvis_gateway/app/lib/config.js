const D = require('./domains');

class ValidationError extends Error {}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function clean(s, max) {
  return String(s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

// Reiner Text: HTML-Tags und Steuerzeichen entfernen, Leerraum glaetten
function plainText(s, max, what) {
  if (typeof s !== 'string') throw new ValidationError(`${what}: Text erwartet`);
  const t = s.replace(/<[^>]*>/g, ' ').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length > max) throw new ValidationError(`${what}: höchstens ${max} Zeichen erlaubt (aktuell ${t.length})`);
  return t;
}

function num(v, what) {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ValidationError(`${what}: Zahl erwartet`);
  return v;
}

// Standardgrenzen einer Aktion/eines Parameters aus Vorlage und aktuellem HA-Zustand
function defaultLimits(spec, attrs) {
  if (spec.type === 'int' || spec.type === 'number') {
    let min = spec.defMin ?? spec.min;
    let max = spec.defMax ?? spec.max;
    if (spec.attrMin && typeof attrs?.[spec.attrMin] === 'number') min = attrs[spec.attrMin];
    if (spec.attrMax && typeof attrs?.[spec.attrMax] === 'number') max = attrs[spec.attrMax];
    min = Math.max(spec.min, Math.min(min, spec.max));
    max = Math.max(spec.min, Math.min(max, spec.max));
    return { min, max };
  }
  if (spec.type === 'choice') {
    if (spec.values) {
      const fromAttr = Array.isArray(attrs?.[spec.attr]) ? attrs[spec.attr].filter((x) => spec.values.includes(x)) : null;
      return { allowed: fromAttr && fromAttr.length ? fromAttr : [...spec.values] };
    }
    const list = Array.isArray(attrs?.[spec.attr]) ? attrs[spec.attr].filter((x) => typeof x === 'string') : [];
    return { allowed: list.slice(0, 100) };
  }
  return null;
}

function defaultConfig(entityId, attrs) {
  const domain = D.domainOf(entityId);
  const acts = D.actionsFor(domain);
  const controllable = Object.keys(acts).length > 0;
  const actions = {};
  for (const [name, a] of Object.entries(acts)) {
    const limits = {};
    for (const [pn, spec] of Object.entries(a.params)) {
      const l = defaultLimits(spec, attrs);
      if (l) limits[pn] = l;
    }
    actions[name] = { enabled: true, min_role: a.defaultMinRole || 'all', limits };
  }
  return {
    access: controllable && !D.READ_ONLY_DEFAULT_DOMAINS.has(domain) ? 'control' : 'read',
    name: null,
    hint: null,
    aliases: [],
    room: null,
    actions,
    confirm: domain === 'lock' ? 2 : 0,
    min_role: domain === 'lock' ? 'erwachsen' : 'all',
    quiet: null,
    attributes: [...D.attributesFor(domain)],
  };
}

// Erklaerungen je Option; nur fuer erlaubte Optionen, andere werden verworfen
function normalizeOptionHints(input, allowed, where) {
  if (input === undefined || input === null) return null;
  if (typeof input !== 'object' || Array.isArray(input)) throw new ValidationError(`${where}: option_hints muss ein Objekt sein`);
  const out = {};
  for (const opt of allowed) {
    if (!Object.hasOwn(input, opt)) continue;
    const t = input[opt] === null ? '' : plainText(input[opt], 80, `${where} „${opt}“`);
    if (t) out[opt] = t;
  }
  return Object.keys(out).length ? out : null;
}

function normalizeLimits(spec, input, base, where) {
  if (spec.type === 'int' || spec.type === 'number') {
    const src = input && typeof input === 'object' ? input : {};
    const min = src.min === undefined ? base.min : num(src.min, `${where} min`);
    const max = src.max === undefined ? base.max : num(src.max, `${where} max`);
    if (spec.type === 'int' && (!Number.isInteger(min) || !Number.isInteger(max))) throw new ValidationError(`${where}: ganze Zahlen erwartet`);
    if (min > max) throw new ValidationError(`${where}: Minimum ist größer als Maximum`);
    if (min < spec.min || max > spec.max) throw new ValidationError(`${where}: erlaubt sind ${spec.min} bis ${spec.max}`);
    return { min, max };
  }
  if (spec.type === 'choice') {
    const src = input && Array.isArray(input.allowed) ? input.allowed : base.allowed;
    const allowed = [];
    for (const v of src) {
      if (typeof v !== 'string' || !v || v.length > 100) throw new ValidationError(`${where}: ungültiger Wert`);
      if (spec.values && !spec.values.includes(v)) throw new ValidationError(`${where}: "${v}" ist nicht zulässig`);
      if (!allowed.includes(v)) allowed.push(v);
    }
    if (allowed.length > 100) throw new ValidationError(`${where}: zu viele Werte`);
    return { allowed };
  }
  return null;
}

// Prueft/normalisiert eine Entitaets-Konfiguration. Unbekanntes wird verworfen, Ungueltiges abgelehnt.
// attrs: aktuelle HA-Attribute (nur fuer Standardwerte, z.B. Optionslisten).
function normalizeConfig(entityId, input, attrs) {
  if (typeof entityId !== 'string' || !D.ENTITY_ID_RE.test(entityId)) throw new ValidationError(`Ungültige entity_id: ${String(entityId).slice(0, 80)}`);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ValidationError(`${entityId}: Objekt erwartet`);
  const domain = D.domainOf(entityId);
  const acts = D.actionsFor(domain);
  const def = defaultConfig(entityId, attrs);
  const out = { ...def };

  if (input.access !== undefined) {
    if (!['off', 'read', 'control'].includes(input.access)) throw new ValidationError(`${entityId}: Zugriff muss off, read oder control sein`);
    out.access = input.access;
  }
  if (out.access === 'control' && Object.keys(acts).length === 0) out.access = 'read';

  if (input.name !== undefined) out.name = input.name === null || input.name === '' ? null : clean(input.name, 80) || null;
  if (input.room !== undefined) out.room = input.room === null || input.room === '' ? null : clean(input.room, 60) || null;
  if (input.aliases !== undefined) {
    if (!Array.isArray(input.aliases)) throw new ValidationError(`${entityId}: aliases muss eine Liste sein`);
    const seen = new Set();
    out.aliases = [];
    for (const a of input.aliases.slice(0, 20)) {
      const c = clean(a, 60);
      if (c && !seen.has(c.toLowerCase())) { seen.add(c.toLowerCase()); out.aliases.push(c); }
    }
  }
  if (input.hint !== undefined) {
    out.hint = input.hint === null ? null : plainText(input.hint, 300, `${entityId}: Hinweis`) || null;
  }
  if (input.confirm !== undefined) {
    if (![0, 1, 2].includes(input.confirm)) throw new ValidationError(`${entityId}: Rückfrage-Stufe muss 0, 1 oder 2 sein`);
    out.confirm = input.confirm;
  }
  if (input.min_role !== undefined) {
    if (!D.MIN_ROLES.includes(input.min_role)) throw new ValidationError(`${entityId}: Mindestrolle muss all, erwachsen oder admin sein`);
    out.min_role = input.min_role;
  }
  if (input.quiet !== undefined) {
    if (input.quiet === null) out.quiet = null;
    else {
      const q = input.quiet;
      if (!q || !TIME_RE.test(q.from || '') || !TIME_RE.test(q.to || '')) throw new ValidationError(`${entityId}: Sperrzeit braucht von/bis im Format HH:MM`);
      if (q.from === q.to) throw new ValidationError(`${entityId}: Sperrzeit von und bis dürfen nicht gleich sein`);
      out.quiet = { from: q.from, to: q.to };
    }
  }
  if (input.attributes !== undefined) {
    if (!Array.isArray(input.attributes)) throw new ValidationError(`${entityId}: attributes muss eine Liste sein`);
    const allowed = D.attributesFor(domain);
    out.attributes = [...new Set(input.attributes.filter((a) => allowed.includes(a)))];
  }
  if (input.actions !== undefined) {
    if (!input.actions || typeof input.actions !== 'object' || Array.isArray(input.actions)) throw new ValidationError(`${entityId}: actions muss ein Objekt sein`);
    out.actions = {};
    for (const [name, a] of Object.entries(acts)) {
      const given = Object.hasOwn(input.actions, name) ? input.actions[name] : null;
      const defA = def.actions[name];
      const entry = { enabled: !!(given && given.enabled), min_role: defA.min_role, limits: {} };
      if (given && given.min_role !== undefined) {
        if (!D.MIN_ROLES.includes(given.min_role)) throw new ValidationError(`${entityId}.${name}: Mindestrolle ungültig`);
        entry.min_role = given.min_role;
      }
      for (const [pn, spec] of Object.entries(a.params)) {
        const l = normalizeLimits(spec, given?.limits?.[pn], defA.limits[pn], `${entityId}.${name}.${pn}`);
        if (l) entry.limits[pn] = l;
        if (spec.type === 'choice') {
          const hints = normalizeOptionHints(given?.option_hints?.[pn], l.allowed, `${entityId}.${name}.${pn}`);
          if (hints) (entry.option_hints ||= {})[pn] = hints;
        }
      }
      out.actions[name] = entry;
    }
  }
  return out;
}

module.exports = { ValidationError, defaultConfig, normalizeConfig, TIME_RE };
