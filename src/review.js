'use strict';
// Consultant actions on the review queue: approve (optionally with edits), edit, merge, dismiss.
const { tx, audit, AppError, nowIso } = require('./db');
const ledger = require('./ledger');
const { requireItem } = require('./menu');
const { generateSuggestions } = require('./ingest');

const ACTION_TO_STATE = { forecast: 'forecast', approve: 'committed', complete: 'used', cancel: 'canceled', change: null, support_hours: null };

function getSuggestion(db, id) {
  const s = db.prepare('SELECT * FROM suggestions WHERE id = ?').get(id);
  if (!s) throw new AppError(404, 'Suggestion not found');
  return s;
}

function listSuggestions(db, clientId, status = 'open') {
  const rows = db.prepare(`SELECT * FROM suggestions WHERE client_id = ? AND (? = 'all' OR status = ?) ORDER BY updated_at DESC, id DESC`)
    .all(clientId, status, status);
  const ev = db.prepare(`SELECT r.id, r.source_type, r.external_id, r.title, r.status, r.author, r.occurred_at, r.url, r.body, se.signal
                         FROM suggestion_evidence se JOIN source_records r ON r.id = se.source_record_id
                         WHERE se.suggestion_id = ? ORDER BY r.occurred_at`);
  return rows.map((s) => ({ ...s, flags: JSON.parse(s.flags), evidence: ev.all(s.id) }));
}

function requireOpen(s) {
  if (s.status !== 'open') throw new AppError(409, `Suggestion is already ${s.status}`);
}

/** Save reviewer edits without approving. Edited fields survive later evidence refreshes. */
function editSuggestion(db, { id, actor, title, menuItemCode, points, note }) {
  return tx(db, () => {
    const s = getSuggestion(db, id); requireOpen(s);
    let pmin = s.points_min, pmax = s.points_max;
    if (menuItemCode) { const m = requireItem(db, s.client_id, menuItemCode); pmin = m.points_min; pmax = m.points_max; }
    db.prepare(`UPDATE suggestions SET title=COALESCE(?,title), menu_item_code=COALESCE(?,menu_item_code), proposed_points=COALESCE(?,proposed_points),
        points_min=?, points_max=?, reviewer_note=COALESCE(?,reviewer_note), edited=1, updated_at=? WHERE id=?`)
      .run(title || null, menuItemCode || null, points ?? null, pmin, pmax, note || null, nowIso(), id);
    audit(db, { clientId: s.client_id, actor, action: 'suggestion.edit', entity: 'suggestion', entityId: id, detail: { title, menuItemCode, points } });
    return getSuggestion(db, id);
  });
}

/**
 * Approve a suggestion. The reviewer confirms the final state and amount. This is the ONLY path
 * from evidence to the ledger.
 */
function approveSuggestion(db, p) {
  return tx(db, () => {
    const s = getSuggestion(db, p.id); requireOpen(s);
    const actor = p.actor;
    const workDate = p.workDate || s.evidence_date || undefined;
    const evidenceIds = db.prepare('SELECT source_record_id FROM suggestion_evidence WHERE suggestion_id = ?').all(s.id).map((r) => r.source_record_id);
    let itemId = null;

    if (s.action === 'support_hours') {
      const hours = Number(p.hours ?? s.proposed_hours);
      if (!(hours > 0)) throw new AppError(400, 'Confirm the number of support hours');
      ledger.logSupportHours(db, { clientId: s.client_id, hours, description: p.clientSummary || p.title || s.title, workDate, actor, suggestionId: s.id });
    } else {
      const state = p.state || ACTION_TO_STATE[s.action];
      if (!state) throw new AppError(400, 'Choose the resulting state (forecast, committed, used or canceled)');
      const existing = s.work_item_id ? ledger.getItem(db, s.work_item_id)
        : db.prepare('SELECT * FROM work_items WHERE client_id = ? AND group_key = ?').get(s.client_id, s.group_key);
      const points = p.points != null && p.points !== '' ? Number(p.points) : s.proposed_points;

      if (existing) {
        itemId = existing.id;
        if (p.points != null && Number(p.points) !== existing.points && existing.state !== 'forecast') {
          if (!p.reason) throw new AppError(400, 'Changing the amount of an approved entry is a correction: give a reason');
        }
        if (state === existing.state) {
          if (points != null && points !== existing.points) ledger.correct(db, { itemId, points, actor, reason: p.reason, overrideReason: p.overrideReason });
        } else {
          ledger.transition(db, { itemId, to: state, actor, reason: p.reason || `Suggestion #${s.id} approved`, points: points ?? undefined,
            overrideReason: p.overrideReason, workDate });
        }
        if (p.clientSummary != null || p.summaryApproved != null) {
          ledger.setSummary(db, { itemId, clientSummary: p.clientSummary ?? existing.client_summary, approved: p.summaryApproved ?? existing.summary_approved, actor });
        }
      } else {
        if (state === 'canceled') throw new AppError(400, 'Nothing has been booked for this work yet; dismiss the suggestion instead');
        const code = p.menuItemCode || s.menu_item_code;
        const fromTracker = JSON.parse(s.flags).includes('points_from_tracker');
        if (!code && !fromTracker) throw new AppError(400, 'Choose the service menu item');
        // Points-tracker items may not map to a menu item: the tracker's Total Points is the agreed amount.
        const menuItem = code ? requireItem(db, s.client_id, code)
          : { code: null, name: 'From ClickUp points tracker', menu_version_id: undefined, points_min: 0, points_max: Number.MAX_SAFE_INTEGER };
        if (points == null || !Number.isInteger(points)) throw new AppError(400, `Confirm the point amount (menu: ${menuItem.points_min === menuItem.points_max ? menuItem.points_min : `${menuItem.points_min}–${menuItem.points_max}`})`);
        if ((points < menuItem.points_min || points > menuItem.points_max) && !p.reason) {
          throw new AppError(400, `Amount ${points} is outside the menu (${menuItem.points_min}–${menuItem.points_max}); give a reason for the exception`);
        }
        const dept = db.prepare(`SELECT json_extract(r.data, '$.department') d FROM suggestion_evidence se JOIN source_records r ON r.id = se.source_record_id
          WHERE se.suggestion_id = ? AND json_extract(r.data, '$.department') IS NOT NULL LIMIT 1`).get(s.id);
        const category = (dept && dept.d) || (menuItem.notes ? String(menuItem.notes).split(' · ')[0] : null);
        const item = ledger.createWorkItem(db, {
          category,
          clientId: s.client_id, state, points, title: p.title || s.title, groupKey: s.group_key,
          clientSummary: p.clientSummary, summaryApproved: !!p.summaryApproved,
          menuVersionId: menuItem.menu_version_id, menuItemCode: menuItem.code, menuItemName: menuItem.name,
          workDate, origin: 'suggestion', internalNotes: p.internalNotes, actor,
          reason: p.reason || `Suggestion #${s.id} approved`, overrideReason: p.overrideReason,
        });
        itemId = item.id;
      }
      const link = db.prepare('INSERT OR IGNORE INTO work_item_evidence (work_item_id, source_record_id) VALUES (?,?)');
      for (const rid of evidenceIds) link.run(itemId, rid);
    }

    db.prepare(`UPDATE suggestions SET status='approved', work_item_id=COALESCE(?, work_item_id), resolved_by=?, resolved_at=?, resolution_note=? WHERE id=?`)
      .run(itemId, actor, nowIso(), p.reason || null, s.id);
    audit(db, { clientId: s.client_id, actor, action: 'suggestion.approve', entity: 'suggestion', entityId: s.id, reason: p.reason,
      detail: { state: p.state || ACTION_TO_STATE[s.action], points: p.points ?? s.proposed_points, work_item_id: itemId } });
    return { suggestion: getSuggestion(db, s.id), workItemId: itemId };
  });
}

function dismissSuggestion(db, { id, actor, reason }) {
  if (!reason) throw new AppError(400, 'Give a reason for dismissing (e.g. included in consulting scope)');
  return tx(db, () => {
    const s = getSuggestion(db, id); requireOpen(s);
    db.prepare(`UPDATE suggestions SET status='dismissed', resolved_by=?, resolved_at=?, resolution_note=? WHERE id=?`).run(actor, nowIso(), reason, id);
    audit(db, { clientId: s.client_id, actor, action: 'suggestion.dismiss', entity: 'suggestion', entityId: id, reason });
    return getSuggestion(db, id);
  });
}

/** Merge suggestion `id` into `intoId`: its evidence joins the target deliverable permanently. */
function mergeSuggestion(db, { id, intoId, actor, reason }) {
  return tx(db, () => {
    const s = getSuggestion(db, id); const t = getSuggestion(db, intoId);
    requireOpen(s); requireOpen(t);
    if (s.client_id !== t.client_id) throw new AppError(400, 'Cannot merge across clients');
    if (s.id === t.id) throw new AppError(400, 'Cannot merge a suggestion into itself');
    db.prepare(`UPDATE source_records SET group_override = ?, group_key = ? WHERE client_id = ? AND group_key = ?`)
      .run(t.group_key, t.group_key, s.client_id, s.group_key);
    db.prepare(`UPDATE suggestions SET status='merged', merged_into=?, resolved_by=?, resolved_at=?, resolution_note=? WHERE id=?`)
      .run(t.id, actor, nowIso(), reason || null, s.id);
    audit(db, { clientId: s.client_id, actor, action: 'suggestion.merge', entity: 'suggestion', entityId: s.id, reason, detail: { into: t.id } });
    generateSuggestions(db, s.client_id);
    return getSuggestion(db, t.id);
  });
}

module.exports = { listSuggestions, editSuggestion, approveSuggestion, dismissSuggestion, mergeSuggestion, getSuggestion };
