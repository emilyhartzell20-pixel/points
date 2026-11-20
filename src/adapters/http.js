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

// The ONE exception: answering a review on the client's behalf (set a task's status, add a comment).
// Limited to exactly these two ClickUp endpoints, so no other data can ever be changed.
const WRITES = [
  { method: 'PUT', re: /^\/api\/v2\/task\/[A-Za-z0-9_-]+$/ },
  { method: 'POST', re: /^\/api\/v2\/task\/[A-Za-z0-9_-]+\/comment$/ },
];
async function writeJson(url, headers, { method, body, fetchImpl = globalThis.fetch }) {
  const u = new URL(url);
  if (u.host !== 'api.clickup.com' || !WRITES.some((w) => w.method === method && w.re.test(u.pathname))) {
    throw new Error('This write is not permitted');
  }
  const res = await fetchImpl(url, { method, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`${u.host} responded ${res.status}`);
  return res.json().catch(() => ({}));
}

module.exports = { getJson, writeJson };
