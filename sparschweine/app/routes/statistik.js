const express = require('express');
const db = require('../db/sparschweine');

const router = express.Router();

router.get('/api/statistik', (req, res) => {
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
    GROUP BY k.id
    ORDER BY summe DESC
  `).all();
  res.json(rows);
});

module.exports = router;
