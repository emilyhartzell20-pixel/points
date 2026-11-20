'use strict';
// A client's HTML editorial calendar: an HTML file LeadG2 uploads (or a web address) shown on the client
// dashboard in a sandboxed frame. The page runs in an isolated origin with no access to the app or its cookies.
const { audit, AppError, nowIso } = require('./db');

const MAX_HTML = 1.9e6;

function getPage(db, clientId) {
  return db.prepare('SELECT * FROM client_pages WHERE client_id = ?').get(clientId) || null;
}

/** Summary without the HTML itself (for staff screens and the client dashboard). */
function pageInfo(db, clientId) {
  const p = db.prepare('SELECT client_id, url, file_name, updated_at, updated_by, html IS NOT NULL AS has_html, length(html) AS size FROM client_pages WHERE client_id = ?').get(clientId);
  if (!p) return null;
  return p.has_html ? { kind: 'html', file_name: p.file_name, size: p.size, updated_at: p.updated_at, updated_by: p.updated_by }
    : { kind: 'url', url: p.url, updated_at: p.updated_at, updated_by: p.updated_by };
}

function setPage(db, { clientId, html, url, fileName, actor }) {
  if (html != null && url) throw new AppError(400, 'Upload a file or paste a web address, not both');
  if (html != null) {
    html = String(html);
    if (!html.trim()) throw new AppError(400, 'That file is empty');
    if (html.length > MAX_HTML) throw new AppError(413, 'That file is too large (limit about 1.9 MB). Ask Claude to slim it down or host it and paste the web address.');
    if (!/<(html|body|div|table|section|!doctype)/i.test(html)) throw new AppError(400, 'That doesn\'t look like an HTML page');
    url = null;
  } else {
    let u;
    try { u = new URL(String(url || '').trim()); } catch { throw new AppError(400, 'Upload an HTML file or paste a web address starting with https://'); }
    if (u.protocol !== 'https:') throw new AppError(400, 'The web address must start with https://');
    if (/(^|\.)clickup\.com$/i.test(u.hostname)) throw new AppError(400, 'ClickUp pages need a ClickUp login, so clients can\'t see them here. Upload the HTML file instead.');
    url = u.toString(); html = null;
  }
  db.prepare(`INSERT INTO client_pages (client_id, html, url, file_name, updated_at, updated_by) VALUES (?,?,?,?,?,?)
    ON CONFLICT(client_id) DO UPDATE SET html = excluded.html, url = excluded.url, file_name = excluded.file_name, updated_at = excluded.updated_at, updated_by = excluded.updated_by`)
    .run(clientId, html, url, html != null ? String(fileName || 'editorial-calendar.html').slice(0, 200) : null, nowIso(), actor);
  audit(db, { clientId, actor, action: 'editorial_page.set', detail: html != null ? { file_name: fileName || null, size: html.length } : { url } });
  return pageInfo(db, clientId);
}

function removePage(db, { clientId, actor }) {
  db.prepare('DELETE FROM client_pages WHERE client_id = ?').run(clientId);
  audit(db, { clientId, actor, action: 'editorial_page.remove' });
}

// Served on its own: sandboxed (opaque origin, so no cookies or app API), only embeddable by this app.
const PAGE_HEADERS = {
  'Content-Type': 'text/html; charset=utf-8',
  'Content-Security-Policy': "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self'; form-action 'none'",
};

module.exports = { getPage, pageInfo, setPage, removePage, PAGE_HEADERS, MAX_HTML };
