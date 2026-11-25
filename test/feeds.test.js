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
  const scan = { ...adapter, listHierarchy: async () => [{ workspace: 'W', space: { id: '55', name: 'MrSteam' }, lists: [
    { id: '900', name: 'MrSteam Point Tracker 2026 (740 Points)' }, { id: '700', name: '[MRSTEAM] Blog Calendar' },
    { id: '701', name: '[MRSTEAM] Collaboration' }, { id: '702', name: '[TEMPLATE] Collaboration' }] }] };
  const [row] = await ingest.findTrackers(db, scan);
  assert.deepEqual([row.calendar.id, row.collaboration.id], ['700', 'space:55'], 'approvals watch the whole space');
  lists['55'] = lists['701'];
  const [r] = await ingest.importTrackers(db, { adapter: scan, actor: 't', items: [{ listId: '900', listName: row.list_name, name: 'MrSteam', allocation: 740, calendarListId: '700', collabListId: row.collaboration.id }] });
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

// ---------------------------------------------------------------- answering reviews from the dashboard
const { writeJson } = require('../src/adapters/http');
const { LiveClickUp } = require('../src/adapters/clickup');
const STATUSES = ['not ready', 'ready for review', 'revision needed', 'under revision', 'done'].map((status) => ({ status, type: status === 'done' ? 'closed' : 'custom' }));
function writer() {
  const sent = [];
  return { sent, a: { ...adapter, listStatuses: async () => STATUSES, respondToReview: async (taskId, ans) => { sent.push({ taskId, ...ans }); } } };
}
const dana = { email: 'dana@q.example', name: 'Dana Q' };

test('approve: sets the task to its list\'s approved status, comments, and drops off "waiting"', async () => {
  const { db, clientId } = setup();
  const { a, sent } = writer();
  feeds.addFeed(db, { clientId, kind: 'collaboration', listId: '701', actor: 't' });
  await feeds.refreshFeeds(db, a, { clientId });
  const r = await feeds.respondToReview(db, a, { clientId, user: dana, taskId: 'c1', decision: 'approve' });
  assert.equal(r.status, 'done');
  assert.equal(sent.length, 1);
  assert.match(sent[0].comment, /Approved by Dana Q \(client\)/);
  assert.equal(clientDashboard(db, clientId).content.waiting.length, 0);
  assert.ok(db.prepare(`SELECT 1 FROM audit_log WHERE action = 'review.approve' AND actor = ?`).get(dana.email));
  await assert.rejects(feeds.respondToReview(db, a, { clientId, user: dana, taskId: 'c1', decision: 'approve' }), /Not found/, 'answered items are gone');
  await assert.rejects(feeds.respondToReview(db, a, { clientId, user: dana, taskId: 'c2', decision: 'approve' }), /Not found/, 'not-ready items are never offered');
  assert.equal(sent.length, 1);
});

test('request changes: needs a note, sets "revision needed" and passes the note on', async () => {
  const { db, clientId } = setup();
  const { a, sent } = writer();
  feeds.addFeed(db, { clientId, kind: 'collaboration', listId: '701', actor: 't' });
  await feeds.refreshFeeds(db, a, { clientId });
  await assert.rejects(feeds.respondToReview(db, a, { clientId, user: dana, taskId: 'c1', decision: 'changes', comment: '  ' }), /what you would like changed/);
  const r = await feeds.respondToReview(db, a, { clientId, user: dana, taskId: 'c1', decision: 'changes', comment: 'Swap the hero image' });
  assert.equal(r.status, 'revision needed');
  assert.match(sent[0].comment, /Changes requested by Dana Q[\s\S]*Swap the hero image/);
  assert.equal(feeds.targetStatus([{ status: 'Client Approved', type: 'custom' }, { status: 'complete', type: 'closed' }], 'approve'), 'Client Approved');
});

test('a ClickUp failure is reported and the item stays waiting', async () => {
  const { db, clientId } = setup();
  const a = { ...adapter, listStatuses: async () => STATUSES, respondToReview: async () => { throw new Error('api.clickup.com responded 401'); } };
  feeds.addFeed(db, { clientId, kind: 'collaboration', listId: '701', actor: 't' });
  await feeds.refreshFeeds(db, a, { clientId });
  await assert.rejects(feeds.respondToReview(db, a, { clientId, user: dana, taskId: 'c1', decision: 'approve' }), /didn't accept/);
  assert.equal(clientDashboard(db, clientId).content.waiting.length, 1);
});

test('the ClickUp write path can only set a task status or add a task comment', async () => {
  const calls = [];
  const fetchImpl = async (url, o) => { calls.push([o.method, new URL(url).pathname, JSON.parse(o.body)]); return { ok: true, json: async () => ({}) }; };
  await new LiveClickUp({ token: 'x', fetchImpl }).respondToReview('86abc', { status: 'done', comment: 'hi' });
  assert.deepEqual(calls.map((c) => c.slice(0, 2)), [['PUT', '/api/v2/task/86abc'], ['POST', '/api/v2/task/86abc/comment']]);
  assert.deepEqual(calls[0][2], { status: 'done' });
  for (const [method, url] of [['DELETE', 'https://api.clickup.com/api/v2/task/1'], ['PUT', 'https://api.clickup.com/api/v2/list/1'],
    ['POST', 'https://api.clickup.com/api/v2/task/1/attachment'], ['PUT', 'https://evil.example/api/v2/task/1'], ['POST', 'https://api.clickup.com/api/v2/task/../list/1/task']]) {
    await assert.rejects(writeJson(url, {}, { method, body: {}, fetchImpl }), /not permitted/, `${method} ${url}`);
  }
});

test('a client can only answer their own items, and staff cannot answer for them', async (t) => {
  const s = await seeded({ sync: false });
  const { a, sent } = writer();
  feeds.addFeed(s.db, { clientId: s.hp, kind: 'collaboration', listId: '701', actor: 't' });
  await feeds.refreshFeeds(s.db, a, { clientId: s.hp });
  s.db.prepare('UPDATE clients SET portal_enabled = 1').run();
  const srv = await startServer(createApp({ db: s.db, adapters: { clickup: a } }));
  t.after(srv.close);
  const pat = client(srv.base); await pat.login('pat@bluebirddental.example', 'demo-client');
  assert.equal((await pat.post('/api/client/reviews/c1', { decision: 'approve' })).status, 404);
  const staff = client(srv.base); await staff.login(DEMO_STAFF.email, DEMO_STAFF.password);
  assert.equal((await staff.post('/api/client/reviews/c1', { decision: 'approve' })).status, 403);
  assert.equal(sent.length, 0);
  const dana2 = client(srv.base); await dana2.login('dana@harborpoint.example', 'demo-client');
  const ok = await dana2.post('/api/client/reviews/c1', { decision: 'approve' });
  assert.equal(ok.status, 200);
  assert.equal(sent.length, 1);
});

test('approvals can watch a whole space: "client review" items and tasks assigned to the client\'s people', async () => {
  const { db, clientId } = setup();
  db.prepare("INSERT INTO users (email, name, role, client_id, password_hash) VALUES ('kim@questco.example', 'Kim', 'client', ?, 'x')").run(clientId);
  const space = [
    { id: 'r1', name: 'December social posts', status: { status: 'client review', type: 'custom' }, list: { id: '501' }, due_date: ms('2026-12-01') },
    { id: 'a1', name: 'Send 2027 survey contacts', status: { status: 'in progress', type: 'custom' }, list: { id: '502' }, assignees: [{ email: 'KIM@questco.example' }] },
    { id: 'x1', name: 'Internal draft', status: { status: 'internal review', type: 'custom' }, list: { id: '501' }, assignees: [{ email: 'jeremy@leadg2.com' }] },
    { id: 'x2', name: 'Old approved thing', status: { status: 'approved', type: 'done' }, list: { id: '501' }, assignees: [{ email: 'kim@questco.example' }] },
  ];
  const sent = []; let asked = null;
  const qStatuses = ['not ready', 'in progress', 'internal review', 'client review', 'revisions', 'approved', 'done']
    .map((status) => ({ status, type: status === 'approved' ? 'done' : status === 'done' ? 'closed' : 'custom' }));
  const a = { mode: 'live', fetchTasks: async ({ mappings, includeClosed }) => { assert.equal(mappings[0].source_type, 'clickup_space'); assert.equal(includeClosed, false); return space; },
    listStatuses: async (listId) => { asked = listId; return qStatuses; }, respondToReview: async (taskId, ans) => { sent.push({ taskId, ...ans }); } };
  feeds.addFeed(db, { clientId, kind: 'collaboration', listId: 'https://app.clickup.com/9017740562/v/s/90173598053', actor: 't' });
  await feeds.refreshFeeds(db, a, { clientId });
  const w = clientDashboard(db, clientId).content.waiting;
  assert.deepEqual(w.map((i) => [i.title, i.action]), [['December social posts', 'review'], ['Send 2027 survey contacts', 'assigned']]);

  await assert.rejects(feeds.respondToReview(db, a, { clientId, user: dana, taskId: 'r1', decision: 'done' }), /already been answered/, 'review items use approve/changes');
  await feeds.respondToReview(db, a, { clientId, user: dana, taskId: 'r1', decision: 'changes', comment: 'Fewer emojis' });
  assert.equal(asked, '501', 'statuses come from the task\'s own list');
  assert.equal(sent[0].status, 'revisions');
  await assert.rejects(feeds.respondToReview(db, a, { clientId, user: dana, taskId: 'a1', decision: 'approve' }), /already been answered/);
  const r = await feeds.respondToReview(db, a, { clientId, user: dana, taskId: 'a1', decision: 'done' });
  assert.equal(r.status, 'done');
  assert.match(sent[1].comment, /Marked done by Dana Q/);
  assert.equal(clientDashboard(db, clientId).content.waiting.length, 0);
});

test('ClickUp links: list, folder and space URLs', () => {
  assert.deepEqual(feeds.parseTarget('https://app.clickup.com/9017740562/v/li/901710435611'), { scope: 'list', id: '901710435611' });
  assert.deepEqual(feeds.parseTarget('https://app.clickup.com/9017740562/v/f/90175845823'), { scope: 'folder', id: '90175845823' });
  assert.deepEqual(feeds.parseTarget('https://app.clickup.com/9017740562/v/s/90173598053'), { scope: 'space', id: '90173598053' });
  assert.deepEqual(feeds.parseTarget('space:90173598053'), { scope: 'space', id: '90173598053' });
  assert.deepEqual(feeds.parseTarget('901710435611'), { scope: 'list', id: '901710435611' });
  assert.equal(feeds.parseTarget('https://app.clickup.com/9017740562/v/f/90175845823/8cqzk8j-62977').scope, 'folder');
});

test('EmployerFlexible\'s Collaboration list: "ready" items assigned to client people (guests, no login yet) show up', async () => {
  const { db, clientId } = setup();
  const efStatuses = [['not ready', 'open'], ['ready', 'unstarted'], ['revision needed', 'done'], ['under revision', 'done'], ['approved', 'closed']]
    .map(([status, type]) => ({ status, type }));
  const client = [{ username: 'Alice McDonald', email: 'alice@employerflexible.example' }, { username: 'Dan', email: 'dan@employerflexible.example' }];
  const staff = [{ username: 'Jeremy Streich', email: 'jeremy@leadg2.com' }];
  const st = (status) => ({ status, type: efStatuses.find((x) => x.status === status).type });
  const space = [
    { id: 'p', name: 'Review Champion Playbook #3', status: st('ready'), assignees: client, list: { id: '804' }, due_date: ms('2026-12-01') },
    { id: 's', name: 'December Social Media', status: st('ready'), assignees: client, list: { id: '804' }, due_date: ms('2026-12-04') },
    { id: 'f', name: 'Submit Monthly Comms Intake Form', status: st('ready'), assignees: client, list: { id: '804' }, due_date: ms('2026-12-05') },
    { id: 'n', name: 'January Blogs', status: st('not ready'), assignees: client, list: { id: '804' } },
    { id: 'r', name: 'November Blogs', status: st('revision needed'), assignees: client, list: { id: '804' } },
    { id: 'x', name: 'Write Copy', status: { status: 'not ready', type: 'open' }, assignees: staff, list: { id: '717' } },
    { id: 'y', name: 'Research + create first draft', status: { status: 'ready to start', type: 'unstarted' }, assignees: staff, list: { id: '857' } },
  ];
  const sent = [];
  const a = { mode: 'live', fetchTasks: async () => space, listStatuses: async () => efStatuses, respondToReview: async (id, ans) => { sent.push({ id, ...ans }); } };
  feeds.addFeed(db, { clientId, kind: 'collaboration', listId: 'space:90176032931', actor: 't' });
  await feeds.refreshFeeds(db, a, { clientId });
  const w = clientDashboard(db, clientId).content.waiting;
  assert.deepEqual(w.map((i) => [i.title, i.action]), [
    ['Review Champion Playbook #3', 'review'], ['December Social Media', 'review'], ['Submit Monthly Comms Intake Form', 'assigned']]);
  assert.doesNotMatch(JSON.stringify(w), /alice@|Jeremy/);
  await feeds.respondToReview(db, a, { clientId, user: dana, taskId: 'p', decision: 'approve' });
  await feeds.respondToReview(db, a, { clientId, user: dana, taskId: 's', decision: 'changes', comment: 'Swap post 3' });
  await feeds.respondToReview(db, a, { clientId, user: dana, taskId: 'f', decision: 'done' });
  assert.deepEqual(sent.map((x) => [x.id, x.status]), [['p', 'approved'], ['s', 'revision needed'], ['f', 'approved']]);
});
