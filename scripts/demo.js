'use strict';
// Demo runner.
//   npm run demo            reset DB, seed sample data, run sample syncs, start server (review queue pending)
//   npm run demo:reviewed   same, then apply the scripted consultant review (250 / 103 / 23 / 124)
//   npm run seed            seed + sync only, no server
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { openDb } = require('../src/db');
const { seedSample, syncAllSample, applyDemoReview } = require('../src/seed');
const { balance } = require('../src/ledger');
const { createApp } = require('../src/server');

(async () => {
  const args = new Set(process.argv.slice(2));
  const file = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'leadg2.db');
  for (const f of [file, `${file}-wal`, `${file}-shm`]) fs.rmSync(f, { force: true });
  const db = openDb(file);
  const ids = seedSample(db);
  const hp = ids['harbor-point'];
  console.log('Opening balance (reconciled from tracker):', fmt(balance(db, hp)));
  const sync = await syncAllSample(db, ids);
  console.log('Sample sync:', JSON.stringify(sync['harbor-point']));
  const open = db.prepare(`SELECT COUNT(*) n FROM suggestions WHERE client_id=? AND status='open'`).get(hp).n;
  console.log(`Review queue: ${open} open suggestions; balance unchanged until a consultant approves:`, fmt(balance(db, hp)));
  if (args.has('--auto-review')) {
    applyDemoReview(db, hp);
    db.prepare('UPDATE clients SET portal_enabled = 1 WHERE id = ?').run(hp);
    console.log('After scripted consultant review:', fmt(balance(db, hp)));
  }
  if (args.has('--no-serve')) return;
  const port = Number(process.env.PORT || 3000);
  http.createServer(createApp({ db })).listen(port, () => {
    console.log(`\nOpen http://localhost:${port}`);
    console.log('  Staff:  consultant@leadg2.example / demo-consultant');
    console.log('  Client: dana@harborpoint.example / demo-client' + (args.has('--auto-review') ? '' : '  (grant access in Staff → Client preview first)'));
  });
})().catch((e) => { console.error(e); process.exit(1); });

function fmt(b) { return `allocated ${b.allocated} · used ${b.used} · committed ${b.committed} · available ${b.available} (forecast ${b.forecast})`; }
