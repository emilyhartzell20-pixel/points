'use strict';
// Live-app behavior: real menu preloaded, no sample data in production, ClickUp browsing, hourly sync.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { openDb } = require('../src/db');
const { seeded, startServer, client } = require('./helpers');
const { DEMO_STAFF } = require('../src/seed');
const { createApp } = require('../src/server');
const admin = require('../src/admin');
const { LiveClickUp } = require('../src/adapters/clickup');
const { syncEverything } = require('../src/scheduler');

test('the LeadG2 2026 menu template loads all 40 items with the right point values', () => {
  const db = openDb(':memory:');
  const r = admin.createMenuFromTemplate(db, { template: 'leadg2-2026', actor: 't' });
  assert.equal(r.added, 40);
  const item = (code) => db.prepare('SELECT * FROM menu_items WHERE menu_version_id = ? AND code = ?').get(r.id, code);
  assert.deepEqual([item('LP').points_min, item('LP-FULL').points_min], [3, 5]);
  assert.deepEqual([item('EBOOK').points_min, item('EBOOK').points_max], [8, 13]);
  assert.deepEqual([item('VIDEO-30').points_min, item('VIDEO-60').points_min, item('VIDEO-90').points_min], [7, 9, 11]);
  assert.deepEqual([item('SALES-EMAIL').category, item('SALES-EMAIL').notes], ['Sales', 'Per email']);
  // Re-importing an edited file updates prices instead of duplicating.
  const csv = 'code,name,points_min,points_max\nLP,Landing page,4,4\nNEW-THING,Brand new item,2,\n';
  assert.deepEqual(admin.importMenuCsv(db, { versionId: r.id, csv, actor: 't' }), { added: 1, updated: 1 });
  assert.equal(item('LP').points_min, 4);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM menu_items WHERE menu_version_id = ?').get(r.id).n, 41);
});

function startProd(env) {
  const proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', path.join(__dirname, '..', 'src', 'server.js')], { env: { ...process.env, ...env } });
  let out = '';
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no startup: ${out}`)), 8000);
    const on = (d) => { out += d; if (/listening/.test(out)) { clearTimeout(timer); resolve(); } };
    proc.stdout.on('data', on); proc.stderr.on('data', on);
  });
  return { proc, ready, output: () => out };
}

test('on start the live app loads the menu automatically (and fills an existing empty menu)', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lg2-'));
  const a = startProd({ DB_FILE: path.join(dir, 'a.db'), PORT: '0', ADMIN_EMAIL: 'o@leadg2.example', NODE_ENV: 'production' });
  t.after(() => a.proc.kill());
  await a.ready;
  assert.match(a.output(), /Loaded the LeadG2 2026 menu \(40 items\)/);
  a.proc.kill();

  // An app where someone already created an empty menu (like the live one): the items go into it.
  const dbFile = path.join(dir, 'b.db');
  const db = openDb(dbFile);
  admin.inviteStaff(db, { email: 'o@leadg2.example', name: 'O', actor: 't' });
  const v = admin.createMenuVersion(db, { code: '2026', effectiveDate: '2026-01-01', actor: 't' });
  db.close();
  const b = startProd({ DB_FILE: dbFile, PORT: '0', NODE_ENV: 'production' });
  t.after(() => b.proc.kill());
  await b.ready;
  assert.match(b.output(), /into your existing menu \(40 items\)/);
  b.proc.kill();
  assert.equal(openDb(dbFile).prepare('SELECT COUNT(*) n FROM menu_items WHERE menu_version_id = ?').get(v.id).n, 40);
});

test('the live app never syncs sample data: without a ClickUp key it says how to connect', async (t) => {
  const s = await seeded({ sync: false });
  const saved = { ...process.env }; delete process.env.CLICKUP_API_TOKEN; delete process.env.CONNECTOR_MODE;
  t.after(() => { process.env = saved; });
  const srv = await startServer(createApp({ db: s.db }));
  t.after(srv.close);
  const staff = client(srv.base); await staff.login(DEMO_STAFF.email, DEMO_STAFF.password);
  const ov = (await staff.get(`/api/staff/clients/${s.hp}/overview`)).body;
  assert.equal(ov.connector_mode.clickup, 'not_connected');
  const r = (await staff.post(`/api/staff/clients/${s.hp}/sync`, { source: 'clickup' })).body;
  assert.equal(r.clickup.status, 'failed');
  assert.match(r.clickup.error, /CLICKUP_API_TOKEN in Render/);
  assert.equal(s.db.prepare('SELECT COUNT(*) n FROM source_records').get().n, 0, 'no sample records imported');
  assert.equal((await staff.get('/api/staff/clickup/browse')).status, 409);
});

test('with a ClickUp key it is live; the list browser shows workspaces, spaces, folders and lists', async () => {
  const saved = process.env.CLICKUP_API_TOKEN; process.env.CLICKUP_API_TOKEN = 'pk_test';
  try {
    const s = await seeded({ sync: false });
    const routes = {
      '/api/v2/team': { teams: [{ id: 't1', name: 'LeadG2' }] },
      '/api/v2/team/t1/space': { spaces: [{ id: 's1', name: 'Harbor Point' }] },
      '/api/v2/space/s1/list': { lists: [{ id: 'l1', name: 'Points work' }] },
      '/api/v2/space/s1/folder': { folders: [{ name: 'Website', lists: [{ id: 'l2', name: 'Redesign' }] }] },
    };
    const fetchImpl = async (url, opts) => {
      assert.equal(opts.method, 'GET'); assert.equal(opts.headers.Authorization, 'pk_test');
      const body = routes[new URL(url).pathname]; return { ok: !!body, status: body ? 200 : 404, json: async () => body };
    };
    const tree = await new LiveClickUp({ fetchImpl }).listHierarchy();
    assert.deepEqual(tree, [{ workspace: 'LeadG2', space: { id: 's1', name: 'Harbor Point' },
      lists: [{ id: 'l1', name: 'Points work', folder: null }, { id: 'l2', name: 'Redesign', folder: 'Website' }] }]);
    const srv = await startServer(createApp({ db: s.db }));
    const staff = client(srv.base); await staff.login(DEMO_STAFF.email, DEMO_STAFF.password);
    assert.equal((await staff.get(`/api/staff/clients/${s.hp}/overview`)).body.connector_mode.clickup, 'live');
    await srv.close();
  } finally { if (saved === undefined) delete process.env.CLICKUP_API_TOKEN; else process.env.CLICKUP_API_TOKEN = saved; }
});

test('hourly sync runs only live connectors, for clients with matching sources', async () => {
  const s = await seeded({ sync: false });
  const calls = [];
  const live = { mode: 'live', fetchTasks: async ({ mappings }) => { calls.push(mappings.map((m) => m.client_id)); return []; } };
  const off = { mode: 'not_connected', fetchMessages: async () => { throw new Error('should not be called'); } };
  await syncEverything(s.db, { clickup: live, outlook: off }, { error() {}, log() {} });
  assert.equal(calls.length, 2, 'both seeded clients have ClickUp lists');
  assert.equal(s.db.prepare(`SELECT COUNT(*) n FROM sync_runs WHERE source = 'clickup' AND status = 'success'`).get().n, 2);
  assert.equal(s.db.prepare(`SELECT COUNT(*) n FROM sync_runs WHERE source = 'outlook'`).get().n, 0);
});
