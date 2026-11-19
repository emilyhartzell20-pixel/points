'use strict';
// Sample-data seeding and the scripted "consultant review" used by the demo and tests.
const fs = require('node:fs');
const path = require('node:path');
const { tx } = require('./db');
const auth = require('./auth');
const importer = require('./importer');
const review = require('./review');
const ingest = require('./ingest');
const { SampleClickUp } = require('./adapters/clickup');
const { SampleOutlook } = require('./adapters/outlook');

const SAMPLE = path.join(__dirname, '..', 'data', 'sample');
const read = (f) => fs.readFileSync(path.join(SAMPLE, f), 'utf8');

const DEMO_STAFF = { email: 'consultant@leadg2.example', name: 'Demo Consultant', password: 'demo-consultant' };

function seedSample(db) {
  const menus = JSON.parse(read('menus.json'));
  const clients = JSON.parse(read('clients.json'));
  const ids = {};
  tx(db, () => {
    for (const m of menus) {
      const v = db.prepare('INSERT INTO menu_versions (code, name, effective_date) VALUES (?,?,?)').run(m.code, m.name, m.effective_date);
      for (const i of m.items) {
        db.prepare('INSERT INTO menu_items (menu_version_id, code, name, points_min, points_max, keywords, notes) VALUES (?,?,?,?,?,?,?)')
          .run(v.lastInsertRowid, i.code, i.name, i.points_min, i.points_max, JSON.stringify(i.keywords || []), i.notes || null);
      }
    }
    auth.createUser(db, { ...DEMO_STAFF, role: 'staff' });
    for (const c of clients) {
      const r = db.prepare('INSERT INTO clients (slug, name, aliases, portal_enabled, pilot) VALUES (?,?,?,?,?)')
        .run(c.slug, c.name, JSON.stringify(c.aliases || []), c.portal_enabled ? 1 : 0, c.pilot ? 1 : 0);
      const cid = Number(r.lastInsertRowid); ids[c.slug] = cid;
      const menuId = db.prepare('SELECT id FROM menu_versions WHERE code = ?').get(c.contract.menu).id;
      const k = c.contract;
      const ct = db.prepare(`INSERT INTO contracts (client_id, term_start, term_end, menu_version_id, agreement_ref, opening_balance_date, opening_used, opening_committed)
                             VALUES (?,?,?,?,?,?,?,?)`).run(cid, k.term_start, k.term_end, menuId, k.agreement_ref, k.opening_balance_date, k.opening_used, k.opening_committed);
      for (const a of c.allocations) {
        db.prepare('INSERT INTO allocations (contract_id, kind, points, source_ref, verified_by) VALUES (?,?,?,?,?)')
          .run(ct.lastInsertRowid, a.kind, a.points, a.source_ref, a.verified_by);
      }
      if (c.support_hours) {
        db.prepare('INSERT INTO support_hour_banks (client_id, hours_purchased, source_ref, term_start, term_end) VALUES (?,?,?,?,?)')
          .run(cid, c.support_hours.hours_purchased, c.support_hours.source_ref, k.term_start, k.term_end);
      }
      for (const m of c.mappings) {
        db.prepare('INSERT INTO source_mappings (client_id, source_type, value, scope, label) VALUES (?,?,?,?,?)').run(cid, m.source_type, m.value, m.scope, m.label);
      }
      for (const u of c.users) auth.createUser(db, { ...u, role: 'client', clientId: cid });
    }
  });
  for (const c of clients) {
    importer.importTracker(db, { clientId: ids[c.slug], csv: read(c.contract.opening_csv), actor: 'import@leadg2.example', opening: true, filename: c.contract.opening_csv });
  }
  return ids;
}

async function syncAllSample(db, ids) {
  const adapters = { clickup: new SampleClickUp(), outlook: new SampleOutlook() };
  const out = {};
  for (const [slug, id] of Object.entries(ids)) {
    out[slug] = {};
    for (const s of ['clickup', 'outlook']) out[slug][s] = await ingest.syncSource(db, { clientId: id, source: s, adapter: adapters[s], actor: 'demo-sync' });
  }
  return out;
}

/** The consultant decisions that take the pilot to 250 / 103 / 23 / 124. */
function applyDemoReview(db, clientId, actor = DEMO_STAFF.email) {
  const open = () => review.listSuggestions(db, clientId, 'open');
  const find = (gk, action) => {
    const s = open().find((x) => x.group_key === gk && x.action === action);
    if (!s) throw new Error(`Demo review: no open ${action} suggestion for ${gk}`);
    return s;
  };
  // 1. Lead scoring finished: move its 8 reserved points committed -> used.
  review.approveSuggestion(db, { id: find('clickup:86b2lead', 'complete').id, actor,
    clientSummary: 'Built and launched a lead scoring model (fit + engagement)', summaryApproved: true });
  // 2. Landing page: client approved and confirmed it is live. 10 pts used.
  review.approveSuggestion(db, { id: find('clickup:86b3land', 'complete').id, actor,
    clientSummary: 'Built the carrier partner program landing page and sign-up form', summaryApproved: true });
  // 3. Webinar emails canceled by the client: release the 8 reserved points.
  review.approveSuggestion(db, { id: find('clickup:86b2webi', 'cancel').id, actor, reason: 'Client canceled by email on 2026-10-09; ClickUp task to be closed' });
  // 4. Exception routing workflow: menu range 8–15, reviewer confirms 13 (4 branches + Slack alert).
  review.approveSuggestion(db, { id: find('clickup:86b3wflw', 'approve').id, actor, points: 13,
    reason: 'Confirmed 13 within WF-COMPLEX range: 4 branches plus Slack alert',
    clientSummary: 'Shipment exception routing workflow (approved, in progress)', summaryApproved: true });
  // 5. Dashboard is only a pricing request: track as forecast (does not reduce available).
  review.approveSuggestion(db, { id: find('clickup:86b3dash', 'forecast').id, actor, menuItemCode: 'DASH', points: 8 });
  // 6. Not point work.
  review.dismissSuggestion(db, { id: find('clickup:86b3cons', 'complete').id, actor, reason: 'Included in monthly consulting scope' });
  review.dismissSuggestion(db, { id: find('clickup:86b3proj', 'complete').id, actor, reason: 'Part of the fixed-scope website redesign project' });
  review.dismissSuggestion(db, { id: find('outlook:conv-inv', 'approve').id, actor, reason: 'Not a work request; contains instruction-like text. Forwarded to AR.' });
  // 7. Support hours go to the hours bank, not points.
  review.approveSuggestion(db, { id: find('clickup:86b3supp', 'support_hours').id, actor, hours: 1.5 });
  // 8. Uncertain match (personal email): confirm it is Harbor Point, then dismiss the request as consulting scope.
  const pending = ingest.matchQueue(db).find((r) => r.title === 'Harbor Point - quick question');
  if (pending) {
    ingest.resolveMatch(db, { recordId: pending.id, clientId, actor, reason: 'Dana confirmed this is her personal address' });
    review.dismissSuggestion(db, { id: find('outlook:conv-pers', 'forecast').id, actor, reason: 'User admin is covered by consulting scope' });
  }
  // The chatbot idea (email mention only) is intentionally left open: a mention never charges points.
}

module.exports = { seedSample, syncAllSample, applyDemoReview, DEMO_STAFF };
