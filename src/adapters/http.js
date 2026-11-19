'use strict';
// Read-only HTTP helper for connectors. Only GET is allowed for data access, so a connector can
// never modify a ClickUp task or a mailbox. Tokens stay in server memory and are never logged.

async function getJson(url, headers, { fetchImpl = globalThis.fetch, method = 'GET' } = {}) {
  if (method !== 'GET') throw new Error('Connectors are read-only: only GET requests are permitted');
  const res = await fetchImpl(url, { method: 'GET', headers });
  if (!res.ok) {
    // Never echo headers or response bodies (could contain tokens or mail content) into sync errors.
    throw new Error(`${new URL(url).host} responded ${res.status}`);
  }
  return res.json();
}

module.exports = { getJson };
