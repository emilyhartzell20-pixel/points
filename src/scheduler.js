'use strict';
// Automatic hourly sync of every client's ClickUp lists and Outlook mail, for connectors that are live.
const ingest = require('./ingest');

const SOURCE_TYPES = { clickup: ['clickup_list', 'clickup_space'], outlook: ['email_domain', 'email_address'] };

async function syncEverything(db, adapters, log = console) {
  // Hours trackers (calls & training logs) are re-read straight into the ledger; new calls are added.
  await ingest.refreshHoursTrackers(db, adapters.clickup, log);
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

function scheduleSourceSync(db, adapters, { minutes = Number(process.env.SYNC_EVERY_MINUTES || 60), log = console } = {}) {
  if (!Object.values(adapters).some((a) => a && a.mode === 'live')) return;
  const tick = () => syncEverything(db, adapters, log).catch((e) => log.error(`Scheduled sync error: ${e.message}`));
  setTimeout(tick, 2 * 60e3).unref();
  setInterval(tick, minutes * 60e3).unref();
  log.log(`Automatic sync every ${minutes} minutes is on for: ${Object.entries(adapters).filter(([, a]) => a.mode === 'live').map(([k]) => k).join(', ')}`);
}

module.exports = { syncEverything, scheduleSourceSync };
