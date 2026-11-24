'use strict';
// Ingestion: store evidence idempotently, match it to a client, group it into deliverables, and
// propose ledger suggestions for a reviewer. Nothing here ever posts a ledger event: points move
// only when a consultant approves a suggestion (see review.js).
//
// SECURITY: task and email content is untrusted evidence. It is pattern-matched for signals and
// displayed (escaped) to reviewers. It is never interpreted as instructions, and any text that
// looks like instructions is flagged for the reviewer.
const crypto = require('node:crypto');
const { tx, audit, nowIso } = require('./db');
const { activeContract } = require('./ledger');
const { findItem, matchByText } = require('./menu');
const { fetchClickUp } = require('./adapters/clickup');
const { fetchOutlook } = require('./adapters/outlook');

const INTERNAL_DOMAINS = (process.env.INTERNAL_EMAIL_DOMAINS || 'leadg2.com').split(',').map((d) => d.trim().toLowerCase());
const hash = (v) => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const domainOf = (email) => String(email || '').split('@')[1] || '';

// ---------------------------------------------------------------- client matching
function mappingsFor(db, clientId) {
  return db.prepare('SELECT * FROM source_mappings WHERE client_id = ?').all(clientId);
}

function matchRecord(db, rec) {
  if (rec.source_type === 'clickup_task') {
    const byList = db.prepare(`SELECT * FROM source_mappings WHERE source_type='clickup_list' AND value = ?`).get(rec.data.list_id || '');
    const bySpace = db.prepare(`SELECT * FROM source_mappings WHERE source_type='clickup_space' AND value = ?`).get(rec.data.space_id || '');
    const m = byList || bySpace;
    if (m) return { status: 'matched', clientId: m.client_id, scope: byList ? byList.scope : bySpace.scope, reason: `Mapped ClickUp ${byList ? 'list' : 'space'} ${m.label || m.value}` };
    return { status: 'ignored', reason: 'ClickUp location is not mapped to a client' };
  }
  // Outlook: participants vs explicit address/domain mappings.
  const external = rec.data.participants.filter((p) => !INTERNAL_DOMAINS.includes(domainOf(p)));
  const hits = new Map();
  for (const p of external) {
    const m = db.prepare(`SELECT * FROM source_mappings WHERE (source_type='email_address' AND lower(value)=?)
                          OR (source_type='email_domain' AND lower(value)=?) ORDER BY source_type='email_address' DESC`).get(p, domainOf(p));
    if (m && !hits.has(m.client_id)) hits.set(m.client_id, m);
  }
  if (hits.size === 1) {
    const [m] = hits.values();
    return { status: 'matched', clientId: m.client_id, scope: m.scope, reason: `Participant matches mapped ${m.source_type.replace('_', ' ')} ${m.value}` };
  }
  if (hits.size > 1) {
    return { status: 'uncertain', candidates: [...hits.keys()], reason: 'Participants match more than one client' };
  }
  const text = `${rec.title}\n${rec.body}`.toLowerCase();
  const candidates = db.prepare('SELECT id, name, aliases FROM clients').all()
    .filter((c) => [c.name, ...JSON.parse(c.aliases)].some((a) => a && text.includes(a.toLowerCase()))).map((c) => c.id);
  if (candidates.length) return { status: 'uncertain', candidates, reason: 'Mentions a client name but no participant matches a mapped address or domain' };
  return { status: 'ignored', reason: 'No mapped participant' };
}

// ---------------------------------------------------------------- idempotent upsert
function upsertRecord(db, rec, match) {
  const contentHash = hash({ t: rec.title, s: rec.status, b: rec.body, d: rec.data, o: rec.occurred_at });
  const linkedTask = rec.source_type === 'outlook_message' ? findTaskRef(`${rec.title}\n${rec.body}`) : null;
  const existing = db.prepare('SELECT * FROM source_records WHERE source_type = ? AND external_id = ?').get(rec.source_type, rec.external_id);
  if (existing) {
    if (existing.content_hash === contentHash) {
      db.prepare('UPDATE source_records SET last_seen_at = ? WHERE id = ?').run(nowIso(), existing.id);
      return { id: existing.id, outcome: 'unchanged' };
    }
    // Keep a reviewer's manual client resolution if the automatic match is still not certain.
    const keepManual = existing.match_status === 'matched' && match.status !== 'matched';
    db.prepare(`UPDATE source_records SET title=?, status=?, author=?, body=?, data=?, url=?, occurred_at=?, thread_id=?, linked_task_id=?,
        content_hash=?, last_seen_at=?, client_id=?, match_status=?, match_candidates=?, match_reason=?, scope=? WHERE id=?`)
      .run(rec.title, rec.status, rec.author, rec.body, JSON.stringify(rec.data), rec.url, rec.occurred_at, rec.thread_id, linkedTask,
        contentHash, nowIso(),
        keepManual ? existing.client_id : (match.clientId ?? null),
        keepManual ? existing.match_status : match.status,
        JSON.stringify(match.candidates || []), keepManual ? existing.match_reason : match.reason,
        keepManual ? existing.scope : (match.scope || 'points'), existing.id);
    return { id: existing.id, outcome: 'updated' };
  }
  const r = db.prepare(`INSERT INTO source_records (source_type, external_id, client_id, match_status, match_candidates, match_reason, scope,
      thread_id, linked_task_id, occurred_at, url, title, status, author, body, data, content_hash)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(rec.source_type, rec.external_id, match.clientId ?? null, match.status,
    JSON.stringify(match.candidates || []), match.reason, match.scope || 'points', rec.thread_id, linkedTask, rec.occurred_at, rec.url,
    rec.title, rec.status, rec.author, rec.body, JSON.stringify(rec.data), contentHash);
  return { id: Number(r.lastInsertRowid), outcome: 'new' };
}

function findTaskRef(text) {
  const m = /app\.clickup\.com\/t\/([a-z0-9]+)/i.exec(text) || /\bCU-([a-z0-9]{5,})\b/i.exec(text);
  return m ? m[1].toLowerCase() : null;
}

// ---------------------------------------------------------------- grouping
// One deliverable = one ClickUp task (subtasks roll up to the parent) plus the email threads that
// reference it. Threads with no task reference form their own group. Reviewer merges override both.
function regroup(db, clientId) {
  const recs = db.prepare(`SELECT * FROM source_records WHERE client_id = ? AND match_status = 'matched'`).all(clientId);
  const threadTask = new Map();
  for (const r of recs) if (r.source_type === 'outlook_message' && r.linked_task_id && r.thread_id && !threadTask.has(r.thread_id)) threadTask.set(r.thread_id, r.linked_task_id);
  const upd = db.prepare('UPDATE source_records SET group_key = ? WHERE id = ?');
  for (const r of recs) {
    let key;
    if (r.group_override) key = r.group_override;
    else if (r.source_type === 'clickup_task') key = `clickup:${(JSON.parse(r.data).parent_id || r.external_id).toLowerCase()}`;
    else if (r.linked_task_id) key = `clickup:${r.linked_task_id}`;
    else if (r.thread_id && threadTask.has(r.thread_id)) key = `clickup:${threadTask.get(r.thread_id)}`;
    else key = `outlook:${r.thread_id || r.external_id}`;
    if (key !== r.group_key) upd.run(key, r.id);
  }
}

// ---------------------------------------------------------------- signals
const INJECTION = /(ignore (all |any )?(previous|prior|above) instructions|disregard (the )?(rules|instructions)|system prompt|you are (an? )?(ai|assistant|model)|as an ai|mark .{0,40} as (used|approved|complete)|(add|credit|deduct|set) \d+ points)/i;

function latestReply(body) {
  // Ignore quoted history so an old "approved" further down a thread isn't re-counted.
  const cut = String(body || '').split(/\n(?:-{2,}\s*Original Message|From: .+|On .{5,80} wrote:)/i)[0];
  return cut.split('\n').filter((l) => !l.trim().startsWith('>')).join('\n');
}

function clickupSignal(status) {
  const s = String(status || '').toLowerCase();
  if (/cancel/.test(s)) return 'canceled';
  if (/^(complete|completed|closed|done|delivered)$/.test(s)) return 'completed';
  if (/approved/.test(s)) return 'approved';
  if (/(progress|review|scheduled|active|working|ongoing|drafting|revisions|with design)/.test(s)) return 'in_progress';
  return 'requested';
}

function emailSignals(text) {
  const t = text.toLowerCase();
  const out = [];
  if (/\b(cancel|cancell?ed|hold off|no longer need|scrap (it|this)|put (it|this|that) on hold)\b/.test(t)) out.push('canceled');
  if (/\b(is live|went live|now live|launched|delivered|completed?|wrapped up|all done|finished)\b/.test(t)) out.push('completed');
  if (/\b(approved?|go ahead|please proceed|green light|signed off|sign-off|let'?s do it|you have the go)\b/.test(t)) out.push('approved');
  if (/\b(instead of|scope change|change (the|of) scope|revise the scope|switch (it )?to|expand(ing)? the scope)\b/.test(t)) out.push('changed');
  if (/\b(can you|could you|would you|we'?d like|we need|interested in|request(ing)?|wondering if)\b/.test(t)) out.push('requested');
  return out;
}

function recordSignals(db, clientId, r) {
  if (r.source_type === 'clickup_task') {
    const sig = clickupSignal(r.status);
    // In a points tracker, "In Progress" / "Client Review" means the work was agreed and is underway.
    if (sig === 'in_progress' && JSON.parse(r.data).from_tracker) return { signals: ['approved'], fromClient: false, tracker: true };
    return { signals: [sig], fromClient: false, tracker: JSON.parse(r.data).from_tracker };
  }
  const clientDomains = mappingsFor(db, clientId).filter((m) => m.source_type === 'email_domain').map((m) => m.value.toLowerCase());
  const clientAddrs = mappingsFor(db, clientId).filter((m) => m.source_type === 'email_address').map((m) => m.value.toLowerCase());
  const from = (r.author || '').toLowerCase();
  const fromClient = clientAddrs.includes(from) || clientDomains.includes(domainOf(from));
  return { signals: emailSignals(`${r.title}\n${latestReply(r.body)}`), fromClient };
}

const fmtDate = (iso) => String(iso || '').slice(0, 10);
const excerpt = (s, n = 140) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const cleanSubject = (s) => String(s || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').trim();

// ---------------------------------------------------------------- suggestions
function evaluateGroup(db, clientId, groupKey) {
  const contract = activeContract(db, clientId);
  const recs = db.prepare(`SELECT * FROM source_records WHERE client_id = ? AND match_status='matched' AND group_key = ? ORDER BY occurred_at`).all(clientId, groupKey);
  if (!recs.length) return null;
  const item = db.prepare('SELECT * FROM work_items WHERE client_id = ? AND group_key = ?').get(clientId, groupKey);
  const tasks = recs.filter((r) => r.source_type === 'clickup_task');
  const emails = recs.filter((r) => r.source_type === 'outlook_message');
  const task = tasks.find((t) => !JSON.parse(t.data).parent_id) || tasks[0];
  const taskData = task ? JSON.parse(task.data) : {};
  // Headings like "August 2026" that only group other tasks are not deliverables.
  if (!item && !emails.length && tasks.every((t) => JSON.parse(t.data).points == null)) {
    const isParent = db.prepare(`SELECT 1 FROM source_records WHERE client_id = ? AND source_type = 'clickup_task'
      AND json_extract(data, '$.raw_parent') IN (${tasks.map(() => '?').join(',')}) LIMIT 1`).get(clientId, ...tasks.map((t) => t.external_id));
    if (isParent) return null;
  }

  const flags = new Set();
  const lines = [];
  const evidence = [];
  const has = { requested: false, approved: false, clientApproved: false, in_progress: false, completed: false, canceled: false, clientCanceled: false, changed: false };
  let taskSignal = null;
  const emailSigs = new Set();
  const sigDate = {}; // latest date each signal was seen

  // In a points tracker, only the task that carries the points decides the stage. Its step-by-step
  // subtasks ("Write copy", "Send to client"…) are evidence, not signals: a done subtask isn't a done deliverable.
  const trackerTask = tasks.find((t) => { const d = JSON.parse(t.data); return d.from_tracker && d.points != null; });
  for (const r of recs) {
    const isStep = trackerTask && r.source_type === 'clickup_task' && r !== trackerTask;
    const { signals: raw, fromClient, tracker } = recordSignals(db, clientId, r);
    const signals = isStep ? [] : raw;
    evidence.push({ id: r.id, signal: signals.join(',') || 'mention' });
    if (r.source_type === 'clickup_task') {
      if (r === task) taskSignal = signals[0];
      lines.push(`ClickUp task "${r.title}" is ${r.status || 'unknown'} (updated ${fmtDate(r.occurred_at)}).`);
    } else {
      signals.forEach((s) => emailSigs.add(s));
      lines.push(`${fromClient ? 'Client' : 'Internal'} email from ${r.author} on ${fmtDate(r.occurred_at)}: "${excerpt(latestReply(r.body))}"`);
    }
    const when = r.source_type === 'clickup_task' && signals[0] === 'completed' ? (JSON.parse(r.data).date_closed || r.occurred_at) : r.occurred_at;
    for (const s of signals) {
      has[s] = true;
      if (!sigDate[s] || when > sigDate[s]) sigDate[s] = when;
      if (s === 'approved' && (fromClient || tracker)) has.clientApproved = true; // the consultants' tracker records agreed work
      if (s === 'canceled' && fromClient) has.clientCanceled = true;
    }
    if (INJECTION.test(`${r.title}\n${r.body}`)) flags.add('embedded_instructions');
    if (r.scope === 'consulting') flags.add('may_be_included_in_consulting');
    if (r.scope === 'project') flags.add('may_be_fixed_scope_project');
  }
  const allText = recs.map((r) => `${r.title}\n${r.body}`).join('\n').toLowerCase();
  if (/\b(monthly (consulting|strategy)|consulting call|strategy call|retainer|proactive consulting)\b/.test(allText)) flags.add('may_be_included_in_consulting');
  if (/\b(fixed[- ]scope|statement of work|\bsow\b|project phase|phase \d)\b/.test(allText) || (taskData.tags || []).includes('project')) flags.add('may_be_fixed_scope_project');
  if ((taskData.tags || []).includes('consulting')) flags.add('may_be_included_in_consulting');

  // Sources disagree?
  if (has.completed && has.canceled) flags.add('sources_disagree');
  if (taskSignal && taskSignal !== 'canceled' && emailSigs.has('canceled')) flags.add('sources_disagree');
  if (taskSignal === 'canceled' && (emailSigs.has('approved') || emailSigs.has('completed'))) flags.add('sources_disagree');
  if (taskSignal && taskSignal !== 'completed' && emailSigs.has('completed') && !emailSigs.has('canceled')) flags.add('sources_disagree');
  if (!tasks.length) flags.add('email_only');

  const isSupport = recs.some((r) => r.scope === 'support_hours');
  const title = item ? item.title : (task ? task.title : cleanSubject(emails[0].title));

  // Decide what to propose.
  let action = null;
  if (isSupport) {
    action = 'support_hours';
    flags.delete('may_be_included_in_consulting');
    if (!has.completed) flags.add('not_yet_completed');
  } else if (item) {
    if (['used', 'canceled'].includes(item.state)) action = has.changed ? 'change' : null;
    else if (has.clientCanceled || (has.canceled && !has.completed)) action = 'cancel';
    else if (has.completed) action = 'complete';
    else if (has.changed) action = 'change';
    else if (item.state === 'forecast' && (has.clientApproved || has.approved)) action = 'approve';
  } else if (has.canceled && !has.completed && !has.approved) {
    action = null; // requested then canceled before anything was approved: nothing to book
  } else if (has.completed) action = 'complete';
  else if (has.clientApproved) action = 'approve';
  else if (has.approved || has.in_progress || has.requested || recs.length) action = 'forecast';

  if (!action) return null;
  if (!isSupport && !item && (action === 'complete' || action === 'approve') && !has.clientApproved && !taskData.from_tracker) flags.add('no_client_approval_evidence');
  if (has.changed) flags.add('scope_changed');

  // Point amount from the client's menu version.
  let menu = null, proposed = null, pmin = null, pmax = null, hours = null;
  if (isSupport) {
    hours = taskData.hours ?? null;
    if (hours == null) flags.add('hours_unclear');
    lines.push(`Mapped to the HubSpot support-hours bank (tracked in hours, not points).`);
  } else if (item && action !== 'change') {
    proposed = item.points;
    lines.push(`Existing ledger entry #${item.id} (${item.state}, ${item.points} pts from menu ${item.menu_item_code || 'n/a'}). The same points move; nothing is charged twice.`);
  } else {
    menu = (taskData.menu_code && findItem(db, clientId, taskData.menu_code)) || matchByText(db, clientId, `${title}\n${allText}`);
    if (taskData.menu_code && !findItem(db, clientId, taskData.menu_code)) flags.add('menu_item_not_on_client_menu');
    if (menu) {
      pmin = menu.points_min; pmax = menu.points_max;
      const ver = db.prepare('SELECT code FROM menu_versions WHERE id = ?').get(contract.menu_version_id).code;
      if (pmin === pmax) {
        proposed = pmin;
        lines.push(`Menu ${ver} · ${menu.code} "${menu.name}" = ${pmin} pts.`);
        if (taskData.points != null && taskData.points !== pmin) { flags.add('sources_disagree'); lines.push(`ClickUp Points field says ${taskData.points}.`); }
      } else {
        flags.add('points_range_confirm');
        lines.push(`Menu ${ver} · ${menu.code} "${menu.name}" is a range: ${pmin}–${pmax} pts. Reviewer must confirm the amount.`);
        if (taskData.points != null) {
          lines.push(`ClickUp Points field suggests ${taskData.points}.`);
          if (taskData.points < pmin || taskData.points > pmax) flags.add('sources_disagree');
          else proposed = taskData.points; // pre-filled, but the flag still asks the reviewer to confirm
        }
      }
      if (menu.notes) lines.push(`Menu note: ${menu.notes}`);
    } else {
      flags.add('point_cost_unclear');
      lines.push('No matching item on this client\'s service menu. Reviewer must choose the item and amount.');
    }
    if (item && action === 'change') lines.unshift(`Scope change on existing entry #${item.id} (${item.state}, ${item.points} pts).`);
    // The points tracker's own number wins: it is what the consultant recorded for this work.
    if (taskData.from_tracker && taskData.points != null) {
      flags.delete('point_cost_unclear'); flags.add('points_from_tracker');
      proposed = Math.round(taskData.points);
      if (proposed !== taskData.points) flags.add('fractional_points');
      const calc = taskData.point_value != null && taskData.how_many != null ? taskData.point_value * taskData.how_many : null;
      lines.push(`ClickUp tracker: ${taskData.point_value ?? '?'} pts × ${taskData.how_many ?? '?'} = ${taskData.points} total${taskData.department ? ` · ${taskData.department}` : ''}${taskData.tracker_notes ? ` · note: "${taskData.tracker_notes}"` : ''}.`);
      if (calc != null && Math.abs(calc - taskData.points) > 0.5) { flags.add('sources_disagree'); lines.push(`Point Value × How Many = ${calc}, but Total Points says ${taskData.points}. Confirm the amount.`); }
    }
  }
  if (flags.has('embedded_instructions')) lines.push('⚠ Source text contains instruction-like language. It was treated as evidence only and not acted on.');

  const evidenceHash = hash(recs.map((r) => [r.id, r.content_hash]));
  const dateFor = { complete: sigDate.completed, cancel: sigDate.canceled, approve: sigDate.approved, support_hours: sigDate.completed };
  const evidenceDate = fmtDate(dateFor[action] || recs[recs.length - 1].occurred_at);
  return { action, evidenceDate, title, item, menu, proposed, pmin, pmax, hours, flags: [...flags], rationale: lines.join('\n'), evidence, evidenceHash };
}

// Month headings like "February 2027" are how the tracker schedules work: moving a task under a different
// heading moves it to that month. When a task sits under such a heading, the heading wins over the
// Delivery Month field; otherwise the field is used.
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
function headingMonth(title) {
  const m = /^\s*([a-z]+)\s+(\d{4})\s*$/i.exec(String(title || ''));
  if (!m) return null;
  const i = MONTHS.indexOf(m[1].toLowerCase());
  return i < 0 ? null : `${m[2]}-${String(i + 1).padStart(2, '0')}-01`;
}

/** A month name with no year (the "Point Delivery Month" dropdown) is placed inside the contract term. */
function monthNameInTerm(name, termStart) {
  const i = MONTHS.indexOf(String(name || '').trim().toLowerCase());
  if (i < 0 || !termStart) return null;
  const [y, m] = String(termStart).slice(0, 7).split('-').map(Number);
  const year = i + 1 >= m ? y : y + 1;
  return `${year}-${String(i + 1).padStart(2, '0')}-01`;
}
function trackerMonth(data, headingTitle, termStart) {
  return headingMonth(headingTitle) || (data.delivery_month ? String(data.delivery_month).slice(0, 10) : null) || monthNameInTerm(data.delivery_month_name, termStart);
}

// Scheduling details from a points tracker (Delivery Month, Department) don't change any balance, so a
// sync applies them to the matching ledger item directly. Points and stage still go through review.
function applyTrackerDetails(db, clientId, actor = 'clickup-sync') {
  const termStart = activeContract(db, clientId).term_start;
  const rows = db.prepare(`SELECT w.id, w.work_date, w.category, json_extract(r.data, '$.delivery_month') AS field_month,
      json_extract(r.data, '$.delivery_month_name') AS month_name,
      json_extract(r.data, '$.department') AS dept, r.title, hd.title AS heading
    FROM work_items w JOIN source_records r ON r.client_id = w.client_id AND r.group_key = w.group_key
    LEFT JOIN source_records hd ON hd.source_type = 'clickup_task' AND hd.external_id = json_extract(r.data, '$.raw_parent')
    WHERE w.client_id = ? AND r.source_type = 'clickup_task' AND json_extract(r.data, '$.from_tracker') = 1
      AND json_extract(r.data, '$.parent_id') IS NULL`).all(clientId);
  let changed = 0;
  for (const r of rows) {
    const month = trackerMonth({ delivery_month: r.field_month, delivery_month_name: r.month_name }, r.heading, termStart);
    const updates = {};
    if (month && month.slice(0, 7) !== String(r.work_date).slice(0, 7)) updates.work_date = month;
    if (r.dept && r.dept !== r.category) updates.category = r.dept;
    if (!Object.keys(updates).length) continue;
    db.prepare(`UPDATE work_items SET work_date = COALESCE(?, work_date), category = COALESCE(?, category), updated_at = ? WHERE id = ?`)
      .run(updates.work_date || null, updates.category || null, nowIso(), r.id);
    audit(db, { clientId, actor, action: 'work_item.tracker_update', entity: 'work_item', entityId: r.id,
      detail: { from: { month: String(r.work_date).slice(0, 7), type: r.category }, to: { month: updates.work_date && updates.work_date.slice(0, 7), type: updates.category } } });
    changed++;
  }
  return changed;
}

const STAGE = { forecast: 0, approve: 1, change: 1, support_hours: 1, cancel: 2, complete: 2 };

function generateSuggestions(db, clientId) {
  return tx(db, () => {
    regroup(db, clientId);
    const groups = db.prepare(`SELECT DISTINCT group_key FROM source_records WHERE client_id = ? AND match_status='matched' AND group_key IS NOT NULL`).all(clientId);
    let created = 0, refreshed = 0;
    for (const { group_key: gk } of groups) {
      const ev = evaluateGroup(db, clientId, gk);
      if (!ev) {
        // Nothing left to decide for this deliverable (e.g. it is already on the ledger in this state).
        db.prepare(`UPDATE suggestions SET status='dismissed', resolved_by='system', resolved_at=?, resolution_note=?
                    WHERE client_id=? AND group_key=? AND status='open'`).run(nowIso(), 'No longer needed: the ledger already reflects this', clientId, gk);
        continue;
      }
      const existing = db.prepare('SELECT * FROM suggestions WHERE client_id = ? AND group_key = ? AND action = ?').get(clientId, gk, ev.action);
      let sid;
      if (existing) {
        if (existing.status !== 'open' || existing.evidence_hash === ev.evidenceHash) continue; // resolved suggestions are never resurrected
        if (existing.edited) {
          db.prepare(`UPDATE suggestions SET evidence_date=?, rationale=?, flags=?, evidence_hash=?, updated_at=? WHERE id=?`)
            .run(ev.evidenceDate, ev.rationale, JSON.stringify(ev.flags), ev.evidenceHash, nowIso(), existing.id);
        } else {
          db.prepare(`UPDATE suggestions SET title=?, work_item_id=?, menu_item_code=?, proposed_points=?, points_min=?, points_max=?, proposed_hours=?,
              evidence_date=?, rationale=?, flags=?, evidence_hash=?, updated_at=? WHERE id=?`)
            .run(ev.title, ev.item ? ev.item.id : null, ev.menu ? ev.menu.code : (ev.item ? ev.item.menu_item_code : null), ev.proposed, ev.pmin, ev.pmax,
              ev.hours, ev.evidenceDate, ev.rationale, JSON.stringify(ev.flags), ev.evidenceHash, nowIso(), existing.id);
        }
        sid = existing.id; refreshed++;
      } else {
        const r = db.prepare(`INSERT INTO suggestions (client_id, group_key, action, work_item_id, title, menu_item_code, proposed_points, points_min, points_max,
            proposed_hours, evidence_date, rationale, flags, evidence_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(clientId, gk, ev.action, ev.item ? ev.item.id : null, ev.title, ev.menu ? ev.menu.code : (ev.item ? ev.item.menu_item_code : null),
            ev.proposed, ev.pmin, ev.pmax, ev.hours, ev.evidenceDate, ev.rationale, JSON.stringify(ev.flags), ev.evidenceHash);
        sid = Number(r.lastInsertRowid); created++;
        // Newer evidence supersedes earlier-stage open suggestions for the same deliverable.
        for (const old of db.prepare(`SELECT * FROM suggestions WHERE client_id=? AND group_key=? AND status='open' AND id != ?`).all(clientId, gk, sid)) {
          if (STAGE[old.action] <= STAGE[ev.action]) {
            db.prepare(`UPDATE suggestions SET status='dismissed', resolved_by='system', resolved_at=?, resolution_note=? WHERE id=?`)
              .run(nowIso(), `Superseded by suggestion #${sid} (newer evidence)`, old.id);
          }
        }
      }
      db.prepare('DELETE FROM suggestion_evidence WHERE suggestion_id = ?').run(sid);
      const ins = db.prepare('INSERT OR IGNORE INTO suggestion_evidence (suggestion_id, source_record_id, signal) VALUES (?,?,?)');
      for (const e of ev.evidence) ins.run(sid, e.id, e.signal);
    }
    return { created, refreshed };
  });
}

// ---------------------------------------------------------------- sync orchestration
function lastSuccess(db, clientId, source, mode) {
  // The "changed since" watermark only counts runs against the same kind of connection: a sample-data
  // run (or a run before the key was added) must not make a real sync skip real history.
  return mode
    ? db.prepare(`SELECT * FROM sync_runs WHERE client_id=? AND source=? AND status='success' AND mode=? ORDER BY id DESC LIMIT 1`).get(clientId, source, mode)
    : db.prepare(`SELECT * FROM sync_runs WHERE client_id=? AND source=? AND status='success' ORDER BY id DESC LIMIT 1`).get(clientId, source);
}

async function syncSource(db, { clientId, source, adapter, actor = 'system', full = false }) {
  const contract = activeContract(db, clientId);
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  const prev = full ? null : lastSuccess(db, clientId, source, adapter.mode);
  // Re-read a 1-day overlap: safe because imports are idempotent, and it covers clock skew.
  const overlap = prev ? new Date(Date.parse(prev.started_at) - 86400000).toISOString() : null;
  const opening = contract.opening_balance_date ? new Date(`${contract.opening_balance_date}T00:00:00Z`).toISOString() : null;
  const since = [opening, overlap].filter(Boolean).sort().pop() || null;
  const run = db.prepare(`INSERT INTO sync_runs (client_id, source, mode, started_at, status, since) VALUES (?,?,?,?, 'running', ?)`)
    .run(clientId, source, adapter.mode || 'unknown', nowIso(), since);
  const runId = Number(run.lastInsertRowid);
  try {
    const ctx = { mappings: mappingsFor(db, clientId), aliases: [client.name, ...JSON.parse(client.aliases)], since };
    const records = source === 'clickup' ? await fetchClickUp(adapter, ctx) : await fetchOutlook(adapter, ctx);
    const stats = { seen: 0, new: 0, updated: 0 };
    const touched = new Set([clientId]);
    tx(db, () => {
      for (const rec of records) {
        // Before the opening balance: skip, except month headings ("February 2027"), which schedule the work under them.
        if (opening && rec.occurred_at < opening && !(rec.source_type === 'clickup_task' && headingMonth(rec.title))) continue;
        stats.seen++;
        const match = matchRecord(db, rec);
        if (match.status === 'ignored') continue; // unrelated mail is not stored
        if (match.status === 'matched' && match.clientId !== clientId) touched.add(match.clientId);
        const res = upsertRecord(db, rec, match);
        if (res.outcome === 'new') stats.new++;
        if (res.outcome === 'updated') stats.updated++;
      }
    });
    // A tracker task may sit under a month heading this sync didn't return (headings rarely change, so an
    // incremental sync skips them). Fetch any such heading directly so the task lands in the right month.
    if (source === 'clickup' && typeof adapter.fetchTaskById === 'function') {
      const { normalizeTask } = require('./adapters/clickup');
      const missing = new Set(records.filter((r) => r.data.from_tracker && r.data.raw_parent).map((r) => r.data.raw_parent));
      for (const id of missing) {
        if (db.prepare(`SELECT 1 FROM source_records WHERE source_type = 'clickup_task' AND external_id = ?`).get(id)) continue;
        const parent = normalizeTask(await adapter.fetchTaskById(id));
        if (!headingMonth(parent.title)) continue;
        const match = matchRecord(db, parent);
        if (match.status === 'matched') tx(db, () => upsertRecord(db, parent, match));
      }
    }
    for (const cid of touched) { stats.rescheduled = (stats.rescheduled || 0) + tx(db, () => { regroup(db, cid); return applyTrackerDetails(db, cid); }); generateSuggestions(db, cid); }
    db.prepare(`UPDATE sync_runs SET status='success', finished_at=?, records_seen=?, records_new=?, records_updated=? WHERE id=?`)
      .run(nowIso(), stats.seen, stats.new, stats.updated, runId);
    audit(db, { clientId, actor, action: `sync.${source}.success`, detail: stats });
    return { runId, status: 'success', ...stats };
  } catch (e) {
    const msg = String(e && e.message || e).slice(0, 500);
    db.prepare(`UPDATE sync_runs SET status='failed', finished_at=?, error=? WHERE id=?`).run(nowIso(), msg, runId);
    audit(db, { clientId, actor, action: `sync.${source}.failed`, reason: msg });
    return { runId, status: 'failed', error: msg };
  }
}

function syncStatus(db, clientId) {
  const out = {};
  for (const source of ['clickup', 'outlook', 'tracker', 'hubspot']) {
    const ok = lastSuccess(db, clientId, source);
    const last = db.prepare('SELECT * FROM sync_runs WHERE client_id=? AND source=? ORDER BY id DESC LIMIT 1').get(clientId, source);
    const failures = db.prepare(`SELECT started_at, error FROM sync_runs WHERE client_id=? AND source=? AND status='failed' ORDER BY id DESC LIMIT 5`).all(clientId, source);
    out[source] = { last_success_at: ok ? ok.finished_at : null, last_run: last || null, recent_failures: failures };
  }
  return out;
}

// ---------------------------------------------------------------- uncertain match queue
function matchQueue(db) {
  return db.prepare(`SELECT id, source_type, external_id, title, author, occurred_at, url, match_candidates, match_reason, body
                     FROM source_records WHERE match_status = 'uncertain' ORDER BY occurred_at DESC`).all()
    .map((r) => ({ ...r, match_candidates: JSON.parse(r.match_candidates), body: excerpt(r.body, 600) }));
}

function resolveMatch(db, { recordId, clientId, actor, reason }) {
  return tx(db, () => {
    const r = db.prepare('SELECT * FROM source_records WHERE id = ?').get(recordId);
    if (!r) throw Object.assign(new Error('Record not found'), { status: 404 });
    if (clientId) {
      db.prepare(`UPDATE source_records SET client_id=?, match_status='matched', match_reason=? WHERE id=?`)
        .run(clientId, `Assigned by ${actor}${reason ? `: ${reason}` : ''}`, recordId);
      audit(db, { clientId, actor, action: 'match.assign', entity: 'source_record', entityId: recordId, reason });
      generateSuggestions(db, clientId);
    } else {
      db.prepare(`UPDATE source_records SET client_id=NULL, match_status='ignored', match_reason=? WHERE id=?`)
        .run(`Ignored by ${actor}${reason ? `: ${reason}` : ''}`, recordId);
      audit(db, { actor, action: 'match.ignore', entity: 'source_record', entityId: recordId, reason });
    }
  });
}

// ---------------------------------------------------------------- import a ClickUp points tracker
const TRACKER_STATE = { completed: 'used', approved: 'committed', in_progress: 'committed' };

/**
 * Stage from the tracker's Service Point Status. Planned (or blank) is planned; once an item moves past
 * Planned (Ongoing, In Progress, Client Review, Blocked, …) its points count as committed; Completed = used.
 */
function trackerStage(status) {
  const s = String(status || '').trim().toLowerCase();
  if (!s || /^(planned|planning|to do|not started|backlog)$/.test(s)) return 'forecast';
  if (/cancel/.test(s)) return 'canceled';
  if (/^(complete|completed|done|delivered|closed)$/.test(s)) return 'used';
  return 'committed';
}

/**
 * Read every task in the client's ClickUp tracker list(s) and put each one with points on the ledger:
 * Completed = used, In Progress / Client Review = committed, everything else = planned (forecast).
 * Idempotent: tasks already imported (here or from the tracker CSV) are skipped.
 */
/**
 * Make the app match the client's ClickUp tracker(s) exactly: ClickUp is the source of truth.
 * New tracker items are added, changed ones (status, points, month, type, name) are updated, and items
 * removed from the tracker are canceled. Every change is logged with "clickup-sync" as the actor.
 * Points trackers: Service Point Status gives the stage (Completed = used, In Progress / Client Review =
 * committed, anything else = planned) and Total Points the amount. Hours trackers: see readHoursTracker.
 */
async function importTrackerFromClickUp(db, { clientId, adapter, actor = 'clickup-sync', allowEmpty = false }) {
  const ledger = require('./ledger');
  if (!adapter || adapter.mode !== 'live') throw Object.assign(new Error('ClickUp is not connected'), { status: 409 });
  const contract = activeContract(db, clientId);
  const unit = db.prepare('SELECT unit FROM clients WHERE id = ?').get(clientId).unit;
  const amount = (n) => (unit === 'hours' ? quarter(n) : Math.round(n));
  const desired = []; let notCounted = null; let fetched = 0;

  // Hours trackers (calls & training logs).
  for (const h of db.prepare('SELECT list_id FROM hours_trackers WHERE client_id = ?').all(clientId)) {
    const tasks = await adapter.fetchTasks({ mappings: [{ source_type: 'clickup_list', value: h.list_id }], since: null });
    fetched += tasks.length;
    const { contracts, entries, contracted } = readHoursTracker(tasks, { year: contract.term_start.slice(0, 4) });
    if (contracted > 0 && ledger.balance(db, clientId).allocated === 0) {
      ledger.addAllocation(db, { clientId, kind: 'base', points: quarter(contracted), actor,
        sourceRef: `ClickUp "CONTRACT ALLOCATION" rows: ${contracts.map((c) => `${c.pool} ${c.hours}`).join(', ')} (confirm against the signed agreement)` });
    }
    const today = new Date().toISOString().slice(0, 10);
    for (const e of entries.filter((x) => x.date && x.counted)) {
      desired.push({ taskId: e.id, title: e.title, points: amount(e.hours), state: e.date > today ? 'forecast' : 'used', date: e.date, category: e.pool, phase: null,
        notes: 'From the ClickUp hours tracker' });
    }
    const outside = entries.filter((x) => !x.counted);
    if (outside.length) notCounted = { calls: outside.length, hours: quarter(outside.reduce((a, x) => a + x.hours, 0)), pools: [...new Set(outside.map((x) => x.pool))] };
    db.prepare('UPDATE hours_trackers SET imported_at = ?, last_error = NULL WHERE list_id = ?').run(nowIso(), h.list_id);
  }

  // Points trackers.
  const mappings = mappingsFor(db, clientId).filter((m) => m.source_type.startsWith('clickup') && m.scope === 'points');
  if (mappings.length) {
    const all = await fetchClickUp(adapter, { mappings, aliases: [], since: null });
    fetched += all.length;
    const titles = Object.fromEntries(all.map((t) => [t.external_id, t.title]));
    for (const t of all.filter((x) => x.data.from_tracker && x.data.points != null)) {
      const date = (trackerMonth(t.data, titles[t.data.raw_parent], contract.term_start) || t.data.date_closed || t.data.date_created || nowIso()).slice(0, 10);
      desired.push({ taskId: t.external_id, title: t.title.trim(), points: amount(t.data.points), date, category: t.data.department || null,
        // A blank Service Point Status is planned (the task's own ClickUp status is about the work, not the points).
        state: trackerStage(t.data.tracker_status), phase: t.data.tracker_status ? t.data.tracker_status.trim() : null,
        notes: [t.data.point_value != null && t.data.how_many != null ? `${t.data.point_value} x ${t.data.how_many}` : '', t.data.tracker_notes].filter(Boolean).join('; ') || null });
    }
  }
  if (!desired.length && !fetched) {
    if (!allowEmpty && !mappings.length && !db.prepare('SELECT 1 FROM hours_trackers WHERE client_id = ?').get(clientId)) {
      throw Object.assign(new Error('Link the client\'s ClickUp tracker first (Admin → Clients → Scan ClickUp)'), { status: 409 });
    }
    db.prepare(`INSERT INTO sync_runs (client_id, source, mode, status, started_at, finished_at) VALUES (?,?,?,?,?,?)`)
      .run(clientId, 'clickup', adapter.mode, 'success', nowIso(), nowIso());
    return { created: 0, updated: 0, removed: 0, skipped: 0, found: 0, conflicts: [] };
  }

  const stats = { created: 0, updated: 0, removed: 0, skipped: 0, found: desired.length, conflicts: [], not_counted: notCounted };
  const reason = 'Matched to the ClickUp tracker';
  tx(db, () => {
    const seen = new Set();
    for (const d of desired) {
      const ref = `tracker:CU-${d.taskId}`; const gk = `clickup:${String(d.taskId).toLowerCase()}`;
      seen.add(ref);
      let w = db.prepare('SELECT * FROM work_items WHERE client_id = ? AND external_ref = ?').get(clientId, ref)
        || db.prepare('SELECT * FROM work_items WHERE client_id = ? AND group_key = ?').get(clientId, gk);
      if (!w) {
        if (d.state === 'canceled') continue;
        ledger.createWorkItem(db, { clientId, state: d.state, points: d.points, title: d.title, clientSummary: d.title, summaryApproved: true,
          externalRef: ref, groupKey: gk, workDate: d.date, origin: 'import', internalNotes: d.notes, actor, category: d.category,
          reason, overrideReason: 'ClickUp tracker is the source of truth' });
        if (d.phase) db.prepare('UPDATE work_items SET phase = ? WHERE client_id = ? AND external_ref = ?').run(d.phase, clientId, ref);
        stats.created++; continue;
      }
      if (w.external_ref !== ref && !db.prepare('SELECT 1 FROM work_items WHERE client_id = ? AND external_ref = ?').get(clientId, ref)) {
        db.prepare('UPDATE work_items SET external_ref = ? WHERE id = ?').run(ref, w.id);
      }
      const r = ledger.mirrorItem(db, { itemId: w.id, state: d.state, points: d.points, actor, reason });
      w = r.item;
      const detail = w.title !== d.title || w.work_date !== d.date || (d.category && w.category !== d.category) || (w.phase || null) !== (d.phase || null);
      if (detail) {
        db.prepare(`UPDATE work_items SET title = ?, client_summary = CASE WHEN client_summary IS NULL OR client_summary = title THEN ? ELSE client_summary END,
          work_date = ?, category = COALESCE(?, category), phase = ?, updated_at = ? WHERE id = ?`).run(d.title, d.title, d.date, d.category, d.phase || null, nowIso(), w.id);
      }
      if (r.changed || detail) stats.updated++; else stats.skipped++;
    }
    // Removed from the tracker in ClickUp → canceled here (never deleted, so the history stays).
    for (const w of db.prepare(`SELECT * FROM work_items WHERE client_id = ? AND external_ref LIKE 'tracker:CU-%' AND state != 'canceled'`).all(clientId)) {
      if (seen.has(w.external_ref)) continue;
      ledger.mirrorItem(db, { itemId: w.id, state: 'canceled', points: w.points, actor, reason: 'No longer in the ClickUp tracker' });
      stats.removed++;
    }
    audit(db, { clientId, actor, action: 'clickup.mirror', detail: { created: stats.created, updated: stats.updated, removed: stats.removed } });
  });
  db.prepare(`INSERT INTO sync_runs (client_id, source, mode, status, started_at, finished_at, records_seen, records_new, records_updated)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(clientId, 'clickup', adapter.mode, 'success', nowIso(), nowIso(), stats.found, stats.created, stats.updated + stats.removed);
  return stats;
}

/** Mirror every client that has a ClickUp tracker. */
async function mirrorAll(db, adapter, log = console) {
  if (!adapter || adapter.mode !== 'live') return;
  const ids = db.prepare(`SELECT client_id FROM hours_trackers UNION SELECT client_id FROM source_mappings
    WHERE source_type IN ('clickup_list','clickup_space') AND scope = 'points'`).all().map((r) => r.client_id);
  for (const clientId of ids) {
    try { await importTrackerFromClickUp(db, { clientId, adapter, allowEmpty: true }); }
    catch (e) {
      log.error(`ClickUp mirror failed for client ${clientId}: ${e.message}`);
      try { db.prepare(`INSERT INTO sync_runs (client_id, source, mode, status, started_at, finished_at, error) VALUES (?,?,?,?,?,?,?)`)
        .run(clientId, 'clickup', adapter.mode, 'failed', nowIso(), nowIso(), String(e.message).slice(0, 300)); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------- hours trackers (calls & training logs)
// A list where each call is a task (usually a subtask under a month row) whose ClickUp Time Estimate is its
// length. "CONTRACT ALLOCATION | <pool>: 15 hrs …" rows give the contracted hours. Month rows with no time
// are summaries and are skipped, so nothing is counted twice.
const HOURS_TRACKER_NAME = /(call\s*(?:&|and)\s*training|hours?\s*track|time\s*track|hours?\s*bank|contract\s*vs\.?\s*delivered)/i;
const quarter = (h) => Math.round(h * 4) / 4;
const textOf = (t) => String(t.text_content || t.description || '');
const field = (t, label) => { const m = new RegExp(`${label}:\\s*([^\\n]+)`, 'i').exec(textOf(t)); return m ? m[1].trim() : null; };

function readHoursTracker(tasks, { year }) {
  const contracts = []; const entries = [];
  for (const t of tasks) {
    const name = String(t.name || '').trim();
    if (/^contract\s*allocation/i.test(name)) {
      const pool = (/\|\s*([^:|]+):/.exec(name) || [])[1];
      const n = Number(field(t, 'Contracted')) || Number((/:\s*(\d+(?:\.\d+)?)\s*(?:hrs?|hours|contracted)/i.exec(name) || [])[1]);
      if (n > 0) contracts.push({ pool: pool ? pool.trim() : 'Hours', hours: n });
      continue;
    }
    if (/^reconciliation/i.test(name)) continue;
    const hours = quarter((Number(t.time_estimate) || 0) / 3600e3);
    if (!(hours > 0)) continue; // month summaries and anything without a duration
    const ms = Number(t.start_date || t.due_date || 0);
    let date = ms ? new Date(ms).toISOString().slice(0, 10) : null;
    const md = /^(\d{1,2})[-/](\d{1,2})\s*\|/.exec(name);
    if (!date && md) date = `${year}-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`;
    const title = name.replace(/^\d{1,2}[-/]\d{1,2}\s*\|\s*/, '').trim() || name;
    const pool = field(t, 'Contract pool') || field(t, 'Category') || 'Calls & training';
    entries.push({ id: String(t.id), date, title, hours, pool: pool.charAt(0).toUpperCase() + pool.slice(1) });
  }
  // With contract pools, only calls in those pools draw on the contracted hours ("Virtual rollout sessions"
  // belongs to "Virtual rollout"); anything else (e.g. "Other project/support activity") is reported, not counted.
  const norm = (x) => x.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  for (const e of entries) {
    const c = contracts.find((k) => norm(e.pool).includes(norm(k.pool)) || norm(k.pool).includes(norm(e.pool)));
    e.counted = !contracts.length || !!c;
    if (c) e.pool = c.pool;
  }
  return { contracts, entries, contracted: contracts.reduce((a, c) => a + c.hours, 0) };
}

/** Kept for callers: hours trackers are loaded by the same mirror as points trackers. */
async function importHoursTracker(db, { clientId, adapter, actor }) {
  return importTrackerFromClickUp(db, { clientId, adapter, actor, allowEmpty: true });
}
const refreshHoursTrackers = mirrorAll;

// ---------------------------------------------------------------- find every client's tracker in ClickUp
const TRACKER_NAME = /(point\s*track|service\s*point)/i;
const TEMPLATE_NAME = /\[template\]|\[year\]|#\s*points\)/i;

/** Allocation from a list name: "(900 Points)", "(400 pts)", "30 Points", "(#57 Points)", "(83/300)", "(20)". */
function parseAllocation(name) {
  const n = String(name || '');
  let m = /\(\s*#?\s*(\d+)\s*(?:points?|pts)\s*\)/i.exec(n) || /\b(\d+)\s*(?:points?|pts)\b/i.exec(n);
  if (m) return Number(m[1]);
  m = /\(\s*\d+\s*\/\s*(\d+)\s*\)/.exec(n); if (m) return Number(m[1]);
  m = /\(\s*(\d+)\s*\)/.exec(n); if (m) return Number(m[1]);
  return null;
}

async function findTrackers(db, adapter) {
  if (!adapter || typeof adapter.listHierarchy !== 'function') throw Object.assign(new Error('ClickUp is not connected'), { status: 409 });
  const tree = await adapter.listHierarchy();
  const mapped = db.prepare(`SELECT m.value, c.id AS client_id, c.name FROM source_mappings m JOIN clients c ON c.id = m.client_id WHERE m.source_type = 'clickup_list'`).all();
  const byList = Object.fromEntries(mapped.map((r) => [r.value, r]));
  for (const r of db.prepare('SELECT h.list_id AS value, c.id AS client_id, c.name FROM hours_trackers h JOIN clients c ON c.id = h.client_id').all()) byList[r.value] = r;
  const out = [];
  const feedTaken = new Set(db.prepare('SELECT list_id FROM client_feeds').all().map((r) => r.list_id));
  for (const sp of tree) {
    const pickList = (re) => sp.lists.find((x) => re.test(x.name) && !TEMPLATE_NAME.test(x.name) && !/template/i.test(x.name));
    const cal = pickList(/(blog|editorial|content)\s+calendar/i);
    // Approvals watch the whole client space: items in a review status, or assigned to the client's people.
    const collab = { id: `space:${sp.space.id}`, name: `Everything in ${sp.space.name} waiting on the client`, taken: sp.space.id };
    for (const l of sp.lists) {
      const kind = TRACKER_NAME.test(l.name) ? 'points' : HOURS_TRACKER_NAME.test(l.name) ? 'hours' : null;
      if (!kind || TEMPLATE_NAME.test(l.name) || /template/i.test(sp.space.name)) continue;
      const existing = byList[l.id];
      const sameName = db.prepare('SELECT id, name FROM clients WHERE lower(name) = lower(?)').get(sp.space.name);
      out.push({ list_id: l.id, list_name: l.name.trim(), space: sp.space.name, folder: l.folder, client_name: sp.space.name, kind,
        allocation: kind === 'hours' ? null : parseAllocation(l.name), status: existing ? 'linked' : sameName ? 'client_exists' : 'new',
        client_id: existing ? existing.client_id : sameName ? sameName.id : null, linked_to: existing ? existing.name : null,
        calendar: cal ? { id: cal.id, name: cal.name.trim(), linked: feedTaken.has(cal.id) } : null,
        collaboration: { id: collab.id, name: collab.name, linked: feedTaken.has(collab.taken) } });
    }
  }
  return out.sort((a, z) => a.client_name.localeCompare(z.client_name));
}

/** Contract term from the tracker's month headings and delivery months; falls back to the year in the list name. */
function detectTerm(tasks, listName) {
  const months = [];
  for (const t of tasks) {
    const hm = headingMonth(t.title); if (hm) months.push(hm);
    if (t.data.points != null && t.data.delivery_month) months.push(String(t.data.delivery_month).slice(0, 7) + '-01');
  }
  if (months.length) {
    months.sort();
    const first = months[0]; const last = months[months.length - 1];
    const [ly, lm] = last.split('-').map(Number);
    const end = new Date(Date.UTC(ly, lm, 0)).toISOString().slice(0, 10);
    return { term_start: first, term_end: end > first ? end : `${first.slice(0, 4)}-12-31`, from: 'month headings' };
  }
  const y = /\b(20\d\d)\b/.exec(listName) || [null, String(new Date().getUTCFullYear())];
  return { term_start: `${y[1]}-01-01`, term_end: `${y[1]}-12-31`, from: 'list name' };
}

/** Create (or reuse) each client, link its tracker list, and load the tracker. One result per item. */
async function importTrackers(db, { items, adapter, actor }) {
  const admin = require('./admin');
  const results = [];
  for (const it of items) {
    try {
      const listId = String(it.listId || '').trim();
      if (!/^\d+$/.test(listId)) throw new Error('Missing ClickUp list');
      const hoursKind = it.kind === 'hours';
      const mapping = db.prepare(`SELECT client_id FROM source_mappings WHERE source_type = 'clickup_list' AND value = ?`).get(listId)
        || db.prepare('SELECT client_id FROM hours_trackers WHERE list_id = ?').get(listId);
      let clientId = mapping ? mapping.client_id : null;
      let created = false; let term = null;
      if (!clientId) {
        const name = String(it.name || '').trim();
        if (!name) throw new Error('Enter the client name');
        const same = db.prepare('SELECT id FROM clients WHERE lower(name) = lower(?)').get(name);
        if (same && hoursKind) {
          if (db.prepare('SELECT unit FROM clients WHERE id = ?').get(same.id).unit !== 'hours') {
            throw new Error(`${name} is set up for points. Switch it to hours (Admin → Clients → Edit) or rename this row to make a separate client`);
          }
          clientId = same.id;
        } else if (same) {
          clientId = same.id;
          // A second tracker for an existing client (e.g. a separate implementation pool) adds its points.
          const extra = Number(it.allocation);
          if (Number.isInteger(extra) && extra > 0) {
            require('./ledger').addAllocation(db, { clientId, kind: 'purchase', points: extra, sourceRef: `ClickUp tracker "${it.listName || listId}"`, actor,
              note: 'Added when linking an additional ClickUp tracker; confirm against the signed agreement' });
          }
        }
        else {
          const tasks = (await fetchClickUp(adapter, { mappings: [{ source_type: 'clickup_list', value: listId }], aliases: [], since: null }));
          term = it.termStart && it.termEnd ? { term_start: it.termStart, term_end: it.termEnd, from: 'entered' } : detectTerm(tasks, it.listName || '');
          const menu = db.prepare('SELECT id FROM menu_versions ORDER BY effective_date DESC, id DESC LIMIT 1').get();
          if (!menu) throw new Error('Create a service menu first (Admin → Service menu)');
          const alloc = Number(it.allocation);
          const c = admin.createClient(db, { name, termStart: term.term_start, termEnd: term.term_end, menuVersionId: menu.id, unit: hoursKind ? 'hours' : 'points',
            agreementRef: `From ClickUp tracker "${it.listName || listId}" (update with the signed agreement)`,
            basePoints: Number.isFinite(alloc) && alloc >= 0 ? (hoursKind ? quarter(alloc) : Math.round(alloc)) : 0, actor });
          clientId = c.id; created = true;
        }
        if (hoursKind) {
          db.prepare('INSERT OR IGNORE INTO hours_trackers (list_id, client_id, label) VALUES (?,?,?)').run(listId, clientId, it.listName || null);
          audit(db, { clientId, actor, action: 'hours_tracker.link', detail: { list_id: listId, name: it.listName || null } });
        } else admin.addMapping(db, { clientId, sourceType: 'clickup_list', value: listId, scope: 'points', label: it.listName || null, actor });
      }
      const feedsMod = require('./feeds');
      const linkedFeeds = [];
      for (const [kind, lid] of [['calendar', it.calendarListId], ['collaboration', it.collabListId]]) {
        const target = lid && feedsMod.parseTarget(String(lid));
        if (!target || db.prepare('SELECT 1 FROM client_feeds WHERE kind = ? AND list_id = ?').get(kind, target.id)) continue;
        feedsMod.addFeed(db, { clientId, kind, listId: String(lid), actor }); linkedFeeds.push(kind);
      }
      if (linkedFeeds.length) await feedsMod.refreshFeeds(db, adapter, { clientId });
      const r = await importTrackerFromClickUp(db, { clientId, adapter, actor, allowEmpty: true });
      const b = activeContract(db, clientId) && require('./ledger').balance(db, clientId);
      results.push({ listId, clientId, name: db.prepare('SELECT name FROM clients WHERE id = ?').get(clientId).name, created, term,
        found: r.found, added: r.created, skipped: r.skipped, balance: b, unit: db.prepare('SELECT unit FROM clients WHERE id = ?').get(clientId).unit, linked_feeds: linkedFeeds,
        warning: [b && b.allocated === 0 ? `No allocation found: set it with "+ Add ${hoursKind ? 'hours' : 'points'} → Add to allocation"` : null,
          r.not_counted ? `${r.not_counted.calls} calls (${r.not_counted.hours} h) in ${r.not_counted.pools.join(', ')} aren't in a contracted pool, so they weren't counted` : null].filter(Boolean).join(' · ') || null });
    } catch (e) {
      results.push({ listId: it.listId, name: it.name, error: e.message });
    }
  }
  return results;
}

module.exports = { trackerStage, mirrorAll, readHoursTracker, importHoursTracker, refreshHoursTrackers, HOURS_TRACKER_NAME, findTrackers, importTrackers, parseAllocation, detectTerm, importTrackerFromClickUp, syncSource, syncStatus, generateSuggestions, regroup, matchQueue, resolveMatch, matchRecord, emailSignals, findTaskRef, INJECTION };
