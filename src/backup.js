'use strict';
// Consistent SQLite snapshots (VACUUM INTO is safe while the app is running).
const fs = require('node:fs');
const path = require('node:path');

function backupDir(dbFile) {
  return process.env.BACKUP_DIR || path.join(path.dirname(dbFile), 'backups');
}

function runBackup(db, { dbFile, keep = Number(process.env.BACKUP_KEEP || 30) }) {
  const dir = backupDir(dbFile);
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `leadg2-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  db.prepare('VACUUM INTO ?').run(out);
  const old = fs.readdirSync(dir).filter((f) => /^leadg2-.*\.db$/.test(f)).sort().reverse().slice(keep);
  for (const f of old) fs.rmSync(path.join(dir, f));
  return { file: out, removed: old.length };
}

/** Back up once shortly after start, then every 24 hours. No external scheduler needed. */
function scheduleDailyBackups(db, { dbFile, log = console }) {
  const run = () => {
    try { const r = runBackup(db, { dbFile }); log.log(`Backup written: ${r.file}`); } catch (e) { log.error(`Backup failed: ${e.message}`); }
  };
  const first = setTimeout(run, 60e3); first.unref();
  const daily = setInterval(run, 24 * 3600e3); daily.unref();
}

module.exports = { runBackup, scheduleDailyBackups, backupDir };
