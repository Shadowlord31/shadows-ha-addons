const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || '/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'dienstplan.db');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(schema);

// Migration auf Mehrfach-Bloecke pro Tag (Teilschichten): dp_shifts und
// dp_work_times hatten vorher UNIQUE(user_id,date), also maximal einen
// Eintrag pro Tag. SQLite kann einen UNIQUE-Constraint nicht per ALTER
// TABLE aendern, daher hier bei Bedarf einmalig Tabelle umkopieren.
// db.exec(schema) oben hat wegen "CREATE TABLE IF NOT EXISTS" bei
// bestehenden Installationen nichts an der alten Struktur geaendert.
function migrateToMultiBlock(table, cols) {
  const hasSortOrder = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === 'sort_order');
  if (hasSortOrder) return;
  const migrate = db.transaction(() => {
    db.exec(`ALTER TABLE ${table} RENAME TO ${table}_legacy`);
    db.exec(schema); // legt die neue Tabelle (mit sort_order) frisch an
    db.exec(`INSERT INTO ${table} (${cols.join(',')},sort_order) SELECT ${cols.join(',')},0 FROM ${table}_legacy`);
    db.exec(`DROP TABLE ${table}_legacy`);
  });
  migrate();
}
migrateToMultiBlock('dp_shifts', ['id', 'user_id', 'shift_type_id', 'date', 'actual_start', 'actual_end', 'note']);
migrateToMultiBlock('dp_work_times', ['id', 'user_id', 'date', 'start_time', 'end_time', 'break_minutes', 'planned_hours', 'actual_hours', 'is_vacation', 'work_type', 'note']);

module.exports = db;
