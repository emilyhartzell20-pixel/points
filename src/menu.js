'use strict';
const { AppError } = require('./db');

function menuForClient(db, clientId) {
  const c = db.prepare('SELECT menu_version_id FROM contracts WHERE client_id = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(clientId);
  if (!c) return { version: null, items: [] };
  const version = db.prepare('SELECT * FROM menu_versions WHERE id = ?').get(c.menu_version_id);
  const items = db.prepare('SELECT * FROM menu_items WHERE menu_version_id = ? ORDER BY code').all(c.menu_version_id)
    .map((i) => ({ ...i, keywords: JSON.parse(i.keywords) }));
  return { version, items };
}

function findItem(db, clientId, code) {
  if (!code) return null;
  const { version, items } = menuForClient(db, clientId);
  const item = items.find((i) => i.code === code);
  return item ? { ...item, version } : null;
}

function requireItem(db, clientId, code) {
  const item = findItem(db, clientId, code);
  if (!item) throw new AppError(400, `Menu item ${code} is not on this client's menu`);
  return item;
}

// Best keyword match against the client's menu. Returns null when nothing matches clearly.
function matchByText(db, clientId, text) {
  const t = String(text || '').toLowerCase();
  const { items } = menuForClient(db, clientId);
  let best = null;
  for (const item of items) {
    const score = item.keywords.reduce((s, k) => (t.includes(k.toLowerCase()) ? s + k.length : s), 0);
    if (score > 0 && (!best || score > best.score)) best = { item, score };
  }
  return best ? best.item : null;
}

module.exports = { menuForClient, findItem, requireItem, matchByText };
