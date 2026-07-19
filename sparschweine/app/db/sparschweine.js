const Database = require('better-sqlite3');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || '/data';
const db = new Database(path.join(DATA_DIR, 'sparschweine.sqlite'));
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS sparschweine (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    zielbetrag REAL,
    farbe TEXT NOT NULL DEFAULT '#4CAF50',
    erstellt_am TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS kategorien (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    farbe TEXT NOT NULL DEFAULT '#888888',
    erstellt_am TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS spareintraege (
    id TEXT PRIMARY KEY,
    sparschwein_id TEXT NOT NULL,
    kategorie_id TEXT,
    datum TEXT NOT NULL,
    betrag REAL NOT NULL,
    beschreibung TEXT,
    erstellt_am TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (sparschwein_id) REFERENCES sparschweine(id) ON DELETE CASCADE,
    FOREIGN KEY (kategorie_id) REFERENCES kategorien(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_spareintraege_sparschwein_datum ON spareintraege(sparschwein_id, datum);
`);

// Migration fuer bereits existierende DBs aus v0.1.0 (ohne kategorie_id-Spalte).
// Muss vor dem Index auf kategorie_id laufen, sonst schlaegt die Index-Erstellung
// auf einer alten DB fehl (Spalte existiert dort noch nicht).
try {
  db.exec('ALTER TABLE spareintraege ADD COLUMN kategorie_id TEXT REFERENCES kategorien(id) ON DELETE SET NULL');
} catch (e) {
  if (!/duplicate column/i.test(e.message)) throw e;
}

db.exec('CREATE INDEX IF NOT EXISTS idx_spareintraege_kategorie ON spareintraege(kategorie_id)');

module.exports = db;
