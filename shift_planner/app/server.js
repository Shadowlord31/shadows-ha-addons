const express = require('express');
const path = require('path');

const ingressAuth = require('./middleware/ingress-auth');
require('./db/dienstplan'); // Schema wird beim ersten require angelegt

const app = express();
const PORT = process.env.PORT || 3001;

app.use(express.json());
app.use(ingressAuth);

app.use('/', require('./routes/dienstplan'));

app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'public/dienstplan/index.html')));
app.get('/dienstplan*', (_req, res) => res.sendFile(path.join(__dirname, 'public/dienstplan/index.html')));
app.get('/admin', (req, res) => {
  if (!req.dpUser?.is_admin) return res.status(403).send('Kein Admin-Zugriff');
  res.sendFile(path.join(__dirname, 'public/admin/index.html'));
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => console.log(`Shift Planner: ${PORT}`));
