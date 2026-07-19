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
  CREATE TABLE IF NOT EXISTS spareintraege (
    id TEXT PRIMARY KEY,
    sparschwein_id TEXT NOT NULL,
    datum TEXT NOT NULL,
    betrag REAL NOT NULL,
    beschreibung TEXT,
    erstellt_am TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (sparschwein_id) REFERENCES sparschweine(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_spareintraege_sparschwein_datum ON spareintraege(sparschwein_id, datum);
`);

module.exports = db;
