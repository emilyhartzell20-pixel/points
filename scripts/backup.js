'use strict';
// npm run backup  ->  <data dir>/backups/leadg2-<timestamp>.db, keeps the newest 30 (BACKUP_KEEP)
const path = require('node:path');
const { openDb } = require('../src/db');
const { runBackup } = require('../src/backup');

const dbFile = process.env.DB_FILE || path.join(__dirname, '..', 'data', 'leadg2.db');
const db = openDb(dbFile);
const r = runBackup(db, { dbFile });
db.close();
console.log(`Backup written: ${r.file}${r.removed ? ` (removed ${r.removed} older)` : ''}`);
