'use strict';
// Quick-link cards at the top of a client's dashboard (their SharePoint folder, ClickUp board, etc.).
const { audit, AppError, nowIso } = require('./db');

const MAX_LINKS = 8;

function kindOf(url) {
  const host = new URL(url).hostname.toLowerCase();
  if (/(^|\.)sharepoint\.com$|(^|\.)onedrive\.(live\.)?com$|1drv\.ms$/.test(host)) return 'sharepoint';
  if (/(^|\.)clickup\.com$/.test(host)) return 'clickup';
  if (/(^|\.)hubspot\.com$|(^|\.)hs-sites\.com$/.test(host)) return 'hubspot';
  if (/(^|\.)google\.com$/.test(host)) return 'google';
  if (/(^|\.)teams\.microsoft\.com$/.test(host)) return 'teams';
  if (/(^|\.)canva\.com$/.test(host)) return 'canva';
  return 'link';
}

function listLinks(db, clientId) {
  return db.prepare('SELECT * FROM client_links WHERE client_id = ? ORDER BY sort, id').all(clientId);
}

/** What the client sees: label, address, short note, and a kind for the icon. */
function clientLinks(db, clientId) {
  return listLinks(db, clientId).map((l) => ({ label: l.label, url: l.url, note: l.note || null, kind: kindOf(l.url) }));
}

function addLink(db, { clientId, label, url, note, actor }) {
  label = String(label || '').trim(); note = String(note || '').trim();
  if (!label) throw new AppError(400, 'Give the link a name (for example "Your SharePoint folder")');
  if (label.length > 60) throw new AppError(400, 'Keep the name under 60 characters');
  if (note.length > 140) throw new AppError(400, 'Keep the description under 140 characters');
  let u;
  try { u = new URL(String(url || '').trim()); } catch { throw new AppError(400, 'Paste the full web address, starting with https://'); }
  if (u.protocol !== 'https:') throw new AppError(400, 'The web address must start with https://');
  const n = db.prepare('SELECT COUNT(*) n, COALESCE(MAX(sort), 0) s FROM client_links WHERE client_id = ?').get(clientId);
  if (n.n >= MAX_LINKS) throw new AppError(400, `Up to ${MAX_LINKS} links per client`);
  const r = db.prepare('INSERT INTO client_links (client_id, label, url, note, sort, created_at, created_by) VALUES (?,?,?,?,?,?,?)')
    .run(clientId, label, u.toString(), note || null, n.s + 1, nowIso(), actor);
  audit(db, { clientId, actor, action: 'client_link.add', detail: { label, url: u.toString() } });
  return db.prepare('SELECT * FROM client_links WHERE id = ?').get(Number(r.lastInsertRowid));
}

function removeLink(db, { clientId, linkId, actor }) {
  const l = db.prepare('SELECT * FROM client_links WHERE id = ? AND client_id = ?').get(linkId, clientId);
  if (!l) throw new AppError(404, 'Not found');
  db.prepare('DELETE FROM client_links WHERE id = ?').run(l.id);
  audit(db, { clientId, actor, action: 'client_link.remove', detail: { label: l.label, url: l.url } });
}

function moveLinkUp(db, { clientId, linkId }) {
  const all = listLinks(db, clientId);
  const i = all.findIndex((l) => l.id === linkId);
  if (i < 0) throw new AppError(404, 'Not found');
  if (i === 0) return;
  [all[i - 1], all[i]] = [all[i], all[i - 1]];
  const upd = db.prepare('UPDATE client_links SET sort = ? WHERE id = ?');
  all.forEach((l, k) => upd.run(k + 1, l.id));
}

module.exports = { listLinks, clientLinks, addLink, removeLink, moveLinkUp, kindOf };
