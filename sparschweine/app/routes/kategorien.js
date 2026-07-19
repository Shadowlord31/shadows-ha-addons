const express = require('express');
const db = require('../db/sparschweine');

const router = express.Router();
const generateId = () => Math.random().toString(36).slice(2) + Date.now().toString(36);

router.get('/api/kategorien', (req, res) => {
  res.json(db.prepare('SELECT * FROM kategorien ORDER BY name').all());
});

router.post('/api/kategorien', (req, res) => {
  const { name, farbe } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name ist erforderlich' });
  const id = generateId();
  db.prepare('INSERT INTO kategorien (id, name, farbe) VALUES (?, ?, ?)')
    .run(id, name.trim(), farbe || '#888888');
  res.json(db.prepare('SELECT * FROM kategorien WHERE id = ?').get(id));
});

router.put('/api/kategorien/:id', (req, res) => {
  const { id } = req.params;
  const { name, farbe } = req.body;
  const updates = [], values = [];
  if (name !== undefined) { updates.push('name = ?'); values.push(String(name).trim()); }
  if (farbe !== undefined) { updates.push('farbe = ?'); values.push(farbe); }
  if (updates.length) { values.push(id); db.prepare(`UPDATE kategorien SET ${updates.join(', ')} WHERE id = ?`).run(...values); }
  const k = db.prepare('SELECT * FROM kategorien WHERE id = ?').get(id);
  if (!k) return res.status(404).json({ error: 'Kategorie nicht gefunden' });
  res.json(k);
});

router.delete('/api/kategorien/:id', (req, res) => {
  db.prepare('DELETE FROM kategorien WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
