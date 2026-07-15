// Portierung der Postgres-Funktion check_crop_rotation() nach JavaScript.
function checkCropRotation(db, bedId, familyId, year) {
  const family = db.prepare('SELECT pause_years FROM plant_families WHERE id = ?').get(familyId);
  if (!family) {
    return { status: 'ok', last_used_year: null, years_since: null, pause_required: 0, message: 'Familie unbekannt' };
  }
  const pauseYears = family.pause_years;

  const sameYearCount = db.prepare(`
    SELECT COUNT(*) AS c FROM (
      SELECT id FROM plans WHERE bed_id = ? AND plant_family_id = ? AND year = ?
      UNION ALL
      SELECT id FROM entries WHERE bed_id = ? AND plant_family_id = ? AND CAST(strftime('%Y', entry_date) AS INTEGER) = ? AND cat = 'plant'
    )
  `).get(bedId, familyId, year, bedId, familyId, year).c;

  if (sameYearCount > 0) {
    return { status: 'blocked', last_used_year: year, years_since: 0, pause_required: pauseYears, message: `Bereits in ${year} auf diesem Beet geplant/gepflanzt!` };
  }

  const lastYearRow = db.prepare(`
    SELECT MAX(yr) AS last_year FROM (
      SELECT year AS yr FROM plans WHERE bed_id = ? AND plant_family_id = ? AND year < ?
      UNION ALL
      SELECT CAST(strftime('%Y', entry_date) AS INTEGER) AS yr FROM entries WHERE bed_id = ? AND plant_family_id = ? AND CAST(strftime('%Y', entry_date) AS INTEGER) < ? AND cat = 'plant'
    )
  `).get(bedId, familyId, year, bedId, familyId, year);
  const lastYear = lastYearRow ? lastYearRow.last_year : null;

  if (lastYear === null) {
    return { status: 'ok', last_used_year: null, years_since: null, pause_required: pauseYears, message: 'Noch nie auf diesem Beet – ideal!' };
  }

  const yearsSince = year - lastYear;
  if (yearsSince > pauseYears) {
    return { status: 'ok', last_used_year: lastYear, years_since: yearsSince, pause_required: pauseYears, message: `Pause eingehalten (${yearsSince} von ${pauseYears} Jahren)` };
  }
  if (yearsSince === pauseYears) {
    return { status: 'warning', last_used_year: lastYear, years_since: yearsSince, pause_required: pauseYears, message: 'Gerade so ausreichend – besser 1 weiteres Jahr warten' };
  }
  return { status: 'blocked', last_used_year: lastYear, years_since: yearsSince, pause_required: pauseYears, message: `Zu früh! Noch ${pauseYears - yearsSince} Jahr(e) Pause nötig` };
}

module.exports = { checkCropRotation };
