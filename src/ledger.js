'use strict';
// The points ledger. All balance numbers are derived from append-only events, so every point is
// counted exactly once: reserve (+committed), consume (-committed +used), release (-committed).
const { tx, audit, AppError, nowIso, unitOf, assertAmount } = require('./db');

function activeContract(db, clientId) {
  const c = db.prepare('SELECT * FROM contracts WHERE client_id = ? AND active = 1 ORDER BY id DESC LIMIT 1').get(clientId);
  if (!c) throw new AppError(404, 'No active contract for client');
  return c;
}

function balance(db, clientId) {
  const contract = activeContract(db, clientId);
  const alloc = db.prepare(`SELECT COALESCE(SUM(points),0) total,
      COALESCE(SUM(CASE WHEN kind='base' THEN points END),0) base,
      COALESCE(SUM(CASE WHEN kind='bonus' THEN points END),0) bonus,
      COALESCE(SUM(CASE WHEN kind='purchase' THEN points END),0) purchase,
      MAX(created_at) last_at
    FROM allocations WHERE contract_id = ?`).get(contract.id);
  const led = db.prepare(`SELECT COALESCE(SUM(e.used_delta),0) used, COALESCE(SUM(e.committed_delta),0) committed,
      MAX(e.created_at) last_at
    FROM ledger_events e JOIN work_items w ON w.id = e.work_item_id
    WHERE e.client_id = ? AND w.contract_id = ?`).get(clientId, contract.id);
  const forecast = db.prepare(`SELECT COALESCE(SUM(points),0) f FROM work_items
    WHERE client_id = ? AND contract_id = ? AND state = 'forecast'`).get(clientId, contract.id).f;
  const allocated = Number(alloc.total);
  const used = Number(led.used);
  const committed = Number(led.committed);
  const lastUpdated = [alloc.last_at, led.last_at].filter(Boolean).sort().pop() || null;
  return {
    allocated, used, committed,
    available: allocated - used - committed,
    forecast: Number(forecast), // planned work: shown for planning only, never reduces available
    available_after_planned: allocated - used - committed - Number(forecast),
    allocation_breakdown: { base: Number(alloc.base), bonus: Number(alloc.bonus), purchase: Number(alloc.purchase) },
    term_start: contract.term_start, term_end: contract.term_end,
    last_updated: lastUpdated,
  };
}

function addEvent(db, item, type, committedDelta, usedDelta, actor, reason) {
  db.prepare(`INSERT INTO ledger_events (client_id, work_item_id, event_type, committed_delta, used_delta, actor, reason, created_at)
              VALUES (?,?,?,?,?,?,?,?)`).run(item.client_id, item.id, type, committedDelta, usedDelta, actor, reason || null, nowIso());
}

function getItem(db, id) {
  const w = db.prepare('SELECT * FROM work_items WHERE id = ?').get(id);
  if (!w) throw new AppError(404, 'Work item not found');
  return w;
}

function assertPoints(db, clientId, points) {
  assertAmount(points, unitOf(db, clientId));
}

// Guard against accidentally overdrawing. Callers may pass an override reason to proceed.
function checkCapacity(db, clientId, extra, overrideReason) {
  if (extra <= 0) return;
  const b = balance(db, clientId);
  if (b.available - extra < 0 && !overrideReason) {
    throw new AppError(409, `This would exceed the available balance (${b.available} available, ${extra} requested). Provide an override reason to proceed.`);
  }
}

/**
 * Create a work item in a given state and post the matching ledger events.
 * state: forecast | committed | used
 */
function createWorkItem(db, p) {
  return tx(db, () => {
    const contract = activeContract(db, p.clientId);
    assertPoints(db, p.clientId, p.points);
    if (!['forecast', 'committed', 'used'].includes(p.state)) throw new AppError(400, 'Invalid state');
    if (!p.title) throw new AppError(400, 'Title is required');
    if (p.state !== 'forecast' && p.origin !== 'opening') checkCapacity(db, p.clientId, p.points, p.overrideReason);
    const r = db.prepare(`INSERT INTO work_items (client_id, contract_id, group_key, external_ref, title, client_summary, summary_approved,
        state, points, menu_version_id, menu_item_code, menu_item_name, work_date, origin, internal_notes, created_by, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      p.clientId, contract.id, p.groupKey || null, p.externalRef || null, p.title, p.clientSummary || null,
      p.summaryApproved ? 1 : 0, p.state, p.points, p.menuVersionId ?? contract.menu_version_id,
      p.menuItemCode || null, p.menuItemName || null, p.workDate || nowIso().slice(0, 10), p.origin,
      p.internalNotes || null, p.actor, nowIso(), nowIso());
    const item0 = getItem(db, Number(r.lastInsertRowid));
    if (p.category) db.prepare('UPDATE work_items SET category = ? WHERE id = ?').run(String(p.category).trim().slice(0, 60), item0.id);
    const item = getItem(db, item0.id);
    const evType = p.origin === 'opening' ? 'opening' : null;
    if (p.state === 'committed') addEvent(db, item, evType || 'reserve', p.points, 0, p.actor, p.reason);
    if (p.state === 'used') addEvent(db, item, evType || 'consume_direct', 0, p.points, p.actor, p.reason);
    audit(db, { clientId: p.clientId, actor: p.actor, action: `work_item.create.${p.state}`, entity: 'work_item', entityId: item.id,
      reason: p.reason, detail: { points: p.points, origin: p.origin, menu_item_code: p.menuItemCode, override: p.overrideReason || undefined } });
    return item;
  });
}

/**
 * Move a work item between states. The points that move are always the item's own snapshotted
 * points, so completion can never charge a second time.
 */
function transition(db, { itemId, to, actor, reason, points, overrideReason, workDate }) {
  return tx(db, () => {
    let item = getItem(db, itemId);
    const from = item.state;
    if (from === to) return { item, changed: false }; // idempotent: completing twice is a no-op
    const allowed = {
      forecast: ['committed', 'used', 'canceled'],
      committed: ['used', 'canceled'],
      used: [],
      canceled: [],
    };
    if (!allowed[from].includes(to)) {
      throw new AppError(409, `Cannot move work from ${from} to ${to}${from === 'used' ? ' (use a correction instead)' : ''}`);
    }
    if (points != null && points !== item.points) {
      assertPoints(db, item.client_id, points);
      if (from === 'committed') {
        // Changing the amount of reserved work is a correction and must be explained.
        correct(db, { itemId, points, actor, reason: reason || 'Amount changed at completion' , overrideReason});
      } else {
        db.prepare('UPDATE work_items SET points = ? WHERE id = ?').run(points, itemId);
      }
      item = getItem(db, itemId);
    }
    const p = item.points;
    if (from === 'forecast' && to === 'committed') { checkCapacity(db, item.client_id, p, overrideReason); addEvent(db, item, 'reserve', p, 0, actor, reason); }
    if (from === 'forecast' && to === 'used') { checkCapacity(db, item.client_id, p, overrideReason); addEvent(db, item, 'consume_direct', 0, p, actor, reason); }
    if (from === 'committed' && to === 'used') addEvent(db, item, 'consume', -p, p, actor, reason);
    if (from === 'committed' && to === 'canceled') addEvent(db, item, 'release', -p, 0, actor, reason);
    db.prepare('UPDATE work_items SET state = ?, work_date = COALESCE(?, work_date), updated_at = ? WHERE id = ?')
      .run(to, workDate || (to === 'used' ? nowIso().slice(0, 10) : null), nowIso(), itemId);
    audit(db, { clientId: item.client_id, actor, action: `work_item.${from}->${to}`, entity: 'work_item', entityId: itemId, reason,
      detail: { points: p, override: overrideReason || undefined } });
    return { item: getItem(db, itemId), changed: true };
  });
}

/** Change the approved amount of a work item. Logged with who and why; never silently rewrites. */
function correct(db, { itemId, points, actor, reason, overrideReason }) {
  if (!reason || !String(reason).trim()) throw new AppError(400, 'A reason is required for corrections');
  assertPoints(db, getItem(db, itemId).client_id, points);
  return tx(db, () => {
    const item = getItem(db, itemId);
    const delta = points - item.points;
    if (delta === 0) return item;
    if (item.state === 'committed') { checkCapacity(db, item.client_id, delta, overrideReason); addEvent(db, item, 'correction', delta, 0, actor, reason); }
    if (item.state === 'used') { checkCapacity(db, item.client_id, delta, overrideReason); addEvent(db, item, 'correction', 0, delta, actor, reason); }
    if (item.state === 'canceled') throw new AppError(409, 'Canceled work cannot be corrected');
    db.prepare('UPDATE work_items SET points = ?, updated_at = ? WHERE id = ?').run(points, nowIso(), itemId);
    audit(db, { clientId: item.client_id, actor, action: 'work_item.correction', entity: 'work_item', entityId: itemId, reason,
      detail: { from: item.points, to: points, state: item.state } });
    return getItem(db, itemId);
  });
}

/**
 * Make a work item match its source exactly (state and amount), whatever it was before. Used when the
 * ClickUp tracker is the source of truth: the difference is posted as one logged correction event, so the
 * ledger stays append-only and every change is traceable. No capacity check: ClickUp decides.
 */
function mirrorItem(db, { itemId, state, points, actor, reason }) {
  return tx(db, () => {
    const item = getItem(db, itemId);
    if (item.state === state && item.points === points) return { item, changed: false };
    const cur = db.prepare('SELECT COALESCE(SUM(committed_delta),0) c, COALESCE(SUM(used_delta),0) u FROM ledger_events WHERE work_item_id = ?').get(itemId);
    const want = { c: state === 'committed' ? points : 0, u: state === 'used' ? points : 0 };
    const dc = want.c - Number(cur.c); const du = want.u - Number(cur.u);
    if (dc || du) addEvent(db, item, 'correction', dc, du, actor, reason);
    db.prepare('UPDATE work_items SET state = ?, points = ?, updated_at = ? WHERE id = ?').run(state, points, nowIso(), itemId);
    audit(db, { clientId: item.client_id, actor, action: 'work_item.mirror', entity: 'work_item', entityId: itemId, reason,
      detail: { from: { state: item.state, points: item.points }, to: { state, points } } });
    return { item: getItem(db, itemId), changed: true };
  });
}

function setSummary(db, { itemId, clientSummary, approved, actor }) {
  return tx(db, () => {
    const item = getItem(db, itemId);
    db.prepare('UPDATE work_items SET client_summary = ?, summary_approved = ?, updated_at = ? WHERE id = ?')
      .run(clientSummary ?? item.client_summary, approved ? 1 : 0, nowIso(), itemId);
    audit(db, { clientId: item.client_id, actor, action: 'work_item.summary', entity: 'work_item', entityId: itemId,
      detail: { approved: !!approved } });
    return getItem(db, itemId);
  });
}

function listItems(db, clientId) {
  return db.prepare(`SELECT w.*, (SELECT COALESCE(SUM(committed_delta),0) FROM ledger_events WHERE work_item_id = w.id) ledger_committed,
      (SELECT COALESCE(SUM(used_delta),0) FROM ledger_events WHERE work_item_id = w.id) ledger_used
    FROM work_items w WHERE w.client_id = ? ORDER BY w.work_date DESC, w.id DESC`).all(clientId);
}

function listEvents(db, clientId) {
  return db.prepare(`SELECT e.*, w.title FROM ledger_events e JOIN work_items w ON w.id = e.work_item_id
    WHERE e.client_id = ? ORDER BY e.id DESC`).all(clientId);
}

// --- HubSpot support-hours bank (hours only) ---
function supportHours(db, clientId) {
  const bank = db.prepare('SELECT * FROM support_hour_banks WHERE client_id = ? ORDER BY id DESC LIMIT 1').get(clientId);
  if (!bank) return null;
  const used = db.prepare('SELECT COALESCE(SUM(hours),0) h FROM support_hour_entries WHERE bank_id = ?').get(bank.id).h;
  const entries = db.prepare('SELECT work_date, hours, description FROM support_hour_entries WHERE bank_id = ? ORDER BY work_date DESC').all(bank.id);
  return { hours_purchased: bank.hours_purchased, hours_used: Number(used), hours_remaining: bank.hours_purchased - Number(used), entries };
}

function logSupportHours(db, { clientId, hours, description, workDate, actor, suggestionId }) {
  const bank = db.prepare('SELECT * FROM support_hour_banks WHERE client_id = ? ORDER BY id DESC LIMIT 1').get(clientId);
  if (!bank) throw new AppError(409, 'This client has no support-hours bank');
  if (!(hours > 0)) throw new AppError(400, 'Hours must be positive');
  db.prepare(`INSERT INTO support_hour_entries (bank_id, work_date, hours, description, suggestion_id, actor) VALUES (?,?,?,?,?,?)`)
    .run(bank.id, workDate || nowIso().slice(0, 10), hours, description, suggestionId || null, actor);
  audit(db, { clientId, actor, action: 'support_hours.log', detail: { hours, description } });
}

/**
 * Add points to the contract allocation (bonus or additional purchase). Each addition needs a
 * reference to the agreement / order form, because the signed paperwork is the source of truth.
 */
function addAllocation(db, { clientId, kind, points, sourceRef, actor, note }) {
  if (!['bonus', 'purchase', 'base'].includes(kind)) throw new AppError(400, 'Choose bonus, purchase or base');
  assertAmount(points, unitOf(db, clientId), { positive: true });
  if (!sourceRef || !String(sourceRef).trim()) throw new AppError(400, 'Reference the signed agreement, order form or approval for these points');
  return tx(db, () => {
    const contract = activeContract(db, clientId);
    const r = db.prepare('INSERT INTO allocations (contract_id, kind, points, source_ref, verified_by, created_at) VALUES (?,?,?,?,?,?)')
      .run(contract.id, kind, points, String(sourceRef).trim(), actor, nowIso());
    audit(db, { clientId, actor, action: `allocation.add.${kind}`, entity: 'allocation', entityId: Number(r.lastInsertRowid), reason: note || null,
      detail: { points, source_ref: sourceRef } });
    return db.prepare('SELECT * FROM allocations WHERE id = ?').get(Number(r.lastInsertRowid));
  });
}

module.exports = { mirrorItem, addAllocation, activeContract, balance, createWorkItem, transition, correct, setSummary, listItems, listEvents,
  supportHours, logSupportHours, getItem };
