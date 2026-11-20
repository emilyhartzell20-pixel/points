'use strict';
// Editorial calendar + "Waiting on you" from client-facing ClickUp lists.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const admin = require('../src/admin');
const feeds = require('../src/feeds');
const ingest = require('../src/ingest');
const { clientDashboard } = require('../src/clientView');
const { seeded, startServer, client } = require('./helpers');
const { DEMO_STAFF } = require('../src/seed');
const { createApp } = require('../src/server');

const ms = (d) => String(Date.parse(`${d}T17:00:00Z`));
const lists = {
  '700': [ // [QUESTCO] Blog Calendar
    { id: 'b1', name: 'How Much Does a PEO Cost?', status: { status: 'ready to start', type: 'open' }, due_date: ms('2027-03-15') },
    { id: 'b2', name: 'How to Build a Workforce Budget for 2027', status: { status: 'done', type: 'closed' }, due_date: ms('2026-11-12') },
    { id: 'b3', name: 'Old post', status: { status: 'done', type: 'closed' }, due_date: ms('2026-05-01') },
    { id: 'b4', name: 'Write draft', parent: 'b1', status: { status: 'in progress' }, due_date: ms('2027-03-01') },
  ],
  '701': [ // [MRSTEAM] Collaboration
    { id: 'c1', name: 'Blog (Bathroom Privacy)', status: { status: 'ready for review', type: 'unstarted' }, due_date: ms('2026-11-24'), description: 'INTERNAL NOTE', assignees: [{ username: 'William Kauker' }] },
    { id: 'c2', name: 'Not ready yet', status: { status: 'not ready', type: 'open' } },
    { id: 'c3', name: 'Approved already', status: { status: 'done', type: 'closed' } },
  ],
};
const adapter = { mode: 'live', fetchTasks: async ({ mappings }) => lists[mappings[0].value] || [] };

function setup() {
  const db = openDb(':memory:');
  const m = admin.createMenuFromTemplate(db, { template: 'leadg2-2026', actor: 't' });
  const c = admin.createClient(db, { name: 'Questco', termStart: '2026-04-01', termEnd: '2027-03-31', menuVersionId: m.id, agreementRef: 'x', basePoints: 900, actor: 't' });
  return { db, clientId: c.id, menuId: m.id };
}

test('editorial calendar: upcoming content with plain-language stages; steps and old items left out', async () => {
  const { db, clientId } = setup();
  feeds.addFeed(db, { clientId, kind: 'calendar', listId: 'https://app.clickup.com/9017740562/v/li/700', actor: 't' });
  await feeds.refreshFeeds(db, adapter, { clientId });
  const c = feeds.clientFeeds(db, clientId, { today: '2026-11-20' });
  assert.deepEqual(c.calendar, [
    { title: 'How to Build a Workforce Budget for 2027', date: '2026-11-12', stage: 'published' },
    { title: 'How Much Does a PEO Cost?', date: '2027-03-15', stage: 'planned' },
  ]);
  assert.equal(c.waiting, null, 'no approvals list linked');
});

test('waiting on you: only items ready for the client\'s review, without internal details', async () => {
  const { db, clientId } = setup();
  feeds.addFeed(db, { clientId, kind: 'collaboration', listId: '701', actor: 't' });
  await feeds.refreshFeeds(db, adapter, { clientId });
  const v = clientDashboard(db, clientId);
  assert.deepEqual(v.content.waiting.map((w) => [w.title, w.due, w.status]), [['Blog (Bathroom Privacy)', '2026-11-24', 'Ready for your review']]);
  assert.doesNotMatch(JSON.stringify(v), /INTERNAL NOTE|William|not ready|Approved already/);
});

test('the ClickUp scan finds each client\'s calendar and collaboration lists and links them on import', async () => {
  const { db } = setup();
  const scan = { ...adapter, listHierarchy: async () => [{ workspace: 'W', space: { id: 's', name: 'MrSteam' }, lists: [
    { id: '900', name: 'MrSteam Point Tracker 2026 (740 Points)' }, { id: '700', name: '[MRSTEAM] Blog Calendar' },
    { id: '701', name: '[MRSTEAM] Collaboration' }, { id: '702', name: '[TEMPLATE] Collaboration' }] }] };
  const [row] = await ingest.findTrackers(db, scan);
  assert.deepEqual([row.calendar.id, row.collaboration.id], ['700', '701']);
  const [r] = await ingest.importTrackers(db, { adapter: scan, actor: 't', items: [{ listId: '900', listName: row.list_name, name: 'MrSteam', allocation: 740, calendarListId: '700', collabListId: '701' }] });
  assert.deepEqual(r.linked_feeds, ['calendar', 'collaboration']);
  const v = clientDashboard(db, r.clientId);
  assert.equal(v.content.waiting.length, 1);
  assert.ok(v.content.calendar.length >= 1);
  assert.equal((await ingest.findTrackers(db, scan))[0].calendar.linked, true);
});

test('one client never sees another client\'s calendar or approvals', async (t) => {
  const s = await seeded({ sync: false });
  feeds.addFeed(s.db, { clientId: s.hp, kind: 'collaboration', listId: '701', actor: 't' });
  await feeds.refreshFeeds(s.db, adapter, { clientId: s.hp });
  s.db.prepare('UPDATE clients SET portal_enabled = 1').run();
  const srv = await startServer(createApp({ db: s.db, adapters: {} }));
  t.after(srv.close);
  const pat = client(srv.base); await pat.login('pat@bluebirddental.example', 'demo-client');
  const body = (await pat.get('/api/client/dashboard')).text;
  assert.doesNotMatch(body, /Bathroom Privacy/);
  assert.equal((await pat.post(`/api/staff/clients/${s.hp}/feeds`, { kind: 'calendar', listId: '1' })).status, 403);
  const staff = client(srv.base); await staff.login(DEMO_STAFF.email, DEMO_STAFF.password);
  assert.equal((await staff.post(`/api/staff/clients/${s.bb}/feeds`, { kind: 'collaboration', listId: '701' })).status, 409, 'a list can only feed one client');
});
