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
    'tracker_id,date,title,client_summary,menu_code,points,status,clickup_task_id,notes',
    'CU-a,2026-08-01,download pdf + website page,Survey PDF and web page,,14,used,a,Questco Marketing; 7 pts x 2',
    'CU-b,2026-08-01,Internal promo playbook,,,6,used,b,Sales; 3 pts x 2',
    'CU-c,2026-09-01,Lead Scoring,Lead scoring and intent signals,,16,committed,c,Questco Marketing; 2 pts x 1',
    'CU-d,2026-12-01,December Blogs,December blogs,,10,forecast,d,Questco Marketing; 5 pts x 2',
    'CU-e,2026-12-01,PEO Pulse,PEO Pulse newsletter,,4,forecast,e,Client Communications; 4 pts x 1',
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
