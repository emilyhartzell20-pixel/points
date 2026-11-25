'use strict';
// Monthly KPI recaps from a ClickUp doc, shaped like Questco's "[QUESTCO] Monthly KPI Recaps".
const test = require('node:test');
const assert = require('node:assert/strict');
const reports = require('../src/reports');
const feeds = require('../src/feeds');
const { seeded, startServer, client } = require('./helpers');
const { DEMO_STAFF } = require('../src/seed');
const { createApp } = require('../src/server');

const OCT = `## October Funnel Performance

| KPI | October 2026 |
| ---| --- |
| Contacts entering Marketing Qualified Lead (MQL) | 55 |
| Contacts entering Sales Qualified Lead (SQL) | 13 |
| New deals with Lead Source = Lead G2 | 13 |

## Deal Analysis

*   **13** LeadG2-sourced deals created during October.
*   **7** remain open and **4** are marked lost.

![](https://t9017740562.p.clickup-attachments.com/x/Screenshot.png)

**Total October points completed = 69**
[October service point tracker](https://app.clickup.com/t/86e0uz3mp).
<script>alert(1)</script>`;
const AUG = `### August at a Glance

| Metric | August | July | Trend |
| ---| ---| ---| --- |
| Sales Qualified Leads | 16 | 16 | Flat |
| Opportunities Created | 13 | 12 | +8% — new 2026 high |
| Closed-Won Deals | 0 | 1 | \\-1 |`;
const JAN = `### January Funnel Performance
*   30 Sales Qualified Leads
*   **SQLs:** **January 2026: 30 SQLs**
    *       *   SQLs increased from **20 in December → 30 in January (+50% MoM)**`;
const pages = [{ id: 'root', name: '[QUESTCO] Monthly KPI Recaps', content: '', pages: [
  { id: 'jan', name: 'Questco January KPI Recap', date_created: '1770053150493', content: JAN },
  { id: 'aug', name: 'Questco August KPI Recap', date_created: '1788193440326', content: AUG },
  { id: 'oct', name: 'October 2026 KPI Recap', date_created: '1793659593335', content: OCT },
] }];
const adapter = { mode: 'live', docPages: async (ws, doc) => { assert.deepEqual([ws, doc], ['9017740562', '8cqzk8j-25777']); return pages; } };
const URL_ = 'https://doc.clickup.com/9017740562/d/h/8cqzk8j-25777/049d44c31ae2474';

test('recap text becomes safe blocks: headings, lists, tables, links; no HTML', () => {
  const b = reports.toBlocks(OCT);
  assert.deepEqual(b.map((x) => x.type), ['h3', 'table', 'h3', 'ul', 'p', 'p', 'p', 'p']);
  assert.deepEqual(b[3].items[0], [{ t: '13', b: true }, { t: ' LeadG2-sourced deals created during October.' }]);
  assert.deepEqual(b[4].spans, [{ t: 'View image', href: 'https://t9017740562.p.clickup-attachments.com/x/Screenshot.png' }]);
  assert.ok(JSON.stringify(b).includes('"t":"<script>alert(1)</script>"'), 'raw HTML stays plain text');
  const j = reports.toBlocks(JAN);
  assert.equal(j[1].items[2].map((s) => s.t).join(''), 'SQLs increased from 20 in December → 30 in January (+50% MoM)');
  assert.equal(reports.toBlocks(AUG)[1].rows[2][3][0].t, '-1');
});

test('headline numbers come from the newest recap\'s first table', () => {
  assert.deepEqual(reports.headline(reports.toBlocks(OCT)), { month_label: 'October 2026', items: [
    { label: 'Contacts entering Marketing Qualified Lead (MQL)', value: '55', trend: null, compare: null },
    { label: 'Contacts entering Sales Qualified Lead (SQL)', value: '13', trend: null, compare: null },
    { label: 'New deals with Lead Source = Lead G2', value: '13', trend: null, compare: null }] });
  assert.equal(reports.headline(reports.toBlocks(AUG)).items[1].trend, '+8% — new 2026 high');
  assert.equal(reports.headline(reports.toBlocks(JAN)), null);
});

test('linked doc shows on that client\'s dashboard only, newest month first, next to points completed', async (t) => {
  const s = await seeded({ sync: false });
  s.db.prepare('UPDATE clients SET portal_enabled = 1').run();
  const srv = await startServer(createApp({ db: s.db, adapters: { clickup: adapter } }));
  t.after(srv.close);
  const staff = client(srv.base); await staff.login(DEMO_STAFF.email, DEMO_STAFF.password);
  const dana = client(srv.base); await dana.login('dana@harborpoint.example', 'demo-client');
  const pat = client(srv.base); await pat.login('pat@bluebirddental.example', 'demo-client');
  assert.equal((await dana.post(`/api/staff/clients/${s.hp}/report`, { url: URL_ })).status, 403);
  assert.equal((await staff.post(`/api/staff/clients/${s.hp}/report`, { url: 'https://example.com/doc' })).status, 400);
  const r = JSON.parse((await staff.post(`/api/staff/clients/${s.hp}/report`, { url: URL_ })).text);
  assert.equal(r.pages, 3);
  assert.equal((await staff.post(`/api/staff/clients/${s.bb}/report`, { url: URL_ })).status, 409, 'one doc, one client');
  s.db.prepare("UPDATE work_items SET work_date = '2026-10-15' WHERE client_id = ? AND state = 'used'").run(s.hp);
  const v = JSON.parse((await dana.get('/api/client/dashboard')).text).results;
  assert.deepEqual(v.months.map((m) => m.month), ['2026-10', '2026-08', '2026-01']);
  assert.equal(v.headline.items[0].value, '55');
  assert.ok(v.months[0].work_completed > 0);
  assert.doesNotMatch(JSON.stringify(v), new RegExp(DEMO_STAFF.email));
  assert.equal(JSON.parse((await pat.get('/api/client/dashboard')).text).results, null);
});
