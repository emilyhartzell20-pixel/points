'use strict';
// Opening-balance import from the existing tracker, bulk CSV import, and manual entry.
// These keep the tracker usable even when a connector is down.
const crypto = require('node:crypto');
const { tx, audit, AppError, nowIso } = require('./db');
const ledger = require('./ledger');
const { requireItem, findItem } = require('./menu');

function parseCsv(text) {
  const rows = []; let row = []; let field = ''; let q = false;
  const s = String(text).replace(/^﻿/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { field += '"'; i++; } else if (c === '"') q = false; else field += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((v) => v.trim() !== ''));
  if (!nonEmpty.length) return [];
  const header = nonEmpty[0].map((h) => h.trim().toLowerCase());
  return nonEmpty.slice(1).map((r, idx) => {
    const o = { __line: idx + 2 };
    header.forEach((h, i) => { o[h] = (r[i] ?? '').trim(); });
    return o;
  });
}

const REQUIRED = ['tracker_id', 'date', 'title', 'points', 'status'];
const STATUS = { used: 'used', completed: 'used', complete: 'used', committed: 'committed', approved: 'committed', forecast: 'forecast', planned: 'forecast' };

/**
 * Import tracker rows. Idempotent on tracker_id: re-importing the same file changes nothing.
 * opening=true posts the reconciled opening balance and verifies it against the contract totals.
 */
function importTracker(db, { clientId, csv, actor, opening = false, filename = 'upload.csv' }) {
  const rows = parseCsv(csv);
  if (!rows.length) throw new AppError(400, 'The file has no rows');
  for (const k of REQUIRED) if (!(k in rows[0])) throw new AppError(400, `Missing column: ${k}`);
  const started = nowIso();
  const result = tx(db, () => {
    const contract = ledger.activeContract(db, clientId);
    if (opening && contract.opening_reconciled_at) {
      // Already imported: verify idempotently instead of re-posting.
      const dupes = rows.filter((r) => db.prepare('SELECT 1 FROM work_items WHERE client_id=? AND external_ref=?').get(clientId, `tracker:${r.tracker_id}`));
      if (dupes.length === rows.length) return { created: 0, skipped: rows.length, conflicts: [] };
      throw new AppError(409, `This client's opening balance is already set (${contract.opening_used || 0} used / ${contract.opening_committed || 0} committed). Untick "This is the reconciled opening balance" and import again: the rows are added to the ledger the same way.`);
    }
    let created = 0, skipped = 0; const conflicts = [];
    for (const r of rows) {
      const state = STATUS[String(r.status).toLowerCase()];
      const points = Number(r.points);
      if (!state) throw new AppError(400, `Line ${r.__line}: unknown status "${r.status}"`);
      if (!Number.isInteger(points) || points < 0) throw new AppError(400, `Line ${r.__line}: points must be a whole number`);
      const ref = `tracker:${r.tracker_id}`;
      const existing = db.prepare('SELECT * FROM work_items WHERE client_id = ? AND external_ref = ?').get(clientId, ref);
      if (existing) {
        skipped++;
        if (existing.points !== points || existing.state !== state) conflicts.push({ line: r.__line, tracker_id: r.tracker_id, note: `Ledger has ${existing.points} pts ${existing.state}; file has ${points} ${state}. Not overwritten — use a correction.` });
        continue;
      }
      const menu = r.menu_code ? (opening ? findItem(db, clientId, r.menu_code) : requireItem(db, clientId, r.menu_code)) : null;
      ledger.createWorkItem(db, {
        clientId, state, points, title: r.title, clientSummary: r.client_summary || null, summaryApproved: !!r.client_summary,
        externalRef: ref, groupKey: r.clickup_task_id ? `clickup:${r.clickup_task_id.toLowerCase()}` : null,
        menuItemCode: menu ? menu.code : (r.menu_code || null), menuItemName: menu ? menu.name : null,
        workDate: r.date, origin: opening ? 'opening' : 'import', internalNotes: r.notes || null, actor,
        reason: opening ? `Opening balance from tracker (${filename})` : `Imported from ${filename}`,
        overrideReason: r.override_reason || undefined,
      });
      created++;
    }
    if (opening) {
      const b = ledger.balance(db, clientId);
      if (contract.opening_used != null && (b.used !== contract.opening_used || b.committed !== contract.opening_committed)) {
        throw new AppError(409, `Opening balance does not reconcile: file gives ${b.used} used / ${b.committed} committed, ` +
          `contract record says ${contract.opening_used} used / ${contract.opening_committed} committed. Nothing was imported.`);
      }
      db.prepare('UPDATE contracts SET opening_reconciled_at = ? WHERE id = ?').run(nowIso(), contract.id);
    }
    audit(db, { clientId, actor, action: opening ? 'import.opening_balance' : 'import.tracker', detail: { filename, created, skipped, conflicts: conflicts.length } });
    return { created, skipped, conflicts };
  });
  db.prepare(`INSERT INTO sync_runs (client_id, source, mode, started_at, finished_at, status, records_seen, records_new)
              VALUES (?, 'tracker', 'file', ?, ?, 'success', ?, ?)`).run(clientId, started, nowIso(), rows.length, result.created);
  return result;
}

/** Manual entry. An idempotency key (e.g. from the form) prevents double submits. */
function manualEntry(db, p) {
  const ref = `manual:${p.idempotencyKey || crypto.randomUUID()}`;
  const dup = db.prepare('SELECT * FROM work_items WHERE client_id = ? AND external_ref = ?').get(p.clientId, ref);
  if (dup) return { item: dup, duplicate: true };
  if (!p.reason) throw new AppError(400, 'Give a reason / evidence note for the manual entry');
  if (!p.title || !String(p.title).trim()) throw new AppError(400, 'Describe the work');
  const points = Number(p.points);
  // Work that is not on the client's menu ("custom") is allowed, but must say why.
  const menu = p.menuItemCode ? requireItem(db, p.clientId, p.menuItemCode) : null;
  if (!menu && !p.exceptionReason) throw new AppError(400, 'This work is not on the service menu: explain how the point amount was agreed');
  if (menu && (points < menu.points_min || points > menu.points_max) && !p.exceptionReason) {
    throw new AppError(400, `Amount ${points} is outside the menu (${menu.points_min}–${menu.points_max}); give an exception reason`);
  }
  const notes = [p.internalNotes, p.evidenceUrl && `Evidence: ${p.evidenceUrl}`].filter(Boolean).join('\n') || null;
  const item = ledger.createWorkItem(db, {
    clientId: p.clientId, state: p.state, points, title: p.title, clientSummary: p.clientSummary, summaryApproved: !!p.summaryApproved,
    externalRef: ref, menuVersionId: menu ? menu.menu_version_id : undefined, menuItemCode: menu ? menu.code : null,
    menuItemName: menu ? menu.name : 'Custom (not on menu)', workDate: p.workDate,
    origin: 'manual', internalNotes: notes, actor: p.actor,
    reason: [p.reason, p.exceptionReason && `${menu ? 'Exception' : 'Custom pricing'}: ${p.exceptionReason}`].filter(Boolean).join(' · '), overrideReason: p.overrideReason,
  });
  return { item, duplicate: false };
}

module.exports = { parseCsv, importTracker, manualEntry };
