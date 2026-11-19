'use strict';
const state = { clientId: null, tab: 'review', overview: null, clients: [] };
const panel = document.getElementById('panel');

const FLAG_TEXT = {
  may_be_included_in_consulting: 'May be included in monthly consulting',
  may_be_fixed_scope_project: 'May be part of a fixed-scope project',
  sources_disagree: 'Sources disagree',
  point_cost_unclear: 'Point cost unclear',
  points_range_confirm: 'Menu range – confirm amount',
  no_client_approval_evidence: 'No client approval found',
  email_only: 'Email only (no ClickUp task)',
  embedded_instructions: 'Contains instruction-like text (ignored)',
  scope_changed: 'Scope change mentioned',
  menu_item_not_on_client_menu: 'Menu item not on this client\'s menu',
  hours_unclear: 'Hours unclear',
  not_yet_completed: 'Not yet completed',
};
const ACTION_TEXT = { forecast: 'Planned (forecast)', approve: 'Approved → reserve points', complete: 'Completed → use points', cancel: 'Canceled → release points', change: 'Scope change', support_hours: 'Support hours (not points)' };
const DEFAULT_STATE = { forecast: 'forecast', approve: 'committed', complete: 'used', cancel: 'canceled', change: '' };

document.getElementById('logout').addEventListener('click', logout);
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  state.tab = b.dataset.tab; render();
}));
document.getElementById('client').addEventListener('change', (e) => { state.clientId = Number(e.target.value); refresh(); });

async function init() {
  const me = await api('/api/me');
  if (me.user.role !== 'staff') { location.href = '/client'; return; }
  state.clients = await api('/api/staff/clients');
  const sel = document.getElementById('client');
  sel.replaceChildren(...state.clients.map((c) => h('option', { value: c.id }, `${c.name}${c.pilot ? ' (pilot)' : ''}`)));
  state.clientId = state.clients[0] && state.clients[0].id;
  await refresh();
}

async function refresh() {
  state.overview = await api(`/api/staff/clients/${state.clientId}/overview`);
  const b = state.overview.balance;
  const s = (label, v, cls) => h('div', { class: `stat ${cls || ''}` }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, String(v)));
  document.getElementById('balance').replaceChildren(
    s('Allocated', b.allocated), s('Used', b.used, 'used'), s('Committed', b.committed, 'committed'), s('Available', b.available, 'available'),
    s('Forecast (not counted)', b.forecast, 'forecast'),
    ...(state.overview.support_hours ? [s('Support hours left', `${state.overview.support_hours.hours_remaining} / ${state.overview.support_hours.hours_purchased} h`, 'hours')] : []));
  await render();
}

async function act(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); await refresh(); } catch (e) { toast(e.message, 'error'); }
}

async function render() {
  const fn = { review: renderReview, ledger: renderLedger, entry: renderEntry, sources: renderSources, preview: renderPreview, audit: renderAudit }[state.tab];
  panel.replaceChildren(h('p', { class: 'muted' }, 'Loading…'));
  try { panel.replaceChildren(await fn()); } catch (e) { panel.replaceChildren(h('p', { class: 'error' }, e.message)); }
}

// ------------------------------------------------------------------ review queue
function menuSelect(selected, name = 'menuItemCode') {
  return h('select', { name }, h('option', { value: '' }, '— choose menu item —'),
    state.overview.menu.items.map((i) => h('option', { value: i.code, selected: i.code === selected },
      `${i.code} · ${i.name} (${i.points_min === i.points_max ? i.points_min : `${i.points_min}–${i.points_max}`} pts)`)));
}

function evidenceList(ev) {
  return h('ul', { class: 'evidence' }, ev.map((r) => h('li', {},
    h('div', { class: 'ev-head' },
      h('span', { class: `src ${r.source_type}` }, r.source_type === 'clickup_task' ? 'ClickUp' : 'Email'),
      r.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener noreferrer' }, r.title) : r.title,
      h('span', { class: 'muted small' }, ` · ${r.author || ''} · ${fmtDate(r.occurred_at)}${r.status ? ` · ${r.status}` : ''} · signal: ${r.signal || '—'}`)),
    r.body ? h('details', {}, h('summary', {}, 'Show source text (evidence only)'), h('pre', { class: 'source-text' }, r.body)) : null)));
}

function suggestionCard(s, others) {
  const isHours = s.action === 'support_hours';
  const form = h('form', { class: 'review-form' });
  const range = s.points_min != null ? (s.points_min === s.points_max ? `${s.points_min}` : `${s.points_min}–${s.points_max}`) : '?';
  form.append(
    isHours
      ? h('label', {}, 'Hours', h('input', { name: 'hours', type: 'number', step: '0.25', min: '0', value: s.proposed_hours ?? '' }))
      : h('div', { class: 'row' },
        h('label', {}, 'Result', h('select', { name: 'state' }, ['forecast', 'committed', 'used', 'canceled'].map((st) =>
          h('option', { value: st, selected: DEFAULT_STATE[s.action] === st }, { forecast: 'Forecast only', committed: 'Committed (reserve)', used: 'Used (completed & confirmed)', canceled: 'Canceled (release)' }[st])))),
        s.work_item_id ? null : h('label', {}, 'Menu item', menuSelect(s.menu_item_code)),
        h('label', {}, s.work_item_id ? 'Points (from the existing ledger entry)' : `Points (menu ${range})`, h('input', { name: 'points', type: 'number', min: '0', step: '1', value: s.proposed_points ?? '', placeholder: 'confirm' }))),
    h('label', {}, 'Client-facing summary (plain language)', h('textarea', { name: 'clientSummary', rows: '2', placeholder: 'e.g. Built the new partner landing page and sign-up form' })),
    h('label', { class: 'check' }, h('input', { name: 'summaryApproved', type: 'checkbox' }), 'Summary approved to show the client'),
    h('label', {}, 'Reason / note (required for dismissals, exceptions and corrections)', h('input', { name: 'reason', type: 'text' })),
    h('div', { class: 'actions' },
      h('button', { type: 'button', class: 'primary', onclick: () => submit('approve') }, 'Approve'),
      isHours ? null : h('button', { type: 'button', onclick: () => submit('edit') }, 'Save edits'),
      h('button', { type: 'button', class: 'danger', onclick: () => submit('dismiss') }, 'Dismiss'),
      others.length ? h('span', { class: 'merge' },
        h('select', { name: 'intoId' }, h('option', { value: '' }, 'Merge into…'), others.map((o) => h('option', { value: o.id }, `#${o.id} ${o.title}`))),
        h('button', { type: 'button', onclick: () => submit('merge') }, 'Merge')) : null));
  function submit(kind) {
    const f = new FormData(form);
    const body = Object.fromEntries(f.entries());
    body.summaryApproved = f.get('summaryApproved') === 'on';
    if (!body.clientSummary) { delete body.clientSummary; delete body.summaryApproved; }
    if (kind === 'merge' && !body.intoId) return toast('Choose a suggestion to merge into', 'error');
    if (kind === 'edit') body.note = body.reason;
    act(() => api(`/api/staff/suggestions/${s.id}/${kind}`, body), { approve: 'Approved', edit: 'Saved', dismiss: 'Dismissed', merge: 'Merged' }[kind]);
  }
  return h('article', { class: 'card suggestion' },
    h('div', { class: 'sug-head' },
      h('h3', {}, `#${s.id} ${s.title}`),
      h('span', { class: `badge ${s.action}` }, ACTION_TEXT[s.action] || s.action),
      s.evidence_date ? h('span', { class: 'muted small' }, `evidence date ${fmtDate(s.evidence_date)}`) : null),
    s.flags.length ? h('div', { class: 'flags' }, s.flags.map((f) => h('span', { class: `flag ${f}` }, FLAG_TEXT[f] || f))) : null,
    h('div', { class: 'proposal' }, isHours ? `Proposed: ${s.proposed_hours ?? '?'} support hours` :
      `Proposed: ${s.proposed_points ?? 'reviewer to confirm'} pts${s.menu_item_code ? ` · ${s.menu_item_code}` : ''}`),
    h('pre', { class: 'rationale' }, s.rationale),
    s.reviewer_note ? h('p', { class: 'small' }, `Reviewer note: ${s.reviewer_note}`) : null,
    h('h4', {}, 'Evidence'), evidenceList(s.evidence),
    form);
}

async function renderReview() {
  const [sugs, queue] = await Promise.all([api(`/api/staff/clients/${state.clientId}/suggestions?status=open`), api('/api/staff/match-queue')]);
  document.getElementById('qcount').textContent = sugs.length ? String(sugs.length) : '';
  const out = h('div', {});
  if (queue.length) {
    out.append(h('section', { class: 'card warn' }, h('h2', {}, `Uncertain client matches (${queue.length})`),
      h('p', { class: 'muted small' }, 'These records were not matched by an explicit mapping. Assign them to a client or ignore them.'),
      queue.map((r) => {
        const sel = h('select', {}, state.clients.map((c) => h('option', { value: c.id, selected: r.match_candidates.includes(c.id) }, c.name)));
        return h('div', { class: 'match-row' },
          h('div', {}, h('strong', {}, r.title), h('div', { class: 'muted small' }, `${r.author} · ${fmtDate(r.occurred_at)} · ${r.match_reason}`),
            h('details', {}, h('summary', {}, 'Source text'), h('pre', { class: 'source-text' }, r.body))),
          h('div', { class: 'actions' }, sel,
            h('button', { onclick: () => act(() => api(`/api/staff/match-queue/${r.id}`, { clientId: Number(sel.value), reason: 'Confirmed by reviewer' }), 'Assigned') }, 'Assign'),
            h('button', { class: 'ghost', onclick: () => act(() => api(`/api/staff/match-queue/${r.id}`, { clientId: null, reason: 'Not client work' }), 'Ignored') }, 'Ignore')));
      })));
  }
  out.append(h('p', { class: 'muted small' }, 'Suggestions never change the balance on their own. Points move only when you approve.'));
  if (!sugs.length) out.append(h('p', { class: 'muted' }, 'No open suggestions. Run a sync from "Sources & sync".'));
  for (const s of sugs) out.append(suggestionCard(s, sugs.filter((o) => o.id !== s.id)));
  return out;
}

// ------------------------------------------------------------------ ledger
async function renderLedger() {
  const [items, events] = await Promise.all([api(`/api/staff/clients/${state.clientId}/work-items`), api(`/api/staff/clients/${state.clientId}/ledger`)]);
  const doTransition = (w, to) => {
    const reason = prompt(`Reason for moving "${w.title}" to ${to}:`, to === 'used' ? 'Completed and confirmed' : '');
    if (reason == null) return;
    act(() => api(`/api/staff/work-items/${w.id}/transition`, { to, reason }), 'Updated');
  };
  const doCorrect = (w) => {
    const pts = prompt(`Corrected points for "${w.title}" (currently ${w.points}):`, String(w.points)); if (pts == null) return;
    const reason = prompt('Reason for the correction (logged with your name):'); if (!reason) return toast('A reason is required', 'error');
    act(() => api(`/api/staff/work-items/${w.id}/correct`, { points: Number(pts), reason }), 'Corrected');
  };
  const doSummary = (w) => {
    const text = prompt('Client-facing summary:', w.client_summary || w.title); if (text == null) return;
    const ok = confirm('Approve this summary to show on the client dashboard?');
    act(() => api(`/api/staff/work-items/${w.id}/summary`, { clientSummary: text, approved: ok }), 'Summary saved');
  };
  return h('div', {},
    h('section', { class: 'card' }, h('h2', {}, 'Work items'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Date', 'Work', 'State', 'Points', 'Menu', 'Origin', 'Client summary', 'Evidence', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, items.map((w) => h('tr', { class: `state-${w.state}` },
          h('td', {}, fmtDate(w.work_date)), h('td', {}, w.title), h('td', {}, h('span', { class: `badge st-${w.state}` }, w.state)),
          h('td', { class: 'num' }, String(w.points)), h('td', {}, w.menu_item_code || '—'), h('td', {}, w.origin),
          h('td', {}, w.client_summary ? `${w.client_summary}${w.summary_approved ? ' ✓' : ' (not approved)'}` : '—'),
          h('td', {}, w.evidence.map((e) => (e.url ? h('a', { href: e.url, target: '_blank', rel: 'noopener noreferrer', class: 'ev-link' }, e.source_type === 'clickup_task' ? 'ClickUp' : 'Email') : null))),
          h('td', { class: 'row-actions' },
            w.state === 'forecast' ? h('button', { onclick: () => doTransition(w, 'committed') }, 'Approve') : null,
            ['forecast', 'committed'].includes(w.state) ? h('button', { onclick: () => doTransition(w, 'used') }, 'Complete') : null,
            ['forecast', 'committed'].includes(w.state) ? h('button', { onclick: () => doTransition(w, 'canceled') }, 'Cancel') : null,
            ['committed', 'used'].includes(w.state) ? h('button', { onclick: () => doCorrect(w) }, 'Correct') : null,
            h('button', { onclick: () => doSummary(w) }, 'Summary')))))))),
    h('section', { class: 'card' }, h('h2', {}, 'Ledger events (append-only)'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['When', 'Work', 'Event', 'Committed Δ', 'Used Δ', 'By', 'Reason'].map((t) => h('th', {}, t)))),
        h('tbody', {}, events.map((e) => h('tr', {},
          h('td', {}, fmtDateTime(e.created_at)), h('td', {}, e.title), h('td', {}, e.event_type),
          h('td', { class: 'num' }, signed(e.committed_delta)), h('td', { class: 'num' }, signed(e.used_delta)), h('td', {}, e.actor), h('td', {}, e.reason || ''))))))));
}
const signed = (n) => (n > 0 ? `+${n}` : n === 0 ? '·' : String(n));

// ------------------------------------------------------------------ manual entry & import
function renderEntry() {
  const form = h('form', { class: 'card grid-form' },
    h('h2', {}, 'Manual entry'),
    h('p', { class: 'muted small' }, 'Use when a connector is unavailable or the work happened outside ClickUp/Outlook.'),
    h('label', {}, 'Title (internal)', h('input', { name: 'title', required: true })),
    h('label', {}, 'Menu item', menuSelect('')),
    h('label', {}, 'Points', h('input', { name: 'points', type: 'number', min: '0', step: '1', required: true })),
    h('label', {}, 'State', h('select', { name: 'state' }, h('option', { value: 'forecast' }, 'Forecast'), h('option', { value: 'committed' }, 'Committed'), h('option', { value: 'used' }, 'Used'))),
    h('label', {}, 'Date', h('input', { name: 'workDate', type: 'date', value: new Date().toISOString().slice(0, 10) })),
    h('label', {}, 'Evidence / reason', h('input', { name: 'reason', required: true, placeholder: 'e.g. Approved by Dana on call 11/18' })),
    h('label', {}, 'Exception reason (if outside menu)', h('input', { name: 'exceptionReason' })),
    h('label', {}, 'Client summary', h('input', { name: 'clientSummary' })),
    h('label', { class: 'check' }, h('input', { name: 'summaryApproved', type: 'checkbox' }), 'Summary approved for client'),
    h('input', { type: 'hidden', name: 'idempotencyKey', value: crypto.randomUUID() }),
    h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Add entry')));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = new FormData(form); const body = Object.fromEntries(f.entries()); body.summaryApproved = f.get('summaryApproved') === 'on';
    act(async () => { const r = await api(`/api/staff/clients/${state.clientId}/work-items`, body); if (r.duplicate) toast('Already added (duplicate submit ignored)'); }, 'Entry added');
  });
  const imp = h('form', { class: 'card' },
    h('h2', {}, 'Import from tracker (CSV)'),
    h('p', { class: 'muted small' }, 'Columns: tracker_id, date, title, client_summary, menu_code, points, status (used|committed|forecast), clickup_task_id, notes. Re-importing the same tracker_id is skipped, never duplicated.'),
    h('input', { type: 'file', name: 'file', accept: '.csv,text/csv' }),
    h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'opening' }), 'This is the reconciled opening balance'),
    h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Import')));
  imp.addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = imp.querySelector('input[type=file]').files[0]; if (!file) return toast('Choose a CSV file', 'error');
    const csv = await file.text();
    act(async () => {
      const r = await api(`/api/staff/clients/${state.clientId}/import`, { csv, filename: file.name, opening: imp.querySelector('[name=opening]').checked });
      toast(`Imported ${r.created}, skipped ${r.skipped}${r.conflicts.length ? `, ${r.conflicts.length} conflict(s): ${r.conflicts.map((c) => c.note).join(' | ')}` : ''}`, r.conflicts.length ? 'error' : 'ok');
    });
  });
  return h('div', { class: 'two-col' }, form, imp);
}

// ------------------------------------------------------------------ sources
function renderSources() {
  const o = state.overview;
  const box = (key, label) => {
    const s = o.sync[key];
    return h('div', { class: 'card' }, h('h3', {}, label),
      key !== 'tracker' ? h('p', { class: 'small' }, `Mode: ${o.connector_mode[key]} (read-only)`) : null,
      h('p', {}, 'Last successful sync: ', h('strong', {}, fmtDateTime(s.last_success_at))),
      s.last_run ? h('p', { class: 'small muted' }, `Last run ${fmtDateTime(s.last_run.started_at)} · ${s.last_run.status} · seen ${s.last_run.records_seen}, new ${s.last_run.records_new}, updated ${s.last_run.records_updated}${s.last_run.since ? ` · since ${fmtDate(s.last_run.since)}` : ''}`) : null,
      s.recent_failures.length ? h('div', { class: 'error small' }, h('strong', {}, 'Recent failures'), h('ul', {}, s.recent_failures.map((f) => h('li', {}, `${fmtDateTime(f.started_at)}: ${f.error}`)))) : null,
      key !== 'tracker' ? h('button', { class: 'primary', onclick: () => act(async () => {
        const r = await api(`/api/staff/clients/${state.clientId}/sync`, { source: key });
        if (r[key].status === 'failed') throw new Error(`Sync failed: ${r[key].error}`);
        toast(`Synced: ${r[key].new} new, ${r[key].updated} updated`);
      }) }, `Sync ${label} now`) : null);
  };
  return h('div', {},
    h('div', { class: 'three-col' }, box('clickup', 'ClickUp'), box('outlook', 'Outlook'), box('tracker', 'Tracker import')),
    h('section', { class: 'card' }, h('h2', {}, 'Contract & allocation (source of truth)'),
      h('p', {}, `${o.contract.agreement_ref} · term ${fmtDate(o.contract.term_start)} – ${fmtDate(o.contract.term_end)} · menu ${o.menu.version.code}`),
      h('p', { class: 'small' }, `Opening balance as of ${fmtDate(o.contract.opening_balance_date)}: ${o.contract.opening_used} used / ${o.contract.opening_committed} committed · ${o.contract.opening_reconciled_at ? `reconciled ${fmtDateTime(o.contract.opening_reconciled_at)}` : 'NOT reconciled'}`),
      h('ul', {}, o.allocations.map((a) => h('li', {}, `${a.kind}: ${a.points} pts — ${a.source_ref} (verified by ${a.verified_by})`)))),
    h('section', { class: 'card' }, h('h2', {}, 'Client-to-source mappings'),
      h('table', {}, h('thead', {}, h('tr', {}, ['Type', 'Value', 'Scope', 'Label'].map((t) => h('th', {}, t)))),
        h('tbody', {}, o.mappings.map((m) => h('tr', {}, h('td', {}, m.source_type), h('td', {}, m.value), h('td', {}, m.scope), h('td', {}, m.label || '')))))));
}

// ------------------------------------------------------------------ preview & access
async function renderPreview() {
  const v = await api(`/api/staff/clients/${state.clientId}/preview`);
  const c = state.overview.client;
  return h('div', {},
    h('section', { class: 'card access' },
      h('div', {}, h('strong', {}, c.portal_enabled ? 'Client access is ON' : 'Client access is OFF'),
        h('p', { class: 'muted small' }, 'Below is exactly what the client sees (same server function, same fields).')),
      h('button', { class: c.portal_enabled ? 'danger' : 'primary', onclick: () => {
        if (!confirm(c.portal_enabled ? 'Revoke client access and sign out their sessions?' : 'Grant this client access to the dashboard shown below?')) return;
        act(() => api(`/api/staff/clients/${state.clientId}/portal`, { enabled: !c.portal_enabled }), c.portal_enabled ? 'Access revoked' : 'Access granted');
      } }, c.portal_enabled ? 'Revoke access' : 'Grant access')),
    h('div', { class: 'preview-frame' }, renderClientView(v)));
}

async function renderAudit() {
  const rows = await api(`/api/staff/clients/${state.clientId}/audit`);
  return h('section', { class: 'card' }, h('h2', {}, 'Audit log'), h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['When', 'Who', 'Action', 'Reason', 'Detail'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, fmtDateTime(r.created_at)), h('td', {}, r.actor), h('td', {}, r.action), h('td', {}, r.reason || ''), h('td', { class: 'small' }, r.detail || '')))))));
}

init().catch((e) => panel.replaceChildren(h('p', { class: 'error' }, e.message)));
