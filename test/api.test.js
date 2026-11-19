'use strict';
// End-to-end HTTP tests: authentication, server-side client isolation, preview, and data hygiene.
const test = require('node:test');
const assert = require('node:assert/strict');
const { seeded, startServer, client } = require('./helpers');
const { applyDemoReview, DEMO_STAFF } = require('../src/seed');
const { createApp } = require('../src/server');

async function setup() {
  const s = await seeded();
  applyDemoReview(s.db, s.hp);
  const srv = await startServer(createApp({ db: s.db, adapters: {} }));
  return { ...s, ...srv };
}

test('one client cannot access another client\'s data', async (t) => {
  const { db, hp, bb, base, close } = await setup();
  t.after(close);
  const staff = client(base);
  await staff.login(DEMO_STAFF.email, DEMO_STAFF.password);
  assert.equal((await staff.post(`/api/staff/clients/${hp}/portal`, { enabled: true })).status, 200);

  const dana = client(base);
  assert.equal((await dana.login('dana@harborpoint.example', 'demo-client')).status, 200);
  const pat = client(base);
  assert.equal((await pat.login('pat@bluebirddental.example', 'demo-client')).status, 200);

  const d = await dana.get('/api/client/dashboard');
  assert.equal(d.status, 200);
  assert.equal(d.body.client.name, 'Harbor Point Logistics');
  assert.deepEqual(d.body.balance, { allocated: 250, used: 103, committed: 23, available: 124 });
  assert.doesNotMatch(d.text, /Bluebird|recall/i);

  const p = await pat.get('/api/client/dashboard');
  assert.equal(p.body.client.name, 'Bluebird Dental Group');
  assert.doesNotMatch(p.text, /Harbor Point|carrier|landing page for our carrier/i);

  // Client ids in the request are ignored for client routes...
  const tamper = await pat.get(`/api/client/dashboard?client_id=${hp}&clientId=${hp}`);
  assert.equal(tamper.body.client.name, 'Bluebird Dental Group');
  // ...and every staff route (including preview, ledger, suggestions, evidence) is refused.
  for (const path of [`/api/staff/clients/${hp}/preview`, `/api/staff/clients/${hp}/overview`, `/api/staff/clients/${hp}/suggestions`,
    `/api/staff/clients/${hp}/work-items`, `/api/staff/clients/${hp}/ledger`, `/api/staff/clients/${hp}/audit`, '/api/staff/match-queue', '/api/staff/clients']) {
    assert.equal((await pat.get(path)).status, 403, path);
  }
  const item = db.prepare('SELECT id FROM work_items WHERE client_id = ? LIMIT 1').get(hp);
  assert.equal((await pat.post(`/api/staff/work-items/${item.id}/correct`, { points: 0, reason: 'x' })).status, 403);
  assert.equal((await pat.post(`/api/staff/clients/${hp}/portal`, { enabled: false })).status, 403);

  // Unauthenticated requests are refused.
  assert.equal((await client(base).get('/api/client/dashboard')).status, 401);
  void bb;
});

test('client view excludes email bodies, internal notes, suggestions and evidence links', async (t) => {
  const { db, hp, base, close } = await setup();
  t.after(close);
  db.prepare('UPDATE clients SET portal_enabled = 1 WHERE id = ?').run(hp);
  db.prepare(`UPDATE work_items SET internal_notes = 'INTERNAL-ONLY note' WHERE client_id = ?`).run(hp);
  const dana = client(base);
  await dana.login('dana@harborpoint.example', 'demo-client');
  const { text, body } = await dana.get('/api/client/dashboard');
  for (const leak of [/INTERNAL-ONLY/, /IGNORE PREVIOUS/i, /clickup\.com/i, /outlook/i, /@/, /rationale|suggestion|flags|evidence/i, /Approved - please go ahead/, /86b3/]) {
    assert.doesNotMatch(text, leak);
  }
  // Only client-approved summaries are listed.
  const titles = [...body.upcoming, ...body.completed].map((i) => i.description);
  assert.ok(titles.includes('Built the carrier partner program landing page and sign-up form'));
  assert.ok(!titles.some((x) => /webinar/i.test(x)), 'canceled work is not listed');
  assert.ok(!titles.some((x) => /dashboard next quarter|Q1 regional/i.test(x)), 'forecast work is not listed');
});

test('staff can preview exactly what the client sees before granting access', async (t) => {
  const { hp, base, close } = await setup();
  t.after(close);
  const staff = client(base);
  await staff.login(DEMO_STAFF.email, DEMO_STAFF.password);
  const dana = client(base);
  const denied = await dana.login('dana@harborpoint.example', 'demo-client');
  assert.equal(denied.status, 403, 'client cannot sign in before access is granted');

  const preview = await staff.get(`/api/staff/clients/${hp}/preview`);
  assert.equal(preview.status, 200);
  await staff.post(`/api/staff/clients/${hp}/portal`, { enabled: true });
  await dana.login('dana@harborpoint.example', 'demo-client');
  const real = await dana.get('/api/client/dashboard');
  assert.deepEqual(real.body, preview.body);

  // Revoking access ends existing client sessions.
  await staff.post(`/api/staff/clients/${hp}/portal`, { enabled: false });
  assert.equal((await dana.get('/api/client/dashboard')).status, 401);
});

test('staff workflow over HTTP: approve, correct, cancel; bad input rejected', async (t) => {
  const s = await seeded();
  const srv = await startServer(createApp({ db: s.db, adapters: {} }));
  t.after(srv.close);
  const staff = client(srv.base);
  assert.equal((await staff.login(DEMO_STAFF.email, 'wrong')).status, 401);
  await staff.login(DEMO_STAFF.email, DEMO_STAFF.password);
  const sugg = (await staff.get(`/api/staff/clients/${s.hp}/suggestions`)).body;
  const wf = sugg.find((x) => x.group_key === 'clickup:86b3wflw');
  assert.ok(wf.evidence.some((e) => e.url && e.url.includes('app.clickup.com/t/86b3wflw')), 'evidence links to the source task');
  assert.ok(wf.evidence.some((e) => e.source_type === 'outlook_message' && e.url), 'evidence links to the email');
  const ok = await staff.post(`/api/staff/suggestions/${wf.id}/approve`, { points: 13, reason: 'Confirmed in range' });
  assert.equal(ok.status, 200);
  const again = await staff.post(`/api/staff/suggestions/${wf.id}/approve`, { points: 13 });
  assert.equal(again.status, 409, 'cannot approve twice');
  const bal = (await staff.get(`/api/staff/clients/${s.hp}/overview`)).body.balance;
  assert.equal(bal.committed, 39);
  const noReason = await staff.post(`/api/staff/work-items/${ok.body.workItemId}/correct`, { points: 12 });
  assert.equal(noReason.status, 400);
  const notJson = await staff.raw(`/api/staff/clients/${s.hp}/portal`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'enabled=1' });
  assert.equal(notJson.status, 415);
});
