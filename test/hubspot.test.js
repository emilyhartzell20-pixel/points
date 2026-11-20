'use strict';
// HubSpot balance sync, against a simulated HubSpot API (no real account is touched).
const test = require('node:test');
const assert = require('node:assert/strict');
const { seeded, startServer, client } = require('./helpers');
const { DEMO_STAFF } = require('../src/seed');
const { createApp } = require('../src/server');
const { HubSpotSync, parseCompanyId, PROPERTIES } = require('../src/adapters/hubspot');
const { syncClient } = require('../src/hubspotSync');
const admin = require('../src/admin');
const ledger = require('../src/ledger');

function fakeHubSpot() {
  const existing = new Set(); const calls = []; const companies = {};
  const fetchImpl = async (url, opts) => {
    const path = new URL(url).pathname; calls.push({ method: opts.method, path, auth: opts.headers.Authorization });
    const body = opts.body ? JSON.parse(opts.body) : null;
    const reply = (status, json = {}) => ({ ok: status < 300, status, json: async () => json });
    if (opts.method === 'GET') return existing.has(path) ? reply(200) : reply(404);
    if (opts.method === 'POST' && path.endsWith('/groups')) { existing.add(`${path}/${body.name}`); return reply(201); }
    if (opts.method === 'POST') { existing.add(`${path}/${body.name}`); return reply(201); }
    if (opts.method === 'PATCH') { const id = path.split('/').pop(); if (id === '404404') return reply(404); companies[id] = body.properties; return reply(200); }
    return reply(400);
  };
  return { fetchImpl, calls, companies };
}

test('parses HubSpot company URLs and IDs', () => {
  assert.equal(parseCompanyId('https://app.hubspot.com/contacts/109236/record/0-2/987654321'), '987654321');
  assert.equal(parseCompanyId('https://app.hubspot.com/contacts/109236/company/555'), '555');
  assert.equal(parseCompanyId('42'), '42');
  assert.equal(parseCompanyId('not a company'), undefined);
});

test('pushes the four balance numbers onto the linked company, creating fields once', async () => {
  const { db, hp } = await seeded();
  const hs = fakeHubSpot();
  const sync = new HubSpotSync({ token: 'pat-secret', fetchImpl: hs.fetchImpl });
  assert.equal((await syncClient(db, sync, hp)).status, 'skipped', 'not linked yet');
  admin.updateClient(db, { clientId: hp, hubspotCompanyId: 'https://app.hubspot.com/contacts/1/record/0-2/777', actor: 't' });

  assert.equal((await syncClient(db, sync, hp)).status, 'success');
  assert.deepEqual(hs.companies['777'], {
    lg2_points_allocated: '250', lg2_points_used: '85', lg2_points_committed: '26', lg2_points_available: '139',
    lg2_points_contract_end: '2027-03-31', lg2_points_updated_at: hs.companies['777'].lg2_points_updated_at,
  });
  const created = hs.calls.filter((c) => c.method === 'POST').length;
  assert.equal(created, PROPERTIES.length + 1, 'group + each property created once');
  assert.ok(hs.calls.every((c) => c.auth === 'Bearer pat-secret'));
  assert.ok(hs.calls.filter((c) => c.method === 'PATCH').every((c) => c.path === '/crm/v3/objects/companies/777'), 'only writes the linked company');

  // Nothing changed: no call.
  const before = hs.calls.length;
  assert.equal((await syncClient(db, sync, hp)).status, 'unchanged');
  assert.equal(hs.calls.length, before);

  // Balance changes: pushed again, fields not re-created.
  ledger.addAllocation(db, { clientId: hp, kind: 'purchase', points: 30, sourceRef: 'PO-9', actor: 't' });
  assert.equal((await syncClient(db, sync, hp)).status, 'success');
  assert.equal(hs.companies['777'].lg2_points_available, '169');
  assert.equal(hs.calls.filter((c) => c.method === 'POST').length, created);
});

test('a HubSpot failure is recorded without leaking the token', async () => {
  const { db, hp } = await seeded({ sync: false });
  const hs = fakeHubSpot();
  admin.updateClient(db, { clientId: hp, hubspotCompanyId: '404404', actor: 't' });
  const r = await syncClient(db, new HubSpotSync({ token: 'pat-secret', fetchImpl: hs.fetchImpl }), hp);
  assert.equal(r.status, 'failed');
  assert.doesNotMatch(r.error, /pat-secret/);
  assert.match(require('../src/ingest').syncStatus(db, hp).hubspot.recent_failures[0].error, /404/);
});

test('HubSpot link: staff only; never shown to clients; bad input rejected', async (t) => {
  const s = await seeded({ sync: false });
  const hs = fakeHubSpot();
  const srv = await startServer(createApp({ db: s.db, adapters: {}, hubspot: new HubSpotSync({ token: 'pat-secret', fetchImpl: hs.fetchImpl }) }));
  t.after(srv.close);
  const staff = client(srv.base); await staff.login(DEMO_STAFF.email, DEMO_STAFF.password);
  assert.equal((await staff.post(`/api/staff/clients/${s.hp}`, { hubspotCompanyId: 'nope' })).status, 400);
  assert.equal((await staff.post(`/api/staff/clients/${s.hp}/hubspot-sync`, {})).status, 409, 'not linked yet');
  assert.equal((await staff.post(`/api/staff/clients/${s.hp}`, { hubspotCompanyId: '888' })).status, 200);
  assert.equal((await staff.post(`/api/staff/clients/${s.hp}/hubspot-sync`, {})).status, 200);
  assert.equal(hs.companies['888'].lg2_points_used, '85');
  s.db.prepare('UPDATE clients SET portal_enabled = 1').run();
  const dana = client(srv.base); await dana.login('dana@harborpoint.example', 'demo-client');
  assert.equal((await dana.post(`/api/staff/clients/${s.hp}/hubspot-sync`, {})).status, 403);
  assert.doesNotMatch((await dana.get('/api/client/dashboard')).text, /888|hubspot_company|lg2_points/);
});
