'use strict';
// Staff administration: the service point menu, client logins, and client-to-source mappings.
// Every change is audit-logged. Menu edits never touch approved work, because each work item
// stores its own approved amount, menu item and menu version.
const crypto = require('node:crypto');
const { tx, audit, AppError } = require('./db');
const auth = require('./auth');
const { parseCompanyId } = require('./adapters/hubspot');

function hubspotId(input) {
  if (input == null || input === '') return null;
  const id = parseCompanyId(input);
  if (id === undefined) throw new AppError(400, 'Paste the HubSpot company record URL or its ID number');
  return id;
}

// ------------------------------------------------------------------ service point menu
const parseKeywords = (k) => (Array.isArray(k) ? k : String(k || '').split(',')).map((x) => String(x).trim().toLowerCase()).filter(Boolean);

function listMenus(db) {
  const versions = db.prepare('SELECT * FROM menu_versions ORDER BY effective_date DESC, id DESC').all();
  return versions.map((v) => ({
    ...v,
    items: db.prepare('SELECT * FROM menu_items WHERE menu_version_id = ? ORDER BY name').all(v.id).map((i) => ({ ...i, keywords: JSON.parse(i.keywords) })),
    clients: db.prepare(`SELECT c.id, c.name FROM contracts k JOIN clients c ON c.id = k.client_id WHERE k.active = 1 AND k.menu_version_id = ? ORDER BY c.name`).all(v.id),
    approved_work_items: db.prepare('SELECT COUNT(*) n FROM work_items WHERE menu_version_id = ?').get(v.id).n,
  }));
}

function getVersion(db, id) {
  const v = db.prepare('SELECT * FROM menu_versions WHERE id = ?').get(id);
  if (!v) throw new AppError(404, 'Menu version not found');
  return v;
}

/** Create a new menu version, optionally copying every item from an existing one. */
function createMenuVersion(db, { code, name, effectiveDate, copyFromId, actor }) {
  code = String(code || '').trim();
  if (!code) throw new AppError(400, 'Give the menu a version label, e.g. 2027.1');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(effectiveDate || ''))) throw new AppError(400, 'Give the date this menu takes effect');
  if (db.prepare('SELECT 1 FROM menu_versions WHERE code = ?').get(code)) throw new AppError(409, `A menu called ${code} already exists`);
  return tx(db, () => {
    const r = db.prepare('INSERT INTO menu_versions (code, name, effective_date) VALUES (?,?,?)').run(code, String(name || `LeadG2 Service Point Menu ${code}`).trim(), effectiveDate);
    const id = Number(r.lastInsertRowid);
    if (copyFromId) {
      getVersion(db, copyFromId);
      db.prepare(`INSERT INTO menu_items (menu_version_id, code, name, points_min, points_max, keywords, notes, category)
                  SELECT ?, code, name, points_min, points_max, keywords, notes, category FROM menu_items WHERE menu_version_id = ?`).run(id, copyFromId);
    }
    audit(db, { actor, action: 'menu.version.create', entity: 'menu_version', entityId: id, detail: { code, copy_from: copyFromId || null } });
    return getVersion(db, id);
  });
}

function updateMenuVersion(db, { id, name, effectiveDate, actor }) {
  const v = getVersion(db, id);
  if (effectiveDate && !/^\d{4}-\d{2}-\d{2}$/.test(effectiveDate)) throw new AppError(400, 'Invalid date');
  db.prepare('UPDATE menu_versions SET name = COALESCE(?, name), effective_date = COALESCE(?, effective_date) WHERE id = ?').run(name || null, effectiveDate || null, id);
  audit(db, { actor, action: 'menu.version.update', entity: 'menu_version', entityId: id, detail: { from: { name: v.name, effective_date: v.effective_date }, to: { name, effectiveDate } } });
  return getVersion(db, id);
}

/** Add or edit a menu item. A range is points_min < points_max; a fixed price has them equal. */
function saveMenuItem(db, { versionId, itemId, code, name, pointsMin, pointsMax, keywords, notes, category, actor }) {
  getVersion(db, versionId);
  code = String(code || '').trim().toUpperCase().replace(/\s+/g, '-');
  name = String(name || '').trim();
  const min = Number(pointsMin); const max = pointsMax === '' || pointsMax == null ? min : Number(pointsMax);
  if (!name) throw new AppError(400, 'Give the item a name');
  if (!/^[A-Z0-9][A-Z0-9-]{0,29}$/.test(code)) throw new AppError(400, 'Short code: letters, numbers and dashes only (e.g. LP-BUILD)');
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max < min) throw new AppError(400, 'Points must be whole numbers, and the maximum cannot be lower than the minimum');
  const kw = JSON.stringify(parseKeywords(keywords).length ? parseKeywords(keywords) : [name.toLowerCase()]);
  return tx(db, () => {
    const clash = db.prepare('SELECT id FROM menu_items WHERE menu_version_id = ? AND code = ?').get(versionId, code);
    if (clash && clash.id !== Number(itemId)) throw new AppError(409, `Code ${code} is already used in this menu`);
    let id;
    if (itemId) {
      const before = db.prepare('SELECT * FROM menu_items WHERE id = ? AND menu_version_id = ?').get(itemId, versionId);
      if (!before) throw new AppError(404, 'Menu item not found');
      db.prepare('UPDATE menu_items SET code=?, name=?, points_min=?, points_max=?, keywords=?, notes=?, category=COALESCE(?, category) WHERE id=?').run(code, name, min, max, kw, notes || null, category === undefined ? null : (String(category).trim() || null), itemId);
      id = Number(itemId);
      audit(db, { actor, action: 'menu.item.update', entity: 'menu_item', entityId: id,
        detail: { version_id: versionId, from: { code: before.code, name: before.name, min: before.points_min, max: before.points_max }, to: { code, name, min, max } } });
    } else {
      id = Number(db.prepare('INSERT INTO menu_items (menu_version_id, code, name, points_min, points_max, keywords, notes, category) VALUES (?,?,?,?,?,?,?,?)')
        .run(versionId, code, name, min, max, kw, notes || null, category ? String(category).trim() : null).lastInsertRowid);
      audit(db, { actor, action: 'menu.item.create', entity: 'menu_item', entityId: id, detail: { version_id: versionId, code, name, min, max } });
    }
    return db.prepare('SELECT * FROM menu_items WHERE id = ?').get(id);
  });
}

function deleteMenuItem(db, { versionId, itemId, actor }) {
  const item = db.prepare('SELECT * FROM menu_items WHERE id = ? AND menu_version_id = ?').get(itemId, versionId);
  if (!item) throw new AppError(404, 'Menu item not found');
  db.prepare('DELETE FROM menu_items WHERE id = ?').run(itemId);
  audit(db, { actor, action: 'menu.item.delete', entity: 'menu_item', entityId: Number(itemId), detail: { version_id: versionId, code: item.code, name: item.name } });
}

/** Switch which menu a client's contract uses from now on. Approved work keeps its original amounts. */
function assignMenu(db, { clientId, versionId, actor }) {
  const v = getVersion(db, versionId);
  const k = db.prepare('SELECT * FROM contracts WHERE client_id = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(clientId);
  if (!k) throw new AppError(404, 'No active contract for client');
  db.prepare('UPDATE contracts SET menu_version_id = ? WHERE id = ?').run(versionId, k.id);
  audit(db, { clientId, actor, action: 'menu.assign', entity: 'contract', entityId: k.id, detail: { from_version_id: k.menu_version_id, to: v.code } });
  return v;
}

// ------------------------------------------------------------------ client logins
function listClientUsers(db, clientId) {
  return db.prepare(`SELECT u.id, u.email, u.name, u.password_set,
      (SELECT MAX(expires_at) FROM invites i WHERE i.user_id = u.id AND i.used_at IS NULL) AS invite_expires_at
    FROM users u WHERE u.role = 'client' AND u.client_id = ? ORDER BY u.name`).all(clientId)
    .map((u) => ({ ...u, status: u.password_set ? 'active' : (u.invite_expires_at && u.invite_expires_at > new Date().toISOString() ? 'invited' : 'invite_expired') }));
}

/** Add a client login. Returns a one-time link the client uses to choose their own password. */
function inviteClientUser(db, { clientId, email, name, actor }) {
  email = String(email || '').trim().toLowerCase();
  name = String(name || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError(400, 'Enter a valid email address');
  if (!name) throw new AppError(400, 'Enter the person\'s name');
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing) throw new AppError(409, existing.client_id === clientId ? 'This person already has a login; use "New link" to resend' : 'This email already belongs to another account');
  return tx(db, () => {
    // Unusable random password until the client sets their own through the link.
    const userId = auth.createUser(db, { email, name, role: 'client', clientId, password: crypto.randomBytes(32).toString('hex') });
    db.prepare('UPDATE users SET password_set = 0 WHERE id = ?').run(userId);
    const inv = auth.createInvite(db, { userId, actor });
    audit(db, { clientId, actor, action: 'client_user.invite', entity: 'user', entityId: userId, detail: { email } });
    return { userId, ...inv };
  });
}

function clientUser(db, clientId, userId) {
  const u = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'client' AND client_id = ?`).get(userId, clientId);
  if (!u) throw new AppError(404, 'Login not found for this client');
  return u;
}

/** New one-time link: resends an invite, or resets a forgotten password. */
function newClientLink(db, { clientId, userId, actor }) {
  const u = clientUser(db, clientId, userId);
  const inv = auth.createInvite(db, { userId: u.id, actor });
  audit(db, { clientId, actor, action: u.password_set ? 'client_user.reset_link' : 'client_user.reinvite', entity: 'user', entityId: u.id });
  return inv;
}

function removeClientUser(db, { clientId, userId, actor }) {
  const u = clientUser(db, clientId, userId);
  tx(db, () => {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM invites WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    audit(db, { clientId, actor, action: 'client_user.remove', entity: 'user', entityId: u.id, detail: { email: u.email } });
  });
}

// ------------------------------------------------------------------ source mappings
const MAP_TYPES = ['clickup_space', 'clickup_list', 'email_domain', 'email_address'];
const SCOPES = ['points', 'consulting', 'project', 'support_hours'];

function addMapping(db, { clientId, sourceType, value, scope = 'points', label, actor }) {
  if (!MAP_TYPES.includes(sourceType)) throw new AppError(400, 'Choose what kind of source this is');
  if (!SCOPES.includes(scope)) throw new AppError(400, 'Choose what kind of work this source holds');
  value = String(value || '').trim();
  if (sourceType.startsWith('email')) value = value.toLowerCase().replace(/^@/, '');
  if (sourceType.startsWith('clickup')) {
    // Accept a pasted ClickUp URL and pull the ID out of it.
    const m = /\/(?:li|l|s|v\/l(?:i)?)\/(?:\d+-)?(\d+)/.exec(value) || /^(\d+)$/.exec(value);
    if (!m) throw new AppError(400, 'Paste the ClickUp list or space ID (a number) or its URL');
    value = m[1];
  }
  if (sourceType === 'email_domain' && !/^[a-z0-9.-]+\.[a-z]{2,}$/.test(value)) throw new AppError(400, 'Enter a domain like clientname.com');
  if (sourceType === 'email_address' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value)) throw new AppError(400, 'Enter a full email address');
  const taken = db.prepare('SELECT m.*, c.name AS client_name FROM source_mappings m JOIN clients c ON c.id = m.client_id WHERE source_type = ? AND value = ?').get(sourceType, value);
  if (taken) throw new AppError(409, `That ${sourceType.replace('_', ' ')} is already mapped to ${taken.client_name}`);
  const r = db.prepare('INSERT INTO source_mappings (client_id, source_type, value, scope, label) VALUES (?,?,?,?,?)').run(clientId, sourceType, value, scope, label || null);
  audit(db, { clientId, actor, action: 'mapping.add', entity: 'source_mapping', entityId: Number(r.lastInsertRowid), detail: { sourceType, value, scope } });
  return db.prepare('SELECT * FROM source_mappings WHERE id = ?').get(Number(r.lastInsertRowid));
}

function removeMapping(db, { clientId, mappingId, actor }) {
  const m = db.prepare('SELECT * FROM source_mappings WHERE id = ? AND client_id = ?').get(mappingId, clientId);
  if (!m) throw new AppError(404, 'Mapping not found');
  db.prepare('DELETE FROM source_mappings WHERE id = ?').run(mappingId);
  audit(db, { clientId, actor, action: 'mapping.remove', entity: 'source_mapping', entityId: Number(mappingId), detail: { source_type: m.source_type, value: m.value } });
}

// ------------------------------------------------------------------ LeadG2 team (staff admins)
function listStaff(db) {
  return db.prepare(`SELECT u.id, u.email, u.name, u.password_set,
      (SELECT MAX(expires_at) FROM invites i WHERE i.user_id = u.id AND i.used_at IS NULL) AS invite_expires_at
    FROM users u WHERE u.role = 'staff' ORDER BY u.name`).all()
    .map((u) => ({ ...u, status: u.password_set ? 'active' : (u.invite_expires_at && u.invite_expires_at > new Date().toISOString() ? 'invited' : 'invite_expired') }));
}

/** Add a LeadG2 team member. They get a one-time link to choose their own password. */
function inviteStaff(db, { email, name, actor }) {
  email = String(email || '').trim().toLowerCase(); name = String(name || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new AppError(400, 'Enter a valid email address');
  if (!name) throw new AppError(400, 'Enter the person\'s name');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw new AppError(409, 'This email already has an account');
  return tx(db, () => {
    const userId = auth.createUser(db, { email, name, role: 'staff', password: crypto.randomBytes(32).toString('hex') });
    db.prepare('UPDATE users SET password_set = 0 WHERE id = ?').run(userId);
    const inv = auth.createInvite(db, { userId, actor });
    audit(db, { actor, action: 'staff.invite', entity: 'user', entityId: userId, detail: { email } });
    return { userId, ...inv };
  });
}

function staffUser(db, userId) {
  const u = db.prepare(`SELECT * FROM users WHERE id = ? AND role = 'staff'`).get(userId);
  if (!u) throw new AppError(404, 'Team member not found');
  return u;
}

function newStaffLink(db, { userId, actor }) {
  const u = staffUser(db, userId);
  const inv = auth.createInvite(db, { userId: u.id, actor });
  audit(db, { actor, action: u.password_set ? 'staff.reset_link' : 'staff.reinvite', entity: 'user', entityId: u.id });
  return inv;
}

function removeStaff(db, { userId, actorId, actor }) {
  const u = staffUser(db, userId);
  if (u.id === actorId) throw new AppError(400, 'You cannot remove yourself. Ask another admin.');
  const others = db.prepare(`SELECT COUNT(*) n FROM users WHERE role = 'staff' AND password_set = 1 AND id != ?`).get(u.id).n;
  if (!others) throw new AppError(400, 'At least one active admin must remain');
  tx(db, () => {
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM invites WHERE user_id = ?').run(u.id);
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    audit(db, { actor, action: 'staff.remove', entity: 'user', entityId: u.id, detail: { email: u.email } });
  });
}

// ------------------------------------------------------------------ clients (customers)
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));
const slugify = (name) => String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'client';

/**
 * Add a customer with their contract. The allocation must reference the signed agreement.
 * New customers start at zero. Customers moving over from the old tracker get their opening
 * totals recorded here and then reconciled by importing the tracker file (Import tab).
 */
function createClient(db, p) {
  const name = String(p.name || '').trim();
  if (!name) throw new AppError(400, 'Enter the client\'s name');
  if (!isDate(p.termStart) || !isDate(p.termEnd) || p.termEnd <= p.termStart) throw new AppError(400, 'Enter the contract start and end dates (end after start)');
  const base = Number(p.basePoints);
  if (!Number.isInteger(base) || base < 0) throw new AppError(400, 'Allocated points must be a whole number');
  if (!String(p.agreementRef || '').trim()) throw new AppError(400, 'Reference the signed agreement (the source of truth for the allocation)');
  getVersion(db, Number(p.menuVersionId));
  if (db.prepare('SELECT 1 FROM clients WHERE lower(name) = lower(?)').get(name)) throw new AppError(409, 'A client with this name already exists');
  const bonus = Number(p.bonusPoints || 0); const hours = Number(p.supportHours || 0);
  const used = Number(p.openingUsed || 0); const committed = Number(p.openingCommitted || 0);
  if (![bonus, used, committed].every((n) => Number.isInteger(n) && n >= 0) || !(hours >= 0)) throw new AppError(400, 'Numbers must be zero or more');
  const fromTracker = used > 0 || committed > 0;
  const openingDate = p.openingDate || p.termStart;
  if (!isDate(openingDate)) throw new AppError(400, 'Invalid opening balance date');
  const aliases = String(p.aliases || '').split(',').map((a) => a.trim()).filter(Boolean);

  return tx(db, () => {
    let slug = slugify(name); let n = 2;
    while (db.prepare('SELECT 1 FROM clients WHERE slug = ?').get(slug)) slug = `${slugify(name)}-${n++}`;
    const cid = Number(db.prepare('INSERT INTO clients (slug, name, aliases, hubspot_company_id) VALUES (?,?,?,?)').run(slug, name, JSON.stringify(aliases), hubspotId(p.hubspotCompanyId)).lastInsertRowid);
    const kid = Number(db.prepare(`INSERT INTO contracts (client_id, term_start, term_end, menu_version_id, agreement_ref, opening_balance_date, opening_used, opening_committed, opening_reconciled_at)
        VALUES (?,?,?,?,?,?,?,?,?)`).run(cid, p.termStart, p.termEnd, Number(p.menuVersionId), String(p.agreementRef).trim(), openingDate, used, committed,
      fromTracker ? null : new Date().toISOString()).lastInsertRowid);
    const addAlloc = db.prepare('INSERT INTO allocations (contract_id, kind, points, source_ref, verified_by) VALUES (?,?,?,?,?)');
    if (base > 0) addAlloc.run(kid, 'base', base, String(p.agreementRef).trim(), p.actor);
    if (bonus > 0) addAlloc.run(kid, 'bonus', bonus, String(p.bonusRef || p.agreementRef).trim(), p.actor);
    if (hours > 0) {
      db.prepare('INSERT INTO support_hour_banks (client_id, hours_purchased, source_ref, term_start, term_end) VALUES (?,?,?,?,?)')
        .run(cid, hours, String(p.supportRef || p.agreementRef).trim(), p.termStart, p.termEnd);
    }
    audit(db, { clientId: cid, actor: p.actor, action: 'client.create', entity: 'client', entityId: cid,
      detail: { name, term: [p.termStart, p.termEnd], base, bonus, support_hours: hours, opening: fromTracker ? { used, committed, date: openingDate } : null } });
    return { id: cid, slug, needs_opening_import: fromTracker };
  });
}

function updateClient(db, { clientId, name, aliases, termStart, termEnd, agreementRef, hubspotCompanyId, actor }) {
  const c = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!c) throw new AppError(404, 'Client not found');
  const k = db.prepare('SELECT * FROM contracts WHERE client_id = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(clientId);
  const ts = termStart || k.term_start; const te = termEnd || k.term_end;
  if (!isDate(ts) || !isDate(te) || te <= ts) throw new AppError(400, 'Contract end must be after the start');
  if (name && name.trim() !== c.name && db.prepare('SELECT 1 FROM clients WHERE lower(name) = lower(?) AND id != ?').get(name.trim(), clientId)) {
    throw new AppError(409, 'Another client already has this name');
  }
  tx(db, () => {
    db.prepare('UPDATE clients SET name = COALESCE(?, name), aliases = COALESCE(?, aliases) WHERE id = ?').run(
      name ? name.trim() : null, aliases == null ? null : JSON.stringify(String(aliases).split(',').map((a) => a.trim()).filter(Boolean)), clientId);
    db.prepare('UPDATE contracts SET term_start = ?, term_end = ?, agreement_ref = COALESCE(?, agreement_ref) WHERE id = ?').run(ts, te, agreementRef || null, k.id);
    if (hubspotCompanyId !== undefined) {
      db.prepare('UPDATE clients SET hubspot_company_id = ?, hubspot_synced = NULL WHERE id = ?').run(hubspotId(hubspotCompanyId), clientId);
    }
    audit(db, { clientId, actor, action: 'client.update', entity: 'client', entityId: clientId,
      detail: { from: { name: c.name, term: [k.term_start, k.term_end] }, to: { name, term: [ts, te] } } });
  });
}

function listClientsAdmin(db) {
  return db.prepare(`SELECT c.id, c.name, c.slug, c.aliases, c.portal_enabled, c.pilot, c.hubspot_company_id, k.term_start, k.term_end, k.agreement_ref,
      k.opening_used, k.opening_committed, k.opening_reconciled_at, v.code AS menu_code,
      (SELECT COALESCE(SUM(points),0) FROM allocations a WHERE a.contract_id = k.id) AS allocated,
      (SELECT COUNT(*) FROM users u WHERE u.client_id = c.id) AS logins,
      (SELECT COUNT(*) FROM source_mappings m WHERE m.client_id = c.id) AS sources
    FROM clients c LEFT JOIN contracts k ON k.client_id = c.id AND k.active = 1 LEFT JOIN menu_versions v ON v.id = k.menu_version_id
    ORDER BY c.pilot DESC, c.name`).all().map((c) => ({ ...c, aliases: JSON.parse(c.aliases) }));
}

// ------------------------------------------------------------------ menu import (CSV)
const MENU_TEMPLATES = {
  'leadg2-2026': { file: 'leadg2-service-points-2026.csv', code: '2026', name: 'LeadG2 Service Points 2026', effectiveDate: '2026-01-01' },
};

/**
 * Add or update menu items from a CSV with columns: code, name, points_min, points_max, category, keywords, notes.
 * Rows are matched by code, so re-importing an updated file changes prices without duplicating items.
 */
function importMenuCsv(db, { versionId, csv, actor }) {
  const { parseCsv } = require('./importer');
  getVersion(db, versionId);
  const rows = parseCsv(csv);
  if (!rows.length) throw new AppError(400, 'The file has no rows');
  for (const col of ['name', 'points_min']) if (!(col in rows[0])) throw new AppError(400, `Missing column: ${col}`);
  return tx(db, () => {
    let added = 0, updated = 0;
    for (const r of rows) {
      const code = (r.code || r.name).trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 30);
      const existing = db.prepare('SELECT id FROM menu_items WHERE menu_version_id = ? AND code = ?').get(versionId, code);
      const notes = (r.notes || '').trim() || null;
      try {
        saveMenuItem(db, { versionId, itemId: existing ? existing.id : null, code, name: r.name, pointsMin: r.points_min,
          pointsMax: r.points_max || r.points_min, keywords: r.keywords, notes, category: r.category || null, actor });
      } catch (e) { throw new AppError(400, `Line ${r.__line} (${r.name || code}): ${e.message}`); }
      if (existing) updated++; else added++;
    }
    audit(db, { actor, action: 'menu.import', entity: 'menu_version', entityId: versionId, detail: { added, updated } });
    return { added, updated };
  });
}

/** Create a menu version from a bundled template (e.g. the LeadG2 2026 menu). */
function createMenuFromTemplate(db, { template, actor }) {
  const t = MENU_TEMPLATES[template];
  if (!t) throw new AppError(404, 'Unknown menu template');
  const fs = require('node:fs'); const path = require('node:path');
  const csv = fs.readFileSync(path.join(__dirname, '..', 'data', 'menus', t.file), 'utf8');
  let code = t.code; let n = 2;
  while (db.prepare('SELECT 1 FROM menu_versions WHERE code = ?').get(code)) code = `${t.code}-${n++}`;
  return tx(db, () => {
    const v = createMenuVersion(db, { code, name: t.name, effectiveDate: t.effectiveDate, actor });
    const r = importMenuCsv(db, { versionId: v.id, csv, actor });
    return { ...v, ...r };
  });
}

module.exports = { importMenuCsv, createMenuFromTemplate, listStaff, inviteStaff, newStaffLink, removeStaff, createClient, updateClient, listClientsAdmin, listMenus, createMenuVersion, updateMenuVersion, saveMenuItem, deleteMenuItem, assignMenu,
  listClientUsers, inviteClientUser, newClientLink, removeClientUser, addMapping, removeMapping };
