'use strict';
const http = require('node:http');
const { openDb } = require('../src/db');
const { seedSample, syncAllSample } = require('../src/seed');

async function seeded({ sync = true } = {}) {
  const db = openDb(':memory:');
  const ids = seedSample(db);
  if (sync) await syncAllSample(db, ids);
  return { db, ids, hp: ids['harbor-point'], bb: ids.bluebird };
}

function openSuggestion(db, clientId, groupKey, action) {
  return db.prepare(`SELECT * FROM suggestions WHERE client_id=? AND group_key=? AND action=? AND status='open'`).get(clientId, groupKey, action);
}

async function startServer(app) {
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, close: () => new Promise((r) => server.close(r)) };
}

/** Minimal cookie-keeping HTTP client. */
function client(base) {
  let cookie = '';
  const call = async (method, path, body) => {
    const res = await fetch(base + path, {
      method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get('set-cookie'); if (set) cookie = set.split(';')[0];
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, text };
  };
  return {
    raw: (p, init = {}) => fetch(base + p, { ...init, headers: { ...(init.headers || {}), Cookie: cookie } }),
    get: (p) => call('GET', p), post: (p, b = {}) => call('POST', p, b),
    login: (email, password) => call('POST', '/api/login', { email, password }),
  };
}

module.exports = { seeded, openSuggestion, startServer, client };
