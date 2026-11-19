'use strict';
// HTTP server (no framework). Client isolation is enforced here: client-role routes never accept a
// client id from the request; they use the id bound to the authenticated user.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { openDb, audit, AppError } = require('./db');
const auth = require('./auth');
const ledger = require('./ledger');
const review = require('./review');
const ingest = require('./ingest');
const importer = require('./importer');
const { clientDashboard } = require('./clientView');
const { menuForClient } = require('./menu');
const { SampleClickUp, LiveClickUp } = require('./adapters/clickup');
const { SampleOutlook, LiveOutlook } = require('./adapters/outlook');

const PUBLIC = path.join(__dirname, '..', 'public');
const COOKIE = 'lg2_session';

function defaultAdapters() {
  const live = process.env.CONNECTOR_MODE === 'live';
  return { clickup: live ? new LiveClickUp() : new SampleClickUp(), outlook: live ? new LiveOutlook() : new SampleOutlook() };
}

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

function send(res, status, body, headers = {}) {
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : headers['Content-Type'] || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    ...headers,
  });
  res.end(isJson ? JSON.stringify(body) : body);
}

async function readJson(req) {
  if (!/^application\/json/.test(req.headers['content-type'] || '')) throw new AppError(415, 'Expected application/json');
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > 2e6) throw new AppError(413, 'Request too large'); chunks.push(c); }
  try { return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { throw new AppError(400, 'Invalid JSON'); }
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
function serveStatic(res, file) {
  const p = path.join(PUBLIC, file);
  if (!p.startsWith(PUBLIC) || !fs.existsSync(p)) return send(res, 404, 'Not found');
  send(res, 200, fs.readFileSync(p), { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
}

function createApp({ db, adapters = defaultAdapters(), secureCookies = process.env.NODE_ENV === 'production' } = {}) {
  const routes = [];
  const route = (method, pattern, role, handler) => {
    const keys = []; const re = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
    routes.push({ method, re, keys, role, handler });
  };
  const int = (v) => { const n = Number(v); if (!Number.isInteger(n)) throw new AppError(400, 'Bad id'); return n; };
  const clientExists = (id) => { if (!db.prepare('SELECT 1 FROM clients WHERE id = ?').get(id)) throw new AppError(404, 'Client not found'); return id; };
  const ownerOf = (table, id) => { const r = db.prepare(`SELECT client_id FROM ${table} WHERE id = ?`).get(id); if (!r) throw new AppError(404, 'Not found'); return r.client_id; };

  // ---- auth
  route('POST', '/api/login', null, async ({ req, res }) => {
    const { email, password } = await readJson(req);
    const s = auth.login(db, email, password);
    if (!s) throw new AppError(401, 'Email or password is incorrect');
    if (s.user.role === 'client') {
      const c = db.prepare('SELECT portal_enabled FROM clients WHERE id = ?').get(s.user.client_id);
      if (!c || !c.portal_enabled) { auth.logout(db, s.token); throw new AppError(403, 'Your dashboard is not available yet. Your LeadG2 consultant will let you know when it is ready.'); }
    }
    const cookie = `${COOKIE}=${encodeURIComponent(s.token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=43200${secureCookies ? '; Secure' : ''}`;
    send(res, 200, { user: s.user }, { 'Set-Cookie': cookie });
  });
  route('POST', '/api/logout', 'any', async ({ res, token }) => {
    auth.logout(db, token);
    send(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
  });
  route('GET', '/api/me', 'any', ({ res, user }) => send(res, 200, { user }));

  // ---- client (scope comes from the session ONLY)
  route('GET', '/api/client/dashboard', 'client', ({ res, user }) => {
    const c = db.prepare('SELECT portal_enabled FROM clients WHERE id = ?').get(user.client_id);
    if (!c || !c.portal_enabled) throw new AppError(403, 'Dashboard access has not been granted');
    send(res, 200, clientDashboard(db, user.client_id));
  });

  // ---- staff
  route('GET', '/api/staff/clients', 'staff', ({ res }) => {
    const rows = db.prepare('SELECT id, slug, name, portal_enabled, pilot FROM clients ORDER BY pilot DESC, name').all();
    send(res, 200, rows.map((c) => ({ ...c, open_suggestions: db.prepare(`SELECT COUNT(*) n FROM suggestions WHERE client_id=? AND status='open'`).get(c.id).n })));
  });
  route('GET', '/api/staff/clients/:id/overview', 'staff', ({ res, p }) => {
    const id = clientExists(int(p.id));
    const contract = ledger.activeContract(db, id);
    const menu = menuForClient(db, id);
    send(res, 200, {
      client: db.prepare('SELECT * FROM clients WHERE id = ?').get(id),
      contract, allocations: db.prepare('SELECT * FROM allocations WHERE contract_id = ?').all(contract.id),
      balance: ledger.balance(db, id), support_hours: ledger.supportHours(db, id),
      menu, sync: ingest.syncStatus(db, id),
      mappings: db.prepare('SELECT * FROM source_mappings WHERE client_id = ?').all(id),
      connector_mode: Object.fromEntries(Object.entries(adapters).map(([k, a]) => [k, a.mode])),
    });
  });
  route('GET', '/api/staff/clients/:id/suggestions', 'staff', ({ res, p, url }) =>
    send(res, 200, review.listSuggestions(db, clientExists(int(p.id)), url.searchParams.get('status') || 'open')));
  route('GET', '/api/staff/clients/:id/work-items', 'staff', ({ res, p }) => {
    const id = clientExists(int(p.id));
    const ev = db.prepare(`SELECT r.source_type, r.title, r.url FROM work_item_evidence we JOIN source_records r ON r.id = we.source_record_id WHERE we.work_item_id = ?`);
    send(res, 200, ledger.listItems(db, id).map((w) => ({ ...w, evidence: ev.all(w.id) })));
  });
  route('GET', '/api/staff/clients/:id/ledger', 'staff', ({ res, p }) => send(res, 200, ledger.listEvents(db, clientExists(int(p.id)))));
  route('GET', '/api/staff/clients/:id/audit', 'staff', ({ res, p }) =>
    send(res, 200, db.prepare('SELECT * FROM audit_log WHERE client_id = ? ORDER BY id DESC LIMIT 300').all(clientExists(int(p.id)))));
  route('GET', '/api/staff/clients/:id/preview', 'staff', ({ res, p, user }) => {
    const id = clientExists(int(p.id));
    audit(db, { clientId: id, actor: user.email, action: 'client_view.preview' });
    send(res, 200, clientDashboard(db, id));
  });
  route('POST', '/api/staff/clients/:id/portal', 'staff', async ({ req, res, p, user }) => {
    const id = clientExists(int(p.id)); const { enabled } = await readJson(req);
    db.prepare('UPDATE clients SET portal_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    if (!enabled) db.prepare(`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE client_id = ?)`).run(id);
    audit(db, { clientId: id, actor: user.email, action: enabled ? 'portal.grant' : 'portal.revoke' });
    send(res, 200, { portal_enabled: !!enabled });
  });
  route('POST', '/api/staff/clients/:id/sync', 'staff', async ({ req, res, p, user }) => {
    const id = clientExists(int(p.id)); const { source } = await readJson(req);
    const sources = source ? [source] : ['clickup', 'outlook'];
    const results = {};
    for (const s of sources) {
      if (!adapters[s]) throw new AppError(400, `Unknown source ${s}`);
      results[s] = await ingest.syncSource(db, { clientId: id, source: s, adapter: adapters[s], actor: user.email });
    }
    send(res, 200, results);
  });
  route('POST', '/api/staff/clients/:id/import', 'staff', async ({ req, res, p, user }) => {
    const id = clientExists(int(p.id)); const b = await readJson(req);
    send(res, 200, importer.importTracker(db, { clientId: id, csv: b.csv, actor: user.email, opening: !!b.opening, filename: b.filename }));
  });
  route('POST', '/api/staff/clients/:id/work-items', 'staff', async ({ req, res, p, user }) => {
    const id = clientExists(int(p.id)); const b = await readJson(req);
    send(res, 200, importer.manualEntry(db, { ...b, clientId: id, points: Number(b.points), actor: user.email }));
  });
  route('GET', '/api/staff/match-queue', 'staff', ({ res }) => send(res, 200, ingest.matchQueue(db)));
  route('POST', '/api/staff/match-queue/:rid', 'staff', async ({ req, res, p, user }) => {
    const b = await readJson(req);
    if (b.clientId) clientExists(int(b.clientId));
    ingest.resolveMatch(db, { recordId: int(p.rid), clientId: b.clientId ? int(b.clientId) : null, actor: user.email, reason: b.reason });
    send(res, 200, { ok: true });
  });
  route('POST', '/api/staff/suggestions/:sid/:action', 'staff', async ({ req, res, p, user }) => {
    const id = int(p.sid); const b = await readJson(req); const actor = user.email;
    if (p.action === 'approve') return send(res, 200, review.approveSuggestion(db, { ...b, id, actor, points: b.points === '' || b.points == null ? null : Number(b.points) }));
    if (p.action === 'edit') return send(res, 200, review.editSuggestion(db, { ...b, id, actor, points: b.points === '' || b.points == null ? null : Number(b.points) }));
    if (p.action === 'dismiss') return send(res, 200, review.dismissSuggestion(db, { id, actor, reason: b.reason }));
    if (p.action === 'merge') return send(res, 200, review.mergeSuggestion(db, { id, intoId: int(b.intoId), actor, reason: b.reason }));
    throw new AppError(404, 'Unknown action');
  });
  route('POST', '/api/staff/work-items/:wid/:action', 'staff', async ({ req, res, p, user }) => {
    const id = int(p.wid); ownerOf('work_items', id); const b = await readJson(req); const actor = user.email;
    if (p.action === 'transition') return send(res, 200, ledger.transition(db, { itemId: id, to: b.to, actor, reason: b.reason, overrideReason: b.overrideReason }));
    if (p.action === 'correct') return send(res, 200, ledger.correct(db, { itemId: id, points: Number(b.points), actor, reason: b.reason, overrideReason: b.overrideReason }));
    if (p.action === 'summary') return send(res, 200, ledger.setSummary(db, { itemId: id, clientSummary: b.clientSummary, approved: !!b.approved, actor }));
    throw new AppError(404, 'Unknown action');
  });

  // ---- pages
  const pages = { '/': 'login.html', '/login': 'login.html', '/staff': 'staff.html', '/client': 'client.html' };

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && pages[url.pathname]) return serveStatic(res, pages[url.pathname]);
      if (req.method === 'GET' && url.pathname.startsWith('/static/')) return serveStatic(res, url.pathname.slice(8));
      const token = parseCookies(req.headers.cookie)[COOKIE];
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.re.exec(url.pathname); if (!m) continue;
        const p = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const user = auth.userForToken(db, token);
        if (r.role && !user) throw new AppError(401, 'Sign in required');
        if (r.role && r.role !== 'any' && user.role !== r.role) throw new AppError(403, 'Not allowed');
        return await r.handler({ req, res, p, url, user, token });
      }
      send(res, 404, { error: 'Not found' });
    } catch (e) {
      const status = e.status || 500;
      if (status === 500) console.error(e);
      send(res, status, { error: status === 500 ? 'Internal error' : e.message });
    }
  };
}

if (require.main === module) {
  const db = openDb();
  if (!db.prepare('SELECT 1 FROM clients LIMIT 1').get()) {
    console.error('Database is empty. Run `npm run demo` (sample data) first.');
    process.exit(1);
  }
  const port = Number(process.env.PORT || 3000);
  http.createServer(createApp({ db })).listen(port, () => console.log(`LeadG2 points tracker on http://localhost:${port}`));
}

module.exports = { createApp };
