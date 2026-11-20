'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const admin = require('../src/admin');
const importer = require('../src/importer');
const ledger = require('../src/ledger');
const { byMonth } = require('../src/months');
const { clientDashboard } = require('../src/clientView');

function questcoLike() {
  const db = openDb(':memory:');
  const m = admin.createMenuFromTemplate(db, { template: 'leadg2-2026', actor: 't' });
  const c = admin.createClient(db, { name: 'Questco', termStart: '2026-04-01', termEnd: '2027-03-31', menuVersionId: m.id, agreementRef: 'x', basePoints: 900, actor: 't' });
  const csv = [
    'tracker_id,date,title,client_summary,menu_code,points,status,clickup_task_id,notes,category',
    'CU-a,2026-08-01,download pdf + website page,Survey PDF and web page,,14,used,a,7 pts x 2,Questco Marketing',
    'CU-b,2026-08-01,Internal promo playbook,,,6,used,b,3 pts x 2,Sales',
    'CU-c,2026-09-01,Lead Scoring,Lead scoring and intent signals,,16,committed,c,2 pts x 1,Questco Marketing',
    'CU-d,2026-12-01,December Blogs,December blogs,,10,forecast,d,5 pts x 2,Questco Marketing',
    'CU-e,2026-12-01,PEO Pulse,PEO Pulse newsletter,,4,forecast,e,4 pts x 1,Client Communications',
  ].join('\n');
  importer.importTracker(db, { clientId: c.id, csv, actor: 't' });
  return { db, clientId: c.id };
}

test('groups work by month across the whole contract term, with types from the tracker Department', () => {
  const { db, clientId } = questcoLike();
  const d = byMonth(db, clientId);
  assert.equal(d.months.length, 12, 'April 2026 through March 2027');
  assert.equal(d.months[0].label, 'April 2026');
  assert.deepEqual(d.types.map((t) => [t.name, t.slot]), [['Client Communications', 1], ['Questco Marketing', 2], ['Sales', 3]], 'fixed alphabetical slots');
  const aug = d.months.find((m) => m.key === '2026-08');
  assert.deepEqual([aug.used, aug.committed, aug.planned, aug.items.length], [20, 0, 0, 2]);
  const dec = d.months.find((m) => m.key === '2026-12');
  assert.deepEqual([dec.planned, dec.items.map((i) => i.stage)], [14, ['planned', 'planned']]);
  assert.equal(ledger.balance(db, clientId).available_after_planned, 900 - 20 - 16 - 14);
});

test('client dashboard shows months with approved descriptions only; planned can be switched off', () => {
  const { db, clientId } = questcoLike();
  let v = clientDashboard(db, clientId);
  assert.deepEqual(v.planned, { points: 14, available_after: 850 }, 'planned shown by default');
  const aug = v.by_month.months.find((m) => m.key === '2026-08');
  assert.deepEqual(aug.items.map((i) => i.description), ['Survey PDF and web page']);
  assert.equal(aug.other_points, 6, 'item without a client summary is counted but not described');
  const text = JSON.stringify(v.by_month);
  assert.doesNotMatch(text, /download pdf|Internal promo|7 pts x 2|"id"|title/, 'no internal titles, notes or ids');
  db.prepare('UPDATE clients SET show_planned = 0 WHERE id = ?').run(clientId);
  v = clientDashboard(db, clientId);
  assert.equal(v.planned, null);
  assert.equal(v.by_month.months.find((m) => m.key === '2026-12').items.length, 0, 'planned items hidden');
  assert.deepEqual(v.balance, { allocated: 900, used: 20, committed: 16, available: 864 }, 'the four numbers never include planned');
});

test('looking ahead runs to the end of a contract that ends next year, with what remains after each month', () => {
  const db = openDb(':memory:');
  const m = admin.createMenuFromTemplate(db, { template: 'leadg2-2026', actor: 't' });
  const c = admin.createClient(db, { name: 'MrSteam', termStart: '2026-06-01', termEnd: '2027-05-31', menuVersionId: m.id, agreementRef: 'x', basePoints: 100, actor: 't' });
  const csv = ['tracker_id,date,title,client_summary,menu_code,points,status',
    'a,2026-10-01,Done,Done,,20,used', 'b,2026-12-01,Approved,Approved,,10,committed',
    'c,2027-02-01,Feb plan,Feb plan,,30,forecast', 'd,2027-05-01,May plan,May plan,,25,forecast', 'e,2027-07-01,After term,After term,,30,forecast'].join('\n');
  importer.importTracker(db, { clientId: c.id, csv, actor: 't' });
  const o = byMonth(db, c.id, { today: '2026-11-20' }).look_ahead;
  assert.deepEqual([o.from, o.months_left, o.available_now], ['2026-11', 7, 70]);
  const row = (k) => o.months.find((x) => x.key === k);
  assert.deepEqual([row('2026-12').committed, row('2026-12').remaining_after], [10, 70], 'approved is already reserved');
  assert.equal(row('2027-02').remaining_after, 40);
  assert.equal(row('2027-05').remaining_after, 15, 'May of next year is included');
  assert.deepEqual([row('2027-07').after_term, row('2027-07').remaining_after], [true, -15], 'work scheduled after the contract still shows, and the overrun is visible');
  assert.equal(o.remaining_at_end, -15);
  // Client with planned work hidden: no projection from planned items.
  const hidden = byMonth(db, c.id, { today: '2026-11-20', forClient: true, includePlanned: false }).look_ahead;
  assert.equal(hidden.remaining_at_end, 70);
});

test('internal menu notes and import notes never become a type the client can see', () => {
  const db = openDb(':memory:');
  const v = admin.createMenuVersion(db, { code: 'X', effectiveDate: '2026-01-01', actor: 't' });
  admin.saveMenuItem(db, { versionId: v.id, code: 'WF', name: 'Workflow', pointsMin: 8, pointsMax: 15, notes: 'Scale by branches; confirm with consultant.', actor: 't' });
  const c = admin.createClient(db, { name: 'C', termStart: '2026-01-01', termEnd: '2026-12-31', menuVersionId: v.id, agreementRef: 'x', basePoints: 100, actor: 't' });
  importer.importTracker(db, { clientId: c.id, csv: 'tracker_id,date,title,client_summary,menu_code,points,status,notes\na,2026-03-01,Workflow,Built a workflow,WF,10,used,legacy item\n', actor: 't' });
  const text = JSON.stringify(clientDashboard(db, c.id));
  assert.doesNotMatch(text, /confirm with consultant|legacy item/);
  assert.deepEqual(byMonth(db, c.id).types.map((t) => t.name), ['Other']);
});
