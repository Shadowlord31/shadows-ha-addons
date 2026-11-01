const express = require('express');
const router = express.Router();
const db = require('../db/garten');
const { checkCropRotation } = require('../db/crop-rotation');

// Token-Schnittstelle fuer externe Dienste (z.B. Jarvis). Der Zugriffsschutz
// (Ingress offen, direkter Port nur mit X-API-Token) sitzt in middleware/access.js.
// Antworten verwenden Namen statt IDs; IDs gibt es nur fuer Eintraege/Plaene,
// weil PATCH plan/:id sie braucht.

class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra || {};
  }
}

const wrap = (fn) => (req, res) => {
  try {
    fn(req, res);
  } catch (e) {
    if (e instanceof HttpError) return res.status(e.status).json({ error: e.message, ...e.extra });
    console.error('integration error:', e);
    res.status(500).json({ error: 'Interner Fehler' });
  }
};

// ── Helfer ────────────────────────────────────────────────────────────────────
const norm = (s) => String(s == null ? '' : s).trim().replace(/\s+/g, ' ').toLocaleLowerCase('de');

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function parseYear(v, fallback) {
  if (v === undefined || v === '') return fallback;
  if (!/^\d{4}$/.test(String(v))) throw new HttpError(400, 'year muss eine vierstellige Jahreszahl sein');
  return parseInt(v, 10);
}

function isValidDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function optString(v, field, max) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') throw new HttpError(400, `${field} muss ein Text sein`);
  const t = v.trim();
  if (t.length > max) throw new HttpError(400, `${field} ist zu lang (max. ${max} Zeichen)`);
  return t || null;
}

function reqString(v, field, max) {
  const t = optString(v, field, max);
  if (!t) throw new HttpError(400, `${field} erforderlich`);
  return t;
}

// Eindeutige Pseudo-ID (Millisekunden wie in der UI, bei Kollision hochzaehlen)
function newId(table) {
  let id = Date.now();
  const stmt = db.prepare(`SELECT 1 FROM ${table} WHERE id = ?`);
  while (stmt.get(id)) id++;
  return id;
}

const isBool = (v) => typeof v === 'boolean' || v === 0 || v === 1;

// ── Beete ─────────────────────────────────────────────────────────────────────
function loadBeds() {
  const rows = db.prepare('SELECT * FROM beds ORDER BY level, parent_id IS NOT NULL, parent_id, name').all();
  const byId = new Map(rows.map(r => [r.id, r]));
  return rows.map(r => {
    const parts = [];
    for (let b = r, n = 0; b && n < 10; b = b.parent_id ? byId.get(b.parent_id) : null, n++) parts.unshift(b.name);
    return { ...r, path: parts.join(' › ') };
  });
}

function matchBeds(beds, name) {
  const q = norm(name);
  const exact = beds.filter(b => norm(b.name) === q || norm(b.path) === q);
  if (exact.length) return exact;
  return beds.filter(b => norm(b.path).includes(q));
}

function resolveBed(name) {
  const beds = loadBeds();
  const hits = matchBeds(beds, name);
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new HttpError(409, `Beet '${name}' ist mehrdeutig`, { suggestions: hits.map(b => b.path) });
  throw new HttpError(404, `Beet '${name}' nicht gefunden`, { beds: beds.map(b => b.path) });
}

// ── Pflanzen ──────────────────────────────────────────────────────────────────
function loadPlants() {
  return db.prepare(`
    SELECT p.*, pf.name AS family_name FROM plants p
    LEFT JOIN plant_families pf ON p.plant_family_id = pf.id ORDER BY p.name
  `).all();
}

// Liefert die Pflanze, null (kein Treffer) oder wirft 409 bei mehreren Treffern.
function findPlant(name) {
  const plants = loadPlants();
  const q = norm(name);
  const exact = plants.filter(p => norm(p.name) === q);
  if (exact.length === 1) return exact[0];
  const hits = exact.length ? exact : plants.filter(p => norm(p.name).includes(q));
  if (hits.length === 1) return hits[0];
  if (hits.length > 1) throw new HttpError(409, `Pflanze '${name}' ist mehrdeutig`, { suggestions: hits.map(p => p.name) });
  return null;
}

// ── Ausgabeformate ────────────────────────────────────────────────────────────
const ENTRY_SELECT = `
  SELECT e.id, e.entry_date, e.cat, e.plant, e.description, e.location, e.harvest_amount, e.harvest_unit,
         e.harvest_final, e.bed_id, pf.name AS family_name,
         COALESCE(NULLIF(e.plant_cat,''), pl.plant_cat) AS plant_cat
  FROM entries e
  LEFT JOIN plant_families pf ON e.plant_family_id = pf.id
  LEFT JOIN plants pl ON e.plant_id = pl.id`;

function formatEntry(row, bedPaths) {
  return {
    id: row.id,
    date: row.entry_date,
    cat: row.cat,
    plant: row.plant,
    bed: row.bed_id ? (bedPaths.get(row.bed_id) || null) : null,
    family: row.family_name || null,
    plant_category: row.plant_cat || null,
    description: row.description || null,
    location: row.location || null,
    harvest_amount: row.harvest_amount,
    harvest_unit: row.harvest_unit || null,
    harvest_final: !!row.harvest_final
  };
}

const bedPathMap = () => new Map(loadBeds().map(b => [b.id, b.path]));

const PLAN_SELECT = `
  SELECT p.id, p.plant, p.month, p.month_to, p.year, p.note, p.done, p.is_permanent, p.removed_year,
         p.bed_id, pf.name AS family_name
  FROM plans p LEFT JOIN plant_families pf ON p.plant_family_id = pf.id`;

function formatPlan(row, bedPaths) {
  return {
    id: row.id,
    plant: row.plant,
    bed: row.bed_id ? (bedPaths.get(row.bed_id) || null) : null,
    family: row.family_name || null,
    year: row.year,
    month: row.month,
    month_to: row.month_to,
    note: row.note || null,
    done: !!row.done,
    permanent: !!row.is_permanent,
    removed_year: row.removed_year
  };
}

function queryPlans(year, openOnly) {
  let sql = PLAN_SELECT + ` WHERE ((p.is_permanent = 0 AND p.year = ?)
      OR (p.is_permanent = 1 AND p.year <= ? AND (p.removed_year IS NULL OR p.removed_year > ?)))`;
  if (openOnly) sql += ' AND p.done = 0 AND p.is_permanent = 0';
  sql += ' ORDER BY p.is_permanent DESC, p.month, p.plant';
  const paths = bedPathMap();
  return db.prepare(sql).all(year, year, year).map(r => formatPlan(r, paths));
}

// ── Lesen ─────────────────────────────────────────────────────────────────────
router.get('/overview', wrap((req, res) => {
  const year = parseYear(req.query.year, new Date().getFullYear());
  const beds = loadBeds();

  const planned = db.prepare(`
    SELECT p.bed_id, p.plant, p.month, p.month_to, (CASE WHEN p.is_permanent THEN 'dauerhaft' ELSE 'planung' END) AS source
    FROM plans p
    WHERE p.bed_id IS NOT NULL AND p.done = 0
      AND ((p.is_permanent = 0 AND p.year = ?) OR (p.is_permanent = 1 AND p.year <= ? AND (p.removed_year IS NULL OR p.removed_year > ?)))
  `).all(year, year, year);
  const diary = db.prepare(`
    SELECT e.bed_id, e.plant FROM entries e
    WHERE e.cat = 'plant' AND e.bed_id IS NOT NULL AND CAST(strftime('%Y', e.entry_date) AS INTEGER) = ?
      AND NOT EXISTS (
        SELECT 1 FROM entries h
        WHERE h.cat = 'harvest' AND h.harvest_final = 1 AND h.plant = e.plant AND h.bed_id = e.bed_id AND h.entry_date >= e.entry_date
      )
  `).all(year);

  const crops = new Map();
  const add = (bedId, item) => { if (!crops.has(bedId)) crops.set(bedId, []); crops.get(bedId).push(item); };
  planned.forEach(r => add(r.bed_id, { plant: r.plant, source: r.source, month: r.month, month_to: r.month_to }));
  diary.forEach(r => add(r.bed_id, { plant: r.plant, source: 'tagebuch', month: null, month_to: null }));

  const byCat = db.prepare(`SELECT cat, COUNT(*) AS count FROM entries WHERE CAST(strftime('%Y', entry_date) AS INTEGER) = ? GROUP BY cat`).all(year);
  const total = byCat.reduce((s, r) => s + r.count, 0);

  res.json({
    year,
    beds: beds.map(b => ({ name: b.path, current: crops.get(b.id) || [] })),
    open_plans: queryPlans(year, true),
    entry_count: total,
    entry_count_by_cat: Object.fromEntries(byCat.map(r => [r.cat, r.count]))
  });
}));

router.get('/beds', wrap((req, res) => {
  res.json(loadBeds().map(b => ({ name: b.path, level: b.level, note: b.note || null })));
}));

router.get('/plants', wrap((req, res) => {
  res.json(loadPlants().map(p => ({
    name: p.name, emoji: p.emoji, family: p.family_name || null, category: p.plant_cat || null,
    perennial: !!p.is_perennial, sow_depth: p.sow_depth || null, plant_spacing: p.plant_spacing || null, note: p.note || null
  })));
}));

router.get('/plant-families', wrap((req, res) => {
  res.json(db.prepare('SELECT name, pause_years, description, examples FROM plant_families ORDER BY name').all());
}));

router.get('/entries', wrap((req, res) => {
  const where = [];
  const params = [];
  if (req.query.year !== undefined) {
    where.push(`CAST(strftime('%Y', e.entry_date) AS INTEGER) = ?`);
    params.push(parseYear(req.query.year));
  }
  if (req.query.cat !== undefined && req.query.cat !== '') {
    if (!['plant', 'harvest'].includes(req.query.cat)) throw new HttpError(400, "cat muss 'plant' oder 'harvest' sein");
    where.push('e.cat = ?');
    params.push(req.query.cat);
  }
  const beds = loadBeds();
  if (req.query.bed) {
    const ids = matchBeds(beds, String(req.query.bed)).map(b => b.id);
    if (!ids.length) return res.json([]);
    where.push(`e.bed_id IN (${ids.map(() => '?').join(',')})`);
    params.push(...ids);
  }
  let limit = 50;
  if (req.query.limit !== undefined) {
    if (!/^\d+$/.test(String(req.query.limit)) || +req.query.limit < 1 || +req.query.limit > 500) {
      throw new HttpError(400, 'limit muss eine Zahl zwischen 1 und 500 sein');
    }
    limit = +req.query.limit;
  }

  let rows = db.prepare(ENTRY_SELECT + (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY e.entry_date DESC, e.created_at DESC, e.id DESC').all(...params);
  if (req.query.plant) {
    const q = norm(req.query.plant);
    rows = rows.filter(r => norm(r.plant).includes(q));
  }
  const paths = new Map(beds.map(b => [b.id, b.path]));
  res.json(rows.slice(0, limit).map(r => formatEntry(r, paths)));
}));

router.get('/harvest', wrap((req, res) => {
  const year = parseYear(req.query.year, new Date().getFullYear());
  const rows = db.prepare(`
    SELECT plant, harvest_unit AS unit, ROUND(SUM(harvest_amount), 3) AS total, COUNT(*) AS count, MAX(entry_date) AS last_date
    FROM entries
    WHERE cat = 'harvest' AND harvest_amount IS NOT NULL AND CAST(strftime('%Y', entry_date) AS INTEGER) = ?
    GROUP BY plant, harvest_unit ORDER BY plant, harvest_unit
  `).all(year);
  res.json({ year, harvest: rows });
}));

router.get('/costs', wrap((req, res) => {
  const year = parseYear(req.query.year, new Date().getFullYear());
  const yr = `CAST(strftime('%Y', cost_date) AS INTEGER) = ?`;
  const byCategory = db.prepare(`
    SELECT category, ROUND(SUM(amount), 2) AS total, COUNT(*) AS count FROM costs WHERE ${yr}
    GROUP BY category ORDER BY total DESC
  `).all(year);
  const total = db.prepare(`SELECT ROUND(COALESCE(SUM(amount), 0), 2) AS total FROM costs WHERE ${yr}`).get(year).total;
  const latest = db.prepare(`
    SELECT id, cost_date AS date, category, description, amount FROM costs WHERE ${yr}
    ORDER BY cost_date DESC, created_at DESC, id DESC LIMIT 10
  `).all(year);
  res.json({ year, total, by_category: byCategory, latest });
}));

router.get('/plans', wrap((req, res) => {
  const year = parseYear(req.query.year, new Date().getFullYear());
  const openOnly = ['1', 'true'].includes(String(req.query.open));
  res.json({ year, plans: queryPlans(year, openOnly) });
}));

router.get('/crop-rotation', wrap((req, res) => {
  if (!req.query.bed) throw new HttpError(400, 'bed erforderlich');
  if (!req.query.plant) throw new HttpError(400, 'plant erforderlich');
  const year = parseYear(req.query.year, new Date().getFullYear());
  const bed = resolveBed(String(req.query.bed));
  const plant = findPlant(String(req.query.plant));
  if (!plant) {
    throw new HttpError(404, `Pflanze '${req.query.plant}' nicht im Katalog`, { plants: loadPlants().map(p => p.name) });
  }
  const base = { bed: bed.path, plant: plant.name, family: plant.family_name || null, year };
  if (!plant.plant_family_id) {
    return res.json({ ...base, status: 'ok', last_used_year: null, years_since: null, pause_required: 0, message: 'Pflanze hat keine Familie, keine Fruchtfolge-Pruefung moeglich' });
  }
  res.json({ ...base, ...checkCropRotation(db, bed.id, plant.plant_family_id, year) });
}));

// ── Schreiben (kein Loeschen) ─────────────────────────────────────────────────
const HARVEST_UNITS = { kg: 'kg', g: 'g', 'stück': 'Stück', stueck: 'Stück', stk: 'Stück' };

router.post('/entry', wrap((req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'JSON-Objekt erwartet');

  const cat = body.cat;
  if (!['plant', 'harvest'].includes(cat)) throw new HttpError(400, "cat muss 'plant' oder 'harvest' sein");
  const plantName = reqString(body.plant, 'plant', 200);
  const bedName = optString(body.bed, 'bed', 200);
  const description = optString(body.description, 'description', 2000);
  const date = body.date === undefined || body.date === null || body.date === '' ? localToday() : body.date;
  if (!isValidDate(date)) throw new HttpError(400, 'date muss ein gueltiges Datum im Format YYYY-MM-DD sein');

  let amount = null;
  let unit = null;
  let final = 0;
  const hasHarvestFields = ['harvest_amount', 'harvest_unit', 'harvest_final'].some(k => body[k] !== undefined && body[k] !== null);
  if (cat === 'plant' && hasHarvestFields) throw new HttpError(400, "harvest_* Felder nur bei cat 'harvest'");
  if (cat === 'harvest') {
    if (body.harvest_final !== undefined && body.harvest_final !== null) {
      if (!isBool(body.harvest_final)) throw new HttpError(400, 'harvest_final muss true/false sein');
      final = body.harvest_final ? 1 : 0;
    }
    if (body.harvest_amount !== undefined && body.harvest_amount !== null) {
      amount = body.harvest_amount;
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
        throw new HttpError(400, 'harvest_amount muss eine Zahl groesser 0 sein');
      }
      const u = HARVEST_UNITS[norm(body.harvest_unit)];
      if (!u) throw new HttpError(400, "harvest_unit erforderlich bei harvest_amount: 'kg', 'g' oder 'Stück'");
      unit = u;
    } else if (body.harvest_unit !== undefined && body.harvest_unit !== null) {
      throw new HttpError(400, 'harvest_unit ohne harvest_amount');
    }
  }

  const bed = bedName ? resolveBed(bedName) : null;
  const plant = findPlant(plantName);

  const id = newId('entries');
  db.prepare(`
    INSERT INTO entries (id, emoji, plant, entry_date, description, cat, bed_id, plant_family_id,
                         harvest_amount, harvest_unit, plant_id, harvest_final)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(id, plant ? plant.emoji : '🌱', plant ? plant.name : plantName, date, description, cat,
    bed ? bed.id : null, plant ? plant.plant_family_id : null, amount, unit, plant ? plant.id : null, final);

  const row = db.prepare(ENTRY_SELECT + ' WHERE e.id = ?').get(id);
  res.status(201).json({ ...formatEntry(row, bedPathMap()), catalog_match: !!plant });
}));

router.post('/cost', wrap((req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'JSON-Objekt erwartet');

  const date = body.date === undefined || body.date === null || body.date === '' ? localToday() : body.date;
  if (!isValidDate(date)) throw new HttpError(400, 'date muss ein gueltiges Datum im Format YYYY-MM-DD sein');
  const description = reqString(body.description, 'description', 500);
  const categoryIn = reqString(body.category, 'category', 100);
  const amount = body.amount;
  if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount > 10000000) {
    throw new HttpError(400, 'amount muss eine Zahl groesser 0 sein');
  }

  const categories = db.prepare('SELECT name FROM kosten_kategorien ORDER BY name').all().map(r => r.name);
  let category = categoryIn;
  if (categories.length) {
    const hit = categories.find(c => norm(c) === norm(categoryIn));
    if (!hit) throw new HttpError(404, `Kostenkategorie '${categoryIn}' nicht gefunden`, { categories });
    category = hit;
  }

  const id = newId('costs');
  const row = db.prepare('INSERT INTO costs (id, cost_date, category, description, amount) VALUES (?,?,?,?,?) RETURNING *')
    .get(id, date, category, description, Math.round(amount * 100) / 100);
  res.status(201).json({ id: row.id, date: row.cost_date, category: row.category, description: row.description, amount: row.amount });
}));

router.patch('/plan/:id', wrap((req, res) => {
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'JSON-Objekt erwartet');
  const unknown = Object.keys(body).filter(k => !['done', 'note'].includes(k));
  if (unknown.length) throw new HttpError(400, `Nicht aenderbare Felder: ${unknown.join(', ')} (erlaubt: done, note)`);
  if (body.done === undefined && body.note === undefined) throw new HttpError(400, 'done oder note erforderlich');
  if (!/^\d+$/.test(req.params.id)) throw new HttpError(400, 'Ungueltige Plan-ID');

  const existing = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  if (!existing) throw new HttpError(404, 'Plan nicht gefunden');

  let done = existing.done;
  let note = existing.note;
  if (body.done !== undefined) {
    if (!isBool(body.done)) throw new HttpError(400, 'done muss true/false sein');
    done = body.done ? 1 : 0;
  }
  if (body.note !== undefined) note = optString(body.note, 'note', 2000);

  db.prepare('UPDATE plans SET done = ?, note = ? WHERE id = ?').run(done, note, existing.id);
  const row = db.prepare(PLAN_SELECT + ' WHERE p.id = ?').get(existing.id);
  res.json(formatPlan(row, bedPathMap()));
}));

// Nichts hier faellt an die UI-Router durch.
router.use((req, res) => res.status(404).json({ error: 'Unbekannte Integrations-Route' }));

module.exports = router;
