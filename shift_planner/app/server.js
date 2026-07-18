const express = require('express');
const path = require('path');
const fs = require('fs');

const ingressAuth = require('./middleware/ingress-auth');
require('./db/dienstplan'); // Schema wird beim ersten require angelegt

const app = express();
const PORT = process.env.PORT || 3001;

const INDEX_HTML_PATH = path.join(__dirname, 'public/dienstplan/index.html');

// Home Assistant Ingress serviert die App unter einem pro Sitzung wechselnden
// Pfad-Praefix (X-Ingress-Path, z.B. /api/hassio_ingress/<token>). Absolute
// fetch()-Pfade wie '/api/dp/me' im Frontend wuerden diesen Prefix ignorieren
// und an HA Core statt an das Addon gehen. Deshalb wird der Praefix beim
// Ausliefern der HTML injiziert; das Frontend haengt ihn vor jeden API-Call.
function sendIndexWithBase(req, res) {
  const base = req.headers['x-ingress-path'] || '';
  fs.readFile(INDEX_HTML_PATH, 'utf8', (err, html) => {
    if (err) return res.status(500).send('Fehler beim Laden');
    res.type('html').send(html.replace('__INGRESS_BASE__', base));
  });
}

app.use(express.json());
app.use(ingressAuth);

app.use('/', require('./routes/dienstplan'));
app.use('/api/dp', require('./routes/migrate'));
app.use('/', require('./routes/integration'));

app.get('/', sendIndexWithBase);
app.get('/dienstplan*', sendIndexWithBase);

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`Shift Planner: ${PORT}`));
