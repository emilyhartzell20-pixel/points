'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { seeded, openSuggestion } = require('./helpers');
const { applyDemoReview } = require('../src/seed');
const ledger = require('../src/ledger');
const review = require('../src/review');
const ingest = require('../src/ingest');
const importer = require('../src/importer');
const { clientDashboard } = require('../src/clientView');
const { SampleClickUp } = require('../src/adapters/clickup');
const { SampleOutlook } = require('../src/adapters/outlook');

const nums = (b) => ({ allocated: b.allocated, used: b.used, committed: b.committed, available: b.available });

test('pilot example: 250 allocated, 103 used, 23 committed, 124 available', async () => {
  const { db, hp } = await seeded();
  applyDemoReview(db, hp);
  const b = ledger.balance(db, hp);
  assert.deepEqual(nums(b), { allocated: 250, used: 103, committed: 23, available: 124 });
  assert.equal(b.available, b.allocated - b.used - b.committed);
  assert.equal(b.forecast, 8, 'planned dashboard is forecast only and does not reduce available');
  // The client dashboard shows the exact same four numbers.
  assert.deepEqual(clientDashboard(db, hp).balance, { allocated: 250, used: 103, committed: 23, available: 124 });
});

test('reconciled opening balance is the starting point and syncing alone never moves points', async () => {
  const { db, hp } = await seeded({ sync: false });
  assert.deepEqual(nums(ledger.balance(db, hp)), { allocated: 250, used: 85, committed: 26, available: 139 });
  await require('../src/seed').syncAllSample(db, { 'harbor-point': hp });
  // Completed ClickUp tasks and approving emails exist now, but nothing is charged until a consultant approves.
  assert.ok(openSuggestion(db, hp, 'clickup:86b3land', 'complete'));
  assert.deepEqual(nums(ledger.balance(db, hp)), { allocated: 250, used: 85, committed: 26, available: 139 });
});

test('importing the same work twice does not duplicate it', async () => {
  const { db, hp } = await seeded();
  const count = (t) => db.prepare(`SELECT COUNT(*) n FROM ${t}`).get().n;
  const before = { records: count('source_records'), sugg: count('suggestions'), items: count('work_items'), events: count('ledger_events') };

  // Same ClickUp + Outlook data again.
  const r1 = await ingest.syncSource(db, { clientId: hp, source: 'clickup', adapter: new SampleClickUp() });
  const r2 = await ingest.syncSource(db, { clientId: hp, source: 'outlook', adapter: new SampleOutlook() });
  assert.equal(r1.new + r1.updated + r2.new + r2.updated, 0);
  assert.deepEqual({ records: count('source_records'), sugg: count('suggestions'), items: count('work_items'), events: count('ledger_events') }, before);

  // Same opening tracker file again: skipped, not re-posted.
  const fs = require('node:fs');
  const csv = fs.readFileSync(require('node:path').join(__dirname, '..', 'data', 'sample', 'opening-tracker-harbor-point.csv'), 'utf8');
  const again = importer.importTracker(db, { clientId: hp, csv, actor: 't', opening: true });
  assert.equal(again.created, 0);
  assert.equal(count('work_items'), before.items);

  // Regular CSV import twice: second run skips by tracker_id.
  const extra = 'tracker_id,date,title,client_summary,menu_code,points,status\nX-1,2026-11-18,Extra training,Ran an extra training,TRAIN,4,used\n';
  assert.equal(importer.importTracker(db, { clientId: hp, csv: extra, actor: 't' }).created, 1);
  const second = importer.importTracker(db, { clientId: hp, csv: extra, actor: 't' });
  assert.deepEqual([second.created, second.skipped], [0, 1]);

  // Manual entry double-submit with the same idempotency key.
  const entry = { clientId: hp, title: 'Call follow-up build', menuItemCode: 'WF-SIMPLE', points: 5, state: 'committed', reason: 'Approved on call', actor: 't', idempotencyKey: 'abc' };
  assert.equal(importer.manualEntry(db, entry).duplicate, false);
  assert.equal(importer.manualEntry(db, entry).duplicate, true);

  // Approved work is not re-suggested by a later re-import.
  const s = openSuggestion(db, hp, 'clickup:86b3land', 'complete');
  review.approveSuggestion(db, { id: s.id, actor: 't' });
  const bal = nums(ledger.balance(db, hp));
  await ingest.syncSource(db, { clientId: hp, source: 'clickup', adapter: new SampleClickUp() });
  await ingest.syncSource(db, { clientId: hp, source: 'outlook', adapter: new SampleOutlook() });
  assert.deepEqual(nums(ledger.balance(db, hp)), bal);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM work_items WHERE group_key='clickup:86b3land'`).get().n, 1);
});

test('ClickUp tasks and emails about the same deliverable become one entry', async () => {
  const { db, hp } = await seeded();
  const s = openSuggestion(db, hp, 'clickup:86b3land', 'complete');
  const ev = db.prepare('SELECT r.source_type, r.external_id FROM suggestion_evidence se JOIN source_records r ON r.id=se.source_record_id WHERE se.suggestion_id=?').all(s.id);
  // Parent task + subtask + 4 thread emails (the first email has no task link; it joins via its thread).
  assert.equal(ev.filter((e) => e.source_type === 'clickup_task').length, 2);
  assert.equal(ev.filter((e) => e.source_type === 'outlook_message').length, 4);
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM suggestions WHERE client_id=? AND group_key LIKE 'outlook:conv-land%'`).get(hp).n, 0);
});

test('completing committed work moves the same points and never double-charges', async () => {
  const { db, hp } = await seeded();
  const before = ledger.balance(db, hp);
  const s = openSuggestion(db, hp, 'clickup:86b2lead', 'complete');
  assert.equal(s.proposed_points, 8);
  const { workItemId } = review.approveSuggestion(db, { id: s.id, actor: 't' });
  const after = ledger.balance(db, hp);
  assert.equal(after.used - before.used, 8);
  assert.equal(after.committed - before.committed, -8);
  assert.equal(after.available, before.available, 'completion does not change available');

  // Completing again is a no-op.
  const again = ledger.transition(db, { itemId: workItemId, to: 'used', actor: 't' });
  assert.equal(again.changed, false);
  assert.deepEqual(nums(ledger.balance(db, hp)), nums(after));

  // Per-item ledger nets to exactly its points, once, in "used".
  const sums = db.prepare('SELECT SUM(committed_delta) c, SUM(used_delta) u FROM ledger_events WHERE work_item_id=?').get(workItemId);
  assert.deepEqual([sums.c, sums.u], [0, 8]);

  // A fresh sync doesn't propose completing it again.
  await ingest.syncSource(db, { clientId: hp, source: 'clickup', adapter: new SampleClickUp() });
  assert.equal(openSuggestion(db, hp, 'clickup:86b2lead', 'complete'), undefined);
});

test('canceling releases reserved points', async () => {
  const { db, hp } = await seeded();
  const before = ledger.balance(db, hp);
  const s = openSuggestion(db, hp, 'clickup:86b2webi', 'cancel');
  assert.ok(JSON.parse(s.flags).includes('sources_disagree'), 'ClickUp still says in progress while client email cancels');
  const { workItemId } = review.approveSuggestion(db, { id: s.id, actor: 't', reason: 'Client canceled' });
  const after = ledger.balance(db, hp);
  assert.equal(after.committed, before.committed - 8);
  assert.equal(after.used, before.used);
  assert.equal(after.available, before.available + 8);
  assert.equal(ledger.getItem(db, workItemId).state, 'canceled');
  assert.throws(() => ledger.transition(db, { itemId: workItemId, to: 'used', actor: 't' }), /Cannot move/);
});

test('used work cannot be canceled; corrections need a reason and are logged with who and why', async () => {
  const { db, hp } = await seeded();
  const used = db.prepare(`SELECT * FROM work_items WHERE client_id=? AND external_ref='tracker:HP-004'`).get(hp);
  assert.throws(() => ledger.transition(db, { itemId: used.id, to: 'canceled', actor: 't' }), /correction/);
  assert.throws(() => ledger.correct(db, { itemId: used.id, points: 10, actor: 't', reason: '' }), /reason/);
  ledger.correct(db, { itemId: used.id, points: 10, actor: 'reviewer@leadg2.example', reason: 'Client agreed 10 after review' });
  assert.equal(ledger.balance(db, hp).used, 83);
  const log = db.prepare(`SELECT * FROM audit_log WHERE action='work_item.correction' AND entity_id=?`).get(used.id);
  assert.equal(log.actor, 'reviewer@leadg2.example');
  assert.equal(log.reason, 'Client agreed 10 after review');
});

test('approved amounts are snapshotted: later menu changes do not rewrite history', async () => {
  const { db, hp } = await seeded();
  review.approveSuggestion(db, { id: openSuggestion(db, hp, 'clickup:86b3land', 'complete').id, actor: 't' });
  const before = nums(ledger.balance(db, hp));
  db.prepare(`UPDATE menu_items SET points_min=12, points_max=12 WHERE code='LP-BUILD'`).run();
  assert.deepEqual(nums(ledger.balance(db, hp)), before);
  assert.equal(db.prepare(`SELECT points FROM work_items WHERE group_key='clickup:86b3land'`).get().points, 10);
});

test('ranges and unclear costs require the reviewer to confirm the amount', async () => {
  const { db, hp } = await seeded();
  const wf = openSuggestion(db, hp, 'clickup:86b3wflw', 'approve');
  assert.ok(JSON.parse(wf.flags).includes('points_range_confirm'));
  assert.throws(() => review.approveSuggestion(db, { id: wf.id, actor: 't', points: 20 }), /outside the menu/);
  const chat = openSuggestion(db, hp, 'outlook:conv-chat', 'forecast');
  assert.ok(JSON.parse(chat.flags).includes('point_cost_unclear'));
  assert.ok(JSON.parse(chat.flags).includes('email_only'));
  assert.throws(() => review.approveSuggestion(db, { id: chat.id, actor: 't' }), /menu item/);
});

test('consulting, fixed-scope project and support-hours work are flagged and kept out of points', async () => {
  const { db, hp } = await seeded();
  assert.ok(JSON.parse(openSuggestion(db, hp, 'clickup:86b3cons', 'complete').flags).includes('may_be_included_in_consulting'));
  assert.ok(JSON.parse(openSuggestion(db, hp, 'clickup:86b3proj', 'complete').flags).includes('may_be_fixed_scope_project'));
  const before = nums(ledger.balance(db, hp));
  review.approveSuggestion(db, { id: openSuggestion(db, hp, 'clickup:86b3supp', 'support_hours').id, actor: 't', hours: 1.5 });
  assert.deepEqual(nums(ledger.balance(db, hp)), before, 'support hours never touch the point balance');
  assert.equal(ledger.supportHours(db, hp).hours_remaining, 8.5);
});

test('instructions embedded in emails are flagged and never acted on', async () => {
  const { db, hp } = await seeded();
  const s = openSuggestion(db, hp, 'outlook:conv-inv', 'approve');
  assert.ok(JSON.parse(s.flags).includes('embedded_instructions'));
  assert.equal(s.proposed_points, null);
  assert.deepEqual(nums(ledger.balance(db, hp)), { allocated: 250, used: 85, committed: 26, available: 139 });
});

test('uncertain client matches go to the review queue', async () => {
  const { db, hp } = await seeded();
  const q = ingest.matchQueue(db);
  assert.equal(q.length, 1);
  assert.equal(q[0].title, 'Harbor Point - quick question');
  assert.deepEqual(q[0].match_candidates, [hp]);
  ingest.resolveMatch(db, { recordId: q[0].id, clientId: hp, actor: 't' });
  assert.equal(ingest.matchQueue(db).length, 0);
  assert.ok(openSuggestion(db, hp, 'outlook:conv-pers', 'forecast'));
  // Unrelated mail and pre-opening-balance activity are not stored at all.
  assert.equal(db.prepare(`SELECT COUNT(*) n FROM source_records WHERE title IN ('Lunch next week?','Q3 UTM cleanup','Q3 campaign UTM cleanup')`).get().n, 0);
});

test('merging suggestions combines evidence and survives re-import', async () => {
  const { db, hp } = await seeded();
  const chat = openSuggestion(db, hp, 'outlook:conv-chat', 'forecast');
  const dash = openSuggestion(db, hp, 'clickup:86b3dash', 'forecast');
  review.mergeSuggestion(db, { id: chat.id, intoId: dash.id, actor: 't' });
  await ingest.syncSource(db, { clientId: hp, source: 'outlook', adapter: new SampleOutlook() });
  assert.equal(db.prepare(`SELECT group_key FROM source_records WHERE title='Chatbot idea'`).get().group_key, 'clickup:86b3dash');
  assert.equal(db.prepare(`SELECT status FROM suggestions WHERE id=?`).get(chat.id).status, 'merged');
  assert.equal(openSuggestion(db, hp, 'outlook:conv-chat', 'forecast'), undefined);
});

test('opening balance that does not reconcile is rejected entirely', async () => {
  const { db } = await seeded({ sync: false });
  const fs = require('node:fs');
  const csv = fs.readFileSync(require('node:path').join(__dirname, '..', 'data', 'sample', 'opening-tracker-harbor-point.csv'), 'utf8');
  const cid = Number(db.prepare(`INSERT INTO clients (slug, name) VALUES ('t', 'Test Co')`).run().lastInsertRowid);
  db.prepare(`INSERT INTO contracts (client_id, term_start, term_end, menu_version_id, opening_balance_date, opening_used, opening_committed)
              VALUES (?, '2026-04-01', '2027-03-31', 1, '2026-10-01', 84, 26)`).run(cid); // tracker file says 85 used
  assert.throws(() => importer.importTracker(db, { clientId: cid, csv, actor: 't', opening: true }), /does not reconcile/);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM work_items WHERE client_id = ?').get(cid).n, 0, 'nothing partially imported');
});

test('a connector failure is recorded and shown; last successful sync is kept', async () => {
  const { db, hp } = await seeded();
  const okAt = ingest.syncStatus(db, hp).clickup.last_success_at;
  const broken = { mode: 'live', fetchTasks: async () => { throw new Error('api.clickup.com responded 503'); } };
  const r = await ingest.syncSource(db, { clientId: hp, source: 'clickup', adapter: broken });
  assert.equal(r.status, 'failed');
  const st = ingest.syncStatus(db, hp).clickup;
  assert.equal(st.last_success_at, okAt);
  assert.match(st.recent_failures[0].error, /503/);
});
