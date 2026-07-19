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

const getSparschwein = (id) => {
  const s = db.prepare(`
    SELECT s.*, COALESCE(SUM(e.betrag), 0) AS kontostand
    FROM sparschweine s LEFT JOIN spareintraege e ON e.sparschwein_id = s.id
    WHERE s.id = ? GROUP BY s.id
  `).get(id);
  if (!s) return s;
  return { ...s, eintraege: eintraegeMitKategorie.all(id) };
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

router.delete('/api/sparschweine/:id', (req, res) => {
  const del = db.transaction((id) => {
    db.prepare('DELETE FROM spareintraege WHERE sparschwein_id = ?').run(id);
    db.prepare('DELETE FROM sparschweine WHERE id = ?').run(id);
  });
  del(req.params.id);
  res.json({ success: true });
});

router.post('/api/sparschweine/:id/eintraege', (req, res) => {
  const { id: sparschweinId } = req.params;
  const { betrag, beschreibung, datum, kategorie_id } = req.body;
  const numericAmount = Number(betrag);
  if (!Number.isFinite(numericAmount) || numericAmount === 0) return res.status(400).json({ error: 'Betrag muss ungleich 0 sein' });
  const exists = db.prepare('SELECT id FROM sparschweine WHERE id = ?').get(sparschweinId);
  if (!exists) return res.status(404).json({ error: 'Sparschwein nicht gefunden' });
  const id = generateId();
  const entryDate = datum || new Date().toISOString().substring(0, 10);
  db.prepare('INSERT INTO spareintraege (id, sparschwein_id, kategorie_id, datum, betrag, beschreibung) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, sparschweinId, kategorie_id || null, entryDate, numericAmount, beschreibung || null);
  res.json(getSparschwein(sparschweinId));
});

router.delete('/api/spareintraege/:id', (req, res) => {
  const row = db.prepare('SELECT sparschwein_id FROM spareintraege WHERE id = ?').get(req.params.id);
  db.prepare('DELETE FROM spareintraege WHERE id = ?').run(req.params.id);
  res.json(row ? getSparschwein(row.sparschwein_id) : { success: true });
});

module.exports = router;
