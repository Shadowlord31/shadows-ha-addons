const express = require('express');
const db = require('../db/sparschweine');

const router = express.Router();
const generateId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);
const normalizeZielbetrag = (z) => (z === undefined || z === null || z === '') ? null : Number(z);

const eintraegeMitKategorie = db.prepare(`
  SELECT e.*, k.name AS kategorie_name, k.farbe AS kategorie_farbe
  FROM spareintraege e LEFT JOIN kategorien k ON k.id = e.kategorie_id
  WHERE e.sparschwein_id = ? ORDER BY e.datum DESC, e.erstellt_am DESC
`);

const eintraegeOhneSparschwein = db.prepare(`
  SELECT e.*, k.name AS kategorie_name, k.farbe AS kategorie_farbe
  FROM spareintraege e LEFT JOIN kategorien k ON k.id = e.kategorie_id
  WHERE e.sparschwein_id IS NULL ORDER BY e.datum DESC, e.erstellt_am DESC
`);

const getSparschwein = (id) => {
  const s = db.prepare(`
    SELECT s.*, COALESCE(SUM(e.betrag), 0) AS kontostand
    FROM sparschweine s LEFT JOIN spareintraege e ON e.sparschwein_id = s.id
    WHERE s.id = ? GROUP BY s.id
  `).get(id);
  if (!s) return s;
  return { ...s, eintraege: eintraegeMitKategorie.all(id) };
};

const getOhneSparschwein = () => {
  const eintraege = eintraegeOhneSparschwein.all();
  const kontostand = eintraege.reduce((sum, e) => sum + e.betrag, 0);
  return { kontostand, eintraege };
};

router.get('/api/sparschweine', (req, res) => {
  const sparschweine = db.prepare(`
    SELECT s.*, COALESCE(SUM(e.betrag), 0) AS kontostand
    FROM sparschweine s LEFT JOIN spareintraege e ON e.sparschwein_id = s.id
    GROUP BY s.id ORDER BY s.erstellt_am DESC
  `).all();
  res.json(sparschweine.map(s => ({ ...s, eintraege: eintraegeMitKategorie.all(s.id) })));
});

router.get('/api/sparschweine/:id', (req, res) => {
  const s = getSparschwein(req.params.id);
  if (!s) return res.status(404).json({ error: 'Sparschwein nicht gefunden' });
  res.json(s);
});

router.get('/api/ohne-sparschwein', (req, res) => {
  res.json(getOhneSparschwein());
});

router.post('/api/sparschweine', (req, res) => {
  const { name, zielbetrag, farbe } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name ist erforderlich' });
  const id = generateId();
  db.prepare('INSERT INTO sparschweine (id, name, zielbetrag, farbe) VALUES (?, ?, ?, ?)')
    .run(id, name.trim(), normalizeZielbetrag(zielbetrag), farbe || '#4CAF50');
  res.json(getSparschwein(id));
});

router.put('/api/sparschweine/:id', (req, res) => {
  const { id } = req.params;
  const { name, zielbetrag, farbe } = req.body;
  const updates = [], values = [];
  if (name !== undefined) { updates.push('name = ?'); values.push(String(name).trim()); }
  if (zielbetrag !== undefined) { updates.push('zielbetrag = ?'); values.push(normalizeZielbetrag(zielbetrag)); }
  if (farbe !== undefined) { updates.push('farbe = ?'); values.push(farbe); }
  if (updates.length) { values.push(id); db.prepare(`UPDATE sparschweine SET ${updates.join(', ')} WHERE id = ?`).run(...values); }
  const s = getSparschwein(id);
  if (!s) return res.status(404).json({ error: 'Sparschwein nicht gefunden' });
  res.json(s);
});

// Loeschen eines Sparschweins entfernt nur das Sparschwein selbst. Seine
// Buchungen bleiben erhalten und wandern zu "Ohne Sparschwein" (FK ON DELETE
// SET NULL) - der Geldverlauf (z.B. Trinkgeld-Historie) geht nicht verloren.
router.delete('/api/sparschweine/:id', (req, res) => {
  db.prepare('DELETE FROM sparschweine WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Einheitlicher Buchungs-Endpoint: sparschwein_id ist optional. Ohne Angabe
// (oder null) landet die Buchung bei "Ohne Sparschwein" - fuer Geld, das man
// direkt tracken will, ohne es einem Sparziel zuzuordnen (z.B. Trinkgeld).
router.post('/api/eintraege', (req, res) => {
  const { sparschwein_id, kategorie_id, betrag, beschreibung, datum } = req.body;
  const numericAmount = Number(betrag);
  if (!Number.isFinite(numericAmount) || numericAmount === 0) return res.status(400).json({ error: 'Betrag muss ungleich 0 sein' });
  if (sparschwein_id) {
    const exists = db.prepare('SELECT id FROM sparschweine WHERE id = ?').get(sparschwein_id);
    if (!exists) return res.status(404).json({ error: 'Sparschwein nicht gefunden' });
  }
  const id = generateId();
  const entryDate = datum || new Date().toISOString().substring(0, 10);
  db.prepare('INSERT INTO spareintraege (id, sparschwein_id, kategorie_id, datum, betrag, beschreibung) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, sparschwein_id || null, kategorie_id || null, entryDate, numericAmount, beschreibung || null);
  res.json({ id, sparschwein_id: sparschwein_id || null });
});

router.delete('/api/spareintraege/:id', (req, res) => {
  db.prepare('DELETE FROM spareintraege WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
