const express = require('express');
const { ApiError } = require('../lib/gateway');

function wrap(fn) {
  return async (req, res, next) => {
    try { res.json(await fn(req)); } catch (e) { next(e); }
  };
}

module.exports = function v1({ gateway, ha }) {
  const r = express.Router();

  r.get('/health', wrap(() => ({
    ok: ha.connected,
    ha_connected: ha.connected,
    ha_version: ha.version,
    entities_exposed: ha.connected ? gateway.exposedIds().filter((id) => ha.states.has(id)).length : gateway.exposedIds().length,
  })));

  r.get('/areas', wrap(() => ({ areas: gateway.areas() })));

  r.get('/entities', wrap((req) => {
    const s = (v) => (typeof v === 'string' && v ? v : undefined);
    return { entities: gateway.list({ area: s(req.query.area), domain: s(req.query.domain), q: s(req.query.q) }) };
  }));

  r.get('/entities/:ref', wrap((req) => {
    const ref = req.params.ref;
    const room = typeof req.query.area === 'string' ? req.query.area : undefined;
    const looksLikeId = /^[a-z0-9_]+\.[a-z0-9_]+$/.test(ref);
    return gateway.getOne(looksLikeId ? { entity_id: ref } : { name: ref, room });
  }));

  r.post('/call', wrap((req) => gateway.call(req.body)));

  r.use((req, res, next) => next(new ApiError(404, 'not_found', 'Unbekannter Endpunkt')));
  return r;
};
