'use strict';
// Production readiness: sign-in throttling, health check, demo hints off, first admin from env, backups.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { seeded, startServer, client } = require('./helpers');
const { DEMO_STAFF } = require('../src/seed');
const { createApp } = require('../src/server');

test('sign-in is throttled after repeated failures', async (t) => {
  const s = await seeded({ sync: false });
  const srv = await startServer(createApp({ db: s.db, adapters: {} }));
  t.after(srv.close);
  const c = client(srv.base);
  for (let i = 0; i < 10; i++) assert.equal((await c.login(DEMO_STAFF.email, 'wrong')).status, 401);
  const blocked = await c.login(DEMO_STAFF.email, DEMO_STAFF.password);
  assert.equal(blocked.status, 429, 'even the right password is refused while throttled');
});

test('health check works; demo hints only in demo mode; HSTS only in production', async (t) => {
  const s = await seeded({ sync: false });
  const prod = await startServer(createApp({ db: s.db, adapters: {} }));
  const demo = await startServer(createApp({ db: s.db, adapters: {}, demo: true }));
  t.after(() => Promise.all([prod.close(), demo.close()]));
  assert.equal((await client(prod.base).get('/healthz')).status, 200);
  assert.deepEqual((await client(prod.base).get('/api/config')).body, { demo: false });
  assert.deepEqual((await client(demo.base).get('/api/config')).body, { demo: true });
});

test('first start on a fresh host creates the first admin from ADMIN_EMAIL and logs a setup link', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg2-'));
  const env = { ...process.env, DB_FILE: path.join(dir, 'app.db'), PORT: '0', ADMIN_EMAIL: 'owner@leadg2.example', ADMIN_NAME: 'Owner', PUBLIC_URL: 'https://points.example.com', NODE_ENV: 'production' };
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'src', 'server.js')], { env });
  t.after(() => proc.kill());
  let out = '';
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no startup output: ${out}`)), 8000);
    proc.stdout.on('data', (d) => { out += d; if (/listening/.test(out)) { clearTimeout(timer); resolve(); } });
    proc.stderr.on('data', (d) => { out += d; });
  });
  assert.match(out, /https:\/\/points\.example\.com\/setup#t=[\w-]{40,}/);
  // Without ADMIN_EMAIL and no admins, it refuses to start rather than run an app nobody can sign in to.
  const empty = { ...env, DB_FILE: path.join(dir, 'empty.db') }; delete empty.ADMIN_EMAIL;
  assert.throws(() => execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'src', 'server.js')], { env: empty, stdio: 'pipe' }), /No admin accounts/);
});

test('backup writes a consistent copy of the database', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg2-'));
  const dbFile = path.join(dir, 'app.db');
  const { openDb } = require('../src/db');
  const { seedSample } = require('../src/seed');
  const db = openDb(dbFile); seedSample(db); db.close();
  execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'scripts', 'backup.js')], { env: { ...process.env, DB_FILE: dbFile } });
  const files = fs.readdirSync(path.join(dir, 'backups'));
  assert.equal(files.length, 1);
  const copy = openDb(path.join(dir, 'backups', files[0]));
  assert.equal(copy.prepare('SELECT COUNT(*) n FROM work_items').get().n, 16);
});
