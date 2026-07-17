const express = require('express');
const router = express.Router();
const db = require('../db/garten');
const { checkCropRotation } = require('../db/crop-rotation');

const b = (v) => (v ? 1 : 0); // JS boolean -> SQLite 0/1

// ── Beete ─────────────────────────────────────────────────────────────────────
router.get('/beds', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM beds ORDER BY level, parent_id IS NOT NULL, parent_id, name').all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/beds', (req, res) => {
  try {
    const { name, note, parent_id, level } = req.body;
    const row = db.prepare('INSERT INTO beds (name, note, parent_id, level) VALUES (?,?,?,?) RETURNING *')
      .get(name, note || null, parent_id || null, level || 1);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/beds/occupancy', (req, res) => {
  try {
    const y = new Date().getFullYear();
    const plannerRows = db.prepare(`
      SELECT p.id AS plan_id, p.bed_id, p.plant, p.emoji, p.plant_id,
             (CASE WHEN p.is_permanent THEN 'dauerhaft' ELSE 'planer' END) AS source,
             pf.name AS fam_name, pf.color AS fam_color, p.month, p.month_to
      FROM plans p LEFT JOIN plant_families pf ON p.plant_family_id = pf.id
      WHERE p.bed_id IS NOT NULL AND p.done = 0
        AND ((p.is_permanent = 0 AND p.year = ?) OR (p.is_permanent = 1 AND p.year <= ? AND (p.removed_year IS NULL OR p.removed_year > ?)))
    `).all(y, y, y);

    const tagebuchRows = db.prepare(`
      SELECT e.bed_id, e.plant, e.emoji, e.plant_id, pf2.name AS fam_name, pf2.color AS fam_color
      FROM entries e LEFT JOIN plant_families pf2 ON e.plant_family_id = pf2.id
      WHERE e.cat = 'plant' AND e.bed_id IS NOT NULL AND CAST(strftime('%Y', e.entry_date) AS INTEGER) = ?
        AND NOT EXISTS (
          SELECT 1 FROM entries h
          WHERE h.cat = 'harvest' AND h.harvest_final = 1 AND h.plant = e.plant AND h.bed_id = e.bed_id AND h.entry_date >= e.entry_date
        )
    `).all(y);

    const result = {};
    plannerRows.forEach(r => {
      (result[r.bed_id] ||= []).push({
        plan_id: r.plan_id, plant: r.plant, emoji: r.emoji, plant_id: r.plant_id, source: r.source,
        fam_name: r.fam_name, fam_color: r.fam_color, month: r.month, month_to: r.month_to
      });
    });
    tagebuchRows.forEach(r => {
      (result[r.bed_id] ||= []).push({
        plan_id: null, plant: r.plant, emoji: r.emoji, plant_id: r.plant_id, source: 'tagebuch',
        fam_name: r.fam_name, fam_color: r.fam_color, month: null, month_to: null
      });
    });
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/beds/:id', (req, res) => {
  try {
    const { name, note } = req.body;
    db.prepare('UPDATE beds SET name=?, note=? WHERE id=?').run(name, note || null, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/beds/:id/layout', (req, res) => {
  try {
    const { pos_x, pos_y, width, height, feld_typ, spalten } = req.body;
    db.prepare(`UPDATE beds SET
        pos_x=COALESCE(?,pos_x), pos_y=COALESCE(?,pos_y), width=COALESCE(?,width),
        height=COALESCE(?,height), feld_typ=COALESCE(?,feld_typ), spalten=COALESCE(?,spalten)
      WHERE id=?`).run(pos_x ?? null, pos_y ?? null, width ?? null, height ?? null, feld_typ ?? null, spalten ?? null, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/beds/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM beds WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Pflanzenkatalog ───────────────────────────────────────────────────────────
router.get('/plants', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT p.*, pf.name AS family_name, pf.color AS family_color
      FROM plants p LEFT JOIN plant_families pf ON p.plant_family_id = pf.id ORDER BY p.name
    `).all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/plants', (req, res) => {
  try {
    const { name, emoji, plant_family_id, is_perennial, sow_depth, plant_spacing, note, plant_cat } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name erforderlich' });
    const row = db.prepare(`
      INSERT INTO plants (name, emoji, plant_family_id, is_perennial, sow_depth, plant_spacing, note, plant_cat)
      VALUES (?,?,?,?,?,?,?,?) RETURNING *
    `).get(name.trim(), emoji || '🌱', plant_family_id || null, b(is_perennial), sow_depth || null, plant_spacing || null, note || null, plant_cat || null);
    res.json(row);
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'Pflanze existiert bereits' });
    res.status(500).json({ error: e.message });
  }
});
router.patch('/plants/:id', (req, res) => {
  try {
    const { name, emoji, plant_family_id, is_perennial, sow_depth, plant_spacing, note, plant_cat } = req.body;
    db.prepare(`
      UPDATE plants SET name=?, emoji=?, plant_family_id=?, is_perennial=?, sow_depth=?, plant_spacing=?, note=?, plant_cat=? WHERE id=?
    `).run(name.trim(), emoji || '🌱', plant_family_id || null, b(is_perennial), sow_depth || null, plant_spacing || null, note || null, plant_cat || null, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/plants/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM plants WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Einträge ──────────────────────────────────────────────────────────────────
router.get('/entries', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT e.*, b.name AS bed_name, pf.name AS family_name, pf.color AS family_color,
             pl.name AS plant_catalog_name, COALESCE(NULLIF(e.plant_cat,''), pl.plant_cat) AS plant_cat
      FROM entries e LEFT JOIN beds b ON e.bed_id = b.id
      LEFT JOIN plant_families pf ON e.plant_family_id = pf.id
      LEFT JOIN plants pl ON e.plant_id = pl.id
      ORDER BY e.entry_date DESC, e.created_at DESC
    `).all();
    res.json(rows.map(row => ({ ...row, date: row.entry_date })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/entries', (req, res) => {
  try {
    const { id, emoji, plant, date, location, description, cat, bed_id, plant_cat, plant_family_id,
      harvest_amount, harvest_unit, plant_id, harvest_final, perennial_id } = req.body;
    let fe = emoji, fp = plant, ffi = plant_family_id;
    if (plant_id) {
      const pr = db.prepare('SELECT * FROM plants WHERE id=?').get(plant_id);
      if (pr) { fe = pr.emoji; fp = pr.name; ffi = pr.plant_family_id; }
    }
    db.prepare(`
      INSERT INTO entries (id,emoji,plant,entry_date,location,description,cat,bed_id,plant_cat,plant_family_id,harvest_amount,harvest_unit,plant_id,harvest_final,perennial_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, fe, fp, date, location || null, description || null, cat, bed_id || null, plant_cat || null,
      ffi || null, harvest_amount || null, harvest_unit || null, plant_id || null, b(harvest_final), perennial_id || null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/entries/:id', (req, res) => {
  try {
    const { emoji, plant, date, location, description, cat, bed_id, plant_cat, plant_family_id, harvest_amount, harvest_unit, plant_id } = req.body;
    let fe = emoji, fp = plant, ffi = plant_family_id;
    if (plant_id) {
      const pr = db.prepare('SELECT * FROM plants WHERE id=?').get(plant_id);
      if (pr) { fe = pr.emoji; fp = pr.name; ffi = pr.plant_family_id; }
    }
    db.prepare(`
      UPDATE entries SET emoji=?,plant=?,entry_date=?,location=?,description=?,cat=?,bed_id=?,plant_cat=?,plant_family_id=?,harvest_amount=?,harvest_unit=?,plant_id=? WHERE id=?
    `).run(fe, fp, date, location || null, description || null, cat, bed_id || null, plant_cat || null, ffi || null, harvest_amount || null, harvest_unit || null, plant_id || null, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/entries/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM entries WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Planung ───────────────────────────────────────────────────────────────────
router.get('/plans', (req, res) => {
  try {
    const { year } = req.query;
    const base = `
      SELECT p.*, b.name AS bed_name, pf.name AS family_name, pf.color AS family_color, pl.name AS plant_catalog_name
      FROM plans p LEFT JOIN beds b ON p.bed_id = b.id
      LEFT JOIN plant_families pf ON p.plant_family_id = pf.id
      LEFT JOIN plants pl ON p.plant_id = pl.id`;
    let rows;
    if (year) {
      const y = parseInt(year);
      rows = db.prepare(base + ` WHERE (p.is_permanent = 0 AND p.year = ?) OR (p.is_permanent = 1 AND p.year <= ? AND (p.removed_year IS NULL OR p.removed_year > ?)) ORDER BY p.is_permanent DESC, p.year, p.month`).all(y, y, y);
    } else {
      rows = db.prepare(base + ` ORDER BY p.is_permanent DESC, p.year, p.month`).all();
    }
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/plans', (req, res) => {
  try {
    const { id, emoji, plant, month, month_to, year, note, done, bed_id, plant_family_id, is_permanent, plant_cat, plant_id } = req.body;
    let fe = emoji, fp = plant, ffi = plant_family_id;
    if (plant_id) {
      const pr = db.prepare('SELECT * FROM plants WHERE id=?').get(plant_id);
      if (pr) { fe = pr.emoji; fp = pr.name; ffi = pr.plant_family_id; }
    }
    db.prepare(`
      INSERT INTO plans (id,emoji,plant,month,month_to,year,note,done,bed_id,plant_family_id,is_permanent,plant_cat,plant_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(id, fe, fp, month || 0, month_to || month || 0, year, note || null, b(done), bed_id || null, ffi || null, b(is_permanent), plant_cat || null, plant_id || null);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/plans/:id', (req, res) => {
  try {
    const { done, plant_family_id, emoji, plant, month, month_to, year, note, bed_id, is_permanent, removed_year, plant_cat, plant_id } = req.body;
    let fe = emoji, fp = plant, ffi = plant_family_id;
    if (plant_id) {
      const pr = db.prepare('SELECT * FROM plants WHERE id=?').get(plant_id);
      if (pr) { fe = pr.emoji; fp = pr.name; ffi = pr.plant_family_id; }
    }
    if (plant !== undefined || plant_id !== undefined) {
      db.prepare(`
        UPDATE plans SET emoji=?,plant=?,month=?,month_to=?,year=?,note=?,bed_id=?,plant_family_id=?,is_permanent=?,removed_year=?,plant_cat=?,plant_id=? WHERE id=?
      `).run(fe, fp, month || 0, month_to || month || 0, year, note || null, bed_id || null, ffi || null, b(is_permanent), removed_year || null, plant_cat || null, plant_id || null, req.params.id);
    } else if (done !== undefined && plant_family_id === undefined) {
      db.prepare('UPDATE plans SET done=? WHERE id=?').run(b(done), req.params.id);
    } else if (plant_family_id !== undefined && done === undefined) {
      db.prepare('UPDATE plans SET plant_family_id=? WHERE id=?').run(plant_family_id || null, req.params.id);
    } else {
      db.prepare('UPDATE plans SET done=?,plant_family_id=? WHERE id=?').run(b(done), plant_family_id || null, req.params.id);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/plans/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM plans WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Kosten-Kategorien ─────────────────────────────────────────────────────────
router.get('/costs/kategorien', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM kosten_kategorien ORDER BY name').all()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/costs/kategorien', (req, res) => {
  try {
    const { name, icon } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name erforderlich' });
    const row = db.prepare('INSERT INTO kosten_kategorien (name, icon) VALUES (?,?) RETURNING *').get(name.trim(), icon || '🏷');
    res.json(row);
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'Existiert bereits' });
    res.status(500).json({ error: e.message });
  }
});
router.delete('/costs/kategorien/:id', (req, res) => {
  try { db.prepare('DELETE FROM kosten_kategorien WHERE id=?').run(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Kosten ────────────────────────────────────────────────────────────────────
router.get('/costs', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM costs ORDER BY cost_date DESC, created_at DESC').all();
    res.json(rows.map(row => ({ ...row, date: row.cost_date })));
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/costs', (req, res) => {
  try {
    const { cost_date, category, description, amount } = req.body;
    const row = db.prepare('INSERT INTO costs (id,cost_date,category,description,amount) VALUES (?,?,?,?,?) RETURNING *')
      .get(Date.now(), cost_date, category, description, parseFloat(amount));
    res.json({ ...row, date: row.cost_date });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/costs/:id', (req, res) => {
  try { db.prepare('DELETE FROM costs WHERE id=?').run(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Statistiken ───────────────────────────────────────────────────────────────
router.get('/stats/:year', (req, res) => {
  try {
    const year = parseInt(req.params.year);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM entries WHERE CAST(strftime('%Y', entry_date) AS INTEGER)=?`).get(year).count;
    const byCat = db.prepare(`SELECT cat, COUNT(*) AS count FROM entries WHERE CAST(strftime('%Y', entry_date) AS INTEGER)=? GROUP BY cat`).all(year);
    const byMonth = db.prepare(`SELECT CAST(strftime('%m', entry_date) AS INTEGER) AS month, cat, COUNT(*) AS count FROM entries WHERE CAST(strftime('%Y', entry_date) AS INTEGER)=? GROUP BY month,cat ORDER BY month`).all(year);
    const topPlants = db.prepare(`SELECT plant, emoji, COUNT(*) AS count FROM entries WHERE CAST(strftime('%Y', entry_date) AS INTEGER)=? GROUP BY plant,emoji ORDER BY count DESC LIMIT 8`).all(year);
    const byBed = db.prepare(`SELECT b.name, COUNT(*) AS count FROM entries e JOIN beds b ON e.bed_id=b.id WHERE CAST(strftime('%Y', e.entry_date) AS INTEGER)=? GROUP BY b.name ORDER BY count DESC`).all(year);
    const costsByCat = db.prepare(`SELECT category, SUM(amount) AS total FROM costs WHERE CAST(strftime('%Y', cost_date) AS INTEGER)=? GROUP BY category ORDER BY total DESC`).all(year);
    const totalCostsRow = db.prepare(`SELECT SUM(amount) AS total FROM costs WHERE CAST(strftime('%Y', cost_date) AS INTEGER)=?`).get(year);
    const harvestTotals = db.prepare(`SELECT plant, emoji, harvest_unit, SUM(harvest_amount) AS total FROM entries WHERE CAST(strftime('%Y', entry_date) AS INTEGER)=? AND cat='harvest' AND harvest_amount IS NOT NULL GROUP BY plant, emoji, harvest_unit ORDER BY total DESC`).all(year);
    const byPlantCatalog = db.prepare(`
      SELECT pl.id, pl.name, pl.emoji,
        COUNT(DISTINCT e.bed_id) AS bed_count,
        SUM(CASE WHEN e.cat='plant' THEN 1 ELSE 0 END) AS plant_count,
        SUM(CASE WHEN e.cat='harvest' THEN 1 ELSE 0 END) AS harvest_count,
        SUM(CASE WHEN e.cat='harvest' THEN e.harvest_amount ELSE 0 END) AS total_harvest,
        MIN(e.entry_date) AS first_planting
      FROM plants pl
      LEFT JOIN entries e ON e.plant_id = pl.id AND CAST(strftime('%Y', e.entry_date) AS INTEGER)=?
      GROUP BY pl.id, pl.name, pl.emoji ORDER BY plant_count DESC
    `).all(year);
    res.json({
      total, byCat, byMonth, topPlants, byBed, costsByCat,
      totalCosts: totalCostsRow.total || 0, harvestTotals, byPlantCatalog
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Pflanzenfamilien ──────────────────────────────────────────────────────────
router.get('/plant-families', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM plant_families ORDER BY name').all()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/plant-families', (req, res) => {
  try {
    const { name, pause_years, description, examples, color } = req.body;
    const row = db.prepare('INSERT INTO plant_families (name, pause_years, description, examples, color) VALUES (?,?,?,?,?) RETURNING *')
      .get(name, pause_years || 3, description || null, examples || null, color || null);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/plant-families/:id', (req, res) => {
  try {
    const { name, pause_years, description, examples, color } = req.body;
    db.prepare('UPDATE plant_families SET name=?, pause_years=?, description=?, examples=?, color=? WHERE id=?')
      .run(name, pause_years || 3, description || null, examples || null, color || null, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/plant-families/:id', (req, res) => {
  try { db.prepare('DELETE FROM plant_families WHERE id=?').run(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Fruchtfolge ───────────────────────────────────────────────────────────────
router.get('/crop-rotation/history', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT bed_id, bed_name, year, plant_name, emoji, family_id, family_name, family_color
      FROM crop_rotation_history ORDER BY bed_name, year DESC
    `).all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.get('/crop-rotation/:bedId', (req, res) => {
  try {
    const bedId = parseInt(req.params.bedId);
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const families = db.prepare('SELECT id, name, examples, color, pause_years FROM plant_families ORDER BY name').all();
    const rows = families.map(pf => {
      const cr = checkCropRotation(db, bedId, pf.id, year);
      return {
        family_id: pf.id, family_name: pf.name, examples: pf.examples, color: pf.color, pause_years: pf.pause_years,
        status: cr.status, last_used_year: cr.last_used_year, years_since: cr.years_since, message: cr.message
      };
    });
    const order = { ok: 0, warning: 1, blocked: 2 };
    rows.sort((a, c) => (order[a.status] - order[c.status]) || a.family_name.localeCompare(c.family_name));
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Feld-Details ──────────────────────────────────────────────────────────────
router.get('/feld-details/:bedId', (req, res) => {
  try {
    const id = parseInt(req.params.bedId);
    const entries = db.prepare(`
      SELECT e.id,e.plant,e.emoji,e.cat,e.entry_date,e.description,e.harvest_amount,e.harvest_unit,e.harvest_final,e.plant_id,
             pf.name AS fam_name, pf.color AS fam_color
      FROM entries e LEFT JOIN plant_families pf ON e.plant_family_id=pf.id
      WHERE e.bed_id=? ORDER BY e.entry_date DESC LIMIT 30
    `).all(id);
    const history = db.prepare('SELECT year,plant_name,emoji,family_name,family_color FROM crop_rotation_history WHERE bed_id=? ORDER BY year DESC').all(id);
    const plans = db.prepare(`
      SELECT p.id,p.plant,p.emoji,p.year,p.month,p.is_permanent,p.removed_year,p.note,p.done,
             pf.name AS fam_name, pf.color AS fam_color, pf.pause_years
      FROM plans p LEFT JOIN plant_families pf ON p.plant_family_id=pf.id
      WHERE p.bed_id=? ORDER BY p.year DESC, p.month
    `).all(id);
    res.json({ entries, history, plans });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Pflanzenkategorien ────────────────────────────────────────────────────────
router.get('/plant-categories', (req, res) => {
  try { res.json(db.prepare('SELECT * FROM plant_categories ORDER BY name').all()); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/plant-categories', (req, res) => {
  try {
    const { name, emoji } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name erforderlich' });
    const row = db.prepare('INSERT INTO plant_categories (name, emoji) VALUES (?,?) RETURNING *').get(name.trim(), emoji || '🏷');
    res.json(row);
  } catch (e) {
    if (String(e.code).startsWith('SQLITE_CONSTRAINT')) return res.status(409).json({ error: 'Kategorie existiert bereits' });
    res.status(500).json({ error: e.message });
  }
});
router.delete('/plant-categories/:id', (req, res) => {
  try { db.prepare('DELETE FROM plant_categories WHERE id=?').run(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Gehölze / Perennials ──────────────────────────────────────────────────────
router.get('/perennials', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT p.*, pl.name AS plant_name, pl.emoji AS plant_emoji, pl.plant_cat,
             pf.name AS family_name, pf.color AS family_color
      FROM perennials p
      LEFT JOIN plants pl ON p.plant_id = pl.id
      LEFT JOIN plant_families pf ON pl.plant_family_id = pf.id
      ORDER BY p.planted_year, p.name
    `).all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/perennials', (req, res) => {
  try {
    const { name, plant_id, planted_year, location_note } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name erforderlich' });
    const row = db.prepare('INSERT INTO perennials (name, plant_id, planted_year, location_note) VALUES (?,?,?,?) RETURNING *')
      .get(name.trim(), plant_id || null, planted_year || new Date().getFullYear(), location_note || null);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/perennials/:id', (req, res) => {
  try {
    const { name, plant_id, planted_year, location_note, removed_year } = req.body;
    db.prepare('UPDATE perennials SET name=?, plant_id=?, planted_year=?, location_note=?, removed_year=? WHERE id=?')
      .run(name.trim(), plant_id || null, planted_year, location_note || null, removed_year || null, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/perennials/:id', (req, res) => {
  try { db.prepare('DELETE FROM perennials WHERE id=?').run(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Sperrliste ────────────────────────────────────────────────────────────────
router.get('/blocklist', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT b.*, p.name AS plant_name, p.emoji AS plant_emoji, p.plant_cat
      FROM plant_blocklist b JOIN plants p ON b.plant_id = p.id ORDER BY p.name
    `).all();
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/blocklist', (req, res) => {
  try {
    const { plant_id, reason } = req.body;
    if (!plant_id) return res.status(400).json({ error: 'plant_id erforderlich' });
    const exists = db.prepare('SELECT id FROM plant_blocklist WHERE plant_id=?').get(plant_id);
    if (exists) return res.status(409).json({ error: 'Bereits in Sperrliste' });
    const row = db.prepare('INSERT INTO plant_blocklist (plant_id, reason) VALUES (?,?) RETURNING *').get(plant_id, reason || null);
    res.json(row);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.patch('/blocklist/:id', (req, res) => {
  try {
    const { reason } = req.body;
    db.prepare('UPDATE plant_blocklist SET reason=? WHERE id=?').run(reason || null, req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.delete('/blocklist/:id', (req, res) => {
  try { db.prepare('DELETE FROM plant_blocklist WHERE id=?').run(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
