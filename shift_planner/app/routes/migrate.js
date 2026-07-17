const express = require('express');
const router = express.Router();
const db = require('../db/dienstplan');

// Einmalige Migration von der bestehenden Postgres-Instanz (Dienstplan)
// in die SQLite-DB des Addons. Nur lesend gegen Postgres, keine
// Schreibzugriffe dort. Nur ueber Ingress (auth) aufrufbar.
router.post('/migrate/postgres', async (req, res) => {
  if (!req.dpUser) return res.status(401).json({ error: 'Nicht angemeldet' });
  const { Client } = require('pg');
  const {
    host = '192.168.178.114',
    port = 5432,
    user = 'admin',
    password,
    database = 'dienstplan',
    username_map = {}
  } = req.body || {};
  if (!password) return res.status(400).json({ error: 'password erforderlich' });

  const client = new Client({ host, port, user, password, database });
  const counts = {};
  // WICHTIG: pg liefert DATE/TIMESTAMP-Spalten als JS-Date, dessen Komponenten
  // (getFullYear/getMonth/getDate/...) bereits in LOKALER Zeit dem echten
  // Kalendertag entsprechen. toISOString() rechnet dagegen nach UTC um --
  // bei einem Server mit Sommerzeit (UTC+2) rutscht das Datum dadurch einen
  // Tag zurueck. Deshalb hier ausschliesslich lokale Getter verwenden.
  const pad = (n) => String(n).padStart(2, '0');
  const toDateStr = (v) => {
    if (v == null) return null;
    if (!(v instanceof Date)) return v;
    return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  };
  const toTsStr = (v) => {
    if (v == null) return null;
    if (!(v instanceof Date)) return v;
    return `${toDateStr(v)} ${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}`;
  };
  const toTimeStr = (v) => v == null ? null : String(v).slice(0, 5); // 'HH:MM:SS' -> 'HH:MM'
  const b = (v) => v ? 1 : 0;

  try {
    await client.connect();

    db.pragma('foreign_keys = OFF');
    const tables = ['dp_vacation_carryover', 'dp_holidays', 'dp_work_times', 'dp_vacations', 'dp_shifts', 'dp_shift_types', 'dp_users'];
    const delTx = db.transaction(() => {
      for (const t of tables) db.prepare(`DELETE FROM ${t}`).run();
    });
    delTx();

    // dp_users -- username kann per username_map umgemappt werden (z.B. {"thomas":"admin"}),
    // damit die Ingress-Auth (Fallback-Match per username) den migrierten User automatisch
    // dem echten HA-Login zuordnet.
    let r = await client.query('SELECT * FROM dp_users ORDER BY id');
    const insUser = db.prepare(
      'INSERT INTO dp_users (id,username,display_name,vacation_budget,vacation_base,bundesland,work_days,weekly_hours,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
    );
    const userIdMap = {};
    db.transaction(() => {
      for (const row of r.rows) {
        const mappedUsername = username_map[row.username] || row.username;
        insUser.run(row.id, mappedUsername, row.display_name, row.vacation_budget, row.vacation_base, row.bundesland, row.work_days, row.weekly_hours, toTsStr(row.created_at));
        userIdMap[row.id] = row.id;
      }
    })();
    counts.users = r.rows.length;

    // dp_shift_types
    r = await client.query('SELECT * FROM dp_shift_types ORDER BY id');
    const insST = db.prepare('INSERT INTO dp_shift_types (id,user_id,name,short_name,color,default_start,default_end,counts_as_work) VALUES (?,?,?,?,?,?,?,?)');
    db.transaction(() => { for (const row of r.rows) insST.run(row.id, row.user_id, row.name, row.short_name, row.color, toTimeStr(row.default_start), toTimeStr(row.default_end), b(row.counts_as_work)); })();
    counts.shift_types = r.rows.length;

    // dp_shifts
    r = await client.query('SELECT * FROM dp_shifts ORDER BY id');
    const insShift = db.prepare('INSERT INTO dp_shifts (id,user_id,shift_type_id,date,actual_start,actual_end,note) VALUES (?,?,?,?,?,?,?)');
    db.transaction(() => { for (const row of r.rows) insShift.run(row.id, row.user_id, row.shift_type_id, toDateStr(row.date), toTimeStr(row.actual_start), toTimeStr(row.actual_end), row.note); })();
    counts.shifts = r.rows.length;

    // dp_vacations
    r = await client.query('SELECT * FROM dp_vacations ORDER BY id');
    const insVac = db.prepare('INSERT INTO dp_vacations (id,user_id,start_date,end_date,status,note,year) VALUES (?,?,?,?,?,?,?)');
    db.transaction(() => { for (const row of r.rows) insVac.run(row.id, row.user_id, toDateStr(row.start_date), toDateStr(row.end_date), row.status, row.note, row.year); })();
    counts.vacations = r.rows.length;

    // dp_work_times
    r = await client.query('SELECT * FROM dp_work_times ORDER BY id');
    const insWT = db.prepare('INSERT INTO dp_work_times (id,user_id,date,start_time,end_time,break_minutes,planned_hours,actual_hours,is_vacation,work_type,note) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    db.transaction(() => { for (const row of r.rows) insWT.run(row.id, row.user_id, toDateStr(row.date), toTimeStr(row.start_time), toTimeStr(row.end_time), row.break_minutes, row.planned_hours, row.actual_hours, b(row.is_vacation), row.work_type, row.note); })();
    counts.work_times = r.rows.length;

    // dp_vacation_carryover
    r = await client.query('SELECT * FROM dp_vacation_carryover ORDER BY id');
    const insCO = db.prepare('INSERT INTO dp_vacation_carryover (id,user_id,year,carryover) VALUES (?,?,?,?)');
    db.transaction(() => { for (const row of r.rows) insCO.run(row.id, row.user_id, row.year, row.carryover); })();
    counts.vacation_carryover = r.rows.length;

    // dp_holidays -- war vorher global/geteilt (kein user_id). Wird jetzt fuer JEDEN
    // migrierten User dupliziert, damit alle mit demselben Startbestand loslegen und
    // danach unabhaengig voneinander weiterpflegen (jeder-fuer-sich-Modell).
    r = await client.query('SELECT * FROM dp_holidays ORDER BY id');
    const insHol = db.prepare('INSERT INTO dp_holidays (user_id,name,start_date,end_date,type,bundesland,year) VALUES (?,?,?,?,?,?,?)');
    db.transaction(() => {
      for (const uid of Object.values(userIdMap)) {
        for (const row of r.rows) insHol.run(uid, row.name, toDateStr(row.start_date), toDateStr(row.end_date), row.type, row.bundesland, row.year);
      }
    })();
    counts.holidays = r.rows.length * Object.keys(userIdMap).length;

    db.pragma('foreign_keys = ON');
    await client.end();
    res.json({ ok: true, counts });
  } catch (e) {
    try { await client.end(); } catch {}
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
