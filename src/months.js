'use strict';
// Work grouped by month with a type (category) per item, for the "By month" views.
// The client version uses only client-approved descriptions; totals always include every item.
const ledger = require('./ledger');

const MAX_TYPES = 8; // fixed palette slots; more types fold into "Other"
const STAGE = { used: 'used', committed: 'committed', forecast: 'planned' };

function monthKey(d) { return String(d || '').slice(0, 7); }
function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
function monthsBetween(start, end) {
  const out = []; let [y, m] = monthKey(start).split('-').map(Number); const [ey, em] = monthKey(end).split('-').map(Number);
  while (y < ey || (y === ey && m <= em)) { out.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } if (out.length > 60) break; }
  return out;
}

function byMonth(db, clientId, { forClient = false, includePlanned = true } = {}) {
  const b = ledger.balance(db, clientId);
  const states = includePlanned ? ['used', 'committed', 'forecast'] : ['used', 'committed'];
  const rows = db.prepare(`SELECT w.id, w.title, w.client_summary, w.summary_approved, w.state, w.points, w.work_date, w.category, w.menu_item_code,
      (SELECT notes FROM menu_items mi WHERE mi.menu_version_id = w.menu_version_id AND mi.code = w.menu_item_code) AS menu_notes
    FROM work_items w WHERE w.client_id = ? AND w.state IN (${states.map(() => '?').join(',')}) ORDER BY w.work_date, w.id`).all(clientId, ...states);

  // Types: the item's own category, else its menu item's category, else "Other". Fixed alphabetical slots.
  for (const r of rows) r.type = (r.category || (r.menu_notes ? String(r.menu_notes).split(' · ')[0] : '') || 'Other').trim();
  const names = [...new Set(rows.map((r) => r.type))].filter((t) => t !== 'Other').sort((a, z) => a.localeCompare(z));
  const kept = names.slice(0, MAX_TYPES - (names.length > MAX_TYPES || rows.some((r) => r.type === 'Other') ? 1 : 0));
  for (const r of rows) if (!kept.includes(r.type)) r.type = 'Other';
  const types = [...kept, ...(rows.some((r) => r.type === 'Other') ? ['Other'] : [])].map((name, i) => ({ name, slot: i + 1 }));

  const keys = new Set(monthsBetween(b.term_start, b.term_end));
  for (const r of rows) keys.add(monthKey(r.work_date));
  const months = [...keys].sort().map((key) => ({ key, label: monthLabel(key), used: 0, committed: 0, planned: 0, items: [], other_points: 0 }));
  const idx = Object.fromEntries(months.map((m, i) => [m.key, i]));
  for (const r of rows) {
    const m = months[idx[monthKey(r.work_date)]];
    const stage = STAGE[r.state];
    m[stage] += r.points;
    if (forClient && !(r.summary_approved && r.client_summary)) { m.other_points += r.points; continue; }
    m.items.push(forClient
      ? { description: r.client_summary, stage, points: r.points, type: r.type, date: r.work_date }
      : { id: r.id, title: r.title, client_summary: r.client_summary, summary_approved: !!r.summary_approved, stage, points: r.points, type: r.type, date: r.work_date, menu_item_code: r.menu_item_code });
  }
  const order = { used: 0, committed: 1, planned: 2 };
  for (const m of months) m.items.sort((a, z) => order[a.stage] - order[z.stage] || a.type.localeCompare(z.type));
  return { types, months };
}

module.exports = { byMonth };
