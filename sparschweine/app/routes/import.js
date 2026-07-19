const express = require('express');
const db = require('../db/sparschweine');
const { loadOptions } = require('../options');

const router = express.Router();

router.post('/api/import', async (req, res) => {
  const { finanzapp_url, finanzapp_pin } = loadOptions();
  if (!finanzapp_url || !finanzapp_pin) {
    return res.status(400).json({ error: 'Finanz-App URL/PIN nicht in den Addon-Einstellungen konfiguriert' });
  }

  try {
    const loginRes = await fetch(`${finanzapp_url}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pin: finanzapp_pin }),
    });
    if (!loginRes.ok) return res.status(401).json({ error: 'Login bei Finanz-App fehlgeschlagen' });
    const cookies = (loginRes.headers.getSetCookie?.() || [loginRes.headers.get('set-cookie')].filter(Boolean))
      .map(c => c.split(';')[0]).join('; ');

    const dataRes = await fetch(`${finanzapp_url}/api/sparschweine`, { headers: { Cookie: cookies } });
    if (!dataRes.ok) return res.status(502).json({ error: 'Konnte Sparschweine nicht laden' });
    const sparschweine = await dataRes.json();

    const upsertPig = db.prepare(`
      INSERT INTO sparschweine (id, name, zielbetrag, farbe, erstellt_am) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name = excluded.name, zielbetrag = excluded.zielbetrag, farbe = excluded.farbe
    `);
    const upsertEntry = db.prepare(`
      INSERT INTO spareintraege (id, sparschwein_id, datum, betrag, beschreibung, erstellt_am) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `);

    const importAll = db.transaction((pigs) => {
      for (const p of pigs) {
        upsertPig.run(p.id, p.name, p.zielbetrag, p.farbe, p.erstellt_am);
        for (const e of p.eintraege || []) {
          upsertEntry.run(e.id, e.sparschwein_id, e.datum, e.betrag, e.beschreibung, e.erstellt_am);
        }
      }
    });
    importAll(sparschweine);

    res.json({ ok: true, importiert: sparschweine.length });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

module.exports = router;
