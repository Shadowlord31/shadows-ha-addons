const express = require('express');
const router = express.Router();
const db = require('../db/dienstplan');
const { loadOptions } = require('../options');

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

const workDaysCount = (wd, s, e) => {
  let c = 0, cur = new Date(s + 'T12:00:00'), end = new Date(e + 'T12:00:00');
  while (cur <= end) { const dow = cur.getDay(), idx = dow === 0 ? 6 : dow - 1; if (wd[idx] === '1') c++; cur.setDate(cur.getDate() + 1); }
  return c;
};

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

module.exports = router;
