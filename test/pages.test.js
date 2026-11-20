'use strict';
// The HTML editorial calendar page shown on the client dashboard.
const test = require('node:test');
const assert = require('node:assert/strict');
const { seeded, startServer, client } = require('./helpers');
const { DEMO_STAFF } = require('../src/seed');
const { createApp } = require('../src/server');

const HTML = '<!doctype html><html><body><h1>Questco Editorial Calendar</h1><script>document.title="x"</script></body></html>';

test('staff upload an HTML calendar; only that client sees it, sandboxed', async (t) => {
  const s = await seeded({ sync: false });
  s.db.prepare('UPDATE clients SET portal_enabled = 1').run();
  const srv = await startServer(createApp({ db: s.db, adapters: {} }));
  t.after(srv.close);
  const staff = client(srv.base); await staff.login(DEMO_STAFF.email, DEMO_STAFF.password);
  const dana = client(srv.base); await dana.login('dana@harborpoint.example', 'demo-client');
  const pat = client(srv.base); await pat.login('pat@bluebirddental.example', 'demo-client');

  assert.equal((await dana.post(`/api/staff/clients/${s.hp}/editorial`, { html: HTML })).status, 403, 'clients cannot upload');
  { const r = await staff.post(`/api/staff/clients/${s.hp}/editorial`, { url: 'http://example.com/cal.html' }); assert.equal(r.status, 400, r.text); }
  assert.equal((await staff.post(`/api/staff/clients/${s.hp}/editorial`, { url: 'http://example.com/cal.html' })).status, 400);
  assert.equal((await staff.post(`/api/staff/clients/${s.hp}/editorial`, { html: HTML, fileName: 'cal.html' })).status, 200);

  const dash = JSON.parse((await dana.get('/api/client/dashboard')).text);
  assert.equal(dash.editorial_page.kind, 'html');
  assert.doesNotMatch(JSON.stringify(dash), new RegExp(DEMO_STAFF.email), 'uploader is not shown to the client');

  const page = await dana.raw('/api/client/editorial');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Questco Editorial Calendar/);
  assert.match(page.headers.get('content-security-policy'), /^sandbox allow-scripts/);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /allow-same-origin/);

  assert.equal((await pat.get('/api/client/editorial')).status, 404, 'another client has no page and cannot reach this one');
  assert.equal(JSON.parse((await pat.get('/api/client/dashboard')).text).editorial_page, null);

  assert.equal((await staff.post(`/api/staff/clients/${s.hp}/editorial`, { url: 'https://calendar.example.com/questco' })).status, 200);
  assert.deepEqual(JSON.parse((await dana.get('/api/client/dashboard')).text).editorial_page.url, 'https://calendar.example.com/questco');
  assert.equal((await dana.get('/api/client/editorial')).status, 404);
  await staff.post(`/api/staff/clients/${s.hp}/editorial/remove`, {});
  assert.equal(JSON.parse((await dana.get('/api/client/dashboard')).text).editorial_page, null);
});

test('quick links: staff add them, only that client sees them, without internal details', async (t) => {
  const s = await seeded({ sync: false });
  s.db.prepare('UPDATE clients SET portal_enabled = 1').run();
  const srv = await startServer(createApp({ db: s.db, adapters: {} }));
  t.after(srv.close);
  const staff = client(srv.base); await staff.login(DEMO_STAFF.email, DEMO_STAFF.password);
  const dana = client(srv.base); await dana.login('dana@harborpoint.example', 'demo-client');
  const pat = client(srv.base); await pat.login('pat@bluebirddental.example', 'demo-client');

  assert.equal((await dana.post(`/api/staff/clients/${s.hp}/links`, { label: 'x', url: 'https://example.com' })).status, 403);
  assert.equal((await staff.post(`/api/staff/clients/${s.hp}/links`, { label: 'Files', url: 'http://example.com' })).status, 400);
  assert.equal((await staff.post(`/api/staff/clients/${s.hp}/links`, { label: '', url: 'https://example.com' })).status, 400);
  await staff.post(`/api/staff/clients/${s.hp}/links`, { label: 'Your SharePoint folder', url: 'https://leadg2.sharepoint.com/sites/Clients/Harbor', note: 'Shared files' });
  const b = JSON.parse((await staff.post(`/api/staff/clients/${s.hp}/links`, { label: 'Your project board', url: 'https://app.clickup.com/9017740562/v/b/abc' })).text);
  await staff.post(`/api/staff/clients/${s.hp}/links/${b.id}/up`, {});

  const dash = JSON.parse((await dana.get('/api/client/dashboard')).text);
  assert.deepEqual(dash.links, [
    { label: 'Your project board', url: 'https://app.clickup.com/9017740562/v/b/abc', note: null, kind: 'clickup' },
    { label: 'Your SharePoint folder', url: 'https://leadg2.sharepoint.com/sites/Clients/Harbor', note: 'Shared files', kind: 'sharepoint' },
  ]);
  assert.doesNotMatch(JSON.stringify(dash), new RegExp(DEMO_STAFF.email));
  assert.deepEqual(JSON.parse((await pat.get('/api/client/dashboard')).text).links, []);
  assert.equal((await staff.post(`/api/staff/clients/${s.bb}/links/${b.id}/remove`, {})).status, 404, 'a link is removed only through its own client');
  assert.equal((await staff.post(`/api/staff/clients/${s.hp}/links/${b.id}/remove`, {})).status, 200);
  assert.equal(JSON.parse((await dana.get('/api/client/dashboard')).text).links.length, 1);
});

test('invite links use the app address the admin is on (works before the custom domain is live)', async (t) => {
  const saved = { p: process.env.PUBLIC_URL, r: process.env.RENDER_EXTERNAL_URL };
  t.after(() => { for (const [k, v] of [['PUBLIC_URL', saved.p], ['RENDER_EXTERNAL_URL', saved.r]]) { if (v == null) delete process.env[k]; else process.env[k] = v; } });
  const s = await seeded({ sync: false });
  const srv = await startServer(createApp({ db: s.db, adapters: {} }));
  t.after(srv.close);
  process.env.PUBLIC_URL = 'https://points.leadg2.com';
  process.env.RENDER_EXTERNAL_URL = srv.base;
  const staff = client(srv.base); await staff.login(DEMO_STAFF.email, DEMO_STAFF.password);
  const r = JSON.parse((await staff.post(`/api/staff/clients/${s.hp}/users`, { name: 'New Person', email: 'new@harborpoint.example' })).text);
  assert.ok(r.link.startsWith(`${srv.base}/setup#t=`), r.link);
  delete process.env.RENDER_EXTERNAL_URL;
  const r2 = JSON.parse((await staff.post(`/api/staff/clients/${s.hp}/users`, { name: 'Other Person', email: 'other@harborpoint.example' })).text);
  assert.ok(r2.link.startsWith('https://points.leadg2.com/setup#t='), 'an unknown address never ends up in a link');
});
