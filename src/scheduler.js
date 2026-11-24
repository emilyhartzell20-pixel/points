'use strict';
// Automatic hourly sync of every client's ClickUp lists and Outlook mail, for connectors that are live.
const ingest = require('./ingest');

// Only email still goes through the (optional) suggestion pipeline; ClickUp trackers are mirrored above.
const SOURCE_TYPES = { outlook: ['email_domain', 'email_address'] };

async function syncEverything(db, adapters, log = console) {
  // ClickUp trackers (points and hours) are mirrored straight into the ledger: ClickUp is the source of truth.
  await ingest.mirrorAll(db, adapters.clickup, log);
  for (const [source, types] of Object.entries(SOURCE_TYPES)) {
    const adapter = adapters[source];
    if (!adapter || adapter.mode !== 'live') continue;
    const clients = db.prepare(`SELECT DISTINCT client_id FROM source_mappings WHERE source_type IN (${types.map(() => '?').join(',')})`).all(...types);
    for (const { client_id: clientId } of clients) {
      const r = await ingest.syncSource(db, { clientId, source, adapter, actor: 'scheduled-sync' });
      if (r.status === 'failed') log.error(`Scheduled ${source} sync failed for client ${clientId}: ${r.error}`);
    }
  }
}

function scheduleSourceSync(db, adapters, { minutes = Number(process.env.SYNC_EVERY_MINUTES || 10), log = console } = {}) {
  if (!Object.values(adapters).some((a) => a && a.mode === 'live')) return;
  const tick = () => syncEverything(db, adapters, log).catch((e) => log.error(`Scheduled sync error: ${e.message}`));
  setTimeout(tick, 30e3).unref();
  setInterval(tick, minutes * 60e3).unref();
  log.log(`Automatic sync every ${minutes} minutes is on for: ${Object.entries(adapters).filter(([, a]) => a.mode === 'live').map(([k]) => k).join(', ')}`);
}

module.exports = { syncEverything, scheduleSourceSync };
