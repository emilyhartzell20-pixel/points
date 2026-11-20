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

function addFeed(db, { clientId, kind, listId, label, actor }) {
  if (!KINDS.includes(kind)) throw new AppError(400, 'Choose editorial calendar or client approvals');
  const m = /\/(?:li|l)\/(?:\d+-)?(\d+)/.exec(String(listId || '')) || /^(\d+)$/.exec(String(listId || '').trim());
  if (!m) throw new AppError(400, 'Pick a ClickUp list (or paste its URL or ID)');
  const taken = db.prepare('SELECT f.*, c.name FROM client_feeds f JOIN clients c ON c.id = f.client_id WHERE kind = ? AND list_id = ?').get(kind, m[1]);
  if (taken) throw new AppError(409, `That list is already shown for ${taken.name}`);
  const r = db.prepare('INSERT INTO client_feeds (client_id, kind, list_id, label) VALUES (?,?,?,?)').run(clientId, kind, m[1], label || null);
  audit(db, { clientId, actor, action: `feed.add.${kind}`, detail: { list_id: m[1], label } });
  return db.prepare('SELECT * FROM client_feeds WHERE id = ?').get(Number(r.lastInsertRowid));
}

function removeFeed(db, { clientId, feedId, actor }) {
  const f = db.prepare('SELECT * FROM client_feeds WHERE id = ? AND client_id = ?').get(feedId, clientId);
  if (!f) throw new AppError(404, 'Not found');
  tx(db, () => { db.prepare('DELETE FROM feed_items WHERE feed_id = ?').run(f.id); db.prepare('DELETE FROM client_feeds WHERE id = ?').run(f.id); });
  audit(db, { clientId, actor, action: `feed.remove.${f.kind}`, detail: { list_id: f.list_id } });
}

/** Re-read every feed list for a client (or all clients) from ClickUp. */
async function refreshFeeds(db, adapter, { clientId = null } = {}) {
  if (!adapter || adapter.mode !== 'live') return { refreshed: 0 };
  const feeds = clientId ? listFeeds(db, clientId) : db.prepare('SELECT * FROM client_feeds').all();
  let refreshed = 0;
  for (const f of feeds) {
    try {
      const tasks = await adapter.fetchTasks({ mappings: [{ source_type: 'clickup_list', value: f.list_id }], since: null });
      tx(db, () => {
        db.prepare('DELETE FROM feed_items WHERE feed_id = ?').run(f.id);
        const ins = db.prepare('INSERT OR REPLACE INTO feed_items (feed_id, task_id, title, status, status_type, due_date, url) VALUES (?,?,?,?,?,?,?)');
        for (const t of tasks) {
          if (t.parent) continue; // steps under a piece of content aren't shown
          const status = t.status && (t.status.status || t.status);
          ins.run(f.id, String(t.id), String(t.name || '').trim(), status || null, (t.status && t.status.type) || null,
            msToDate(t.due_date || t.start_date), t.url || `https://app.clickup.com/t/${t.id}`);
        }
        db.prepare('UPDATE client_feeds SET refreshed_at = ?, last_error = NULL WHERE id = ?').run(nowIso(), f.id);
      });
      if (f.kind === 'collaboration' && typeof adapter.listStatuses === 'function') {
        const st = await adapter.listStatuses(f.list_id);
        db.prepare('UPDATE client_feeds SET statuses = ? WHERE id = ?').run(JSON.stringify(st), f.id);
      }
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
const WAITING = /(ready for review|client review|awaiting|waiting on client|needs approval|for approval|pending approval)/i;

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
    ? items('collaboration').filter((i) => WAITING.test(i.status || ''))
      .sort((a, z) => String(a.due_date || '9999').localeCompare(String(z.due_date || '9999')))
      .map((i) => ({ id: i.task_id, title: i.title, due: i.due_date, url: i.url, status: 'Ready for your review' }))
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
  return decision === 'approve'
    ? pick(statuses, [/^(client )?approved$/i, /approved/i, /^(done|complete|completed)$/i, (x) => x.type === 'closed'])
    : pick(statuses, [/revision(s)? needed|changes requested|needs? (changes|revisions?)/i, /revis|changes/i]);
}
const inFlight = new Set();

/**
 * A client approves or asks for changes on an item waiting for them. The task must be in one of THIS
 * client's approval lists and still waiting; the client is taken from the session, never the request.
 */
async function respondToReview(db, adapter, { clientId, user, taskId, decision, comment }) {
  if (!['approve', 'changes'].includes(decision)) throw new AppError(400, 'Choose approve or request changes');
  const note = String(comment || '').trim();
  if (note.length > 2000) throw new AppError(400, 'Please keep your note under 2,000 characters');
  if (decision === 'changes' && !note) throw new AppError(400, 'Tell us what you would like changed');
  const item = db.prepare(`SELECT i.*, f.id AS fid, f.list_id, f.statuses FROM feed_items i JOIN client_feeds f ON f.id = i.feed_id
    WHERE f.client_id = ? AND f.kind = 'collaboration' AND i.task_id = ?`).get(clientId, String(taskId));
  if (!item) throw new AppError(404, 'Not found');
  if (!WAITING.test(item.status || '')) throw new AppError(409, 'This item has already been answered');
  if (!adapter || typeof adapter.respondToReview !== 'function') {
    throw new AppError(409, 'Answering here isn\'t switched on yet. Please use "Open in ClickUp" for now.');
  }
  const key = `${clientId}:${item.task_id}`;
  if (inFlight.has(key)) throw new AppError(409, 'Already sending your answer');
  inFlight.add(key);
  try {
    let statuses = item.statuses ? JSON.parse(item.statuses) : null;
    if (!statuses && typeof adapter.listStatuses === 'function') {
      statuses = await adapter.listStatuses(item.list_id);
      db.prepare('UPDATE client_feeds SET statuses = ? WHERE id = ?').run(JSON.stringify(statuses), item.fid);
    }
    const status = targetStatus(statuses || [], decision);
    if (!status) throw new AppError(409, 'We couldn\'t record that automatically. Please use "Open in ClickUp" and let your consultant know.');
    const who = user.name || user.email;
    const text = decision === 'approve'
      ? `✅ Approved by ${who} (client) on the LeadG2 points dashboard.${note ? `\n\nNote: ${note}` : ''}`
      : `✏️ Changes requested by ${who} (client) on the LeadG2 points dashboard:\n\n${note}`;
    try {
      await adapter.respondToReview(item.task_id, { status, comment: text });
    } catch (e) {
      audit(db, { clientId, actor: user.email, action: `review.${decision}.failed`, detail: { task_id: item.task_id, error: String(e.message).slice(0, 200) } });
      throw new AppError(502, 'ClickUp didn\'t accept the update. Please try again in a minute, or use "Open in ClickUp".');
    }
    db.prepare('UPDATE feed_items SET status = ?, status_type = NULL WHERE feed_id = ? AND task_id = ?').run(status, item.fid, item.task_id);
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

module.exports = { respondToReview, targetStatus, listFeeds, addFeed, removeFeed, refreshFeeds, clientFeeds, calendarStage, scheduleFeedRefresh, WAITING };
