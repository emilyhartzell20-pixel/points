'use strict';
// Consistent snapshot of the live database (safe while the app is running).
//   npm run backup                 -> <data dir>/backups/leadg2-<timestamp>.db, keeps the newest 30
//   BACKUP_DIR=/some/path npm run backup
const fs = require('node:fs');
const path = require('node:path');
const { openDb } = require('../src/db');

const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'leadg2.db');
const dir = process.env.BACKUP_DIR || path.join(path.dirname(dbFile), 'backups');
const keep = Number(process.env.BACKUP_KEEP || 30);
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, `leadg2-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
const db = openDb(dbFile);
db.prepare('VACUUM INTO ?').run(out);
db.close();
const old = fs.readdirSync(dir).filter((f) => /^leadg2-.*\.db$/.test(f)).sort().reverse().slice(keep);
for (const f of old) fs.rmSync(path.join(dir, f));
console.log(`Backup written: ${out}${old.length ? ` (removed ${old.length} older)` : ''}`);
