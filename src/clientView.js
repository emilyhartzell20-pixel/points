'use strict';
// The ONLY function that produces client-facing data. It builds the response from an explicit
// allow-list of fields, so email bodies, internal notes, review suggestions, source links and other
// clients' data cannot leak. Staff "preview" calls this exact function.
const ledger = require('./ledger');
const { byMonth } = require('./months');

function clientDashboard(db, clientId) {
  const client = db.prepare('SELECT id, name, show_planned FROM clients WHERE id = ?').get(clientId);
  if (!client) return null;
  const b = ledger.balance(db, clientId);
  const items = db.prepare(`SELECT id, state, points, work_date, client_summary, summary_approved FROM work_items
      WHERE client_id = ? AND state IN ('used','committed') ORDER BY CASE state WHEN 'committed' THEN 0 ELSE 1 END, work_date DESC, id DESC`).all(clientId);
  const shown = items.filter((i) => i.summary_approved && i.client_summary);
  const hidden = items.filter((i) => !(i.summary_approved && i.client_summary));
  const toRow = (i) => ({ date: i.work_date, description: i.client_summary, points: i.points });
  const hours = ledger.supportHours(db, clientId);
  return {
    client: { name: client.name },
    contract_term: { start: b.term_start, end: b.term_end },
    balance: { allocated: b.allocated, used: b.used, committed: b.committed, available: b.available },
    allocation_breakdown: b.allocation_breakdown,
    last_updated: b.last_updated,
    upcoming: shown.filter((i) => i.state === 'committed').map(toRow),
    completed: shown.filter((i) => i.state === 'used').map(toRow),
    // Keeps the totals reconcilable while a summary is still being written.
    pending_summaries: {
      used_points: hidden.filter((i) => i.state === 'used').reduce((s, i) => s + i.points, 0),
      committed_points: hidden.filter((i) => i.state === 'committed').reduce((s, i) => s + i.points, 0),
      count: hidden.length,
    },
    by_month: byMonth(db, clientId, { forClient: true, includePlanned: !!client.show_planned }),
    planned: client.show_planned ? { points: b.forecast, available_after: b.available_after_planned } : null,
    support_hours: hours ? { purchased: hours.hours_purchased, used: hours.hours_used, remaining: hours.hours_remaining } : null,
  };
}

module.exports = { clientDashboard };
