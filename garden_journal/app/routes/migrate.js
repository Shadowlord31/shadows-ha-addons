const express = require('express');
const router = express.Router();
const db = require('../db/garten');

// Einmalige Migration von der bestehenden Postgres-Instanz (Gartentagebuch)
// in die SQLite-DB des Add-ons. Nur lesend gegen Postgres, keine Schreibzugriffe dort.
router.post('/migrate/postgres', async (req, res) => {
  const { Client } = require('pg');
  const {
    host = '192.168.178.114',
    port = 5432,
    user = 'admin',
    password,
    database = 'gartentagebuch'
  } = req.body || {};
  if (!password) return res.status(400).json({ error: 'password erforderlich' });

  const client = new Client({ host, port, user, password, database });
  const counts = {};
  const toDateStr = (v) => v == null ? null : (v instanceof Date ? v.toISOString().split('T')[0] : v);
  const toTsStr = (v) => v == null ? null : (v instanceof Date ? v.toISOString().replace('T', ' ').replace('Z', '') : v);
  const b = (v) => v ? 1 : 0;

  try {
    await client.connect();

    db.pragma('foreign_keys = OFF');
    const tables = ['costs', 'entries', 'plans', 'perennials', 'plant_blocklist', 'beds',
      'plant_categories', 'plants', 'plant_families', 'kosten_kategorien'];
    const delTx = db.transaction(() => {
      for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
    });
    delTx();

    // plant_families
    let r = await client.query('SELECT * FROM plant_families ORDER BY id');
    const insFam = db.prepare('INSERT INTO plant_families (id,name,pause_years,description,examples,color,created_at) VALUES (?,?,?,?,?,?,?)');
    db.transaction(() => { for (const row of r.rows) insFam.run(row.id, row.name, row.pause_years, row.description, row.examples, row.color, toTsStr(row.created_at)); })();
    counts.plant_families = r.rows.length;

    // plants
    r = await client.query('SELECT * FROM plants ORDER BY id');
    const insPlant = db.prepare('INSERT INTO plants (id,name,emoji,plant_family_id,is_perennial,sow_depth,plant_spacing,note,created_at,plant_cat) VALUES (?,?,?,?,?,?,?,?,?,?)');
    db.transaction(() => { for (const row of r.rows) insPlant.run(row.id, row.name, row.emoji, row.plant_family_id, b(row.is_perennial), row.sow_depth, row.plant_spacing, row.note, toTsStr(row.created_at), row.plant_cat); })();
    counts.plants = r.rows.length;

    // plant_categories
    r = await client.query('SELECT * FROM plant_categories ORDER BY id');
    const insPCat = db.prepare('INSERT INTO plant_categories (id,name,emoji,created_at) VALUES (?,?,?,?)');
    db.transaction(() => { for (const row of r.rows) insPCat.run(row.id, row.name, row.emoji, toTsStr(row.created_at)); })();
    counts.plant_categories = r.rows.length;

    // plant_blocklist
    r = await client.query('SELECT * FROM plant_blocklist ORDER BY id');
    const insBlock = db.prepare('INSERT INTO plant_blocklist (id,plant_id,reason,created_at) VALUES (?,?,?,?)');
    db.transaction(() => { for (const row of r.rows) insBlock.run(row.id, row.plant_id, row.reason, toTsStr(row.created_at)); })();
    counts.plant_blocklist = r.rows.length;

    // beds
    r = await client.query('SELECT * FROM beds ORDER BY id');
    const insBed = db.prepare('INSERT INTO beds (id,name,note,created_at,parent_id,level,pos_x,pos_y,width,height,feld_typ,spalten) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    db.transaction(() => { for (const row of r.rows) insBed.run(row.id, row.name, row.note, toTsStr(row.created_at), row.parent_id, row.level, row.pos_x, row.pos_y, row.width, row.height, row.feld_typ, row.spalten); })();
    counts.beds = r.rows.length;

    // perennials
    r = await client.query('SELECT * FROM perennials ORDER BY id');
    const insPer = db.prepare('INSERT INTO perennials (id,name,plant_id,planted_year,location_note,removed_year,created_at) VALUES (?,?,?,?,?,?,?)');
    db.transaction(() => { for (const row of r.rows) insPer.run(row.id, row.name, row.plant_id, row.planted_year, row.location_note, row.removed_year, toTsStr(row.created_at)); })();
    counts.perennials = r.rows.length;

    // plans
    r = await client.query('SELECT * FROM plans ORDER BY id');
    const insPlan = db.prepare('INSERT INTO plans (id,emoji,plant,month,year,note,done,bed_id,plant_family_id,is_permanent,removed_year,plant_cat,month_to,plant_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    db.transaction(() => { for (const row of r.rows) insPlan.run(row.id, row.emoji, row.plant, row.month, row.year, row.note, b(row.done), row.bed_id, row.plant_family_id, b(row.is_permanent), row.removed_year, row.plant_cat, row.month_to, row.plant_id); })();
    counts.plans = r.rows.length;

    // entries
    r = await client.query('SELECT * FROM entries ORDER BY id');
    const insEntry = db.prepare('INSERT INTO entries (id,emoji,plant,entry_date,location,description,cat,created_at,bed_id,plant_cat,plant_family_id,harvest_amount,harvest_unit,plant_id,harvest_final,perennial_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    db.transaction(() => { for (const row of r.rows) insEntry.run(row.id, row.emoji, row.plant, toDateStr(row.entry_date), row.location, row.description, row.cat, toTsStr(row.created_at), row.bed_id, row.plant_cat, row.plant_family_id, row.harvest_amount, row.harvest_unit, row.plant_id, b(row.harvest_final), row.perennial_id); })();
    counts.entries = r.rows.length;

    // kosten_kategorien
    r = await client.query('SELECT * FROM kosten_kategorien ORDER BY id');
    const insKKat = db.prepare('INSERT INTO kosten_kategorien (id,name,icon,created_at) VALUES (?,?,?,?)');
    db.transaction(() => { for (const row of r.rows) insKKat.run(row.id, row.name, row.icon, toTsStr(row.created_at)); })();
    counts.kosten_kategorien = r.rows.length;

    // costs
    r = await client.query('SELECT * FROM costs ORDER BY id');
    const insCost = db.prepare('INSERT INTO costs (id,cost_date,category,description,amount,created_at) VALUES (?,?,?,?,?,?)');
    db.transaction(() => { for (const row of r.rows) insCost.run(row.id, toDateStr(row.cost_date), row.category, row.description, row.amount, toTsStr(row.created_at)); })();
    counts.costs = r.rows.length;

    db.pragma('foreign_keys = ON');
    await client.end();
    res.json({ ok: true, counts });
  } catch (e) {
    try { await client.end(); } catch (_) {}
    try { db.pragma('foreign_keys = ON'); } catch (_) {}
    res.status(500).json({ error: e.message });
  }
});

// Export/Import zwischen zwei Add-on-Instanzen (z.B. Hauptinstanz -> Testinstanz)
const EXPORT_TABLES = [
  'plant_families', 'plants', 'plant_categories', 'plant_blocklist',
  'beds', 'perennials', 'plans', 'entries', 'kosten_kategorien', 'costs'
];

router.get('/export', (req, res) => {
  try {
    const data = {};
    for (const t of EXPORT_TABLES) {
      data[t] = db.prepare(`SELECT * FROM ${t}`).all();
    }
    res.json({ ok: true, exported_at: new Date().toISOString(), data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/import', (req, res) => {
  const { data } = req.body || {};
  if (!data) return res.status(400).json({ error: 'data erforderlich (Export einer anderen Instanz)' });
  const counts = {};
  try {
    db.pragma('foreign_keys = OFF');
    const delTx = db.transaction(() => {
      for (const t of [...EXPORT_TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run();
    });
    delTx();

    for (const t of EXPORT_TABLES) {
      const rows = data[t] || [];
      if (!rows.length) { counts[t] = 0; continue; }
      const cols = Object.keys(rows[0]);
      const placeholders = cols.map(() => '?').join(',');
      const stmt = db.prepare(`INSERT INTO ${t} (${cols.join(',')}) VALUES (${placeholders})`);
      const insTx = db.transaction(() => {
        for (const row of rows) stmt.run(cols.map(c => row[c]));
      });
      insTx();
      counts[t] = rows.length;
    }
    db.pragma('foreign_keys = ON');
    res.json({ ok: true, counts });
  } catch (e) {
    try { db.pragma('foreign_keys = ON'); } catch (_) {}
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
