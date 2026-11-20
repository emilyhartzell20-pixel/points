'use strict';
// Keeps HubSpot company records in step with the ledger. Only pushes when a client's numbers changed.
const { audit, nowIso } = require('./db');
const ledger = require('./ledger');
const { toProperties } = require('./adapters/hubspot');

async function syncClient(db, hubspot, clientId, { force = false, actor = 'system' } = {}) {
  const c = db.prepare('SELECT id, hubspot_company_id, hubspot_synced FROM clients WHERE id = ?').get(clientId);
  if (!c || !c.hubspot_company_id) return { status: 'skipped', reason: 'No HubSpot company linked' };
  const b = ledger.balance(db, clientId);
  const props = toProperties(b);
  const fingerprint = JSON.stringify({ id: c.hubspot_company_id, ...props, lg2_points_updated_at: undefined });
  if (!force && c.hubspot_synced === fingerprint) return { status: 'unchanged' };
  const run = db.prepare(`INSERT INTO sync_runs (client_id, source, mode, started_at, status) VALUES (?, 'hubspot', 'live', ?, 'running')`).run(clientId, nowIso());
  const runId = Number(run.lastInsertRowid);
  try {
    await hubspot.pushBalance(c.hubspot_company_id, b);
    db.prepare('UPDATE clients SET hubspot_synced = ? WHERE id = ?').run(fingerprint, clientId);
    db.prepare(`UPDATE sync_runs SET status='success', finished_at=?, records_seen=1, records_updated=1 WHERE id=?`).run(nowIso(), runId);
    return { status: 'success' };
  } catch (e) {
    const msg = String(e.message).slice(0, 300);
    db.prepare(`UPDATE sync_runs SET status='failed', finished_at=?, error=? WHERE id=?`).run(nowIso(), msg, runId);
    audit(db, { clientId, actor, action: 'sync.hubspot.failed', reason: msg });
    return { status: 'failed', error: msg };
  }
}

async function syncAll(db, hubspot) {
  const out = {};
  for (const { id } of db.prepare('SELECT id FROM clients WHERE hubspot_company_id IS NOT NULL').all()) out[id] = await syncClient(db, hubspot, id);
  return out;
}

/** Check every few minutes for changed balances. */
function scheduleHubSpotSync(db, hubspot, { minutes = 5, log = console } = {}) {
  const tick = () => syncAll(db, hubspot).catch((e) => log.error(`HubSpot sync failed: ${e.message}`));
  const t = setInterval(tick, minutes * 60e3); t.unref();
  setTimeout(tick, 30e3).unref();
}

module.exports = { syncClient, syncAll, scheduleHubSpotSync };
