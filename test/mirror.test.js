'use strict';
// ClickUp is the source of truth: the app mirrors each tracker with no review step.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const admin = require('../src/admin');
const ingest = require('../src/ingest');
const ledger = require('../src/ledger');
const { syncEverything } = require('../src/scheduler');

const STATUS = { type: 'drop_down', name: 'Service Point Status', type_config: { options: [
  { id: 'C', name: 'Completed', orderindex: 4 }, { id: 'I', name: 'In Progress', orderindex: 2 }, { id: 'P', name: 'Planned', orderindex: 1 }] } };
const task = (id, name, parent, status, total) => ({ id, name, parent, url: `https://app.clickup.com/t/${id}`, status: { status: 'to do' },
  list: { id: '900900' }, space: { id: 'S1' }, date_created: '1782957139931', date_updated: String(Date.now()),
  custom_fields: status ? [{ ...STATUS, value: status }, { name: 'Total Points', type: 'number', value: String(total) }] : [] });

function setup() {
  const db = openDb(':memory:');
  const menu = admin.createMenuFromTemplate(db, { template: 'leadg2-2026', actor: 't' });
  const c = admin.createClient(db, { name: 'Questco', termStart: '2026-04-01', termEnd: '2027-03-31', menuVersionId: menu.id, agreementRef: 'x', basePoints: 100, actor: 't' });
  admin.addMapping(db, { clientId: c.id, sourceType: 'clickup_list', value: '900900', scope: 'points', actor: 't' });
  const tasks = [task('aug', 'August 2026'), task('dec', 'December 2026'),
    task('t1', 'Website page', 'aug', 'C', 14), task('t2', 'Lead scoring', 'aug', 'I', 16), task('t3', 'December blogs', 'dec', 'P', 10)];
  return { db, clientId: c.id, tasks, adapter: { mode: 'live', fetchTasks: async () => tasks } };
}
const bal = (db, id) => { const b = ledger.balance(db, id); return [b.used, b.committed, b.forecast, b.available]; };
const items = (db, id) => db.prepare("SELECT title, state, points, work_date FROM work_items WHERE client_id = ? ORDER BY title").all(id).map((w) => ({ ...w }));

test('first read puts everything on the ledger straight away; no suggestions, nothing to approve', async () => {
  const { db, clientId, adapter } = setup();
  const r = await ingest.importTrackerFromClickUp(db, { clientId, adapter });
  assert.deepEqual([r.created, r.updated, r.removed], [3, 0, 0]);
  assert.deepEqual(bal(db, clientId), [14, 16, 10, 70]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM suggestions').get().n, 0);
  const again = await ingest.importTrackerFromClickUp(db, { clientId, adapter });
  assert.deepEqual([again.created, again.updated, again.removed], [0, 0, 0], 'reading again changes nothing');
});

test('any change in ClickUp is mirrored: completed, moved back, points, month, deleted, canceled', async () => {
  const { db, clientId, adapter, tasks } = setup();
  await ingest.importTrackerFromClickUp(db, { clientId, adapter });
  const t = (id) => tasks.find((x) => x.id === id);
  const setStatus = (id, v) => { t(id).custom_fields[0].value = v; };

  setStatus('t2', 'C');                                   // In Progress → Completed
  setStatus('t3', 'I');                                   // Planned → In Progress
  await ingest.importTrackerFromClickUp(db, { clientId, adapter });
  assert.deepEqual(bal(db, clientId), [30, 10, 0, 60]);

  setStatus('t1', 'I');                                   // Completed → back to In Progress (a mistake fixed in ClickUp)
  t('t3').custom_fields[1].value = '12';                  // points changed
  t('t3').parent = 'aug';                                 // moved to August
  await ingest.importTrackerFromClickUp(db, { clientId, adapter });
  assert.deepEqual(bal(db, clientId), [16, 26, 0, 58]);
  assert.equal(items(db, clientId).find((w) => w.title === 'December blogs').work_date, '2026-08-01');

  tasks.splice(tasks.indexOf(t('t2')), 1);               // deleted from the tracker
  const r = await ingest.importTrackerFromClickUp(db, { clientId, adapter });
  assert.equal(r.removed, 1);
  assert.deepEqual(bal(db, clientId), [0, 26, 0, 74]);
  assert.equal(items(db, clientId).find((w) => w.title === 'Lead scoring').state, 'canceled');

  tasks.push(task('t2', 'Lead scoring', 'aug', 'C', 16)); // put back
  await ingest.importTrackerFromClickUp(db, { clientId, adapter });
  assert.deepEqual(bal(db, clientId), [16, 26, 0, 58]);

  // Every change is in the audit log as the ClickUp sync, and the ledger adds up to the work items.
  assert.ok(db.prepare(`SELECT COUNT(*) n FROM audit_log WHERE action = 'work_item.mirror' AND actor = 'clickup-sync'`).get().n >= 5);
  const sums = db.prepare(`SELECT w.state, w.points, COALESCE(SUM(e.committed_delta),0) c, COALESCE(SUM(e.used_delta),0) u
    FROM work_items w LEFT JOIN ledger_events e ON e.work_item_id = w.id WHERE w.client_id = ? GROUP BY w.id`).all(clientId);
  for (const x of sums) assert.deepEqual([x.c, x.u], [x.state === 'committed' ? x.points : 0, x.state === 'used' ? x.points : 0]);
});

test('an empty answer from ClickUp never wipes a client', async () => {
  const { db, clientId, adapter, tasks } = setup();
  await ingest.importTrackerFromClickUp(db, { clientId, adapter });
  tasks.length = 0;
  await ingest.importTrackerFromClickUp(db, { clientId, adapter, allowEmpty: true });
  assert.deepEqual(bal(db, clientId), [14, 16, 10, 70]);
});

test('the scheduled sync mirrors every tracker client', async () => {
  const { db, clientId, adapter } = setup();
  await syncEverything(db, { clickup: adapter }, { error() {}, log() {} });
  assert.deepEqual(bal(db, clientId), [14, 16, 10, 70]);
});

test('Questco\'s Service Point Status options: anything past Planned counts, and the client sees the phase', async () => {
  const { db, clientId, tasks, adapter } = setup();
  const opts = ['Ongoing', 'Planned', 'In Progress', 'Client Review', 'Completed', 'Blocked'].map((name, i) => ({ id: `o${i}`, name, orderindex: i }));
  const field = { type: 'drop_down', name: 'Service Point Status', type_config: { options: opts } };
  const mk = (id, name, opt) => ({ ...task(id, name, 'aug', 'P', 5), custom_fields: [{ ...field, value: opt }, { name: 'Total Points', type: 'number', value: '5' }] });
  tasks.splice(0, tasks.length, task('aug', 'August 2026'),
    mk('a', 'Social posts', 'o0'), mk('b', 'Blog', 'o1'), mk('c', 'Landing page', 'o2'), mk('d', 'Email', 'o3'), mk('e', 'Webinar', 'o4'), mk('f', 'Survey', 'o5'),
    { ...task('g', 'Not set yet', 'aug', 'P', 5), status: { status: 'in progress' }, custom_fields: [{ ...field }, { name: 'Total Points', type: 'number', value: '5' }] });
  assert.deepEqual(['Ongoing', 'Planned', 'In Progress', 'Client Review', 'Completed', 'Blocked', '', 'Canceled'].map(ingest.trackerStage),
    ['committed', 'forecast', 'committed', 'committed', 'used', 'committed', 'forecast', 'canceled']);
  await ingest.importTrackerFromClickUp(db, { clientId, adapter });
  assert.deepEqual(bal(db, clientId), [5, 20, 10, 75], 'blank status = planned, even if the task itself is "in progress"');
  const v = require('../src/clientView').clientDashboard(db, clientId);
  const aug = v.by_month.months.find((m) => m.key === '2026-08');
  const label = Object.fromEntries(aug.items.map((i) => [i.description, i.phase || i.stage]));
  assert.deepEqual(label, { 'Social posts': 'Ongoing', Blog: 'planned', 'Landing page': 'In progress', Email: 'Ready for your review',
    Webinar: 'used', Survey: 'On hold', 'Not set yet': 'planned' });
});
