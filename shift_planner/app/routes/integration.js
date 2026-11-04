const express = require('express');
const router = express.Router();
const db = require('../db/dienstplan');
const { loadOptions } = require('../options');
const {
  workDaysCount,
  VACATION_STATUSES,
  isValidDateStr,
  computeVacationRemaining,
  bookVacationWorkTimes,
  resolveShiftType,
  replaceShiftForDate,
  computeYearStats,
} = require('../lib/shared');
// package.json wird (anders als config.yaml) mit ins Docker-Image kopiert,
// daher hier als einzige zur Laufzeit verlaessliche Versionsquelle -- bei
// jedem Versions-Bump also beide Dateien (config.yaml + package.json) pflegen.
const ADDON_VERSION = require('../package.json').version;

// Eigener, einfacher Zugang fuer die Home-Assistant-Integration: laeuft in
// HA Core, also OHNE Ingress und damit ohne X-Remote-User-* Header. Statt
// dessen ein fester API-Token aus der Addon-Konfiguration (Einstellungen-Tab
// des Addons in HA), der bei jeder Anfrage per Header verglichen wird.
function tokenAuth(req, res, next) {
  const configured = (loadOptions().api_token || '').trim();
  if (!configured) return res.status(403).json({ error: 'Kein api_token in der Addon-Konfiguration gesetzt' });
  const given = req.headers['x-api-token'] || '';
  if (given !== configured) return res.status(401).json({ error: 'Ungueltiger oder fehlender X-API-Token Header' });
  next();
}

router.get('/api/dp/integration/summary', tokenAuth, (req, res) => {
  try {
    const toLocal = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const today = toLocal(new Date());
    const year = new Date().getFullYear();

    const users = db.prepare('SELECT * FROM dp_users ORDER BY id').all();
    const result = users.map(u => {
      // Naechste Schicht (heute oder in der Zukunft)
      const nextShift = db.prepare(
        `SELECT s.date, s.actual_start, s.actual_end, st.name as type_name, st.short_name, st.color,
                st.default_start, st.default_end, st.counts_as_work
         FROM dp_shifts s LEFT JOIN dp_shift_types st ON s.shift_type_id = st.id
         WHERE s.user_id=? AND s.date>=? ORDER BY s.date ASC LIMIT 1`
      ).get(u.id, today);

      // Heutige Schicht separat fuer "im Dienst jetzt"
      const todayShift = db.prepare(
        `SELECT s.actual_start, s.actual_end, st.default_start, st.default_end, st.counts_as_work
         FROM dp_shifts s LEFT JOIN dp_shift_types st ON s.shift_type_id = st.id
         WHERE s.user_id=? AND s.date=?`
      ).get(u.id, today);
      let onShiftNow = false;
      let shiftStartIso = null, shiftEndIso = null;
      if (todayShift && todayShift.counts_as_work) {
        const start = todayShift.actual_start || todayShift.default_start;
        const end = todayShift.actual_end || todayShift.default_end;
        if (start && end) {
          const now = new Date();
          const [sh, sm] = start.split(':').map(Number);
          const [eh, em] = end.split(':').map(Number);
          const startD = new Date(now); startD.setHours(sh, sm, 0, 0);
          const endD = new Date(now); endD.setHours(eh, em, 0, 0);
          if (endD <= startD) endD.setDate(endD.getDate() + 1); // Nachtschicht
          onShiftNow = now >= startD && now <= endD;
          shiftStartIso = startD.toISOString();
          shiftEndIso = endD.toISOString();
        }
      }

      // Laeuft gerade Urlaub?
      const vacationToday = db.prepare(
        `SELECT 1 FROM dp_vacations WHERE user_id=? AND start_date<=? AND end_date>=? AND status!='abgelehnt' LIMIT 1`
      ).get(u.id, today, today);

      // Naechster Urlaub
      const nextVacation = db.prepare(
        `SELECT start_date, end_date, status, note FROM dp_vacations
         WHERE user_id=? AND start_date>=? AND status!='abgelehnt' ORDER BY start_date ASC LIMIT 1`
      ).get(u.id, today);

      // Resturlaub (aktuelles Jahr)
      const base = u.vacation_base || u.vacation_budget || 30;
      const co = db.prepare('SELECT carryover FROM dp_vacation_carryover WHERE user_id=? AND year=?').get(u.id, year);
      const budget = base + (co?.carryover || 0);
      const wd = u.work_days || '1111100';
      const vacs = db.prepare("SELECT start_date as s, end_date as e, status FROM dp_vacations WHERE user_id=? AND year=? AND status!='abgelehnt'").all(u.id, year);
      const used = vacs.filter(v => v.status !== 'geplant').reduce((s, v) => s + workDaysCount(wd, v.s, v.e), 0);
      const planned = vacs.filter(v => v.status === 'geplant').reduce((s, v) => s + workDaysCount(wd, v.s, v.e), 0);

      return {
        username: u.username,
        ha_user_id: u.ha_user_id,
        display_name: u.display_name,
        on_shift_now: onShiftNow,
        shift_start: shiftStartIso,
        shift_end: shiftEndIso,
        on_vacation_now: !!vacationToday,
        next_shift: nextShift ? {
          date: nextShift.date,
          start: nextShift.actual_start || nextShift.default_start,
          end: nextShift.actual_end || nextShift.default_end,
          type_name: nextShift.type_name,
          short_name: nextShift.short_name,
          color: nextShift.color
        } : null,
        next_vacation: nextVacation ? {
          start_date: nextVacation.start_date,
          end_date: nextVacation.end_date,
          status: nextVacation.status,
          note: nextVacation.note
        } : null,
        vacation_budget: budget,
        vacation_remaining: budget - used - planned
      };
    });

    res.json({ users: result, generated_at: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Schichten eines Users in einem Datumsbereich, fuer die HA-Kalender-Entitaet.
// HA fragt beim Anzeigen selbst ab, welcher Zeitraum gebraucht wird (Wochen-,
// Monatsansicht etc.) -- daher hier ein echter Bereich statt fest 7 Tage.
router.get('/api/dp/integration/shifts', tokenAuth, (req, res) => {
  const { username, start, end } = req.query;
  if (!username || !start || !end) return res.status(400).json({ error: 'username, start und end erforderlich' });
  const user = db.prepare('SELECT id FROM dp_users WHERE username=?').get(username);
  if (!user) return res.status(404).json({ error: 'User nicht gefunden' });

  const rows = db.prepare(
    `SELECT s.date, s.actual_start, s.actual_end, st.name as type_name, st.short_name, st.color,
            st.default_start, st.default_end, st.counts_as_work
     FROM dp_shifts s LEFT JOIN dp_shift_types st ON s.shift_type_id = st.id
     WHERE s.user_id=? AND s.date>=? AND s.date<=? ORDER BY s.date ASC`
  ).all(user.id, start, end);

  const events = rows.filter(r => r.counts_as_work).map(r => {
    const startTime = r.actual_start || r.default_start || '00:00';
    const endTime = r.actual_end || r.default_end || '23:59';
    let endDate = r.date;
    // Nachtschicht: Ende liegt zeitlich vor Beginn -> Ende ist am Folgetag
    if (endTime <= startTime) {
      const d = new Date(r.date + 'T12:00:00'); d.setDate(d.getDate() + 1);
      endDate = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
    return {
      summary: r.type_name || 'Schicht',
      short_name: r.short_name,
      color: r.color,
      start: `${r.date}T${startTime}:00`,
      end: `${endDate}T${endTime}:00`
    };
  });

  res.json({ username, events });
});

// ===== ARBEITSZEIT-ERFASSUNG (fuer HA-Services, u.a. Zonen-Automationen) =====

function findUserOr404(username, res) {
  const user = db.prepare('SELECT * FROM dp_users WHERE username=?').get(username);
  if (!user) { res.status(404).json({ error: 'User nicht gefunden' }); return null; }
  return user;
}
function nowHHMM() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function computeHours(start, end, breakMin) {
  // dp_work_times bildet einen einzelnen Kalendertag ab (anders als
  // dp_shifts+shift_types, die Nachtschichten ueber Mitternacht kennen) --
  // hier also KEIN 24h-Wrap, sondern auf 0 clampen (z.B. Pause > Arbeitszeit
  // bei einem sehr kurzen Check-in/Check-out-Test).
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  const mins = Math.max(0, (eh * 60 + em) - (sh * 60 + sm) - (breakMin || 0));
  return Math.round((mins / 60) * 100) / 100;
}

// Kommt-Buchung: legt/aktualisiert den heutigen Arbeitszeit-Eintrag mit
// Start = jetzt. Kein Fehler, wenn schon eine Startzeit existiert (einfach
// ueberschrieben) -- z.B. bei doppeltem Zonen-Enter-Trigger.
router.post('/api/dp/integration/checkin', tokenAuth, (req, res) => {
  const { username, break_minutes } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username erforderlich' });
  const user = findUserOr404(username, res); if (!user) return;
  const date = todayStr(), start = nowHHMM();
  // Seit der Teilschicht-Migration (sort_order, UNIQUE(user_id,date,sort_order))
  // gibt es keinen auf (user_id,date) passenden Unique-Index mehr fuer
  // ON CONFLICT -- daher expliziter Upsert auf den ersten Block des Tages.
  const existing = db.prepare('SELECT * FROM dp_work_times WHERE user_id=? AND date=? ORDER BY sort_order LIMIT 1').get(user.id, date);
  let row;
  if (existing) {
    const brk = break_minutes ?? existing.break_minutes;
    row = db.prepare('UPDATE dp_work_times SET start_time=?,break_minutes=? WHERE id=? RETURNING *').get(start, brk, existing.id);
  } else {
    row = db.prepare(
      `INSERT INTO dp_work_times (user_id,date,sort_order,start_time,break_minutes,work_type) VALUES (?,?,0,?,?, 'work') RETURNING *`
    ).get(user.id, date, start, break_minutes ?? null);
  }
  res.json(row);
});

// Geht-Buchung: setzt Ende = jetzt auf dem heutigen Eintrag und berechnet die
// Stunden. Legt den Eintrag notfalls auch ohne vorheriges Check-in an
// (Start dann = Ende, 0 Stunden) statt mit Fehler abzubrechen.
router.post('/api/dp/integration/checkout', tokenAuth, (req, res) => {
  const { username, break_minutes } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username erforderlich' });
  const user = findUserOr404(username, res); if (!user) return;
  const date = todayStr(), end = nowHHMM();
  let existing = db.prepare('SELECT * FROM dp_work_times WHERE user_id=? AND date=? ORDER BY sort_order LIMIT 1').get(user.id, date);
  const start = existing?.start_time || end;
  const brk = break_minutes ?? existing?.break_minutes ?? 0;
  const hours = computeHours(start, end, brk);
  let row;
  if (existing) {
    row = db.prepare('UPDATE dp_work_times SET end_time=?,break_minutes=?,actual_hours=? WHERE id=? RETURNING *').get(end, brk, hours, existing.id);
  } else {
    row = db.prepare(
      `INSERT INTO dp_work_times (user_id,date,sort_order,start_time,end_time,break_minutes,actual_hours,work_type) VALUES (?,?,0,?,?,?,?, 'work') RETURNING *`
    ).get(user.id, date, start, end, brk, hours);
  }
  res.json(row);
});

// Manueller/vollstaendiger Eintrag (z.B. Nachtragen, oder eine Automation die
// Start+Ende in einem Rutsch kennt statt zwei Zonen-Trigger zu brauchen).
router.post('/api/dp/integration/worktime', tokenAuth, (req, res) => {
  const { username, date, start_time, end_time, break_minutes, work_type, note } = req.body || {};
  if (!username || !date || !start_time || !end_time) {
    return res.status(400).json({ error: 'username, date, start_time und end_time erforderlich' });
  }
  const user = findUserOr404(username, res); if (!user) return;
  const brk = break_minutes || 0;
  const wt = work_type || 'work';
  const isSpecial = wt === 'vacation' || wt === 'holiday_comp' || wt === 'sick';
  const hours = isSpecial ? 8 : computeHours(start_time, end_time, brk);
  const existing = db.prepare('SELECT id FROM dp_work_times WHERE user_id=? AND date=? ORDER BY sort_order LIMIT 1').get(user.id, date);
  let row;
  if (existing) {
    row = db.prepare(
      'UPDATE dp_work_times SET start_time=?,end_time=?,break_minutes=?,actual_hours=?,work_type=?,note=? WHERE id=? RETURNING *'
    ).get(start_time, end_time, brk, hours, wt, note || null, existing.id);
  } else {
    row = db.prepare(
      `INSERT INTO dp_work_times (user_id,date,sort_order,start_time,end_time,break_minutes,actual_hours,work_type,note) VALUES (?,?,0,?,?,?,?,?,?) RETURNING *`
    ).get(user.id, date, start_time, end_time, brk, hours, wt, note || null);
  }
  res.json(row);
});

// ===== LESEN: SCHICHTARTEN & URLAUBE =====

router.get('/api/dp/integration/shift-types', tokenAuth, (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'username erforderlich' });
  const user = findUserOr404(username, res); if (!user) return;
  const rows = db.prepare(
    'SELECT id,name,short_name,default_start,default_end,counts_as_work FROM dp_shift_types WHERE user_id=? ORDER BY name'
  ).all(user.id);
  res.json(rows);
});

router.get('/api/dp/integration/vacations', tokenAuth, (req, res) => {
  const { username, year } = req.query;
  if (!username) return res.status(400).json({ error: 'username erforderlich' });
  const user = findUserOr404(username, res); if (!user) return;
  let q = 'SELECT id,start_date,end_date,status,note,year FROM dp_vacations WHERE user_id=?';
  const p = [user.id];
  if (year) { q += ' AND year=?'; p.push(parseInt(year)); }
  q += ' ORDER BY start_date';
  res.json(db.prepare(q).all(...p));
});

// ===== SCHICHTEN SCHREIBEN =====

// Legt die Schicht des Tages an oder ersetzt sie komplett (ein autoritativer
// Eintrag je Tag -- anders als die Teilschicht-Oberflaeche, die mehrere
// Bloecke pro Tag erlaubt; fuer Automationen reicht ein einzelner Eintrag).
router.put('/api/dp/integration/shift', tokenAuth, (req, res) => {
  const { username, date, shift_type, actual_start, actual_end } = req.body || {};
  if (!username || !date || !shift_type) {
    return res.status(400).json({ error: 'username, date und shift_type erforderlich' });
  }
  if (!isValidDateStr(date)) return res.status(400).json({ error: 'date muss im Format YYYY-MM-DD sein' });
  const user = findUserOr404(username, res); if (!user) return;
  const st = resolveShiftType(db, user.id, shift_type);
  if (!st) return res.status(404).json({ error: `Schichtart '${shift_type}' nicht gefunden` });
  const row = replaceShiftForDate(db, user.id, date, {
    shiftTypeId: st.id, actualStart: actual_start, actualEnd: actual_end, note: null,
  });
  const full = db.prepare(
    `SELECT s.*,st.name as type_name,st.short_name,st.color,st.default_start,st.default_end,st.counts_as_work
     FROM dp_shifts s LEFT JOIN dp_shift_types st ON s.shift_type_id=st.id WHERE s.id=?`
  ).get(row.id);
  res.json(full);
});

router.delete('/api/dp/integration/shift', tokenAuth, (req, res) => {
  const { username, date } = req.body || {};
  if (!username || !date) return res.status(400).json({ error: 'username und date erforderlich' });
  const user = findUserOr404(username, res); if (!user) return;
  const info = db.prepare('DELETE FROM dp_shifts WHERE user_id=? AND date=?').run(user.id, date);
  res.json({ ok: true, deleted: info.changes });
});

// ===== URLAUB SCHREIBEN =====

// Legt einen neuen Urlaub an -- wie die Oberflaeche beim Anlegen loest das
// (auch bei status='genommen') noch KEINE automatische 8h-Buchung aus; die
// passiert erst beim nachtraeglichen Setzen des Status auf 'genommen'
// (PATCH unten), identisch zum Verhalten der Status-Buttons in der UI.
router.post('/api/dp/integration/vacation', tokenAuth, (req, res) => {
  const { username, start_date, end_date, status, note } = req.body || {};
  if (!username || !start_date || !end_date) {
    return res.status(400).json({ error: 'username, start_date und end_date erforderlich' });
  }
  if (!isValidDateStr(start_date) || !isValidDateStr(end_date)) {
    return res.status(400).json({ error: 'start_date/end_date muessen im Format YYYY-MM-DD sein' });
  }
  if (new Date(start_date) > new Date(end_date)) {
    return res.status(400).json({ error: 'end_date muss auf oder nach start_date liegen' });
  }
  const st = status || 'geplant';
  if (!VACATION_STATUSES.includes(st)) {
    return res.status(400).json({ error: `status muss einer von ${VACATION_STATUSES.join(', ')} sein` });
  }
  const user = findUserOr404(username, res); if (!user) return;
  const year = new Date(start_date + 'T12:00:00').getFullYear();
  const row = db.prepare(
    `INSERT INTO dp_vacations (user_id,start_date,end_date,status,note,year) VALUES (?,?,?,?,?,?) RETURNING id,start_date,end_date,status,note,year`
  ).get(user.id, start_date, end_date, st, note || null, year);
  res.json({ ...row, vacation_remaining: computeVacationRemaining(db, user.id, year) });
});

// Aktualisiert einen bestehenden Urlaub (Teil-Update). Wechselt der
// resultierende Status auf 'genommen', wird -- exakt wie beim Status-Klick
// in der Oberflaeche -- automatisch 8h Arbeitszeit fuer jeden Arbeitstag
// des Zeitraums gebucht.
router.patch('/api/dp/integration/vacation/:id', tokenAuth, (req, res) => {
  const { username, start_date, end_date, status, note } = req.body || {};
  if (!username) return res.status(400).json({ error: 'username erforderlich' });
  const user = findUserOr404(username, res); if (!user) return;
  const existing = db.prepare('SELECT * FROM dp_vacations WHERE id=? AND user_id=?').get(req.params.id, user.id);
  if (!existing) return res.status(404).json({ error: 'Urlaub nicht gefunden' });

  const merged = {
    start_date: start_date ?? existing.start_date,
    end_date: end_date ?? existing.end_date,
    status: status ?? existing.status,
    note: note !== undefined ? note : existing.note,
  };
  if (!isValidDateStr(merged.start_date) || !isValidDateStr(merged.end_date)) {
    return res.status(400).json({ error: 'start_date/end_date muessen im Format YYYY-MM-DD sein' });
  }
  if (new Date(merged.start_date) > new Date(merged.end_date)) {
    return res.status(400).json({ error: 'end_date muss auf oder nach start_date liegen' });
  }
  if (!VACATION_STATUSES.includes(merged.status)) {
    return res.status(400).json({ error: `status muss einer von ${VACATION_STATUSES.join(', ')} sein` });
  }

  const year = new Date(merged.start_date + 'T12:00:00').getFullYear();
  const row = db.prepare(
    `UPDATE dp_vacations SET start_date=?,end_date=?,status=?,note=?,year=? WHERE id=? AND user_id=? RETURNING id,start_date,end_date,status,note,year`
  ).get(merged.start_date, merged.end_date, merged.status, merged.note, year, req.params.id, user.id);
  if (merged.status === 'genommen') bookVacationWorkTimes(db, user.id, row.start_date, row.end_date);
  res.json({ ...row, vacation_remaining: computeVacationRemaining(db, user.id, year) });
});

router.delete('/api/dp/integration/vacation/:id', tokenAuth, (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: 'username erforderlich' });
  const user = findUserOr404(username, res); if (!user) return;
  const existing = db.prepare('SELECT id FROM dp_vacations WHERE id=? AND user_id=?').get(req.params.id, user.id);
  if (!existing) return res.status(404).json({ error: 'Urlaub nicht gefunden' });
  db.prepare('DELETE FROM dp_vacations WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ===== EXPORT (rein lesend) =====
// Grundlage fuer eine 1:1-Uebernahme durch Jarvis. Liefert alle
// Dienstplan-Tabellen als Rohdaten (unveraenderte Spaltennamen/-werte, keine
// Umbenennung/Rundung/Zeitzonenkonvertierung) plus die vom Add-on selbst
// berechneten Vergleichswerte (computeVacationRemaining/computeYearStats --
// dieselben Funktionen, die auch /api/dp/vacations/remaining/:year und
// /api/dp/stats/:year beliefern), damit Jarvis seine eigene Rechenlogik
// dagegen pruefen kann. Reine SELECTs, kein Schreibzugriff, keine Migration.
router.get('/api/dp/integration/export', tokenAuth, (req, res) => {
  try {
    const tables = {
      dp_users: db.prepare('SELECT * FROM dp_users ORDER BY id').all(),
      dp_shift_types: db.prepare('SELECT * FROM dp_shift_types ORDER BY id').all(),
      dp_shifts: db.prepare('SELECT * FROM dp_shifts ORDER BY id').all(),
      dp_vacations: db.prepare('SELECT * FROM dp_vacations ORDER BY id').all(),
      dp_work_times: db.prepare('SELECT * FROM dp_work_times ORDER BY id').all(),
      dp_vacation_carryover: db.prepare('SELECT * FROM dp_vacation_carryover ORDER BY id').all(),
      dp_holidays: db.prepare('SELECT * FROM dp_holidays ORDER BY id').all(),
    };

    const zaehler = {};
    for (const [name, rows] of Object.entries(tables)) zaehler[name] = rows.length;

    const now = new Date();
    const curYear = now.getFullYear();
    const curMonth = now.getMonth() + 1;
    const vergleich = tables.dp_users.map((u) => {
      const shiftCount = db.prepare(
        "SELECT COUNT(*) as n FROM dp_shifts WHERE user_id=? AND strftime('%Y',date)=? AND strftime('%m',date)=?"
      ).get(u.id, String(curYear), String(curMonth).padStart(2, '0')).n;
      return {
        user_id: u.id,
        username: u.username,
        vacation_remaining: computeVacationRemaining(db, u.id, curYear),
        stats: computeYearStats(db, u.id, curYear),
        shifts_current_month: { year: curYear, month: curMonth, count: shiftCount },
      };
    });

    res.json({
      version: ADDON_VERSION,
      exportiert_am: now.toISOString(),
      zaehler,
      ...tables,
      vergleich,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
