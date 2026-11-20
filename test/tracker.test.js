'use strict';
// A ClickUp "points tracker" list, shaped like LeadG2's "2026 Service Point Tracking (900 Points)".
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const admin = require('../src/admin');
const auth = require('../src/auth');
const ingest = require('../src/ingest');
const review = require('../src/review');
const importer = require('../src/importer');
const ledger = require('../src/ledger');

const STATUS = { type: 'drop_down', name: 'Service Point Status', type_config: { options: [
  { id: 'opt-c', name: 'Completed', orderindex: 4 }, { id: 'opt-i', name: 'In Progress', orderindex: 2 }, { id: 'opt-p', name: 'Planned', orderindex: 1 }] } };
const DEPT = { type: 'drop_down', name: 'Department', type_config: { options: [{ id: 'd-m', name: 'Questco Marketing', orderindex: 0 }] } };
const task = (id, name, parent, fields = {}) => ({
  id, name, parent, url: `https://app.clickup.com/t/${id}`, status: { status: 'planned' }, list: { id: '900900' }, space: { id: 'S1' },
  date_created: '1782957139931', date_updated: String(Date.parse('2026-11-25T12:00:00Z')),
  custom_fields: [
    fields.status && { ...STATUS, value: fields.status }, fields.total != null && { name: 'Total Points', type: 'number', value: String(fields.total) },
    fields.pv != null && { name: 'Point Value', type: 'number', value: String(fields.pv) }, fields.hm != null && { name: 'How Many', type: 'number', value: String(fields.hm) },
    fields.dept && { ...DEPT, value: fields.dept }].filter(Boolean),
});

function setup() {
  const db = openDb(':memory:');
  auth.createUser(db, { email: 'me@leadg2.example', name: 'Me', role: 'staff', password: 'x-password-1' });
  const menu = admin.createMenuFromTemplate(db, { template: 'leadg2-2026', actor: 't' });
  const c = admin.createClient(db, { name: 'Questco', termStart: '2026-04-01', termEnd: '2027-03-31', menuVersionId: menu.id,
    agreementRef: 'Questco 2026 agreement (900 points)', basePoints: 900, openingDate: '2026-11-20', openingUsed: 14, openingCommitted: 16, actor: 't' });
  admin.addMapping(db, { clientId: c.id, sourceType: 'clickup_list', value: '900900', scope: 'points', actor: 't' });
  return { db, clientId: c.id };
}

test('reads tracker fields: Service Point Status, Total Points, and ignores month headings', async () => {
  const { db, clientId } = setup();
  const tasks = [
    task('m-aug', 'August 2026', null),
    task('t1', 'download pdf + website page', 'm-aug', { status: 'opt-c', total: 14, pv: 7, hm: 2, dept: 'd-m' }),
    task('t2', 'Lead Scoring + Intent Signals', 'm-sep', { status: 'opt-i', total: 16, pv: 2, hm: 1 }),
    task('t3', 'December Blogs', 'm-dec', { status: 'opt-p', total: 10, pv: 5, hm: 2 }),
  ];
  const adapter = { mode: 'live', fetchTasks: async () => tasks };
  const r = await ingest.syncSource(db, { clientId, source: 'clickup', adapter });
  assert.equal(r.status, 'success');
  const sugg = review.listSuggestions(db, clientId, 'open');
  const by = Object.fromEntries(sugg.map((s) => [s.title, s]));
  assert.equal(by['August 2026'], undefined, 'month heading is not a deliverable');
  assert.equal(sugg.filter((s) => s.title === 'download pdf + website page').length, 1, 'child is its own item, not rolled into the month');
  assert.deepEqual([by['download pdf + website page'].action, by['download pdf + website page'].proposed_points], ['complete', 14]);
  assert.deepEqual([by['Lead Scoring + Intent Signals'].action, by['Lead Scoring + Intent Signals'].proposed_points], ['approve', 16]);
  assert.ok(by['Lead Scoring + Intent Signals'].flags.includes('sources_disagree'), '2 x 1 is not 16');
  assert.deepEqual([by['December Blogs'].action, by['December Blogs'].proposed_points], ['forecast', 10]);
  assert.ok(!by['download pdf + website page'].flags.includes('point_cost_unclear'));
  // Approve without a menu item: the tracker's number is the agreed amount.
  const before = ledger.balance(db, clientId).used;
  review.approveSuggestion(db, { id: by['download pdf + website page'].id, actor: 't' });
  assert.equal(ledger.balance(db, clientId).used, before + 14);
});

test('opening balance from the tracker (used, committed and planned rows); later status changes become suggestions', async () => {
  const { db, clientId } = setup();
  const csv = [
    'tracker_id,date,title,client_summary,menu_code,points,status,clickup_task_id',
    'CU-t1,2026-08-01,download pdf + website page,Survey download PDF and web page,,14,used,t1',
    'CU-t2,2026-09-01,Lead Scoring + Intent Signals,Lead scoring and intent signals,,16,committed,t2',
    'CU-t3,2026-12-01,December Blogs,December blogs,,10,forecast,t3',
  ].join('\n');
  importer.importTracker(db, { clientId, csv, actor: 't', opening: true });
  const b = ledger.balance(db, clientId);
  assert.deepEqual([b.allocated, b.used, b.committed, b.available, b.forecast], [900, 14, 16, 870, 10]);

  // In ClickUp, December Blogs is now Completed and Lead Scoring too.
  const tasks = [
    task('t1', 'download pdf + website page', 'm-aug', { status: 'opt-c', total: 14, pv: 7, hm: 2 }),
    task('t2', 'Lead Scoring + Intent Signals', 'm-sep', { status: 'opt-c', total: 16, pv: 16, hm: 1 }),
    task('t3', 'December Blogs', 'm-dec', { status: 'opt-c', total: 10, pv: 5, hm: 2 }),
  ];
  await ingest.syncSource(db, { clientId, source: 'clickup', adapter: { mode: 'live', fetchTasks: async () => tasks } });
  const sugg = review.listSuggestions(db, clientId, 'open');
  assert.equal(sugg.find((s) => s.title === 'download pdf + website page'), undefined, 'already used: nothing to do');
  const lead = sugg.find((s) => s.title === 'Lead Scoring + Intent Signals');
  const dec = sugg.find((s) => s.title === 'December Blogs');
  assert.deepEqual([lead.action, lead.proposed_points], ['complete', 16]);
  assert.deepEqual([dec.action, dec.proposed_points], ['complete', 10]);
  review.approveSuggestion(db, { id: lead.id, actor: 't' });
  review.approveSuggestion(db, { id: dec.id, actor: 't' });
  const after = ledger.balance(db, clientId);
  assert.deepEqual([after.used, after.committed, after.available, after.forecast], [40, 0, 860, 0]);
});

test('"Import tracker history" loads the whole ClickUp tracker once; re-running adds nothing; no review noise', async () => {
  const db = openDb(':memory:');
  const menu = admin.createMenuFromTemplate(db, { template: 'leadg2-2026', actor: 't' });
  const c = admin.createClient(db, { name: 'Questco', termStart: '2026-04-01', termEnd: '2027-03-31', menuVersionId: menu.id, agreementRef: 'x', basePoints: 900, actor: 't' });
  admin.addMapping(db, { clientId: c.id, sourceType: 'clickup_list', value: '900900', scope: 'points', actor: 't' });
  const old = (t) => ({ ...t, date_updated: String(Date.parse('2026-05-01T00:00:00Z')) });
  const tasks = [
    old(task('m-may', 'May 2026', null)),
    old(task('a1', 'May Blogs', 'm-may', { status: 'opt-c', total: 10, pv: 5, hm: 2 })),
    old(task('a2', 'Lead Scoring', 'm-sep', { status: 'opt-i', total: 16, pv: 2, hm: 1 })),
    old(task('a3', 'December Blogs', 'm-dec', { status: 'opt-p', total: 10, pv: 5, hm: 2 })),
  ];
  const adapter = { mode: 'live', fetchTasks: async ({ since }) => { assert.equal(since, null); return tasks; } };
  // A "successful" sample-mode run earlier must not shrink the window of the first live sync.
  db.prepare(`INSERT INTO sync_runs (client_id, source, mode, started_at, finished_at, status) VALUES (?, 'clickup', 'sample', ?, ?, 'success')`).run(c.id, new Date().toISOString(), new Date().toISOString());
  assert.equal(ingest.syncStatus(db, c.id).clickup.last_success_at != null, true);
  const r = await ingest.importTrackerFromClickUp(db, { clientId: c.id, adapter, actor: 't' });
  assert.deepEqual([r.found, r.created, r.skipped], [3, 3, 0]);
  const b = ledger.balance(db, c.id);
  assert.deepEqual([b.used, b.committed, b.available, b.forecast], [10, 16, 874, 10]);
  assert.equal(review.listSuggestions(db, c.id, 'open').length, 0, 'nothing to review: the ledger matches ClickUp');
  const again = await ingest.importTrackerFromClickUp(db, { clientId: c.id, adapter, actor: 't' });
  assert.deepEqual([again.created, again.skipped], [0, 3]);
});

test('the first live sync ignores earlier sample-data runs when choosing what to fetch', async () => {
  const { db, clientId } = setup();
  db.prepare(`INSERT INTO sync_runs (client_id, source, mode, started_at, finished_at, status) VALUES (?, 'clickup', 'sample', ?, ?, 'success')`).run(clientId, new Date().toISOString(), new Date().toISOString());
  let asked;
  await ingest.syncSource(db, { clientId, source: 'clickup', adapter: { mode: 'live', fetchTasks: async ({ since }) => { asked = since; return []; } } });
  assert.equal(asked, '2026-11-20T00:00:00.000Z', 'falls back to the opening-balance date, not the sample run');
});

test('changing Delivery Month or Department in ClickUp moves the item on the next sync, without review', async () => {
  const db = openDb(':memory:');
  const menu = admin.createMenuFromTemplate(db, { template: 'leadg2-2026', actor: 't' });
  const c = admin.createClient(db, { name: 'Questco', termStart: '2026-04-01', termEnd: '2027-03-31', menuVersionId: menu.id, agreementRef: 'x', basePoints: 900, actor: 't' });
  admin.addMapping(db, { clientId: c.id, sourceType: 'clickup_list', value: '900900', scope: 'points', actor: 't' });
  const month = (iso) => ({ name: '📆 Delivery Month', type: 'date', value: String(Date.parse(iso)) });
  const placeholder = (when, dept) => {
    const t = task('ph', 'New Website/CRC Promotion Placeholder', 'm-dec', { status: 'opt-p', total: 50, pv: 50, hm: 1, dept });
    t.custom_fields.push(month(when)); return t;
  };
  let tasks = [placeholder('2026-08-01T00:00:00Z', 'd-m')];
  const adapter = { mode: 'live', fetchTasks: async () => tasks };
  await ingest.importTrackerFromClickUp(db, { clientId: c.id, adapter, actor: 't' });
  const item = () => db.prepare(`SELECT work_date, category, state, points FROM work_items WHERE external_ref = 'tracker:CU-ph'`).get();
  assert.equal(item().work_date.slice(0, 7), '2026-08');

  tasks = [placeholder('2026-12-01T00:00:00Z', 'd-m')];
  tasks[0].date_updated = String(Date.now());
  const r = await ingest.syncSource(db, { clientId: c.id, source: 'clickup', adapter });
  assert.equal(r.rescheduled, 1);
  assert.deepEqual([item().work_date.slice(0, 7), item().state, item().points], ['2026-12', 'forecast', 50], 'moved to December; stage and points untouched');
  assert.equal(review.listSuggestions(db, c.id, 'open').length, 0, 'nothing to review');
  assert.ok(db.prepare(`SELECT 1 FROM audit_log WHERE action = 'work_item.tracker_update'`).get(), 'logged');
});

test('moving a task under a different month heading in ClickUp moves it in the app (heading beats the date field)', async () => {
  const db = openDb(':memory:');
  const menu = admin.createMenuFromTemplate(db, { template: 'leadg2-2026', actor: 't' });
  const c = admin.createClient(db, { name: 'Questco', termStart: '2026-04-01', termEnd: '2027-03-31', menuVersionId: menu.id, agreementRef: 'x', basePoints: 900, actor: 't' });
  admin.addMapping(db, { clientId: c.id, sourceType: 'clickup_list', value: '900900', scope: 'points', actor: 't' });
  const aug = task('m-aug', 'August 2026', null); const feb = task('m-feb', 'February 2027', null);
  const ph = (parent) => { const t = task('ph', 'New Website/CRC Promotion Placeholder', parent, { status: 'opt-p', total: 50, pv: 50, hm: 1 });
    t.custom_fields.push({ name: '📆 Delivery Month', type: 'date', value: String(Date.parse('2026-08-01T00:00:00Z')) }); return t; };
  let tasks = [aug, feb, ph('m-aug')];
  const adapter = { mode: 'live', fetchTasks: async () => tasks };
  await ingest.importTrackerFromClickUp(db, { clientId: c.id, adapter, actor: 't' });
  const month = () => db.prepare(`SELECT substr(work_date, 1, 7) m FROM work_items WHERE external_ref = 'tracker:CU-ph'`).get().m;
  assert.equal(month(), '2026-08');
  tasks = [aug, feb, { ...ph('m-feb'), date_updated: String(Date.now()) }]; // moved under February; date field unchanged
  const r = await ingest.syncSource(db, { clientId: c.id, source: 'clickup', adapter });
  assert.equal(r.rescheduled, 1);
  assert.equal(month(), '2027-02');
});

test('an incremental sync that does not return the month heading still moves the task (heading fetched directly)', async () => {
  const db = openDb(':memory:');
  const menu = admin.createMenuFromTemplate(db, { template: 'leadg2-2026', actor: 't' });
  const c = admin.createClient(db, { name: 'Questco', termStart: '2026-04-01', termEnd: '2027-03-31', menuVersionId: menu.id, agreementRef: 'x', basePoints: 900,
    openingDate: '2026-11-19', openingUsed: 0, openingCommitted: 0, actor: 't' });
  admin.addMapping(db, { clientId: c.id, sourceType: 'clickup_list', value: '900900', scope: 'points', actor: 't' });
  const old = (x) => ({ ...x, date_updated: String(Date.parse('2026-06-01T00:00:00Z')) }); // headings untouched since June
  const aug = old(task('m-aug', 'August 2026', null)); const feb = old(task('m-feb', 'February 2027', null));
  const ph = (parent, updated) => { const t = task('ph', 'New Website/CRC Promotion Placeholder', parent, { status: 'opt-p', total: 50, pv: 50, hm: 1 });
    t.custom_fields.push({ name: '📆 Delivery Month', type: 'date', value: String(Date.parse('2026-08-01T00:00:00Z')) }); t.date_updated = String(updated); return t; };
  // Imported via the tracker CSV (as Questco was), then ClickUp syncs only return changed tasks.
  importer.importTracker(db, { clientId: c.id, csv: 'tracker_id,date,title,client_summary,menu_code,points,status,clickup_task_id\nCU-ph,2026-08-01,Placeholder,,,50,forecast,ph\n', actor: 't' });
  let fetchedById = [];
  const adapter = { mode: 'live',
    fetchTasks: async () => [ph('m-feb', Date.now())], // only the moved task changed
    fetchTaskById: async (id) => { fetchedById.push(id); return { 'm-feb': feb, 'm-aug': aug }[id]; } };
  const r = await ingest.syncSource(db, { clientId: c.id, source: 'clickup', adapter });
  assert.deepEqual(fetchedById, ['m-feb']);
  assert.equal(r.rescheduled, 1);
  assert.equal(db.prepare(`SELECT substr(work_date,1,7) m FROM work_items WHERE external_ref = 'tracker:CU-ph'`).get().m, '2027-02');
  // Next sync: heading already known, no extra lookup.
  fetchedById = [];
  await ingest.syncSource(db, { clientId: c.id, source: 'clickup', adapter });
  assert.deepEqual(fetchedById, []);
});
