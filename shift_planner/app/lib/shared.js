// Gemeinsame Logik fuer routes/dienstplan.js (Ingress/UI) und
// routes/integration.js (API-Token/Jarvis) -- damit beide Seiten exakt
// dasselbe Verhalten haben und nichts dupliziert wird.

const workDaysCount = (wd, s, e) => {
  let c = 0, cur = new Date(s + 'T12:00:00'), end = new Date(e + 'T12:00:00');
  while (cur <= end) { const dow = cur.getDay(), idx = dow === 0 ? 6 : dow - 1; if (wd[idx] === '1') c++; cur.setDate(cur.getDate() + 1); }
  return c;
};

const VACATION_STATUSES = ['geplant', 'genehmigt', 'genommen', 'abgelehnt'];

function isValidDateStr(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00');
  if (isNaN(d.getTime())) return false;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` === s;
}

// Identisch zu GET /api/dp/vacations/remaining/:year.
function computeVacationRemaining(db, userId, year) {
  const u = db.prepare('SELECT vacation_base,vacation_budget,work_days FROM dp_users WHERE id=?').get(userId);
  const base = u?.vacation_base || u?.vacation_budget || 30;
  const co = db.prepare('SELECT carryover FROM dp_vacation_carryover WHERE user_id=? AND year=?').get(userId, year);
  const carryover = co?.carryover || 0;
  const budget = base + carryover;
  const wd = u?.work_days || '1111100';
  const allV = db.prepare("SELECT start_date as s,end_date as e,status FROM dp_vacations WHERE user_id=? AND year=? AND status!='abgelehnt'").all(userId, year);
  const used = allV.filter((v) => v.status === 'genommen').reduce((s, v) => s + workDaysCount(wd, v.s, v.e), 0);
  const planned = allV.filter((v) => v.status === 'geplant').reduce((s, v) => s + workDaysCount(wd, v.s, v.e), 0);
  const approved = allV.filter((v) => v.status === 'genehmigt').reduce((s, v) => s + workDaysCount(wd, v.s, v.e), 0);
  return { budget, base, carryover, used, planned, approved, remaining: budget - used - planned - approved, work_days: wd };
}

// Legt fuer jeden Arbeitstag (laut work_days-Muster des Users) im Zeitraum
// einen 8h-Arbeitszeit-Eintrag an -- identisch zum Verhalten der Oberflaeche
// beim Setzen von Status 'genommen'. Ersetzt dabei alle vorhandenen Bloecke
// des jeweiligen Tages (wie bei den anderen Ganztages-Typen in
// dp_work_times), statt eines inzwischen nicht mehr passenden
// ON CONFLICT(user_id,date) -- das greift seit der Teilschicht-Migration
// (sort_order, UNIQUE(user_id,date,sort_order)) nicht mehr und wuerde einen
// SqliteError werfen.
function bookVacationWorkTimes(db, userId, startDate, endDate) {
  const usr = db.prepare('SELECT work_days FROM dp_users WHERE id=?').get(userId);
  const wd = usr?.work_days || '1111100';
  const replaceDay = db.transaction((ds) => {
    db.prepare('DELETE FROM dp_work_times WHERE user_id=? AND date=?').run(userId, ds);
    db.prepare(
      `INSERT INTO dp_work_times (user_id,date,sort_order,actual_hours,is_vacation,work_type,note) VALUES (?,?,0,8,1,'vacation','Urlaubstag')`
    ).run(userId, ds);
  });
  const cur = new Date(startDate + 'T12:00:00'), end = new Date(endDate + 'T12:00:00');
  while (cur <= end) {
    const dow = cur.getDay(), idx = dow === 0 ? 6 : dow - 1;
    if (wd[idx] === '1') replaceDay(cur.toLocaleDateString('sv-SE'));
    cur.setDate(cur.getDate() + 1);
  }
}

// Schichtart anhand Kuerzel, Name oder ID finden (in dieser Reihenfolge).
function resolveShiftType(db, userId, ref) {
  if (ref === undefined || ref === null || ref === '') return null;
  const key = String(ref);
  let st = db.prepare('SELECT * FROM dp_shift_types WHERE user_id=? AND short_name=?').get(userId, key);
  if (st) return st;
  st = db.prepare('SELECT * FROM dp_shift_types WHERE user_id=? AND name=?').get(userId, key);
  if (st) return st;
  if (/^\d+$/.test(key)) {
    st = db.prepare('SELECT * FROM dp_shift_types WHERE user_id=? AND id=?').get(userId, Number(key));
    if (st) return st;
  }
  return null;
}

// Legt die Schicht eines Tages an oder ersetzt sie (genau ein Block je Tag --
// im Gegensatz zur Oberflaeche, die hier bewusst mehrere Teilschicht-Bloecke
// pro Tag erlaubt; fuer die Integration reicht ein einzelner, autoritativer
// Eintrag je Tag).
function replaceShiftForDate(db, userId, date, { shiftTypeId, actualStart, actualEnd, note }) {
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM dp_shifts WHERE user_id=? AND date=?').run(userId, date);
    return db.prepare(
      `INSERT INTO dp_shifts (user_id,date,sort_order,shift_type_id,actual_start,actual_end,note) VALUES (?,?,0,?,?,?,?) RETURNING *`
    ).get(userId, date, shiftTypeId || null, actualStart || null, actualEnd || null, note || null);
  });
  return tx();
}

// Identisch zu GET /api/dp/stats/:year.
function computeYearStats(db, userId, year) {
  const y = year, uid = userId;
  const today = new Date();
  const toStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const cutoff = toStr(y === today.getFullYear() ? today : new Date(y, 11, 31));
  const u = db.prepare('SELECT work_days,weekly_hours FROM dp_users WHERE id=?').get(uid);
  const wd = u?.work_days || '1111100';
  const wh = parseFloat(u?.weekly_hours || 40);
  const dpw = wd.split('').filter((c) => c === '1').length || 5;
  const hpd = wh / dpw;
  let targetDays = 0;
  for (let d = new Date(y, 0, 1); toStr(d) <= cutoff; d.setDate(d.getDate() + 1)) {
    const idx = d.getDay() === 0 ? 6 : d.getDay() - 1;
    if (wd[idx] === '1') targetDays++;
  }
  const wtr = db.prepare("SELECT date as d,actual_hours,work_type,is_vacation FROM dp_work_times WHERE user_id=? AND strftime('%Y',date)=? AND date<=? ORDER BY date").all(uid, String(y), cutoff);
  const months = {};
  for (let m = 0; m < 12; m++) months[m] = { actual: 0, target: 0, vacation: 0, sick: 0, holiday_comp: 0, work_days: 0 };
  const workDaysSeen = new Set(); // Teilschichten: mehrere 'work'-Bloecke am selben Tag zaehlen nur als 1 Arbeitstag
  wtr.forEach((e) => {
    const m = parseInt(e.d.slice(5, 7)) - 1;
    const h = parseFloat(e.actual_hours || 0);
    const wt = e.work_type || (e.is_vacation ? 'vacation' : 'work');
    months[m].actual = Math.round((months[m].actual + h) * 100) / 100;
    if (wt === 'vacation') months[m].vacation++;
    else if (wt === 'sick') months[m].sick++;
    else if (wt === 'holiday_comp') months[m].holiday_comp++;
    else if (!workDaysSeen.has(e.d)) { workDaysSeen.add(e.d); months[m].work_days++; }
  });
  const vacR = db.prepare('SELECT start_date as s,end_date as e,status FROM dp_vacations WHERE user_id=? AND year=?').all(uid, y);
  const coR = db.prepare('SELECT carryover FROM dp_vacation_carryover WHERE user_id=? AND year=?').get(uid, y);
  const vbu = db.prepare('SELECT vacation_budget,vacation_base FROM dp_users WHERE id=?').get(uid);
  const base = vbu?.vacation_base || vbu?.vacation_budget || 30;
  const co = coR?.carryover || 0;
  const totalActual = Math.round(wtr.reduce((s, e) => s + parseFloat(e.actual_hours || 0), 0) * 100) / 100;
  const vbs = { genommen: 0, geplant: 0, genehmigt: 0 };
  vacR.filter((v) => v.status !== 'abgelehnt').forEach((v) => { if (vbs[v.status] !== undefined) vbs[v.status] += workDaysCount(wd, v.s, v.e); });
  return {
    year: y, cutoff,
    target_hours: Math.round(targetDays * hpd * 100) / 100, target_days: targetDays,
    actual_hours: totalActual,
    diff: Math.round((totalActual - targetDays * hpd) * 100) / 100,
    sick_days: wtr.filter((e) => e.work_type === 'sick').length,
    holiday_comp_days: wtr.filter((e) => e.work_type === 'holiday_comp').length,
    vacation: { budget: base + co, base, carryover: co, genommen: vbs.genommen, geplant: vbs.geplant, genehmigt: vbs.genehmigt, remaining: base + co - vbs.genommen - vbs.geplant - vbs.genehmigt },
    months: Object.values(months),
    weekly_hours: wh, hpd: Math.round(hpd * 100) / 100,
  };
}

module.exports = {
  workDaysCount,
  VACATION_STATUSES,
  isValidDateStr,
  computeVacationRemaining,
  bookVacationWorkTimes,
  resolveShiftType,
  replaceShiftForDate,
  computeYearStats,
};
