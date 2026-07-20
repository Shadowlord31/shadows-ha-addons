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
    sparschwein_id TEXT,
    kategorie_id TEXT,
    datum TEXT NOT NULL,
    betrag REAL NOT NULL,
    beschreibung TEXT,
    erstellt_am TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (sparschwein_id) REFERENCES sparschweine(id) ON DELETE SET NULL,
    FOREIGN KEY (kategorie_id) REFERENCES kategorien(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS idx_spareintraege_sparschwein_datum ON spareintraege(sparschwein_id, datum);
`);

// ─── Migrationen fuer bestehende Installationen ────────────────────────────

// v0.1.0 -> v0.2.0: kategorie_id-Spalte nachruesten (falls sie noch fehlt).
// Muss vor dem Index auf kategorie_id laufen.
try {
  db.exec('ALTER TABLE spareintraege ADD COLUMN kategorie_id TEXT REFERENCES kategorien(id) ON DELETE SET NULL');
} catch (e) {
  if (!/duplicate column/i.test(e.message)) throw e;
}
db.exec('CREATE INDEX IF NOT EXISTS idx_spareintraege_kategorie ON spareintraege(kategorie_id)');

// v0.2.0 -> v0.3.0: sparschwein_id war NOT NULL mit ON DELETE CASCADE.
// SQLite kann eine Spalte nicht per ALTER TABLE nullable machen, deshalb wird
// die Tabelle neu aufgebaut (Standard-SQLite-Migrationsmuster: neue Tabelle,
// Daten kopieren, alte Tabelle ersetzen).
const sparschweinIdInfo = db.prepare("PRAGMA table_info(spareintraege)").all().find(c => c.name === 'sparschwein_id');
if (sparschweinIdInfo && sparschweinIdInfo.notnull === 1) {
  const migrate = db.transaction(() => {
    db.exec(`
      CREATE TABLE spareintraege_neu (
        id TEXT PRIMARY KEY,
        sparschwein_id TEXT,
        kategorie_id TEXT,
        datum TEXT NOT NULL,
        betrag REAL NOT NULL,
        beschreibung TEXT,
        erstellt_am TEXT NOT NULL DEFAULT (datetime('now')),
        FOREIGN KEY (sparschwein_id) REFERENCES sparschweine(id) ON DELETE SET NULL,
        FOREIGN KEY (kategorie_id) REFERENCES kategorien(id) ON DELETE SET NULL
      );
      INSERT INTO spareintraege_neu (id, sparschwein_id, kategorie_id, datum, betrag, beschreibung, erstellt_am)
        SELECT id, sparschwein_id, kategorie_id, datum, betrag, beschreibung, erstellt_am FROM spareintraege;
      DROP TABLE spareintraege;
      ALTER TABLE spareintraege_neu RENAME TO spareintraege;
      CREATE INDEX IF NOT EXISTS idx_spareintraege_sparschwein_datum ON spareintraege(sparschwein_id, datum);
      CREATE INDEX IF NOT EXISTS idx_spareintraege_kategorie ON spareintraege(kategorie_id);
    `);
  });
  migrate();
}

module.exports = db;
