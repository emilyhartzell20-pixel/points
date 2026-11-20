'use strict';
// Menu editing, client logins (invite links), and source mappings.
const test = require('node:test');
const assert = require('node:assert/strict');
const { seeded, openSuggestion, startServer, client } = require('./helpers');
const { DEMO_STAFF } = require('../src/seed');
const { createApp } = require('../src/server');
const admin = require('../src/admin');
const ledger = require('../src/ledger');
const review = require('../src/review');
const ingest = require('../src/ingest');
const { findItem } = require('../src/menu');
const { SampleClickUp } = require('../src/adapters/clickup');

const versionId = (db, code) => db.prepare('SELECT id FROM menu_versions WHERE code = ?').get(code).id;
const itemId = (db, vid, code) => db.prepare('SELECT id FROM menu_items WHERE menu_version_id = ? AND code = ?').get(vid, code).id;

test('editing a menu item changes new work only; approved work keeps its points', async () => {
  const { db, hp } = await seeded();
  review.approveSuggestion(db, { id: openSuggestion(db, hp, 'clickup:86b3land', 'complete').id, actor: 't' });
  const before = ledger.balance(db, hp);
  const v = versionId(db, '2026.1');
  admin.saveMenuItem(db, { versionId: v, itemId: itemId(db, v, 'LP-BUILD'), code: 'LP-BUILD', name: 'Landing page build', pointsMin: 12, pointsMax: '', keywords: 'landing page', actor: 'emily@leadg2.example' });
  assert.equal(findItem(db, hp, 'LP-BUILD').points_min, 12, 'new work uses the new price');
  assert.deepEqual(ledger.balance(db, hp), before, 'balance unchanged');
  assert.equal(db.prepare(`SELECT points FROM work_items WHERE group_key = 'clickup:86b3land'`).get().points, 10);
  const log = db.prepare(`SELECT * FROM audit_log WHERE action = 'menu.item.update'`).get();
  assert.equal(log.actor, 'emily@leadg2.example');
  assert.match(log.detail, /"min":10.*"min":12/);
});

test('menu items: add, range, validation, remove', async () => {
  const { db, hp } = await seeded({ sync: false });
  const v = versionId(db, '2026.1');
  admin.saveMenuItem(db, { versionId: v, code: 'case study', name: 'Case study', pointsMin: 6, pointsMax: 9, actor: 't' });
  const cs = findItem(db, hp, 'CASE-STUDY');
  assert.deepEqual([cs.points_min, cs.points_max], [6, 9], 'code normalized; range stored');
  assert.throws(() => admin.saveMenuItem(db, { versionId: v, code: 'X', name: 'Bad', pointsMin: 9, pointsMax: 6, actor: 't' }), /maximum/);
  assert.throws(() => admin.saveMenuItem(db, { versionId: v, code: 'CASE-STUDY', name: 'Dup', pointsMin: 1, actor: 't' }), /already used/);
  admin.deleteMenuItem(db, { versionId: v, itemId: cs.id, actor: 't' });
  assert.equal(findItem(db, hp, 'CASE-STUDY'), null);
});

test('new menu version: copy, edit, and switch one client without touching others', async () => {
  const { db, hp, bb } = await seeded({ sync: false });
  const v2026 = versionId(db, '2026.1');
  const v = admin.createMenuVersion(db, { code: '2027.1', effectiveDate: '2027-01-01', copyFromId: v2026, actor: 't' });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM menu_items WHERE menu_version_id = ?').get(v.id).n,
    db.prepare('SELECT COUNT(*) n FROM menu_items WHERE menu_version_id = ?').get(v2026).n);
  admin.saveMenuItem(db, { versionId: v.id, itemId: itemId(db, v.id, 'TRAIN'), code: 'TRAIN', name: 'Team training session (1 hour)', pointsMin: 5, actor: 't' });
  assert.equal(findItem(db, hp, 'TRAIN').points_min, 4, 'still on 2026.1 until switched');
  admin.assignMenu(db, { clientId: hp, versionId: v.id, actor: 't' });
  assert.equal(findItem(db, hp, 'TRAIN').points_min, 5);
  assert.equal(db.prepare('SELECT menu_version_id m FROM contracts WHERE client_id = ?').get(bb).m, versionId(db, '2025.2'), 'other client untouched');
  assert.throws(() => admin.createMenuVersion(db, { code: '2027.1', effectiveDate: '2027-01-01', actor: 't' }), /already exists/);
});

test('giving a client access: invite link, client chooses password, access switch, removal', async (t) => {
  const s = await seeded();
  const srv = await startServer(createApp({ db: s.db, adapters: {} }));
  t.after(srv.close);
  const staff = client(srv.base);
  await staff.login(DEMO_STAFF.email, DEMO_STAFF.password);

  const add = await staff.post(`/api/staff/clients/${s.hp}/users`, { name: 'Mark Chen', email: 'Mark.Chen@harborpoint.example' });
  assert.equal(add.status, 200);
  assert.match(add.body.link, /\/setup#t=[\w-]{40,}$/, 'token travels in the URL fragment');
  const token = add.body.link.split('#t=')[1];
  let users = (await staff.get(`/api/staff/clients/${s.hp}/users`)).body;
  assert.equal(users.find((u) => u.email === 'mark.chen@harborpoint.example').status, 'invited');

  // Before choosing a password, no password works.
  const mark = client(srv.base);
  assert.equal((await mark.login('mark.chen@harborpoint.example', '')).status, 401);
  assert.equal((await mark.post('/api/invite/accept', { token, password: 'short' })).status, 400);
  assert.equal((await mark.post('/api/invite/check', { token })).body.name, 'Mark Chen');
  assert.equal((await mark.post('/api/invite/accept', { token, password: 'harbor-point-2026' })).status, 200);
  assert.equal((await mark.post('/api/invite/accept', { token, password: 'another-password' })).status, 400, 'link works once');

  // Password set, but the client can't get in until access is turned on.
  assert.equal((await mark.login('mark.chen@harborpoint.example', 'harbor-point-2026')).status, 403);
  await staff.post(`/api/staff/clients/${s.hp}/portal`, { enabled: true });
  assert.equal((await mark.login('mark.chen@harborpoint.example', 'harbor-point-2026')).status, 200);
  assert.equal((await mark.get('/api/client/dashboard')).body.client.name, 'Harbor Point Logistics');

  // Password reset link replaces the password; old sessions end.
  users = (await staff.get(`/api/staff/clients/${s.hp}/users`)).body;
  const markId = users.find((u) => u.email === 'mark.chen@harborpoint.example').id;
  assert.equal(users.find((u) => u.id === markId).status, 'active');
  const reset = await staff.post(`/api/staff/clients/${s.hp}/users/${markId}/link`, {});
  await mark.post('/api/invite/accept', { token: reset.body.link.split('#t=')[1], password: 'new-password-123' });
  assert.equal((await mark.get('/api/client/dashboard')).status, 401, 'signed out after reset');

  // Clients cannot manage logins, and staff cannot manage a login through the wrong client.
  const dana = client(srv.base);
  await dana.login('dana@harborpoint.example', 'demo-client');
  assert.equal((await dana.post(`/api/staff/clients/${s.hp}/users`, { name: 'x', email: 'x@x.com' })).status, 403);
  assert.equal((await staff.post(`/api/staff/clients/${s.bb}/users/${markId}/remove`, {})).status, 404);

  // Removing a login signs them out and blocks sign-in.
  await mark.login('mark.chen@harborpoint.example', 'new-password-123');
  assert.equal((await staff.post(`/api/staff/clients/${s.hp}/users/${markId}/remove`, {})).status, 200);
  assert.equal((await mark.get('/api/client/dashboard')).status, 401);
  assert.equal((await mark.login('mark.chen@harborpoint.example', 'new-password-123')).status, 401);
});

test('duplicate or invalid client logins are rejected', async () => {
  const { db, hp, bb } = await seeded({ sync: false });
  assert.throws(() => admin.inviteClientUser(db, { clientId: hp, name: 'X', email: 'not-an-email', actor: 't' }), /valid email/);
  assert.throws(() => admin.inviteClientUser(db, { clientId: bb, name: 'Dana', email: 'dana@harborpoint.example', actor: 't' }), /another account/);
});

test('source mappings: add from a pasted ClickUp URL, prevent double-mapping, and remove', async () => {
  const { db, hp, bb } = await seeded({ sync: false });
  const m = admin.addMapping(db, { clientId: hp, sourceType: 'clickup_list', value: 'https://app.clickup.com/9011/v/li/901104567890', scope: 'points', actor: 't' });
  assert.equal(m.value, '901104567890');
  assert.throws(() => admin.addMapping(db, { clientId: bb, sourceType: 'clickup_list', value: '901104567890', actor: 't' }), /already mapped to Harbor Point/);
  assert.equal(admin.addMapping(db, { clientId: hp, sourceType: 'email_domain', value: '@HarborPointFreight.com', actor: 't' }).value, 'harborpointfreight.com');
  assert.throws(() => admin.addMapping(db, { clientId: hp, sourceType: 'clickup_list', value: 'not a list', actor: 't' }), /ClickUp list or space ID/);

  // Removing the list mapping stops future syncs from reading it.
  const list = db.prepare(`SELECT id FROM source_mappings WHERE client_id = ? AND value = '9101'`).get(hp);
  const space = db.prepare(`SELECT id FROM source_mappings WHERE client_id = ? AND value = '9001'`).get(hp);
  admin.removeMapping(db, { clientId: hp, mappingId: list.id, actor: 't' });
  admin.removeMapping(db, { clientId: hp, mappingId: space.id, actor: 't' });
  await ingest.syncSource(db, { clientId: hp, source: 'clickup', adapter: new SampleClickUp() });
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM source_records WHERE title = 'Carrier partner landing page'`).get().n, 0);
  assert.throws(() => admin.removeMapping(db, { clientId: bb, mappingId: list.id, actor: 't' }), /not found/);
});
