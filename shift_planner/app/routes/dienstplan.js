const express = require('express');
const router = express.Router();
const db = require('../db/dienstplan');

// ===== HELPERS =====
const b = (v) => (v ? 1 : 0); // JS boolean -> SQLite 0/1
const workDaysCount = (wd, s, e) => {
  let c = 0, cur = new Date(s + 'T12:00:00'), end = new Date(e + 'T12:00:00');
  while (cur <= end) { const dow = cur.getDay(), idx = dow === 0 ? 6 : dow - 1; if (wd[idx] === '1') c++; cur.setDate(cur.getDate() + 1); }
  return c;
};

// ===== AUTH (Ingress-Identität, siehe middleware/ingress-auth.js) =====
function auth(req, res, next) {
  if (!req.dpUser) return res.status(401).json({ error: 'Nicht angemeldet' });
  next();
}

// ===== ME =====
router.get('/api/dp/me', auth, (req, res) => {
  res.json({ userId: req.dpUser.id, displayName: req.dpUser.display_name });
});

// ===== SHIFT TYPES =====
router.get('/api/dp/shifttypes', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM dp_shift_types WHERE user_id=? ORDER BY name').all(req.dpUser.id));
});
router.post('/api/dp/shifttypes', auth, (req, res) => {
  const { name, short_name, color, default_start, default_end, counts_as_work } = req.body;
  const row = db.prepare(
    `INSERT INTO dp_shift_types (user_id,name,short_name,color,default_start,default_end,counts_as_work) VALUES (?,?,?,?,?,?,?) RETURNING *`
  ).get(req.dpUser.id, name, short_name, color || '#4f8ef7', default_start || null, default_end || null, b(counts_as_work !== false));
  res.json(row);
});
router.put('/api/dp/shifttypes/:id', auth, (req, res) => {
  const { name, short_name, color, default_start, default_end, counts_as_work } = req.body;
  const row = db.prepare(
    `UPDATE dp_shift_types SET name=?,short_name=?,color=?,default_start=?,default_end=?,counts_as_work=? WHERE id=? AND user_id=? RETURNING *`
  ).get(name, short_name, color, default_start || null, default_end || null, b(counts_as_work !== false), req.params.id, req.dpUser.id);
  res.json(row);
});
router.delete('/api/dp/shifttypes/:id', auth, (req, res) => {
  db.prepare('DELETE FROM dp_shift_types WHERE id=? AND user_id=?').run(req.params.id, req.dpUser.id);
  res.json({ ok: true });
});

// ===== SHIFTS =====
router.get('/api/dp/shifts', auth, (req, res) => {
  const { year, month } = req.query;
  let q = `SELECT s.*,st.name as type_name,st.short_name,st.color,st.counts_as_work,st.default_start,st.default_end
           FROM dp_shifts s LEFT JOIN dp_shift_types st ON s.shift_type_id=st.id WHERE s.user_id=?`;
  const p = [req.dpUser.id];
  if (year && month) { q += ` AND strftime('%Y',s.date)=? AND strftime('%m',s.date)=?`; p.push(String(year), String(month).padStart(2, '0')); }
  q += ' ORDER BY s.date';
  res.json(db.prepare(q).all(...p));
});
router.post('/api/dp/shifts', auth, (req, res) => {
  const { date, shift_type_id, actual_start, actual_end, note } = req.body;
  const row = db.prepare(
    `INSERT INTO dp_shifts (user_id,date,shift_type_id,actual_start,actual_end,note) VALUES (?,?,?,?,?,?)
     ON CONFLICT(user_id,date) DO UPDATE SET shift_type_id=excluded.shift_type_id,actual_start=excluded.actual_start,actual_end=excluded.actual_end,note=excluded.note RETURNING *`
  ).get(req.dpUser.id, date, shift_type_id || null, actual_start || null, actual_end || null, note || null);
  res.json(row);
});
router.delete('/api/dp/shifts/:id', auth, (req, res) => {
  db.prepare('DELETE FROM dp_shifts WHERE id=? AND user_id=?').run(req.params.id, req.dpUser.id);
  res.json({ ok: true });
});

// ===== VACATIONS =====
router.get('/api/dp/vacations', auth, (req, res) => {
  const { year } = req.query;
  let q = 'SELECT id,user_id,start_date,end_date,status,note,year FROM dp_vacations WHERE user_id=?';
  const p = [req.dpUser.id];
  if (year) { q += ' AND year=?'; p.push(year); }
  q += ' ORDER BY start_date';
  res.json(db.prepare(q).all(...p));
});
router.get('/api/dp/vacations/remaining/:year', auth, (req, res) => {
  const u = db.prepare('SELECT vacation_base,vacation_budget,work_days FROM dp_users WHERE id=?').get(req.dpUser.id);
  const base = u?.vacation_base || u?.vacation_budget || 30;
  const co = db.prepare('SELECT carryover FROM dp_vacation_carryover WHERE user_id=? AND year=?').get(req.dpUser.id, parseInt(req.params.year));
  const carryover = co?.carryover || 0;
  const budget = base + carryover;
  const wd = u?.work_days || '1111100';
  const allV = db.prepare("SELECT start_date as s,end_date as e,status FROM dp_vacations WHERE user_id=? AND year=? AND status!='abgelehnt'").all(req.dpUser.id, req.params.year);
  const used = allV.filter(v => v.status === 'genommen').reduce((s, v) => s + workDaysCount(wd, v.s, v.e), 0);
  const planned = allV.filter(v => v.status === 'geplant').reduce((s, v) => s + workDaysCount(wd, v.s, v.e), 0);
  const approved = allV.filter(v => v.status === 'genehmigt').reduce((s, v) => s + workDaysCount(wd, v.s, v.e), 0);
  res.json({ budget, base, carryover, used, planned, approved, remaining: budget - used - planned - approved, work_days: wd });
});
router.post('/api/dp/vacations', auth, (req, res) => {
  const { start_date, end_date, status, note, year, also_for_users } = req.body;
  const yr = year || new Date().getFullYear();
  const row = db.prepare(
    `INSERT INTO dp_vacations (user_id,start_date,end_date,status,note,year) VALUES (?,?,?,?,?,?) RETURNING id,user_id,start_date,end_date,status,note,year`
  ).get(req.dpUser.id, start_date, end_date, status || 'geplant', note || null, yr);
  res.json(row);
  if (Array.isArray(also_for_users) && also_for_users.length) {
    const ins = db.prepare(`INSERT INTO dp_vacations (user_id,start_date,end_date,status,note,year) VALUES (?,?,?,?,?,?)`);
    for (const uid of also_for_users) ins.run(uid, start_date, end_date, status || 'geplant', note || null, yr);
  }
});
router.put('/api/dp/vacations/:id', auth, (req, res) => {
  const { start_date, end_date, status, note, year } = req.body;
  const row = db.prepare(
    `UPDATE dp_vacations SET start_date=?,end_date=?,status=?,note=?,year=? WHERE id=? AND user_id=? RETURNING id,user_id,start_date,end_date,status,note,year`
  ).get(start_date, end_date, status, note, year, req.params.id, req.dpUser.id);
  res.json(row);
});
router.delete('/api/dp/vacations/:id', auth, (req, res) => {
  db.prepare('DELETE FROM dp_vacations WHERE id=? AND user_id=?').run(req.params.id, req.dpUser.id);
  res.json({ ok: true });
});
router.patch('/api/dp/vacations/:id/status', auth, (req, res) => {
  const { status } = req.body;
  try {
    const vac = db.prepare('UPDATE dp_vacations SET status=? WHERE id=? AND user_id=? RETURNING id,start_date,end_date,status').get(status, req.params.id, req.dpUser.id);
    if (!vac) return res.status(404).json({ error: 'Nicht gefunden' });
    if (status === 'genommen') {
      const usr = db.prepare('SELECT work_days FROM dp_users WHERE id=?').get(req.dpUser.id);
      const wd2 = usr?.work_days || '1111100';
      const cur = new Date(vac.start_date + 'T12:00:00'), end2 = new Date(vac.end_date + 'T12:00:00');
      const upsert = db.prepare(`INSERT INTO dp_work_times (user_id,date,actual_hours,is_vacation,work_type,note) VALUES (?,?,8,1,'vacation','Urlaubstag')
        ON CONFLICT(user_id,date) DO UPDATE SET actual_hours=8,is_vacation=1,work_type='vacation',note='Urlaubstag'`);
      while (cur <= end2) {
        const dow = cur.getDay(), idx = dow === 0 ? 6 : dow - 1;
        if (wd2[idx] === '1') { const ds = cur.toLocaleDateString('sv-SE'); upsert.run(req.dpUser.id, ds); }
        cur.setDate(cur.getDate() + 1);
      }
    }
    res.json({ ok: true, vac });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
router.post('/api/dp/vacations/carryover', auth, (req, res) => {
  const { from_year, to_year } = req.body;
  try {
    const u = db.prepare('SELECT vacation_base,vacation_budget FROM dp_users WHERE id=?').get(req.dpUser.id);
    const base = u?.vacation_base || u?.vacation_budget || 30;
    const prevCo = db.prepare('SELECT carryover FROM dp_vacation_carryover WHERE user_id=? AND year=?').get(req.dpUser.id, from_year);
    const co = prevCo?.carryover || 0;
    const budget = base + co;
    const v = db.prepare("SELECT COALESCE(SUM(julianday(end_date)-julianday(start_date)+1),0) as used FROM dp_vacations WHERE user_id=? AND year=? AND status!='abgelehnt'").get(req.dpUser.id, from_year);
    const used = parseInt(v.used);
    const carry = Math.max(0, budget - used);
    db.prepare('INSERT INTO dp_vacation_carryover (user_id,year,carryover) VALUES (?,?,?) ON CONFLICT(user_id,year) DO UPDATE SET carryover=?').run(req.dpUser.id, to_year, carry, carry);
    res.json({ ok: true, carried: carry, from_year, to_year });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== WORK TIMES =====
router.get('/api/dp/worktimes', auth, (req, res) => {
  const { year, month } = req.query;
  let q = 'SELECT * FROM dp_work_times WHERE user_id=?';
  const p = [req.dpUser.id];
  if (year && month) { q += " AND strftime('%Y',date)=? AND strftime('%m',date)=?"; p.push(String(year), String(month).padStart(2, '0')); }
  q += ' ORDER BY date DESC';
  res.json(db.prepare(q).all(...p));
});
router.post('/api/dp/worktimes', auth, (req, res) => {
  const { date, start_time, end_time, break_minutes, note, work_type } = req.body;
  let actual_hours = null;
  const is8h = work_type === 'vacation' || work_type === 'holiday_comp' || work_type === 'sick';
  if (is8h) { actual_hours = 8; }
  else if (start_time && end_time) {
    const [sh, sm] = start_time.split(':').map(Number);
    const [eh, em] = end_time.split(':').map(Number);
    actual_hours = Math.round(((eh * 60 + em) - (sh * 60 + sm) - (break_minutes || 0)) / 60 * 100) / 100;
  }
  const row = db.prepare(
    `INSERT INTO dp_work_times (user_id,date,start_time,end_time,break_minutes,actual_hours,note,is_vacation,work_type) VALUES (?,?,?,?,?,?,?,?,?)
     ON CONFLICT(user_id,date) DO UPDATE SET start_time=excluded.start_time,end_time=excluded.end_time,break_minutes=excluded.break_minutes,actual_hours=excluded.actual_hours,note=excluded.note,is_vacation=excluded.is_vacation,work_type=excluded.work_type RETURNING *`
  ).get(req.dpUser.id, date, start_time || null, end_time || null, break_minutes || 0, actual_hours, note || null, b(is8h), work_type || 'work');
  res.json(row);
});
router.delete('/api/dp/worktimes/:id', auth, (req, res) => {
  db.prepare('DELETE FROM dp_work_times WHERE id=? AND user_id=?').run(req.params.id, req.dpUser.id);
  res.json({ ok: true });
});
router.get('/api/dp/worktimes/target/:year/:month', auth, (req, res) => {
  try {
    const u = db.prepare('SELECT work_days,weekly_hours FROM dp_users WHERE id=?').get(req.dpUser.id);
    const wd = u?.work_days || '1111100';
    const wh = parseFloat(u?.weekly_hours || 40);
    const dpw = wd.split('').filter(c => c === '1').length || 5;
    const hpd = wh / dpw;
    const y = parseInt(req.params.year), m = parseInt(req.params.month) - 1;
    let wdc = 0;
    for (let d = new Date(y, m, 1); d <= new Date(y, m + 1, 0); d.setDate(d.getDate() + 1)) {
      const idx = d.getDay() === 0 ? 6 : d.getDay() - 1;
      if (wd[idx] === '1') wdc++;
    }
    res.json({ target: Math.round(wdc * hpd * 100) / 100, days: wdc, hpd: Math.round(hpd * 100) / 100, weekly_hours: wh, dpw });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== HOLIDAYS =====
router.get('/api/dp/holidays', auth, (req, res) => {
  const { year, bundesland } = req.query;
  let q = 'SELECT * FROM dp_holidays WHERE user_id=?'; const p = [req.dpUser.id];
  if (year) { q += ' AND year=?'; p.push(year); }
  if (bundesland) { q += ' AND (bundesland=? OR bundesland IS NULL)'; p.push(bundesland); }
  q += ' ORDER BY start_date';
  res.json(db.prepare(q).all(...p));
});
router.post('/api/dp/holidays', auth, (req, res) => {
  const { name, start_date, end_date, type, bundesland, year } = req.body;
  const row = db.prepare(`INSERT INTO dp_holidays (user_id,name,start_date,end_date,type,bundesland,year) VALUES (?,?,?,?,?,?,?) RETURNING *`)
    .get(req.dpUser.id, name, start_date, end_date, type || 'ferien', bundesland || null, year || new Date().getFullYear());
  res.json(row);
});
router.delete('/api/dp/holidays/:id', auth, (req, res) => {
  db.prepare('DELETE FROM dp_holidays WHERE id=? AND user_id=?').run(req.params.id, req.dpUser.id);
  res.json({ ok: true });
});
// openholidaysapi.org: deckt Schulferien UND gesetzliche Feiertage fuer alle
// deutschen Bundeslaender ab, inkl. mehrerer Jahre im Voraus (ferien-api.de
// hatte fuer viele Laender/Jahre schlicht keine Daten).
function fetchOpenHolidays(kind, bundesland, year) {
  return new Promise((resolve, reject) => {
    const https = require('https');
    const url = `https://openholidaysapi.org/${kind}?countryIsoCode=DE&languageIsoCode=DE&validFrom=${year}-01-01&validTo=${year}-12-31&subdivisionCode=DE-${bundesland}`;
    https.get(url, r => {
      let d = ''; r.on('data', c => d += c);
      r.on('end', () => {
        if (r.statusCode >= 400) return reject(new Error(`openholidaysapi.org (${kind}) antwortete mit HTTP ${r.statusCode}`));
        try { resolve(JSON.parse(d)); } catch { reject(new Error(`openholidaysapi.org (${kind}) lieferte keine gueltige Antwort`)); }
      });
    }).on('error', e => reject(new Error(`openholidaysapi.org nicht erreichbar: ${e.message}`)));
  });
}

router.get('/api/dp/ferien-proxy', auth, async (req, res) => {
  const { bundesland, year } = req.query;
  if (!bundesland || !year) return res.status(400).json({ error: 'fehlt' });
  try {
    const [school, pub] = await Promise.all([
      fetchOpenHolidays('SchoolHolidays', bundesland, year),
      fetchOpenHolidays('PublicHolidays', bundesland, year)
    ]);
    const nameOf = (n) => (n.find(x => x.language === 'DE') || n[0] || {}).text || 'Feiertag';
    const merged = [
      ...school.map(h => ({ name: nameOf(h.name), start: h.startDate, end: h.endDate, type: 'ferien' })),
      ...pub.map(h => ({ name: nameOf(h.name), start: h.startDate, end: h.endDate, type: 'feiertag' }))
    ];
    res.json(merged);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

// ===== SETTINGS =====
router.get('/api/dp/settings', auth, (req, res) => {
  res.json(db.prepare('SELECT id,username,display_name,vacation_budget,vacation_base,bundesland,work_days,weekly_hours FROM dp_users WHERE id=?').get(req.dpUser.id));
});
router.put('/api/dp/settings', auth, (req, res) => {
  const { display_name, vacation_budget, bundesland, vacation_carryover, carryover_year } = req.body;
  try {
    if (vacation_carryover !== undefined) {
      const yr = carryover_year || new Date().getFullYear();
      db.prepare('INSERT INTO dp_vacation_carryover (user_id,year,carryover) VALUES (?,?,?) ON CONFLICT(user_id,year) DO UPDATE SET carryover=?')
        .run(req.dpUser.id, yr, vacation_carryover, vacation_carryover);
    } else {
      const wd = req.body.work_days || '1111100';
      db.prepare('UPDATE dp_users SET display_name=?,vacation_budget=?,vacation_base=?,bundesland=?,work_days=?,weekly_hours=? WHERE id=?')
        .run(display_name, vacation_budget, vacation_budget, bundesland, wd, parseFloat(req.body.weekly_hours) || 40, req.dpUser.id);
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== OTHER USERS =====
router.get('/api/dp/other-users', auth, (req, res) => {
  res.json(db.prepare('SELECT id,display_name FROM dp_users WHERE id!=? ORDER BY display_name').all(req.dpUser.id));
});

// ===== STATS =====
router.get('/api/dp/stats/:year', auth, (req, res) => {
  try {
    const y = parseInt(req.params.year), uid = req.dpUser.id;
    const today = new Date();
    const toStr = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const cutoff = toStr(y === today.getFullYear() ? today : new Date(y, 11, 31));
    const u = db.prepare('SELECT work_days,weekly_hours FROM dp_users WHERE id=?').get(uid);
    const wd = u?.work_days || '1111100';
    const wh = parseFloat(u?.weekly_hours || 40);
    const dpw = wd.split('').filter(c => c === '1').length || 5;
    const hpd = wh / dpw;
    let targetDays = 0;
    for (let d = new Date(y, 0, 1); toStr(d) <= cutoff; d.setDate(d.getDate() + 1)) {
      const idx = d.getDay() === 0 ? 6 : d.getDay() - 1;
      if (wd[idx] === '1') targetDays++;
    }
    const wtr = db.prepare("SELECT date as d,actual_hours,work_type,is_vacation FROM dp_work_times WHERE user_id=? AND strftime('%Y',date)=? AND date<=? ORDER BY date").all(uid, String(y), cutoff);
    const months = {};
    for (let m = 0; m < 12; m++) months[m] = { actual: 0, target: 0, vacation: 0, sick: 0, holiday_comp: 0, work_days: 0 };
    wtr.forEach(e => {
      const m = parseInt(e.d.slice(5, 7)) - 1;
      const h = parseFloat(e.actual_hours || 0);
      const wt = e.work_type || (e.is_vacation ? 'vacation' : 'work');
      months[m].actual = Math.round((months[m].actual + h) * 100) / 100;
      if (wt === 'vacation') months[m].vacation++;
      else if (wt === 'sick') months[m].sick++;
      else if (wt === 'holiday_comp') months[m].holiday_comp++;
      else months[m].work_days++;
    });
    const vacR = db.prepare("SELECT start_date as s,end_date as e,status FROM dp_vacations WHERE user_id=? AND year=?").all(uid, y);
    const coR = db.prepare('SELECT carryover FROM dp_vacation_carryover WHERE user_id=? AND year=?').get(uid, y);
    const vbu = db.prepare('SELECT vacation_budget,vacation_base FROM dp_users WHERE id=?').get(uid);
    const base = vbu?.vacation_base || vbu?.vacation_budget || 30;
    const co = coR?.carryover || 0;
    const totalActual = Math.round(wtr.reduce((s, e) => s + parseFloat(e.actual_hours || 0), 0) * 100) / 100;
    const vbs = { genommen: 0, geplant: 0, genehmigt: 0 };
    vacR.filter(v => v.status !== 'abgelehnt').forEach(v => { if (vbs[v.status] !== undefined) vbs[v.status] += workDaysCount(wd, v.s, v.e); });
    res.json({
      year: y, cutoff,
      target_hours: Math.round(targetDays * hpd * 100) / 100, target_days: targetDays,
      actual_hours: totalActual,
      diff: Math.round((totalActual - targetDays * hpd) * 100) / 100,
      sick_days: wtr.filter(e => e.work_type === 'sick').length,
      holiday_comp_days: wtr.filter(e => e.work_type === 'holiday_comp').length,
      vacation: { budget: base + co, base, carryover: co, genommen: vbs.genommen, geplant: vbs.geplant, genehmigt: vbs.genehmigt, remaining: base + co - vbs.genommen - vbs.geplant - vbs.genehmigt },
      months: Object.values(months),
      weekly_hours: wh, hpd: Math.round(hpd * 100) / 100
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ===== PUBLIC DASHBOARD (kein Login noetig, HA-Nutzer sind ueber Ingress ohnehin authentifiziert) =====
router.get('/api/dp/dashboard', (req, res) => {
  try {
    const toLocal = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const today = toLocal(new Date());
    let ws = req.query.week_start || today;
    const weekDates = [];
    for (let i = 0; i < 7; i++) { const d = new Date(ws + 'T12:00:00'); d.setDate(d.getDate() + i); weekDates.push(toLocal(d)); }
    const year = new Date(ws).getFullYear();
    const users = db.prepare('SELECT id,display_name,vacation_base,vacation_budget,work_days FROM dp_users ORDER BY id').all();
    const result = [];
    for (const u of users) {
      const coR = db.prepare('SELECT carryover FROM dp_vacation_carryover WHERE user_id=? AND year=?').get(u.id, year);
      const budget = (u.vacation_base || u.vacation_budget || 30) + (coR?.carryover || 0);
      const wd = u.work_days || '1111100';
      const vrows = db.prepare("SELECT start_date as s,end_date as e,status FROM dp_vacations WHERE user_id=? AND year=? AND status!='abgelehnt'").all(u.id, year);
      const byS = { genommen: 0, geplant: 0, genehmigt: 0 };
      vrows.forEach(v => { if (byS[v.status] !== undefined) byS[v.status] += workDaysCount(wd, v.s, v.e); });
      const weekEnd = weekDates[6];
      const shifts = db.prepare('SELECT s.*,st.name as type_name,st.short_name,st.color,st.default_start,st.default_end FROM dp_shifts s LEFT JOIN dp_shift_types st ON s.shift_type_id=st.id WHERE s.user_id=? AND s.date>=? AND s.date<=? ORDER BY s.date').all(u.id, ws, weekEnd);
      const wts = db.prepare('SELECT * FROM dp_work_times WHERE user_id=? AND date>=? AND date<=?').all(u.id, ws, weekEnd);
      const nv = db.prepare("SELECT * FROM dp_vacations WHERE user_id=? AND start_date>=? AND status!='abgelehnt' ORDER BY start_date LIMIT 1").get(u.id, today);
      const shMap = {}; shifts.forEach(s => { shMap[s.date] = s; });
      const wMap = {}; wts.forEach(w => { wMap[w.date] = w; });
      const vacR = db.prepare("SELECT * FROM dp_vacations WHERE user_id=? AND end_date>=? AND start_date<=? AND status!='abgelehnt'").all(u.id, ws, weekEnd);
      const vSet = new Set();
      vacR.forEach(v => { let d = new Date(v.start_date + 'T12:00:00'), e = new Date(v.end_date + 'T12:00:00'); while (d <= e) { vSet.add(d.toISOString().slice(0, 10)); d.setDate(d.getDate() + 1); } });
      const week = weekDates.map(d => ({ date: d, shift: shMap[d] || null, work: wMap[d] || null, vacation: vSet.has(d) }));
      result.push({ id: u.id, name: u.display_name, vacation: { budget, remaining: budget - byS.genommen - byS.geplant - byS.genehmigt }, week, next_vacation: nv || null });
    }
    res.json(result);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
