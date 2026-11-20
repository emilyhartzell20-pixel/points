'use strict';
// "Find clients in ClickUp": discovery of tracker lists across spaces, and one-step setup.
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDb } = require('../src/db');
const admin = require('../src/admin');
const ingest = require('../src/ingest');
const review = require('../src/review');
const ledger = require('../src/ledger');

test('reads the allocation from real tracker list names', () => {
  const cases = {
    '2026 Service Point Tracking (900 Points)': 900, 'MrSteam Point Tracker 2026 (740 Points)': 740,
    'Federated Media Client Point Tracker 2026 (#57 Points)': 57, '25-26 Service Point Tracking (710 points)': 710,
    '[SPO] 2026 Service Point Tracking (335 Points)(295+40)': 335, 'Allevity 2026 (400 pts) Service Point Tracking': 400,
    'Digonex Client Point Tracker 2026 30 Points': 30, 'Hodges/Hi-Tech Home (20) Service Point Tracking': 20,
    'EmployerFlexible (83/300) Service Point Tracking': 300, 'Lone Star Service Point Tracking': null,
  };
  for (const [name, n] of Object.entries(cases)) assert.equal(ingest.parseAllocation(name), n, name);
});

const STATUS = { name: 'Service Point Status', type: 'drop_down', type_config: { options: [{ id: 'c', name: 'Completed', orderindex: 4 }, { id: 'p', name: 'Planned', orderindex: 1 }, { id: 'i', name: 'In Progress', orderindex: 2 }] } };
const TYPE = { name: '🗂️ Deliverable Type', type: 'drop_down', type_config: { options: [{ id: 'cc', name: 'Content Creation', orderindex: 2 }] } };
const t = (id, name, parent, list, f = {}) => ({ id, name, parent, list: { id: list }, space: { id: 's' }, status: { status: f.raw || 'to do' },
  date_created: '1767225600000', date_updated: '1767225600000', url: `https://app.clickup.com/t/${id}`,
  custom_fields: [f.st && { ...STATUS, value: f.st }, f.pts != null && { name: 'Total Points', type: 'number', value: String(f.pts) },
    f.type && { ...TYPE, value: 'cc' }, f.month && { name: 'Point Delivery Month', type: 'drop_down', type_config: { options: [{ id: 'm', name: f.month, orderindex: 0 }] }, value: 'm' }].filter(Boolean) });

function fakeClickUp() {
  const lists = {
    '1001': [t('h1', 'January 2026', null, '1001'), t('h2', 'December 2026', null, '1001'),
      t('a', 'April Blog Posts', 'h1', '1001', { st: 'c', pts: 10, type: true }),
      t('a1', 'Write copy', 'a', '1001', { raw: 'done' }),
      t('b', 'New LP templates', 'h2', '1001', { st: 'i', pts: 8 })],
    '1002': [t('x', 'September Newsletter', null, '1002', { st: 'p', pts: 4, month: 'September' })],
  };
  return {
    mode: 'live',
    listHierarchy: async () => [
      { workspace: 'W', space: { id: 's1', name: 'MrSteam' }, lists: [{ id: '1001', name: 'MrSteam Point Tracker 2026 (740 Points)', folder: '[MRSTEAM] Execution' }, { id: '1009', name: '[MRSTEAM] Blog Calendar', folder: null }] },
      { workspace: 'W', space: { id: 's2', name: 'Lone Star' }, lists: [{ id: '1002', name: 'Lone Star Service Point Tracking', folder: null }] },
      { workspace: 'W', space: { id: 's3', name: 'Template Client Space' }, lists: [{ id: '1003', name: '[TEMPLATE] Client Point Tracker [Year] (# Points)', folder: null }] },
    ],
    fetchTasks: async ({ mappings }) => mappings.flatMap((m) => lists[m.value] || []),
  };
}

test('finds tracker lists in every space (skipping templates) and sets each client up in one step', async () => {
  const db = openDb(':memory:');
  admin.createMenuFromTemplate(db, { template: 'leadg2-2026', actor: 't' });
  const adapter = fakeClickUp();
  const found = await ingest.findTrackers(db, adapter);
  assert.deepEqual(found.map((f) => [f.client_name, f.list_id, f.allocation, f.status]), [['Lone Star', '1002', null, 'new'], ['MrSteam', '1001', 740, 'new']]);

  const results = await ingest.importTrackers(db, { adapter, actor: 't', items: [
    { listId: '1001', listName: found[1].list_name, name: 'MrSteam', allocation: 740 },
    { listId: '1002', listName: found[0].list_name, name: 'Lone Star', allocation: null, termStart: '2026-07-01', termEnd: '2027-06-30' },
  ] });
  const mr = results.find((r) => r.name === 'MrSteam');
  assert.equal(mr.error, undefined);
  assert.deepEqual([mr.term.term_start, mr.term.term_end, mr.term.from], ['2026-01-01', '2026-12-31', 'month headings']);
  assert.deepEqual([mr.balance.allocated, mr.balance.used, mr.balance.committed], [740, 10, 8]);
  assert.equal(db.prepare(`SELECT category FROM work_items WHERE external_ref = 'tracker:CU-a'`).get().category, 'Content Creation', 'type from Deliverable Type');
  const ls = results.find((r) => r.name === 'Lone Star');
  assert.match(ls.warning, /No allocation/);
  assert.equal(db.prepare(`SELECT substr(work_date,1,7) m FROM work_items WHERE external_ref = 'tracker:CU-x'`).get().m, '2026-09', 'month name placed inside the term');

  // Re-running is safe; already-linked lists are reported as linked.
  const again = await ingest.findTrackers(db, adapter);
  assert.deepEqual(again.map((f) => f.status), ['linked', 'linked']);
  const rerun = await ingest.importTrackers(db, { adapter, actor: 't', items: [{ listId: '1001', name: 'MrSteam', allocation: 740 }] });
  assert.deepEqual([rerun[0].added, rerun[0].created], [0, false]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM clients').get().n, 2);
});

test('a done subtask ("Write copy") does not mark its deliverable complete', async () => {
  const db = openDb(':memory:');
  admin.createMenuFromTemplate(db, { template: 'leadg2-2026', actor: 't' });
  const adapter = fakeClickUp();
  const [r] = await ingest.importTrackers(db, { adapter, actor: 't', items: [{ listId: '1001', listName: 'MrSteam Point Tracker 2026 (740 Points)', name: 'MrSteam', allocation: 740 }] });
  // "New LP templates" is In Progress (committed). Its subtask gets marked done.
  const tasks = await adapter.fetchTasks({ mappings: [{ value: '1001' }] });
  tasks.push(t('b1', 'Build page in HubSpot', 'b', '1001', { raw: 'done' }));
  tasks.forEach((x) => { x.date_updated = String(Date.now()); });
  await ingest.syncSource(db, { clientId: r.clientId, source: 'clickup', adapter: { mode: 'live', fetchTasks: async () => tasks } });
  assert.equal(review.listSuggestions(db, r.clientId, 'open').filter((s) => s.action === 'complete').length, 0);
  assert.equal(ledger.balance(db, r.clientId).committed, 8);
});

test('a second tracker for the same client adds its points to that client', async () => {
  const db = openDb(':memory:');
  admin.createMenuFromTemplate(db, { template: 'leadg2-2026', actor: 't' });
  const adapter = { mode: 'live', fetchTasks: async () => [] };
  const res = await ingest.importTrackers(db, { adapter, actor: 't', items: [
    { listId: '2001', listName: 'EmployerFlexible (83/300) Service Point Tracking', name: 'EmployerFlexible', allocation: 300, termStart: '2026-01-01', termEnd: '2026-12-31' },
    { listId: '2002', listName: 'EmployerFlexible (80) HS Implementation Point Tracker', name: 'EmployerFlexible', allocation: 80 },
  ] });
  assert.deepEqual(res.map((r) => r.error), [undefined, undefined]);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM clients').get().n, 1);
  assert.equal(ledger.balance(db, res[0].clientId).allocated, 380);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM source_mappings WHERE client_id = ?').get(res[0].clientId).n, 2);
});
