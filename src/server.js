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
const admin = require('./admin');
const { HubSpotSync } = require('./adapters/hubspot');
const hubspotSync = require('./hubspotSync');
const { clientDashboard } = require('./clientView');
const { menuForClient } = require('./menu');
const { SampleClickUp, LiveClickUp } = require('./adapters/clickup');
const { SampleOutlook, LiveOutlook } = require('./adapters/outlook');

const PUBLIC = path.join(__dirname, '..', 'public');
const COOKIE = 'lg2_session';

/**
 * Sample data only in the demo (or when CONNECTOR_MODE=sample). Otherwise each connector is live as soon
 * as its credentials are set on the server, and clearly "not connected" until then.
 */
function defaultAdapters({ demo = false } = {}) {
  if (demo || process.env.CONNECTOR_MODE === 'sample') return { clickup: new SampleClickUp(), outlook: new SampleOutlook() };
  const { NotConnected } = require('./adapters/clickup');
  const outlookReady = process.env.OUTLOOK_ACCESS_TOKEN || (process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET);
  return {
    clickup: process.env.CLICKUP_API_TOKEN ? new LiveClickUp()
      : new NotConnected('ClickUp', 'Add your ClickUp API token as CLICKUP_API_TOKEN in Render → leadg2-points → Environment.'),
    outlook: outlookReady ? new LiveOutlook()
      : new NotConnected('Outlook', 'It needs a Microsoft 365 app registration with read-only mail access (see DEPLOY.md, section 6).'),
  };
}

function parseCookies(h) {
  const out = {};
  for (const part of String(h || '').split(';')) { const i = part.indexOf('='); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}

function send(res, status, body, headers = {}) {
  if (process.env.NODE_ENV === 'production') headers = { 'Strict-Transport-Security': 'max-age=31536000', ...headers };
  const isJson = typeof body !== 'string' && !Buffer.isBuffer(body);
  res.writeHead(status, {
    'Content-Type': isJson ? 'application/json; charset=utf-8' : headers['Content-Type'] || 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
function serveStatic(res, file) {
  const p = path.join(PUBLIC, file);
  if (!p.startsWith(PUBLIC) || !fs.existsSync(p)) return send(res, 404, 'Not found');
  send(res, 200, fs.readFileSync(p), { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
}

function createApp({ db, adapters = null, secureCookies = process.env.NODE_ENV === 'production', demo = false, hubspot = new HubSpotSync() } = {}) {
  adapters = adapters || defaultAdapters({ demo });
  // Sign-in throttle: at most 10 failed attempts per email and per IP in 15 minutes.
  const failures = new Map();
  const WINDOW = 15 * 60e3, LIMIT = 10;
  const clientIp = (req) => (process.env.TRUST_PROXY ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || req.socket.remoteAddress || '?';
  const throttled = (keys) => keys.some((k) => { const f = failures.get(k); return f && Date.now() - f.first < WINDOW && f.count >= LIMIT; });
  const recordFailure = (keys) => {
    for (const k of keys) {
      const f = failures.get(k);
      if (!f || Date.now() - f.first >= WINDOW) failures.set(k, { first: Date.now(), count: 1 }); else f.count++;
    }
    if (failures.size > 10000) for (const [k, f] of failures) if (Date.now() - f.first >= WINDOW) failures.delete(k);
  };
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
    const keys = [`ip:${clientIp(req)}`, `email:${String(email || '').toLowerCase()}`];
    if (throttled(keys)) throw new AppError(429, 'Too many sign-in attempts. Wait 15 minutes and try again.');
    const s = auth.login(db, email, password);
    if (!s) { recordFailure(keys); throw new AppError(401, 'Email or password is incorrect'); }
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
  route('GET', '/api/config', null, ({ res }) => send(res, 200, { demo }));
  route('GET', '/healthz', null, ({ res }) => { db.prepare('SELECT 1').get(); send(res, 200, { ok: true }); });
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
      hubspot: { configured: hubspot.configured },
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
  route('POST', '/api/staff/clients/:id/allocations', 'staff', async ({ req, res, p, user }) => {
    const id = clientExists(int(p.id)); const b = await readJson(req);
    send(res, 200, ledger.addAllocation(db, { clientId: id, kind: b.kind, points: Number(b.points), sourceRef: b.sourceRef, note: b.note, actor: user.email }));
  });
  // ---- service point menu
  route('POST', '/api/staff/menu-templates/:tpl', 'staff', async ({ res, p, user }) =>
    send(res, 200, admin.createMenuFromTemplate(db, { template: p.tpl, actor: user.email })));
  route('POST', '/api/staff/menus/:vid/import', 'staff', async ({ req, res, p, user }) => {
    const b = await readJson(req); send(res, 200, admin.importMenuCsv(db, { versionId: int(p.vid), csv: b.csv, actor: user.email }));
  });
  route('GET', '/api/staff/menus', 'staff', ({ res }) => send(res, 200, admin.listMenus(db)));
  route('POST', '/api/staff/menus', 'staff', async ({ req, res, user }) => {
    const b = await readJson(req);
    send(res, 200, admin.createMenuVersion(db, { code: b.code, name: b.name, effectiveDate: b.effectiveDate, copyFromId: b.copyFromId ? int(b.copyFromId) : null, actor: user.email }));
  });
  route('POST', '/api/staff/menus/:vid', 'staff', async ({ req, res, p, user }) => {
    const b = await readJson(req);
    send(res, 200, admin.updateMenuVersion(db, { id: int(p.vid), name: b.name, effectiveDate: b.effectiveDate, actor: user.email }));
  });
  route('POST', '/api/staff/menus/:vid/items', 'staff', async ({ req, res, p, user }) => {
    const b = await readJson(req);
    send(res, 200, admin.saveMenuItem(db, { ...b, versionId: int(p.vid), itemId: b.itemId ? int(b.itemId) : null, actor: user.email }));
  });
  route('POST', '/api/staff/menus/:vid/items/:iid/delete', 'staff', async ({ res, p, user }) => {
    admin.deleteMenuItem(db, { versionId: int(p.vid), itemId: int(p.iid), actor: user.email }); send(res, 200, { ok: true });
  });
  route('POST', '/api/staff/clients/:id/menu', 'staff', async ({ req, res, p, user }) => {
    const id = clientExists(int(p.id)); const b = await readJson(req);
    send(res, 200, admin.assignMenu(db, { clientId: id, versionId: int(b.versionId), actor: user.email }));
  });

  // ---- client logins (invite links: the client chooses their own password)
  const inviteLink = (req, token) => {
    const base = process.env.PUBLIC_URL || `${secureCookies ? 'https' : 'http'}://${req.headers.host}`;
    return `${base.replace(/\/$/, '')}/setup#t=${token}`; // fragment: never sent to servers or logs
  };
  route('GET', '/api/staff/clients/:id/users', 'staff', ({ res, p }) => send(res, 200, admin.listClientUsers(db, clientExists(int(p.id)))));
  route('POST', '/api/staff/clients/:id/users', 'staff', async ({ req, res, p, user }) => {
    const id = clientExists(int(p.id)); const b = await readJson(req);
    const r = admin.inviteClientUser(db, { clientId: id, email: b.email, name: b.name, actor: user.email });
    send(res, 200, { userId: r.userId, link: inviteLink(req, r.token), expires_at: r.expires_at });
  });
  route('POST', '/api/staff/clients/:id/users/:uid/link', 'staff', async ({ req, res, p, user }) => {
    const r = admin.newClientLink(db, { clientId: clientExists(int(p.id)), userId: int(p.uid), actor: user.email });
    send(res, 200, { link: inviteLink(req, r.token), expires_at: r.expires_at });
  });
  route('POST', '/api/staff/clients/:id/users/:uid/remove', 'staff', async ({ res, p, user }) => {
    admin.removeClientUser(db, { clientId: clientExists(int(p.id)), userId: int(p.uid), actor: user.email }); send(res, 200, { ok: true });
  });
  route('POST', '/api/invite/check', null, async ({ req, res }) => {
    const { token } = await readJson(req); const inv = auth.inviteInfo(db, token);
    if (!inv) throw new AppError(410, 'This link has expired or was already used. Ask your LeadG2 consultant for a new one.');
    send(res, 200, { name: inv.name, email: inv.email });
  });
  route('POST', '/api/invite/accept', null, async ({ req, res }) => {
    const r = auth.acceptInvite(db, await readJson(req));
    if (!r.ok) throw new AppError(400, r.error);
    send(res, 200, r);
  });

  route('POST', '/api/staff/clients/:id/hubspot-sync', 'staff', async ({ res, p, user }) => {
    const id = clientExists(int(p.id));
    if (!hubspot.configured) throw new AppError(409, 'HubSpot is not connected yet (HUBSPOT_PRIVATE_APP_TOKEN is not set on the server)');
    const r = await hubspotSync.syncClient(db, hubspot, id, { force: true, actor: user.email });
    if (r.status === 'skipped') throw new AppError(409, `${r.reason}. Add it under Admin → Clients → Edit.`);
    send(res, 200, r);
  });

  // ---- LeadG2 team
  route('GET', '/api/staff/team', 'staff', ({ res, user }) => send(res, 200, { me: user.id, members: admin.listStaff(db) }));
  route('POST', '/api/staff/team', 'staff', async ({ req, res, user }) => {
    const b = await readJson(req); const r = admin.inviteStaff(db, { email: b.email, name: b.name, actor: user.email });
    send(res, 200, { userId: r.userId, link: inviteLink(req, r.token), expires_at: r.expires_at });
  });
  route('POST', '/api/staff/team/:uid/link', 'staff', async ({ req, res, p, user }) => {
    const r = admin.newStaffLink(db, { userId: int(p.uid), actor: user.email });
    send(res, 200, { link: inviteLink(req, r.token), expires_at: r.expires_at });
  });
  route('POST', '/api/staff/team/:uid/remove', 'staff', async ({ res, p, user }) => {
    admin.removeStaff(db, { userId: int(p.uid), actorId: user.id, actor: user.email }); send(res, 200, { ok: true });
  });

  // ---- clients (customers)
  route('GET', '/api/staff/clients-admin', 'staff', ({ res }) => send(res, 200, admin.listClientsAdmin(db)));
  route('POST', '/api/staff/clients', 'staff', async ({ req, res, user }) => {
    const b = await readJson(req); send(res, 200, admin.createClient(db, { ...b, actor: user.email }));
  });
  route('POST', '/api/staff/clients/:id', 'staff', async ({ req, res, p, user }) => {
    const id = clientExists(int(p.id)); const b = await readJson(req);
    admin.updateClient(db, { ...b, clientId: id, actor: user.email }); send(res, 200, { ok: true });
  });

  // ---- source mappings
  route('POST', '/api/staff/clients/:id/mappings', 'staff', async ({ req, res, p, user }) => {
    const id = clientExists(int(p.id)); const b = await readJson(req);
    send(res, 200, admin.addMapping(db, { clientId: id, sourceType: b.sourceType, value: b.value, scope: b.scope, label: b.label, actor: user.email }));
  });
  route('POST', '/api/staff/clients/:id/mappings/:mid/remove', 'staff', async ({ res, p, user }) => {
    admin.removeMapping(db, { clientId: clientExists(int(p.id)), mappingId: int(p.mid), actor: user.email }); send(res, 200, { ok: true });
  });

  route('GET', '/api/staff/clickup/browse', 'staff', async ({ res }) => {
    const a = adapters.clickup;
    if (!a || typeof a.listHierarchy !== 'function') throw new AppError(409, a && a.message ? a.message : 'ClickUp is not connected');
    send(res, 200, await a.listHierarchy());
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
  const pages = { '/': 'login.html', '/login': 'login.html', '/staff': 'staff.html', '/client': 'client.html', '/setup': 'setup.html' };

  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      const getLike = req.method === 'GET' || req.method === 'HEAD'; // HEAD: Node omits the body automatically
      if (getLike && pages[url.pathname]) return serveStatic(res, pages[url.pathname]);
      if (getLike && url.pathname.startsWith('/static/')) return serveStatic(res, url.pathname.slice(8));
      if (req.method === 'HEAD' && url.pathname === '/healthz') return send(res, 200, '');
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
  const hasAdmin = () => db.prepare(`SELECT 1 FROM users WHERE role = 'staff' LIMIT 1`).get();
  if (!hasAdmin() && process.env.ADMIN_EMAIL) {
    // First start on a host with no terminal: create the first admin and print their one-time setup link to the logs.
    const admin = require('./admin');
    const r = admin.inviteStaff(db, { email: process.env.ADMIN_EMAIL, name: process.env.ADMIN_NAME || process.env.ADMIN_EMAIL, actor: 'first-start' });
    const base = (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, '');
    console.log(`First admin created for ${process.env.ADMIN_EMAIL}. Open this link within 7 days to choose a password:\n  ${base}/setup#t=${r.token}`);
  }
  if (!hasAdmin()) {
    console.error('No admin accounts yet. Set ADMIN_EMAIL (and ADMIN_NAME) and restart, or run `npm run create-admin -- you@leadg2.com "Your Name"`.');
    process.exit(1);
  }
  if (process.env.NODE_ENV === 'production' && !process.env.PUBLIC_URL) console.warn('PUBLIC_URL is not set: invite links will use the request host.');
  if (process.env.BACKUP_DAILY === '1') {
    require('./backup').scheduleDailyBackups(db, { dbFile: process.env.DB_FILE || require('node:path').join(__dirname, '..', 'data', 'leadg2.db') });
  }
  // Make sure the LeadG2 service point menu is there from the start.
  if (!db.prepare('SELECT 1 FROM menu_items LIMIT 1').get()) {
    const empty = db.prepare('SELECT id FROM menu_versions ORDER BY id DESC LIMIT 1').get();
    if (empty) {
      const csv = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'data', 'menus', 'leadg2-service-points-2026.csv'), 'utf8');
      const r = admin.importMenuCsv(db, { versionId: empty.id, csv, actor: 'first-start' });
      console.log(`Loaded the LeadG2 2026 menu into your existing menu (${r.added} items).`);
    } else {
      const r = admin.createMenuFromTemplate(db, { template: 'leadg2-2026', actor: 'first-start' });
      console.log(`Loaded the LeadG2 2026 menu (${r.added} items).`);
    }
  }
  const hubspot = new HubSpotSync();
  if (hubspot.configured) hubspotSync.scheduleHubSpotSync(db, hubspot);
  const demo = process.env.DEMO_MODE === '1';
  const adapters = defaultAdapters({ demo });
  require('./scheduler').scheduleSourceSync(db, adapters);
  const port = Number(process.env.PORT || 3000);
  http.createServer(createApp({ db, hubspot, adapters, demo })).listen(port, () => console.log(`LeadG2 points tracker listening on port ${port}`));
}

module.exports = { createApp };
