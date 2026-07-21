const express = require('express');
const db = require('../db/sparschweine');

const router = express.Router();

// ?month=YYYY-MM filtert auf einen Monat (datum beginnt mit diesem Praefix).
// Ohne Parameter: alle Buchungen (Verhalten vor 0.4.0).
router.get('/api/statistik', (req, res) => {
  const { month } = req.query;
  const monthFilter = /^\d{4}-\d{2}$/.test(month || '') ? month : null;

  const rows = db.prepare(`
    SELECT
      k.id AS kategorie_id,
      COALESCE(k.name, 'Ohne Kategorie') AS name,
      COALESCE(k.farbe, '#666666') AS farbe,
      COUNT(e.id) AS anzahl,
      COALESCE(SUM(e.betrag), 0) AS summe,
      COALESCE(SUM(CASE WHEN e.betrag > 0 THEN e.betrag ELSE 0 END), 0) AS einzahlungen,
      COALESCE(SUM(CASE WHEN e.betrag < 0 THEN -e.betrag ELSE 0 END), 0) AS abhebungen
    FROM spareintraege e
    LEFT JOIN kategorien k ON k.id = e.kategorie_id
    ${monthFilter ? "WHERE e.datum LIKE ? || '%'" : ''}
    GROUP BY k.id
    ORDER BY summe DESC
  `).all(...(monthFilter ? [monthFilter] : []));

  res.json(rows);
});

// Buchungen einer Kategorie (Drill-down von der Statistik-Seite).
// ?kategorie_id=<id> oder =none fuer "Ohne Kategorie". ?month=YYYY-MM optional.
router.get('/api/statistik/eintraege', (req, res) => {
  const { kategorie_id, month } = req.query;
  const monthFilter = /^\d{4}-\d{2}$/.test(month || '') ? month : null;

  const conditions = [];
  const params = [];
  if (kategorie_id === 'none') {
    conditions.push('e.kategorie_id IS NULL');
  } else if (kategorie_id) {
    conditions.push('e.kategorie_id = ?');
    params.push(kategorie_id);
  }
  if (monthFilter) {
    conditions.push("e.datum LIKE ? || '%'");
    params.push(monthFilter);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const rows = db.prepare(`
    SELECT e.*, k.name AS kategorie_name, k.farbe AS kategorie_farbe, s.name AS sparschwein_name
    FROM spareintraege e
    LEFT JOIN kategorien k ON k.id = e.kategorie_id
    LEFT JOIN sparschweine s ON s.id = e.sparschwein_id
    ${where}
    ORDER BY e.datum DESC, e.erstellt_am DESC
  `).all(...params);

  res.json(rows);
});

module.exports = router;
