const crypto = require('crypto');
const { loadOptions } = require('../options');

// Der Supervisor-Ingress-Proxy erreicht das Add-on ausschliesslich vom Gateway
// 172.30.32.2. Die X-Remote-User-* / X-Ingress-Path Header allein taugen nicht
// als Beweis, weil sie bei direktem Port-Zugriff frei gesetzt werden koennten.
const INGRESS_IPS = (process.env.INGRESS_GATEWAY_IPS || '172.30.32.2')
  .split(',').map(s => s.trim()).filter(Boolean);

const INTEGRATION_PREFIX = '/garten/api/integration/';

function isIngress(req) {
  const addr = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  return INGRESS_IPS.includes(addr);
}

function tokensEqual(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Ingress: unveraendert offen. Direkter Zugriff (Port/Reverse Proxy): nur
// /garten/api/integration/* mit gueltigem X-API-Token, alles andere 401.
function accessGate(req, res, next) {
  if (isIngress(req)) return next();

  if (!req.path.startsWith(INTEGRATION_PREFIX)) {
    return res.status(401).json({ error: 'Direkter Zugriff nur auf /garten/api/integration/* mit X-API-Token' });
  }

  const configured = String(loadOptions().api_token || '').trim();
  if (!configured) return res.status(403).json({ error: 'Kein api_token in der Add-on-Konfiguration gesetzt' });

  const given = req.get('x-api-token');
  if (!given || !tokensEqual(given, configured)) {
    return res.status(401).json({ error: 'Ungueltiger oder fehlender X-API-Token Header' });
  }
  next();
}

module.exports = { accessGate };
