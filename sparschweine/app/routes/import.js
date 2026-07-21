const express = require('express');
const db = require('../db/sparschweine');

const router = express.Router();

// Generischer Einmal-Import: nimmt Kategorien/Sparschweine/Buchungen im
// Request-Body entgegen und schreibt sie idempotent (INSERT OR IGNORE per ID)
// in die eigene DB. Ruft selbst nichts extern ab - keine Kopplung an andere
// Systeme, einfach ein Werkzeug fuer einmalige Datenuebernahmen.
router.post('/api/bulk-import', (req, res) => {
  const { kategorien: kats = [], sparschweine: pigs = [], eintraege: entries = [] } = req.body;

  const insKat = db.prepare('INSERT OR IGNORE INTO kategorien (id, name, farbe, erstellt_am) VALUES (?, ?, ?, ?)');
  const insPig = db.prepare('INSERT OR IGNORE INTO sparschweine (id, name, zielbetrag, farbe, erstellt_am) VALUES (?, ?, ?, ?, ?)');
  const insEntry = db.prepare('INSERT OR IGNORE INTO spareintraege (id, sparschwein_id, kategorie_id, datum, betrag, beschreibung, erstellt_am) VALUES (?, ?, ?, ?, ?, ?, ?)');

  const jetzt = new Date().toISOString();
  const tx = db.transaction(() => {
    for (const k of kats) insKat.run(k.id, k.name, k.farbe, k.erstellt_am || jetzt);
    for (const p of pigs) insPig.run(p.id, p.name, p.zielbetrag ?? null, p.farbe, p.erstellt_am || jetzt);
    for (const e of entries) {
      insEntry.run(e.id, e.sparschwein_id || null, e.kategorie_id || null, e.datum, e.betrag, e.beschreibung || null, e.erstellt_am || jetzt);
    }
  });
  tx();

  res.json({ ok: true, kategorien: kats.length, sparschweine: pigs.length, eintraege: entries.length });
});

module.exports = router;
