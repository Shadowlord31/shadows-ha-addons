const crypto = require('crypto');
const { loadOptions } = require('../options');

// Der Supervisor-Ingress-Proxy erreicht das Add-on ausschliesslich vom Gateway
// 172.30.32.2. Die X-Remote-User-* / X-Ingress-Path Header allein taugen nicht
// als Beweis, weil sie bei direktem Port-Zugriff frei gesetzt werden koennten.
const DEFAULT_INGRESS_IPS = (process.env.INGRESS_GATEWAY_IPS || '172.30.32.2')
  .split(',').map(s => s.trim()).filter(Boolean);

const API_PREFIX = '/api/v1/';

function tokensEqual(given, expected) {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(String(expected)).digest();
  return crypto.timingSafeEqual(a, b);
}

// Ingress: unveraendert offen. Direkter Zugriff (Port/Reverse Proxy): nur
// /api/v1/* mit gueltigem X-API-Token, alles andere 401.
// ingressIps/getOptions sind nur fuer Tests austauschbar.
function createAccessGate({ ingressIps = DEFAULT_INGRESS_IPS, getOptions = loadOptions } = {}) {
  function isIngress(req) {
    const addr = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    return ingressIps.includes(addr);
  }

  return function accessGate(req, res, next) {
    if (isIngress(req)) return next();

    if (!req.path.startsWith(API_PREFIX)) {
      return res.status(401).json({ error: 'Direkter Zugriff nur auf /api/v1/* mit X-API-Token', code: 'unauthorized' });
    }

    const configured = String(getOptions().api_token || '').trim();
    if (!configured) return res.status(403).json({ error: 'Kein api_token in der Add-on-Konfiguration gesetzt', code: 'no_token_configured' });

    const given = req.get('x-api-token');
    if (!given || !tokensEqual(given, configured)) {
      return res.status(401).json({ error: 'Ungueltiger oder fehlender X-API-Token Header', code: 'unauthorized' });
    }
    next();
  };
}

module.exports = { createAccessGate, tokensEqual };
