'use strict';
// Live connector adapters, exercised against a mock fetch: read-only, credentials stay server-side.
const test = require('node:test');
const assert = require('node:assert/strict');
const { LiveClickUp, normalizeTask } = require('../src/adapters/clickup');
const { LiveOutlook, normalizeMessage } = require('../src/adapters/outlook');
const { getJson } = require('../src/adapters/http');

function mockFetch(routes) {
  const calls = [];
  const f = async (url, opts) => {
    calls.push({ url: String(url), method: opts.method, headers: opts.headers });
    const hit = routes.find(([re]) => re.test(String(url)));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => hit[1](String(url)) };
  };
  f.calls = calls;
  return f;
}

test('ClickUp live adapter uses GET only, pages through lists in a mapped space, and sends the token as a header', async () => {
  const fetchImpl = mockFetch([
    [/\/space\/9001\/list/, () => ({ lists: [{ id: 'L1' }] })],
    [/\/space\/9001\/folder/, () => ({ folders: [{ lists: [{ id: 'L2' }] }] })],
    [/\/list\/L1\/task.*page=0/, () => ({ tasks: [{ id: 'a1', name: 'Landing page', status: { status: 'complete' }, date_updated: '1762300000000', list: { id: 'L1' }, space: { id: '9001' } }], last_page: true })],
    [/\/list\/L2\/task.*page=0/, () => ({ tasks: [], last_page: true })],
  ]);
  const a = new LiveClickUp({ token: 'pk_secret', fetchImpl });
  const tasks = await a.fetchTasks({ mappings: [{ source_type: 'clickup_space', value: '9001' }], since: '2026-10-01T00:00:00Z' });
  assert.equal(tasks.length, 1);
  assert.ok(fetchImpl.calls.every((c) => c.method === 'GET'));
  assert.ok(fetchImpl.calls.every((c) => c.headers.Authorization === 'pk_secret'));
  assert.ok(fetchImpl.calls.every((c) => !c.url.includes('pk_secret')), 'token never in URL');
  assert.ok(fetchImpl.calls.some((c) => /date_updated_gt=\d+/.test(c.url)));
});

test('connectors refuse non-GET data requests and keep tokens out of error messages', async () => {
  await assert.rejects(getJson('https://api.clickup.com/api/v2/task/x', {}, { method: 'PUT' }), /read-only/);
  const a = new LiveClickUp({ token: 'pk_secret', fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ err: 'Token pk_secret invalid' }) }) });
  await assert.rejects(a.fetchTasks({ mappings: [{ source_type: 'clickup_list', value: '1' }] }), (e) => !/pk_secret/.test(e.message) && /401/.test(e.message));
  const unconfigured = new LiveClickUp({ token: '' });
  await assert.rejects(unconfigured.fetchTasks({ mappings: [{ source_type: 'clickup_list', value: '1' }] }), /not configured/);
});

test('Outlook live adapter searches only mapped participants/aliases since the watermark, read-only', async () => {
  const fetchImpl = mockFetch([[/graph\.microsoft\.com/, () => ({ value: [{ id: 'm1', conversationId: 'c', subject: 'Hi', receivedDateTime: '2026-11-01T00:00:00Z',
    from: { emailAddress: { address: 'Dana@HarborPoint.example' } }, body: { contentType: 'html', content: '<p>Approved &amp; go</p>' } }] })]]);
  const a = new LiveOutlook({ accessToken: 'tok', mailbox: 'team@leadg2.com', fetchImpl });
  const msgs = await a.fetchMessages({ mappings: [{ source_type: 'email_domain', value: 'harborpoint.example' }], aliases: ['Harbor Point'], since: '2026-10-01T00:00:00Z' });
  assert.equal(msgs.length, 1, 'deduplicated across searches');
  assert.equal(fetchImpl.calls.length, 2);
  assert.ok(fetchImpl.calls.every((c) => c.method === 'GET' && c.headers.Authorization === 'Bearer tok'));
  const q = decodeURIComponent(fetchImpl.calls[0].url);
  assert.match(q, /participants:harborpoint\.example AND received>=2026-10-01/);
  const n = normalizeMessage(msgs[0]);
  assert.equal(n.author, 'dana@harborpoint.example');
  assert.equal(n.body, 'Approved & go');
});

test('normalizers produce stable external ids', () => {
  const t = normalizeTask({ id: 'abc', name: 'x', status: { status: 'to do' }, date_created: '1762300000000', list: { id: '1' }, space: { id: '2' },
    custom_fields: [{ name: 'Service Menu Item', value: 'LP-BUILD' }] });
  assert.equal(t.external_id, 'abc');
  assert.equal(t.data.menu_code, 'LP-BUILD');
  const m = normalizeMessage({ id: 'graph-1', internetMessageId: '<x@y>', subject: 's', receivedDateTime: '2026-11-01T00:00:00Z' });
  assert.equal(m.external_id, '<x@y>', 'internetMessageId is stable across folders/moves');
});
