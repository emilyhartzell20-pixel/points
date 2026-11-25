'use strict';
// Client-facing ClickUp lists: the editorial calendar and "waiting on you" (items ready for the client's review).
// The app copies title, status and date of each task; never descriptions, comments or assignees.
// Its one write: when a client answers a review here, it sets that task's status and adds their comment.
const { tx, audit, AppError, nowIso } = require('./db');

const KINDS = ['calendar', 'collaboration'];
const msToDate = (v) => (v ? new Date(Number(v)).toISOString().slice(0, 10) : null);

function listFeeds(db, clientId) {
  return db.prepare('SELECT * FROM client_feeds WHERE client_id = ? ORDER BY kind, id').all(clientId);
}

/** A list, folder or whole space, from a ClickUp URL, "space:ID"/"folder:ID", or a bare list ID. */
function parseTarget(v) {
  const t = String(v || '').trim();
  let m = /^(space|folder|list):(\d+)$/.exec(t);
  if (m) return { scope: m[1], id: m[2] };
  m = /\/(?:v\/)?(li|l|f|s)\/(?:\d+-)?(\d+)/.exec(t);
  if (m) return { scope: { li: 'list', l: 'list', f: 'folder', s: 'space' }[m[1]], id: m[2] };
  m = /^(\d+)$/.exec(t);
  return m ? { scope: 'list', id: m[1] } : null;
}

function addFeed(db, { clientId, kind, listId, label, actor }) {
  if (!KINDS.includes(kind)) throw new AppError(400, 'Choose editorial calendar or client approvals');
  const target = parseTarget(listId);
  if (!target) throw new AppError(400, 'Pick a ClickUp list, folder or space (or paste its URL)');
  if (kind === 'calendar' && target.scope !== 'list') throw new AppError(400, 'For the editorial calendar, pick the calendar list itself');
  const taken = db.prepare('SELECT f.*, c.name FROM client_feeds f JOIN clients c ON c.id = f.client_id WHERE kind = ? AND list_id = ?').get(kind, target.id);
  if (taken) throw new AppError(409, `That ${target.scope} is already shown for ${taken.name}`);
  const r = db.prepare('INSERT INTO client_feeds (client_id, kind, list_id, scope, label) VALUES (?,?,?,?,?)').run(clientId, kind, target.id, target.scope, label || null);
  audit(db, { clientId, actor, action: `feed.add.${kind}`, detail: { [`${target.scope}_id`]: target.id, label } });
  return db.prepare('SELECT * FROM client_feeds WHERE id = ?').get(Number(r.lastInsertRowid));
}

function removeFeed(db, { clientId, feedId, actor }) {
  const f = db.prepare('SELECT * FROM client_feeds WHERE id = ? AND client_id = ?').get(feedId, clientId);
  if (!f) throw new AppError(404, 'Not found');
  tx(db, () => { db.prepare('DELETE FROM feed_items WHERE feed_id = ?').run(f.id); db.prepare('DELETE FROM client_feeds WHERE id = ?').run(f.id); });
  audit(db, { clientId, actor, action: `feed.remove.${f.kind}`, detail: { list_id: f.list_id } });
}

const MAPPING = { list: 'clickup_list', folder: 'clickup_folder', space: 'clickup_space' };
const isClosed = (t) => { const ty = t.status && t.status.type; return ty === 'closed' || ty === 'done'; };

/** Re-read every feed for a client (or all clients) from ClickUp. */
async function refreshFeeds(db, adapter, { clientId = null } = {}) {
  if (!adapter || adapter.mode !== 'live') return { refreshed: 0 };
  const feeds = clientId ? listFeeds(db, clientId) : db.prepare('SELECT * FROM client_feeds').all();
  let refreshed = 0;
  for (const f of feeds) {
    try {
      const approvals = f.kind === 'collaboration';
      const tasks = await adapter.fetchTasks({ mappings: [{ source_type: MAPPING[f.scope || 'list'], value: f.list_id }], since: null, includeClosed: !approvals });
      // People at this client who have a login here: tasks assigned to them count as "waiting on you".
      const clientEmails = new Set(db.prepare('SELECT lower(email) e FROM users WHERE client_id = ?').all(f.client_id).map((r) => r.e));
      // Someone at the client: a login for this client, or any assignee who isn't on the LeadG2 team
      // (the client's people are in their ClickUp space as guests before they ever get a login here).
      const isClientPerson = (a) => {
        const email = String((a && a.email) || '').toLowerCase();
        if (!email) return false;
        if (clientEmails.has(email)) return true;
        const domain = email.split('@')[1] || '';
        return !internalDomains().some((d) => domain === d || domain.endsWith(`.${d}`));
      };
      tx(db, () => {
        db.prepare('DELETE FROM feed_items WHERE feed_id = ?').run(f.id);
        const ins = db.prepare(`INSERT OR REPLACE INTO feed_items (feed_id, task_id, title, status, status_type, due_date, url, list_id, assigned_to_client)
          VALUES (?,?,?,?,?,?,?,?,?)`);
        for (const t of tasks) {
          const status = t.status && (t.status.status || t.status);
          const assigned = (t.assignees || []).some(isClientPerson);
          if (approvals) {
            // Approvals watch whole spaces, so keep only what's waiting on the client.
            if (isClosed(t) || NOT_YET.test(status || '') || !(WAITING.test(status || '') || assigned)) continue;
          } else if (t.parent) continue; // steps under a piece of content aren't shown on the calendar
          ins.run(f.id, String(t.id), String(t.name || '').trim(), status || null, (t.status && t.status.type) || null,
            msToDate(t.due_date || t.start_date), t.url || `https://app.clickup.com/t/${t.id}`, t.list && t.list.id ? String(t.list.id) : (f.scope === 'list' ? f.list_id : null), assigned ? 1 : 0);
        }
        db.prepare('UPDATE client_feeds SET refreshed_at = ?, last_error = NULL WHERE id = ?').run(nowIso(), f.id);
      });
      refreshed++;
    } catch (e) {
      db.prepare('UPDATE client_feeds SET last_error = ? WHERE id = ?').run(String(e.message).slice(0, 300), f.id);
    }
  }
  return { refreshed };
}

// Plain-language stages for the client.
function calendarStage(status, type) {
  const s = String(status || '').toLowerCase();
  if (type === 'closed' || /(publish|done|complete|live|posted|closed)/.test(s)) return 'published';
  if (/(review|approval)/.test(s)) return 'in_review';
  if (/(progress|draft|writing|design|revision|edit)/.test(s)) return 'in_progress';
  return 'planned';
}
const WAITING = /(ready for review|client review|client approval|client feedback|pending client|awaiting|waiting on client|needs approval|for approval|pending approval)/i;
// Not with the client yet (or back with LeadG2): never shown as waiting.
const NOT_YET = /(not ready|ready to start|under revision|revision needed|internal)/i;
// Tasks that are a to-do for the client rather than something to approve.
const TODO_NAME = /^\s*(submit|send|provide|share|complete|fill|upload|schedule|book|sign up|register|confirm|add|update|grant|invite|connect)\b/i;
function internalDomains() {
  return String(process.env.INTERNAL_EMAIL_DOMAINS || 'leadg2.com,thecenterforsalesstrategy.com').toLowerCase().split(',').map((d) => d.trim()).filter(Boolean);
}
/** What the client does with an item: 'review' (approve / request changes), 'assigned' (mark done), or null. */
function itemAction(i) {
  const status = String(i.status || '');
  if (NOT_YET.test(status)) return null;
  if (WAITING.test(status)) return 'review';
  if (!i.assigned_to_client) return null;
  return /^ready\b/i.test(status) && !TODO_NAME.test(i.title || '') ? 'review' : 'assigned';
}

/** What the client sees. Allow-listed fields only. */
function clientFeeds(db, clientId, { today = new Date().toISOString().slice(0, 10) } = {}) {
  const feeds = listFeeds(db, clientId);
  if (!feeds.length) return null;
  const items = (kind) => db.prepare(`SELECT i.* FROM feed_items i JOIN client_feeds f ON f.id = i.feed_id WHERE f.client_id = ? AND f.kind = ?`).all(clientId, kind);
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 31 * 86400e3).toISOString().slice(0, 10);
  const calendar = feeds.some((f) => f.kind === 'calendar')
    ? items('calendar').filter((i) => i.due_date && i.due_date >= from)
      .sort((a, z) => a.due_date.localeCompare(z.due_date))
      .map((i) => ({ title: i.title, date: i.due_date, stage: calendarStage(i.status, i.status_type) }))
    : null;
  const waiting = feeds.some((f) => f.kind === 'collaboration')
    ? items('collaboration').filter((i) => itemAction(i))
      .sort((a, z) => String(a.due_date || '9999').localeCompare(String(z.due_date || '9999')))
      .map((i) => (itemAction(i) === 'review'
        ? { id: i.task_id, title: i.title, due: i.due_date, url: i.url, action: 'review', status: 'Ready for your review' }
        : { id: i.task_id, title: i.title, due: i.due_date, url: i.url, action: 'assigned', status: 'Assigned to you' }))
    : null;
  const refreshed = feeds.map((f) => f.refreshed_at).filter(Boolean).sort()[0] || null;
  return { calendar, waiting, refreshed_at: refreshed };
}

// ------------------------------------------------------------------ answering a review from the dashboard
const pick = (statuses, tests) => {
  for (const t of tests) { const s = statuses.find((x) => (typeof t === 'function' ? t(x) : t.test(String(x.status || '')))); if (s) return s.status; }
  return null;
};
function targetStatus(statuses, decision) {
  if (decision === 'approve') return pick(statuses, [/^(client )?approved$/i, /approved/i, /^(done|complete|completed)$/i, (x) => x.type === 'closed']);
  if (decision === 'done') return pick(statuses, [/^(done|complete|completed)$/i, (x) => x.type === 'closed', (x) => x.type === 'done']);
  return pick(statuses, [/revision(s)? needed|changes requested|needs? (changes|revisions?)/i, /revis|changes/i]);
}
const inFlight = new Set();

/**
 * A client approves or asks for changes on an item waiting for them. The task must be in one of THIS
 * client's approval lists and still waiting; the client is taken from the session, never the request.
 */
async function respondToReview(db, adapter, { clientId, user, taskId, decision, comment }) {
  if (!['approve', 'changes', 'done'].includes(decision)) throw new AppError(400, 'Choose approve, request changes or mark done');
  const note = String(comment || '').trim();
  if (note.length > 2000) throw new AppError(400, 'Please keep your note under 2,000 characters');
  if (decision === 'changes' && !note) throw new AppError(400, 'Tell us what you would like changed');
  const item = db.prepare(`SELECT i.*, f.id AS fid, coalesce(i.list_id, f.list_id) AS status_list FROM feed_items i JOIN client_feeds f ON f.id = i.feed_id
    WHERE f.client_id = ? AND f.kind = 'collaboration' AND i.task_id = ?`).get(clientId, String(taskId));
  if (!item) throw new AppError(404, 'Not found');
  const action = itemAction(item);
  if (!action || (decision === 'done') !== (action === 'assigned')) throw new AppError(409, 'This item has already been answered');
  if (!adapter || typeof adapter.respondToReview !== 'function') {
    throw new AppError(409, 'Answering here isn\'t switched on yet. Please use "Open in ClickUp" for now.');
  }
  const key = `${clientId}:${item.task_id}`;
  if (inFlight.has(key)) throw new AppError(409, 'Already sending your answer');
  inFlight.add(key);
  try {
    const statuses = typeof adapter.listStatuses === 'function' ? await adapter.listStatuses(item.status_list) : [];
    const status = targetStatus(statuses || [], decision);
    if (!status) throw new AppError(409, 'We couldn\'t record that automatically. Please use "Open in ClickUp" and let your consultant know.');
    const who = user.name || user.email;
    const text = decision === 'approve' ? `✅ Approved by ${who} (client) on the LeadG2 points dashboard.${note ? `\n\nNote: ${note}` : ''}`
      : decision === 'done' ? `✅ Marked done by ${who} (client) on the LeadG2 points dashboard.${note ? `\n\nNote: ${note}` : ''}`
      : `✏️ Changes requested by ${who} (client) on the LeadG2 points dashboard:\n\n${note}`;
    try {
      await adapter.respondToReview(item.task_id, { status, comment: text });
    } catch (e) {
      audit(db, { clientId, actor: user.email, action: `review.${decision}.failed`, detail: { task_id: item.task_id, error: String(e.message).slice(0, 200) } });
      throw new AppError(502, 'ClickUp didn\'t accept the update. Please try again in a minute, or use "Open in ClickUp".');
    }
    // Answered items leave the list right away (the next refresh re-reads ClickUp anyway).
    db.prepare('DELETE FROM feed_items WHERE feed_id = ? AND task_id = ?').run(item.fid, item.task_id);
    audit(db, { clientId, actor: user.email, action: `review.${decision}`, detail: { task_id: item.task_id, title: item.title, status, note: note || null } });
    return { ok: true, decision, status };
  } finally { inFlight.delete(key); }
}

function scheduleFeedRefresh(db, adapter, { minutes = 30, log = console } = {}) {
  if (!adapter || adapter.mode !== 'live') return;
  const tick = () => refreshFeeds(db, adapter).catch((e) => log.error(`Feed refresh failed: ${e.message}`));
  setTimeout(tick, 60e3).unref();
  setInterval(tick, minutes * 60e3).unref();
}

module.exports = { itemAction, parseTarget, respondToReview, targetStatus, listFeeds, addFeed, removeFeed, refreshFeeds, clientFeeds, calendarStage, scheduleFeedRefresh, WAITING };
