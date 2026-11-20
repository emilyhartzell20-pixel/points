'use strict';
// Hours trackers like Morgan Murphy's "2026 Call & Training Tracking (Contract vs Delivered)".
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const admin = require('../src/admin');
const ingest = require('../src/ingest');
const { clientDashboard } = require('../src/clientView');

const H = 3600e3;
const day = (d) => String(Date.parse(`${d}T17:00:00Z`));
const call = (id, name, hours, date, pool, parent = 'jul') => ({ id, name, parent, time_estimate: hours * H, start_date: day(date),
  text_content: `Date: ${date}\nDuration: ${hours} hours\nCategory: Call\nContract pool: ${pool}\nSource: sheet` });
const tasks = [
  { id: 'rec', name: 'RECONCILIATION NEEDED | Contract totals vs individual log', time_estimate: null },
  { id: 'a1', name: 'CONTRACT ALLOCATION | Dedicated office hours: 15 hrs / 4.5 hrs reported / 10.5 hrs arithmetic remaining', text_content: 'Unit: hours\nContracted: 15\nRemaining: 10.5' },
  { id: 'a2', name: 'CONTRACT ALLOCATION | Group training: 15 hrs / 8 hrs delivered / 7 hrs remaining', text_content: 'Unit: hours\nContracted: 15' },
  { id: 'a3', name: 'CONTRACT ALLOCATION | Virtual rollout: 13 contracted / 13 reported / 0 remaining', text_content: 'Unit: hours\nContracted: 13' },
  { id: 'jul', name: 'July 2026 | 3 calls | 4.75 hrs', time_estimate: 0 },
  call('c1', '07-08 | LeadG2 x MM HubSpot Live Office Hours', 2, '2026-07-08', 'Dedicated office hours'),
  call('c2', '07-22 | WideOrbit Data Requirements for Future Billing', 1.5, '2026-07-22', 'Virtual rollout sessions'),
  call('c3', '07-30 | Planning meeting - HubSpot Sales Tools adoption plan', 0.75, '2026-07-30', 'Group training'),
  call('o1', '07-15 | HubSpot Touchbase: MM x LeadG2', 1, '2026-07-15', 'Other project/support activity'),
];
const lists = { 1600480000007174: tasks };
const adapter = {
  mode: 'live',
  fetchTasks: async ({ mappings }) => lists[mappings[0].value] || [],
  listHierarchy: async () => [{ workspace: 'W', space: { id: '77', name: 'Morgan Murphy' }, lists: [
    { id: '1600480000007174', name: '2026 Call & Training Tracking (Contract vs Delivered)' }, { id: '901713887356', name: 'Morgan Murphy Feedback Form' }] }],
};

test('reads calls, contracted hours and pools; skips month summaries and notes', () => {
  const r = ingest.readHoursTracker(tasks, { year: '2026' });
  assert.equal(r.contracted, 43);
  assert.deepEqual(r.entries.map((e) => [e.title, e.hours, e.date, e.pool, e.counted]), [
    ['LeadG2 x MM HubSpot Live Office Hours', 2, '2026-07-08', 'Dedicated office hours', true],
    ['WideOrbit Data Requirements for Future Billing', 1.5, '2026-07-22', 'Virtual rollout', true],
    ['Planning meeting - HubSpot Sales Tools adoption plan', 0.75, '2026-07-30', 'Group training', true],
    ['HubSpot Touchbase: MM x LeadG2', 1, '2026-07-15', 'Other project/support activity', false],
  ]);
});

test('the ClickUp scan finds the hours tracker and sets up an hours client from it', async () => {
  const db = openDb(':memory:');
  admin.createMenuFromTemplate(db, { template: 'leadg2-2026', actor: 't' });
  const found = await ingest.findTrackers(db, adapter);
  assert.deepEqual(found.map((f) => [f.list_name, f.kind]), [['2026 Call & Training Tracking (Contract vs Delivered)', 'hours']]);
  const [r] = await ingest.importTrackers(db, { adapter, actor: 't', items: [{ listId: '1600480000007174', listName: found[0].list_name, name: 'Morgan Murphy', kind: 'hours' }] });
  assert.equal(r.error, undefined, r.error);
  assert.equal(r.unit, 'hours');
  assert.match(r.warning, /1 calls \(1 h\) in Other project\/support activity aren't in a contracted pool/);
  assert.deepEqual([r.balance.allocated, r.balance.used, r.balance.available], [43, 4.25, 38.75]);
  const v = clientDashboard(db, r.clientId);
  assert.equal(v.unit, 'hours');
  assert.deepEqual(v.by_month.types.map((t) => t.name).sort(), ['Dedicated office hours', 'Group training', 'Virtual rollout']);

  // Running again adds nothing; a new call logged in ClickUp is picked up on the next refresh.
  const again = await ingest.importTrackerFromClickUp(db, { clientId: r.clientId, adapter, actor: 't' });
  assert.equal(again.created, 0);
  tasks.push(call('c4', '11-10 | Madison: Morgan Murphy HubSpot Training', 1, '2026-11-10', 'Group training', 'nov'));
  await ingest.refreshHoursTrackers(db, adapter, { error: () => {} });
  assert.equal(clientDashboard(db, r.clientId).balance.used, 5.25);
  assert.equal((await ingest.findTrackers(db, adapter))[0].status, 'linked');
});

test('an hours tracker will not merge into a points client by accident', async () => {
  const db = openDb(':memory:');
  const m = admin.createMenuFromTemplate(db, { template: 'leadg2-2026', actor: 't' });
  admin.createClient(db, { name: 'Morgan Murphy', termStart: '2026-01-01', termEnd: '2026-12-31', menuVersionId: m.id, agreementRef: 'x', basePoints: 100, actor: 't' });
  const [r] = await ingest.importTrackers(db, { adapter, actor: 't', items: [{ listId: '1600480000007174', name: 'Morgan Murphy', kind: 'hours' }] });
  assert.match(r.error, /set up for points/);
});
