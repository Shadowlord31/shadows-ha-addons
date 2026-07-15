CREATE TABLE IF NOT EXISTS plant_families (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  pause_years INTEGER NOT NULL DEFAULT 3,
  description TEXT,
  examples TEXT,
  color TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  emoji TEXT NOT NULL DEFAULT '🌱',
  plant_family_id INTEGER REFERENCES plant_families(id) ON DELETE SET NULL,
  is_perennial INTEGER NOT NULL DEFAULT 0,
  sow_depth TEXT,
  plant_spacing TEXT,
  note TEXT,
  plant_cat TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plant_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  emoji TEXT NOT NULL DEFAULT '🏷',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS plant_blocklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plant_id INTEGER REFERENCES plants(id) ON DELETE CASCADE,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS beds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  parent_id INTEGER REFERENCES beds(id) ON DELETE CASCADE,
  level INTEGER NOT NULL DEFAULT 1,
  pos_x INTEGER,
  pos_y INTEGER,
  width INTEGER,
  height INTEGER,
  feld_typ TEXT DEFAULT 'reihen' CHECK (feld_typ IN ('reihen','raster')),
  spalten INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  emoji TEXT NOT NULL DEFAULT '🌱',
  plant TEXT NOT NULL,
  entry_date TEXT NOT NULL,
  location TEXT,
  description TEXT,
  cat TEXT NOT NULL DEFAULT 'plant',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  bed_id INTEGER REFERENCES beds(id) ON DELETE SET NULL,
  plant_cat TEXT,
  plant_family_id INTEGER REFERENCES plant_families(id) ON DELETE SET NULL,
  harvest_amount REAL,
  harvest_unit TEXT,
  plant_id INTEGER REFERENCES plants(id) ON DELETE SET NULL,
  harvest_final INTEGER NOT NULL DEFAULT 0,
  perennial_id INTEGER REFERENCES perennials(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY,
  emoji TEXT NOT NULL DEFAULT '🌱',
  plant TEXT NOT NULL,
  month INTEGER NOT NULL,
  year INTEGER NOT NULL,
  note TEXT,
  done INTEGER NOT NULL DEFAULT 0,
  bed_id INTEGER REFERENCES beds(id) ON DELETE SET NULL,
  plant_family_id INTEGER REFERENCES plant_families(id) ON DELETE SET NULL,
  is_permanent INTEGER NOT NULL DEFAULT 0,
  removed_year INTEGER,
  plant_cat TEXT,
  month_to INTEGER,
  plant_id INTEGER REFERENCES plants(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_family ON plans(bed_id, plant_family_id, year);

CREATE TABLE IF NOT EXISTS perennials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  plant_id INTEGER REFERENCES plants(id) ON DELETE SET NULL,
  planted_year INTEGER NOT NULL,
  location_note TEXT,
  removed_year INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS kosten_kategorien (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  icon TEXT DEFAULT '🏷️',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS costs (
  id INTEGER PRIMARY KEY,
  cost_date TEXT NOT NULL,
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  amount REAL NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIEW IF NOT EXISTS crop_rotation_history AS
  SELECT p.bed_id, b.name AS bed_name, p.year AS year, p.plant AS plant_name, p.emoji,
         pf.id AS family_id, pf.name AS family_name, pf.color AS family_color
  FROM plans p JOIN beds b ON b.id = p.bed_id LEFT JOIN plant_families pf ON pf.id = p.plant_family_id
  WHERE p.year >= (CAST(strftime('%Y','now') AS INTEGER) - 4)
  UNION ALL
  SELECT e.bed_id, b.name AS bed_name, CAST(strftime('%Y', e.entry_date) AS INTEGER) AS year, e.plant AS plant_name, e.emoji,
         pf.id AS family_id, pf.name AS family_name, pf.color AS family_color
  FROM entries e JOIN beds b ON b.id = e.bed_id LEFT JOIN plant_families pf ON pf.id = e.plant_family_id
  WHERE e.cat = 'plant' AND CAST(strftime('%Y', e.entry_date) AS INTEGER) >= (CAST(strftime('%Y','now') AS INTEGER) - 4)
    AND e.plant_family_id IS NOT NULL;
