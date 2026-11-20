'use strict';
const state = { clientId: null, tab: 'review', overview: null, clients: [], menuId: null };
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
document.getElementById('add-points').addEventListener('click', () => openAddPoints());

// ------------------------------------------------------------------ "+ Add points" dialog
// Two cases: (1) log work that never showed up in ClickUp or email, (2) add points to the allocation.
function openAddPoints(mode = 'work') {
  const o = state.overview; const b = o.balance;
  const today = new Date().toISOString().slice(0, 10);
  const dlg = h('dialog', { class: 'add-points', 'aria-label': 'Add points' });
  const body = h('div', { class: 'dlg-body' });
  const close = () => { dlg.close(); dlg.remove(); };
  const seg = h('div', { class: 'seg', role: 'tablist' },
    h('button', { type: 'button', class: mode === 'work' ? 'on' : '', onclick: () => { close(); openAddPoints('work'); } }, 'Log work'),
    h('button', { type: 'button', class: mode === 'alloc' ? 'on' : '', onclick: () => { close(); openAddPoints('alloc'); } }, 'Add to allocation'));
  const impact = h('p', { class: 'impact' });
  let form;

  if (mode === 'work') {
    const menuSel = h('select', { name: 'menuItemCode' }, h('option', { value: '' }, 'Custom – not on the menu'),
      o.menu.items.map((i) => h('option', { value: i.code }, `${i.name} (${i.points_min === i.points_max ? i.points_min : `${i.points_min}–${i.points_max}`} pts)`)));
    const pts = h('input', { name: 'points', type: 'number', min: '0', step: '1', required: true });
    const st = h('select', { name: 'state' },
      h('option', { value: 'used' }, 'Completed – use points now'),
      h('option', { value: 'committed' }, 'Approved, not done yet – reserve points'),
      h('option', { value: 'forecast' }, 'Planned only – forecast (no points move)'));
    const exc = h('label', {}, 'Why this amount? (required for custom work or amounts outside the menu)', h('input', { name: 'exceptionReason', placeholder: 'e.g. Agreed 6 pts with Dana for a one-off training deck' }));
    const update = () => {
      const m = o.menu.items.find((i) => i.code === menuSel.value);
      if (m && pts.dataset.auto !== 'off') pts.value = m.points_min === m.points_max ? m.points_min : '';
      const n = Number(pts.value) || 0;
      const outside = m ? (n < m.points_min || n > m.points_max) : true;
      exc.hidden = !outside;
      const s2 = st.value;
      impact.textContent = s2 === 'forecast' ? `No change to the balance. Shown as forecast (${b.forecast + n} pts planned).`
        : `Available goes from ${b.available} to ${b.available - n}. ${s2 === 'used' ? `Used becomes ${b.used + n}.` : `Committed becomes ${b.committed + n}.`}`;
    };
    pts.addEventListener('input', () => { pts.dataset.auto = 'off'; update(); });
    menuSel.addEventListener('change', () => { pts.dataset.auto = 'on'; update(); });
    st.addEventListener('change', update);
    form = h('form', { class: 'grid-form' },
      h('div', { class: 'hint' }, 'For work that never appeared in ClickUp or email: a call, a Teams message, a hallway request. It goes straight onto the ledger and is logged with your name.'),
      h('label', {}, 'What was the work?', h('input', { name: 'title', required: true, placeholder: 'e.g. Rebuilt the partner referral form' })),
      h('div', { class: 'row' }, h('label', {}, 'Service menu item', menuSel), h('label', {}, 'Points', pts)),
      exc,
      h('div', { class: 'row' }, h('label', {}, 'Status', st), h('label', {}, 'Date', h('input', { name: 'workDate', type: 'date', value: today }))),
      h('label', {}, 'How do we know? (who asked / approved, and where)', h('input', { name: 'reason', required: true, placeholder: 'e.g. Dana approved on our 11/18 call' })),
      h('label', {}, 'Link to evidence (optional)', h('input', { name: 'evidenceUrl', type: 'url', placeholder: 'https://…' })),
      h('label', {}, 'What the client will see (plain language, optional)', h('input', { name: 'clientSummary', placeholder: 'e.g. Rebuilt your partner referral form' })),
      h('label', { class: 'check' }, h('input', { name: 'summaryApproved', type: 'checkbox' }), 'Show this summary on the client dashboard'),
      h('input', { type: 'hidden', name: 'idempotencyKey', value: crypto.randomUUID() }),
      impact,
      h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Add to ledger'), h('button', { type: 'button', onclick: close }, 'Cancel')));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const f = new FormData(form); const data = Object.fromEntries(f.entries()); data.summaryApproved = f.get('summaryApproved') === 'on';
      act(async () => {
        const r = await api(`/api/staff/clients/${state.clientId}/work-items`, data);
        close(); toast(r.duplicate ? 'Already added (duplicate submit ignored)' : 'Work added to the ledger');
      });
    });
    setTimeout(update);
  } else {
    const pts = h('input', { name: 'points', type: 'number', min: '1', step: '1', required: true });
    const update = () => { const n = Number(pts.value) || 0; impact.textContent = `Allocated goes from ${b.allocated} to ${b.allocated + n}; available from ${b.available} to ${b.available + n}.`; };
    pts.addEventListener('input', update);
    form = h('form', { class: 'grid-form' },
      h('div', { class: 'hint' }, 'For bonus points or additional points the client bought. The signed agreement or order form is the source of truth, so reference it.'),
      h('div', { class: 'row' },
        h('label', {}, 'Type', h('select', { name: 'kind' }, h('option', { value: 'purchase' }, 'Additional purchase'), h('option', { value: 'bonus' }, 'Bonus points'))),
        h('label', {}, 'Points', pts)),
      h('label', {}, 'Agreement / order form reference', h('input', { name: 'sourceRef', required: true, placeholder: 'e.g. Order form PO-1204, signed 2026-11-18' })),
      h('label', {}, 'Note (optional)', h('input', { name: 'note' })),
      impact,
      h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Add to allocation'), h('button', { type: 'button', onclick: close }, 'Cancel')));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const data = Object.fromEntries(new FormData(form).entries());
      act(async () => { await api(`/api/staff/clients/${state.clientId}/allocations`, data); close(); toast('Allocation updated'); });
    });
    update();
  }
  body.append(seg, form);
  dlg.append(h('div', { class: 'dlg-head' }, h('h2', {}, `Add points · ${o.client.name}`), h('button', { type: 'button', onclick: close, 'aria-label': 'Close' }, 'Close')), body);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.append(dlg);
  dlg.showModal();
}
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
  const fn = { menu: renderMenu, review: renderReview, ledger: renderLedger, entry: renderEntry, sources: renderSources, preview: renderPreview, audit: renderAudit }[state.tab];
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
    h('section', { class: 'card' }, h('div', { class: 'toolbar' }, h('h2', {}, 'Work items'), h('button', { class: 'primary', onclick: () => openAddPoints() }, '+ Add points')),
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
  return h('div', {}, imp,
    h('p', { class: 'muted small' }, 'To add a single entry by hand, use the "+ Add points" button.'));
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
    renderMappings(o));
}

const MAP_TYPE_TEXT = { clickup_space: 'ClickUp space', clickup_list: 'ClickUp list', email_domain: 'Email domain', email_address: 'Email address' };
const SCOPE_TEXT = { points: 'Points work', consulting: 'Monthly consulting (flag, no points)', project: 'Fixed-scope project (flag, no points)', support_hours: 'HubSpot support hours (hours, not points)' };

function renderMappings(o) {
  const type = h('select', {}, Object.entries(MAP_TYPE_TEXT).map(([k, t]) => h('option', { value: k }, t)));
  const value = h('input', { placeholder: 'Paste the ClickUp list URL or ID', required: true });
  const scope = h('select', {}, Object.entries(SCOPE_TEXT).map(([k, t]) => h('option', { value: k }, t)));
  const label = h('input', { placeholder: 'e.g. Harbor Point – Points work' });
  type.addEventListener('change', () => {
    value.placeholder = { clickup_space: 'Paste the ClickUp space URL or ID', clickup_list: 'Paste the ClickUp list URL or ID', email_domain: 'clientname.com', email_address: 'person@clientname.com' }[type.value];
  });
  const form = h('form', {},
    h('div', { class: 'row' }, h('label', {}, 'Source', type), h('label', {}, 'Which one', value)),
    h('div', { class: 'row' }, h('label', {}, 'What kind of work is in it', scope), h('label', {}, 'Label (optional)', label)),
    h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Add source')));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    act(() => api(`/api/staff/clients/${state.clientId}/mappings`, { sourceType: type.value, value: value.value, scope: scope.value, label: label.value }), 'Source added');
  });
  const live = Object.values(o.connector_mode).every((m) => m === 'live');
  return h('div', {},
    h('section', { class: 'card' }, h('h2', {}, `Where ${o.client.name}'s work comes from`),
      h('p', { class: 'muted small' }, 'The app only reads the ClickUp lists/spaces and email addresses listed here. Anything else is ignored, and emails that merely mention the client by name go to "Uncertain client matches" for a person to decide.'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Source', 'Which one', 'Kind of work', 'Label', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, o.mappings.map((m) => h('tr', {},
          h('td', {}, MAP_TYPE_TEXT[m.source_type]), h('td', {}, m.value), h('td', {}, SCOPE_TEXT[m.scope]), h('td', {}, m.label || ''),
          h('td', { class: 'row-actions' }, h('button', { class: 'danger', onclick: () => {
            if (!confirm(`Stop reading ${MAP_TYPE_TEXT[m.source_type]} ${m.value} for this client? Evidence already imported stays.`)) return;
            act(() => api(`/api/staff/clients/${state.clientId}/mappings/${m.id}/remove`, {}), 'Source removed');
          } }, 'Remove'))))))),
      h('h3', {}, 'Add a source'), form),
    h('section', { class: 'card explain' }, h('h2', {}, 'How the ClickUp connection works'),
      h('p', { class: 'small' }, live ? 'Connected to live ClickUp and Outlook.' : 'Right now the app is reading built-in SAMPLE data, not your real ClickUp or Outlook. Switching to live is a server setting (see README).'),
      h('ol', { class: 'small' },
        h('li', {}, 'When you click "Sync ClickUp now", the server asks ClickUp for tasks in the lists above that changed since the last sync. It only reads; it can never change a task.'),
        h('li', {}, 'For each task it notes the status (to do, in progress, complete, canceled), plus these optional task fields: a "Service Menu Item" custom field or a tag like menu:LP-BUILD, a "Points" custom field, and an "Hours" field for support work. Subtasks roll up into their parent task.'),
        h('li', {}, 'Emails that contain the task link (app.clickup.com/t/…) or its ID (CU-…) are grouped with that task, so one deliverable becomes one suggestion.'),
        h('li', {}, 'It turns what it found into suggestions in the Review queue. Nothing changes the balance until a consultant approves.'))));
}
// ------------------------------------------------------------------ preview & access
async function renderPreview() {
  const [v, users] = await Promise.all([api(`/api/staff/clients/${state.clientId}/preview`), api(`/api/staff/clients/${state.clientId}/users`)]);
  const c = state.overview.client;
  const STATUS = { active: 'Active', invited: 'Invite sent', invite_expired: 'Link expired' };

  // Shows a freshly created one-time link with a copy button. The link is only shown once.
  const linkBox = h('div', {});
  const showLink = (who, r) => {
    const input = h('input', { value: r.link, readonly: true, 'aria-label': 'Setup link' });
    linkBox.replaceChildren(h('div', { class: 'card warn' },
      h('strong', {}, `Send this link to ${who}`),
      h('p', { class: 'small' }, `They open it, choose their own password, then sign in. It works once and expires ${fmtDate(r.expires_at)}. Copy it now: for security it isn't shown again (you can always make a new one).`),
      h('div', { class: 'invite-link' }, input, h('button', { class: 'primary', onclick: async () => {
        input.select();
        try { await navigator.clipboard.writeText(r.link); toast('Link copied'); } catch { document.execCommand('copy'); toast('Link copied'); }
      } }, 'Copy link'))));
  };

  const name = h('input', { placeholder: 'e.g. Dana Reyes', required: true });
  const email = h('input', { type: 'email', placeholder: 'dana@client.com', required: true });
  const addForm = h('form', { class: 'row' }, h('label', {}, 'Name', name), h('label', {}, 'Email', email),
    h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Add login & get link')));
  addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const r = await api(`/api/staff/clients/${state.clientId}/users`, { name: name.value, email: email.value });
      state.pendingLink = { who: name.value, r }; await render();
    } catch (ex) { toast(ex.message, 'error'); }
  });

  if (state.pendingLink) { showLink(state.pendingLink.who, state.pendingLink.r); state.pendingLink = null; }
  const logins = h('section', { class: 'card' },
    h('h2', {}, 'Client logins'),
    h('ol', { class: 'small steps' },
      h('li', {}, 'Check the preview below: it is exactly what the client will see.'),
      h('li', {}, 'Add a login for each person at the client. You get a one-time link to send them (email, Teams, etc.).'),
      h('li', {}, 'Turn on dashboard access. Until it is on, nobody at this client can sign in, even with a password.')),
    users.length ? h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Name', 'Email', 'Status', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, users.map((u) => h('tr', {},
        h('td', {}, u.name), h('td', {}, u.email), h('td', {}, h('span', { class: `status ${u.status}` }, STATUS[u.status])),
        h('td', { class: 'row-actions' },
          h('button', { onclick: async () => {
            try { showLink(u.name, await api(`/api/staff/clients/${state.clientId}/users/${u.id}/link`, {})); } catch (ex) { toast(ex.message, 'error'); }
          } }, u.status === 'active' ? 'Password reset link' : 'New link'),
          h('button', { class: 'danger', onclick: () => {
            if (!confirm(`Remove ${u.name}'s login? They will be signed out immediately.`)) return;
            act(() => api(`/api/staff/clients/${state.clientId}/users/${u.id}/remove`, {}), 'Login removed');
          } }, 'Remove'))))))) : h('p', { class: 'muted' }, 'No logins yet.'),
    linkBox,
    h('h3', {}, 'Add a login'), addForm);

  return h('div', {},
    h('section', { class: 'card access' },
      h('div', {}, h('strong', {}, c.portal_enabled ? 'Dashboard access is ON' : 'Dashboard access is OFF'),
        h('p', { class: 'muted small' }, c.portal_enabled ? `${users.filter((u) => u.status === 'active').length} active login(s) can see the dashboard below.` : 'Nobody at this client can sign in yet.')),
      h('button', { class: c.portal_enabled ? 'danger' : 'primary', onclick: () => {
        if (!confirm(c.portal_enabled ? 'Turn off access and sign out everyone at this client?' : 'Turn on access? Everyone with a login at this client will be able to see the dashboard below.')) return;
        act(() => api(`/api/staff/clients/${state.clientId}/portal`, { enabled: !c.portal_enabled }), c.portal_enabled ? 'Access turned off' : 'Access turned on');
      } }, c.portal_enabled ? 'Turn off access' : 'Turn on access')),
    logins,
    h('h2', { class: 'preview-title' }, 'What the client sees'),
    h('div', { class: 'preview-frame' }, renderClientView(v)));
}

// ------------------------------------------------------------------ service menu editor
async function renderMenu() {
  const menus = await api('/api/staff/menus');
  const clientVersionId = state.overview.contract.menu_version_id;
  if (!menus.some((m) => m.id === state.menuId)) state.menuId = clientVersionId;
  const v = menus.find((m) => m.id === state.menuId) || menus[0];
  const clientName = state.overview.client.name;
  const range = (i) => (i.points_min === i.points_max ? `${i.points_min}` : `${i.points_min}–${i.points_max}`);

  const picker = h('select', { onchange: (e) => { state.menuId = Number(e.target.value); render(); } },
    menus.map((m) => h('option', { value: m.id, selected: m.id === v.id }, `${m.code} · ${m.name}${m.clients.length ? ` (used by ${m.clients.map((c) => c.name).join(', ')})` : ''}`)));

  // Version details
  const vName = h('input', { value: v.name }); const vDate = h('input', { type: 'date', value: v.effective_date });
  const details = h('section', { class: 'card' },
    h('div', { class: 'toolbar' }, h('h2', {}, `Menu ${v.code}`),
      v.id === clientVersionId ? h('span', { class: 'badge st-committed' }, `${clientName} uses this menu`)
        : h('button', { class: 'secondary', onclick: () => {
          if (!confirm(`Switch ${clientName} to menu ${v.code}?\n\nNew suggestions and entries will use these prices. Work already approved keeps its original points.`)) return;
          act(() => api(`/api/staff/clients/${state.clientId}/menu`, { versionId: v.id }), `${clientName} now uses ${v.code}`);
        } }, `Use this menu for ${clientName}`)),
    h('div', { class: 'hint' }, 'Editing a menu never changes points already approved: each approved item keeps the amount it was approved at. Changes apply to new suggestions and entries. Every change is recorded in the audit log.'),
    h('div', { class: 'row' }, h('label', {}, 'Menu name', vName), h('label', {}, 'Takes effect', vDate),
      h('div', { class: 'actions' }, h('button', { onclick: () => act(() => api(`/api/staff/menus/${v.id}`, { name: vName.value, effectiveDate: vDate.value }), 'Menu details saved') }, 'Save details'))),
    h('p', { class: 'muted small' }, `${v.items.length} items · ${v.approved_work_items} approved work items reference this version`));

  // Items table
  const itemRow = (i) => {
    const f = {
      name: h('input', { value: i ? i.name : '', placeholder: 'e.g. Landing page build', 'aria-label': 'Name' }),
      code: h('input', { value: i ? i.code : '', placeholder: 'LP-BUILD', size: '10', 'aria-label': 'Short code' }),
      min: h('input', { type: 'number', min: '0', step: '1', value: i ? i.points_min : '', class: 'pts-in', 'aria-label': 'Points (min)' }),
      max: h('input', { type: 'number', min: '0', step: '1', value: i && i.points_max !== i.points_min ? i.points_max : '', placeholder: 'same', class: 'pts-in', 'aria-label': 'Points (max, for ranges)' }),
      keywords: h('input', { value: i ? i.keywords.join(', ') : '', placeholder: 'landing page, lp', 'aria-label': 'Matching keywords' }),
      notes: h('input', { value: i ? (i.notes || '') : '', placeholder: 'optional', 'aria-label': 'Notes' }),
    };
    const save = () => act(() => api(`/api/staff/menus/${v.id}/items`, { itemId: i ? i.id : null, name: f.name.value, code: f.code.value,
      pointsMin: f.min.value, pointsMax: f.max.value, keywords: f.keywords.value, notes: f.notes.value }), i ? 'Item saved' : 'Item added');
    return h('tr', { class: i ? '' : 'new-row' },
      h('td', {}, f.name), h('td', {}, f.code), h('td', {}, f.min), h('td', {}, f.max), h('td', {}, f.keywords), h('td', {}, f.notes),
      h('td', { class: 'row-actions' }, h('button', { class: i ? '' : 'primary', onclick: save }, i ? 'Save' : '+ Add'),
        i ? h('button', { class: 'danger', onclick: () => {
          if (!confirm(`Remove "${i.name}" from menu ${v.code}? Work already approved with it is not affected.`)) return;
          act(() => api(`/api/staff/menus/${v.id}/items/${i.id}/delete`, {}), 'Item removed');
        } }, 'Remove') : null));
  };
  const items = h('section', { class: 'card' }, h('h2', {}, 'Menu items'),
    h('p', { class: 'muted small' }, 'For a fixed price, fill in only "Points". For a range (reviewer confirms the amount), also fill in "Up to". Keywords help the app recognize the item in ClickUp tasks and emails.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'menu-table' },
      h('thead', {}, h('tr', {}, ['Item', 'Code', 'Points', 'Up to', 'Keywords', 'Notes', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, v.items.map(itemRow), itemRow(null)))));

  // New version
  const nCode = h('input', { placeholder: 'e.g. 2027.1', required: true }); const nName = h('input', { placeholder: 'LeadG2 Service Point Menu 2027.1' });
  const nDate = h('input', { type: 'date', required: true }); const nCopy = h('input', { type: 'checkbox', checked: true });
  const newVersion = h('section', { class: 'card' }, h('h2', {}, 'Start a new menu version'),
    h('p', { class: 'muted small' }, 'Use this for a yearly price change: copy the current menu, adjust it, then switch clients over when their new term starts. Clients on the old menu are unaffected until you switch them.'),
    h('div', { class: 'row' }, h('label', {}, 'Version label', nCode), h('label', {}, 'Name', nName), h('label', {}, 'Takes effect', nDate)),
    h('label', { class: 'check' }, nCopy, `Start with a copy of every item in ${v.code}`),
    h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => act(async () => {
      const created = await api('/api/staff/menus', { code: nCode.value, name: nName.value, effectiveDate: nDate.value, copyFromId: nCopy.checked ? v.id : null });
      state.menuId = created.id;
    }, 'New menu version created') }, 'Create version')));

  return h('div', {}, h('div', { class: 'card' }, h('label', {}, 'Menu version', picker)), details, items, newVersion);
}

async function renderAudit() {
  const rows = await api(`/api/staff/clients/${state.clientId}/audit`);
  return h('section', { class: 'card' }, h('h2', {}, 'Audit log'), h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['When', 'Who', 'Action', 'Reason', 'Detail'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, fmtDateTime(r.created_at)), h('td', {}, r.actor), h('td', {}, r.action), h('td', {}, r.reason || ''), h('td', { class: 'small' }, r.detail || '')))))));
}

init().catch((e) => panel.replaceChildren(h('p', { class: 'error' }, e.message)));
