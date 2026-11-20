'use strict';
const state = { clientId: null, tab: 'review', overview: null, clients: [], menuId: null, area: 'workspace' };
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
  points_from_tracker: 'Points from the ClickUp tracker',
  fractional_points: 'Fractional points rounded',
};
const ACTION_TEXT = { forecast: 'Planned', approve: 'Approved → reserve points', complete: 'Completed → use points', cancel: 'Canceled → release points', change: 'Scope change', support_hours: 'Support hours (not points)' };
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
    const pts = h('input', { name: 'points', type: 'number', min: '0', step: U.word === 'hours' ? '0.25' : '1', required: true });
    const st = h('select', { name: 'state' },
      h('option', { value: 'used' }, `Completed – use ${U.word} now`),
      h('option', { value: 'committed' }, `Approved, not done yet – reserve ${U.word}`),
      h('option', { value: 'forecast' }, `Planned – no ${U.word} move yet`));
    const exc = U.word === 'hours'
      ? h('label', {}, 'Note on the time (optional)', h('input', { name: 'exceptionReason', placeholder: 'e.g. 1.5 h strategy call with Dana' }))
      : h('label', {}, 'Why this amount? (required for custom work or amounts outside the menu)', h('input', { name: 'exceptionReason', placeholder: 'e.g. Agreed 6 pts with Dana for a one-off training deck' }));
    const update = () => {
      const m = o.menu.items.find((i) => i.code === menuSel.value);
      if (m && pts.dataset.auto !== 'off') pts.value = m.points_min === m.points_max ? m.points_min : '';
      const n = Number(pts.value) || 0;
      const outside = m ? (n < m.points_min || n > m.points_max) : true;
      exc.hidden = U.word === 'hours' ? false : !outside;
      const s2 = st.value;
      impact.textContent = s2 === 'forecast' ? `No change to the balance. Planned becomes ${num(b.forecast + n)} ${U.abbr}; available after planned ${num(b.available_after_planned - n)}.`
        : `Available goes from ${num(b.available)} to ${num(b.available - n)}. ${s2 === 'used' ? `Used becomes ${num(b.used + n)}.` : `Committed becomes ${num(b.committed + n)}.`}`;
    };
    pts.addEventListener('input', () => { pts.dataset.auto = 'off'; update(); });
    menuSel.addEventListener('change', () => { pts.dataset.auto = 'on'; update(); });
    st.addEventListener('change', update);
    form = h('form', { class: 'grid-form' },
      h('div', { class: 'hint' }, 'For work that never appeared in ClickUp or email: a call, a Teams message, a hallway request. It goes straight onto the ledger and is logged with your name.'),
      h('label', {}, 'What was the work?', h('input', { name: 'title', required: true, placeholder: 'e.g. Rebuilt the partner referral form' })),
      h('div', { class: 'row' }, h('label', {}, 'Service menu item', menuSel), h('label', {}, U.Word, pts)),
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
    const pts = h('input', { name: 'points', type: 'number', min: U.word === 'hours' ? '0.25' : '1', step: U.word === 'hours' ? '0.25' : '1', required: true });
    const update = () => { const n = Number(pts.value) || 0; impact.textContent = `Allocated goes from ${b.allocated} to ${b.allocated + n}; available from ${b.available} to ${b.available + n}.`; };
    pts.addEventListener('input', update);
    form = h('form', { class: 'grid-form' },
      h('div', { class: 'hint' }, `For bonus ${U.word} or additional ${U.word} the client bought. The signed agreement or order form is the source of truth, so reference it.`),
      h('div', { class: 'row' },
        h('label', {}, 'Type', h('select', { name: 'kind' }, h('option', { value: 'purchase' }, 'Additional purchase'), h('option', { value: 'bonus' }, `Bonus ${U.word}`))),
        h('label', {}, U.Word, pts)),
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
  dlg.append(h('div', { class: 'dlg-head' }, h('h2', {}, `Add ${U.word} · ${o.client.name}`), h('button', { type: 'button', onclick: close, 'aria-label': 'Close' }, 'Close')), body);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.append(dlg);
  dlg.showModal();
}
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  state.tab = b.dataset.tab; render();
}));
document.getElementById('client').addEventListener('change', (e) => { state.clientId = Number(e.target.value); refresh(); });
document.querySelectorAll('.nav-switch button').forEach((b) => b.addEventListener('click', () => setArea(b.dataset.area)));

function setArea(area, tab) {
  state.area = area;
  document.querySelectorAll('.nav-switch button').forEach((x) => x.classList.toggle('on', x.dataset.area === area));
  document.getElementById('ws-area').hidden = area !== 'workspace';
  document.getElementById('client-pick').hidden = area !== 'workspace';
  document.getElementById('admin-area').hidden = area !== 'admin';
  state.tab = tab || (area === 'admin' ? 'clients' : 'review');
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x.dataset.tab === state.tab));
  refresh();
}

async function loadClients(selectId) {
  state.clients = await api('/api/staff/clients');
  const sel = document.getElementById('client');
  sel.replaceChildren(...state.clients.map((c) => h('option', { value: c.id }, `${c.name}${c.pilot ? ' (pilot)' : ''}`)));
  if (selectId) state.clientId = selectId;
  if (!state.clients.some((c) => c.id === state.clientId)) state.clientId = state.clients[0] ? state.clients[0].id : null;
  if (state.clientId) sel.value = String(state.clientId);
}

async function init() {
  const me = await api('/api/me');
  if (me.user.role !== 'staff') { location.href = '/client'; return; }
  state.me = me.user;
  await loadClients();
  if (!state.clients.length) setArea('admin', 'clients'); else await refresh();
}

async function refresh() {
  if (state.area !== 'workspace' || !state.clientId) { state.overview = null; return render(); }
  state.overview = await api(`/api/staff/clients/${state.clientId}/overview`);
  setUnit(state.overview.client.unit);
  document.getElementById('add-points').textContent = `+ Add ${U.word}`;
  const b = state.overview.balance;
  const s = (label, v, cls) => h('div', { class: `stat ${cls || ''}` }, h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, typeof v === 'number' ? num(v) : String(v)));
  document.getElementById('balance').replaceChildren(
    s('Allocated', b.allocated), s('Used', b.used, 'used'), s('Committed', b.committed, 'committed'), s('Available', b.available, 'available'),
    s('Planned (not counted)', b.forecast, 'forecast'),
    s('Available after planned', b.available_after_planned, 'forecast'),
    ...(state.overview.support_hours ? [s('Support hours left', `${state.overview.support_hours.hours_remaining} / ${state.overview.support_hours.hours_purchased} h`, 'hours')] : []));
  await render();
}

async function act(fn, okMsg) {
  try { await fn(); if (okMsg) toast(okMsg); await refresh(); } catch (e) { toast(e.message, 'error'); }
}

async function render() {
  const fn = { months: renderMonths, clients: renderClients, team: renderTeam, menu: renderMenu, review: renderReview, ledger: renderLedger, entry: renderEntry, sources: renderSources, preview: renderPreview, audit: renderAudit }[state.tab];
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
          h('option', { value: st, selected: DEFAULT_STATE[s.action] === st }, { forecast: 'Planned (not counted)', committed: 'Committed (reserve)', used: 'Used (completed & confirmed)', canceled: 'Canceled (release)' }[st])))),
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

// ------------------------------------------------------------------ by month
async function renderMonths() {
  const data = await api(`/api/staff/clients/${state.clientId}/by-month`);
  const b = state.overview.balance;
  const jump = (key) => { const el = document.getElementById(`month-${key}`); if (el) { el.open = true; el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } };
  return h('div', {},
    renderOutlook(data.look_ahead, { showPlanned: true }),
    h('section', { class: 'card' },
      h('div', { class: 'toolbar' }, h('h2', {}, `${U.Word} by `, h('em', {}, 'month')),
        h('span', { class: 'muted small' }, `${b.used} used · ${b.committed} committed · ${b.forecast} planned of ${b.allocated}`)),
      monthChart(data.months, { showPlanned: true, onPick: jump })),
    h('section', { class: 'card' },
      h('div', { class: 'toolbar' }, h('h2', {}, 'Work, ', h('em', {}, 'month by month')),
        h('div', { class: 'actions' },
          h('button', { type: 'button', onclick: () => document.querySelectorAll('details.month').forEach((d) => { d.open = true; }) }, 'Expand all'),
          h('button', { type: 'button', onclick: () => document.querySelectorAll('details.month').forEach((d) => { d.open = false; }) }, 'Collapse all'))),
      h('p', { class: 'muted small' }, 'Colors show the type of work (from the ClickUp Department, or the menu category). Click a type to filter. Click a bar to jump to its month.'),
      monthList(data, { showPlanned: true, renderItem: (it) => h('div', {}, h('div', { class: 'work-desc' }, it.title),
        it.client_summary && it.client_summary !== it.title ? h('div', { class: 'muted small' }, `Client sees: ${it.client_summary}${it.summary_approved ? '' : ' (not approved)'}`)
          : !it.summary_approved ? h('div', { class: 'muted small' }, 'No client summary yet') : null) })));
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
    h('section', { class: 'card' }, h('div', { class: 'toolbar' }, h('h2', {}, 'Work items'), h('button', { class: 'primary', onclick: () => openAddPoints() }, `+ Add ${U.word}`)),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Date', 'Work', 'State', U.Word, 'Menu', 'Origin', 'Client summary', 'Evidence', ''].map((t) => h('th', {}, t)))),
        h('tbody', {}, items.map((w) => h('tr', { class: `state-${w.state}` },
          h('td', {}, fmtDate(w.work_date)), h('td', {}, w.title), h('td', {}, h('span', { class: `badge st-${w.state}` }, w.state === 'forecast' ? 'planned' : w.state)),
          h('td', { class: 'num' }, num(w.points)), h('td', {}, w.menu_item_code || '—'), h('td', {}, w.origin),
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
  const MODE_TEXT = { live: 'Connected · read-only', sample: 'Sample data (demo only)', not_connected: 'Not connected yet' };
  const HOW_TO = {
    clickup: [
      'In ClickUp, click your avatar → Settings → Apps → API Token → Generate, then copy the token (starts with pk_).',
      'In Render, open leadg2-points → Environment → Add Environment Variable: key CLICKUP_API_TOKEN, value = the token. Save (the app restarts in about a minute).',
      'Come back here, pick this client\'s ClickUp lists below, and click Sync. After that it syncs by itself every hour.',
    ],
    outlook: ['Outlook needs a Microsoft 365 app registration with read-only mail access. Your Microsoft 365 admin can set it up using DEPLOY.md, section 6. Until then, log email-only work with "+ Add points".'],
  };
  const typesFor = { clickup: ['clickup_list', 'clickup_space'], outlook: ['email_domain', 'email_address'] };
  const box = (key, label) => {
    const s = o.sync[key];
    const mode = o.connector_mode[key];
    const mapped = key === 'tracker' || o.mappings.some((m) => typesFor[key].includes(m.source_type));
    return h('div', { class: 'card' }, h('h3', {}, label),
      key !== 'tracker' ? h('p', {}, h('span', { class: `status ${mode === 'live' ? 'active' : mode === 'sample' ? 'invited' : 'invite_expired'}` }, MODE_TEXT[mode] || mode)) : null,
      key !== 'tracker' && mode === 'not_connected' ? h('ol', { class: 'small steps' }, HOW_TO[key].map((t) => h('li', {}, t))) : null,
      key !== 'tracker' && mode === 'live' && !mapped ? h('p', { class: 'small' }, `No ${label} sources for this client yet. Add them below.`) : null,
      mode === 'not_connected' ? null : h('p', { class: 'small' }, key === 'tracker' ? 'Last import: ' : 'Last successful sync: ', h('strong', {}, fmtDateTime(s.last_success_at)), key !== 'tracker' && mode === 'live' ? ' · syncs automatically every hour' : ''),
      s.last_run && mode !== 'not_connected' ? h('p', { class: 'small muted' }, `Last run ${fmtDateTime(s.last_run.started_at)} · ${s.last_run.status} · seen ${s.last_run.records_seen}, new ${s.last_run.records_new}, updated ${s.last_run.records_updated}`) : null,
      s.recent_failures.length && mode !== 'not_connected' ? h('div', { class: 'error small' }, h('strong', {}, 'Recent failures'), h('ul', {}, s.recent_failures.slice(0, 3).map((f) => h('li', {}, `${fmtDateTime(f.started_at)}: ${f.error}`)))) : null,
      key === 'clickup' && mode === 'live' && mapped ? h('div', { class: 'hint' },
        'Does this client have a points tracker list in ClickUp (Total Points + Service Point Status)? Load everything in it once:',
        h('div', { class: 'actions' }, h('button', { class: 'secondary', onclick: (e) => {
          if (!confirm('Read every task in this client\'s ClickUp tracker and add it to the ledger?\n\nCompleted = used, In Progress / Client Review = committed, everything else = planned. Tasks already on the ledger are skipped, so this is safe to run again.')) return;
          e.target.disabled = true; e.target.textContent = 'Reading ClickUp…';
          act(async () => {
            const r = await api(`/api/staff/clients/${state.clientId}/clickup-import`, {});
            toast(`Found ${r.found} tracker items: ${r.created} added, ${r.skipped} already there. Now ${r.balance.used} used, ${r.balance.committed} committed, ${r.balance.available} available.`);
          });
        } }, 'Import tracker history from ClickUp'))) : null,
      key !== 'tracker' && mode !== 'not_connected' ? h('button', { class: 'primary', disabled: !mapped, onclick: () => act(async () => {
        const r = await api(`/api/staff/clients/${state.clientId}/sync`, { source: key });
        if (r[key].status === 'failed') throw new Error(`Sync failed: ${r[key].error}`);
        toast(`Synced: ${r[key].new} new, ${r[key].updated} updated${r[key].rescheduled ? `, ${r[key].rescheduled} moved to a new month or type` : ''}. Check the Review queue.`);
      }) }, `Sync ${label} now`) : null);
  };
  return h('div', {},
    h('div', { class: 'three-col' }, box('clickup', 'ClickUp'), box('outlook', 'Outlook'), box('tracker', 'Tracker import')),
    renderEditorialPageCard(o),
    renderFeedsCard(o),
    renderHubSpotCard(o),
    h('section', { class: 'card' }, h('h2', {}, 'Contract & allocation (source of truth)'),
      h('p', {}, `${o.contract.agreement_ref} · term ${fmtDate(o.contract.term_start)} – ${fmtDate(o.contract.term_end)} · menu ${o.menu.version.code}`),
      h('p', { class: 'small' }, `Opening balance as of ${fmtDate(o.contract.opening_balance_date)}: ${o.contract.opening_used} used / ${o.contract.opening_committed} committed · ${o.contract.opening_reconciled_at ? `reconciled ${fmtDateTime(o.contract.opening_reconciled_at)}` : 'NOT reconciled'}`),
      h('ul', {}, o.allocations.map((a) => h('li', {}, `${a.kind}: ${num(a.points)} ${U.abbr} — ${a.source_ref} (verified by ${a.verified_by})`)))),
    renderMappings(o));
}

function renderEditorialPageCard(o) {
  const pg = o.editorial_page;
  const file = h('input', { type: 'file', accept: '.html,.htm,text/html', 'aria-label': 'HTML file' });
  const url = h('input', { type: 'url', placeholder: 'https://… (or upload a file instead)', 'aria-label': 'Web address' });
  const save = async () => {
    const f = file.files && file.files[0];
    if (!f && !url.value.trim()) return toast('Choose an HTML file or paste a web address', 'error');
    const body = f ? { html: await f.text(), fileName: f.name } : { url: url.value.trim() };
    act(() => api(`/api/staff/clients/${state.clientId}/editorial`, body), 'Editorial calendar updated');
  };
  return h('section', { class: 'card' },
    h('h2', {}, 'Editorial calendar page (HTML)'),
    h('p', { class: 'muted small' }, 'Show your HTML editorial calendar on the client dashboard, exactly as designed. Upload the .html file (the same one embedded in ClickUp) or paste the web address where it\'s hosted. To update it, upload the new version; it replaces the old one. It replaces the list-based calendar for this client.'),
    pg ? h('div', { class: 'row' },
      h('p', { class: 'small' }, pg.kind === 'html' ? `Showing ${pg.file_name || 'uploaded file'} (${Math.round(pg.size / 1024)} KB)` : `Showing ${pg.url}`, ` · updated ${fmtDateTime(pg.updated_at)} by ${pg.updated_by}`),
      h('div', { class: 'row-actions' },
        h('a', { class: 'small', href: pg.kind === 'html' ? `/api/staff/clients/${state.clientId}/editorial` : pg.url, target: '_blank', rel: 'noopener noreferrer' }, 'View ↗'),
        h('button', { class: 'danger', onclick: () => { if (confirm('Stop showing this calendar page to the client?')) act(() => api(`/api/staff/clients/${state.clientId}/editorial/remove`, {}), 'Removed'); } }, 'Remove')))
      : h('p', { class: 'muted small' }, 'No calendar page yet.'),
    h('div', { class: 'row' }, h('label', {}, pg ? 'Replace with a file' : 'Upload HTML file', file), h('label', {}, 'or web address', url),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: save }, pg ? 'Replace' : 'Add'))));
}

function renderFeedsCard(o) {
  const KIND = { calendar: 'Editorial calendar', collaboration: 'Waiting on you (client approvals)' };
  const live = o.connector_mode.clickup === 'live';
  const kind = h('select', {}, h('option', { value: 'calendar' }, KIND.calendar), h('option', { value: 'collaboration' }, KIND.collaboration));
  const list = h('input', { placeholder: 'Paste a ClickUp list, folder or space URL' });
  const picker = h('div', { class: 'actions' });
  if (live) picker.append(h('button', { type: 'button', class: 'secondary', onclick: async (e) => {
    e.target.disabled = true; e.target.textContent = 'Loading ClickUp…';
    try {
      const tree = await api('/api/staff/clickup/browse');
      const sel = h('select', { 'aria-label': 'ClickUp list' }, h('option', { value: '' }, '— choose a list —'),
        tree.map((t) => h('optgroup', { label: `${t.workspace} · ${t.space.name}` },
          h('option', { value: `space:${t.space.id}` }, `★ Whole ${t.space.name} space (best for approvals)`),
          t.lists.map((l) => h('option', { value: l.id }, `${l.folder ? `${l.folder} › ` : ''}${l.name}`)))));
      sel.addEventListener('change', () => { list.value = sel.value; });
      picker.replaceChildren(h('label', {}, 'Pick from ClickUp', sel));
    } catch (ex) { toast(ex.message, 'error'); e.target.disabled = false; e.target.textContent = 'Browse ClickUp'; }
  } }, 'Browse ClickUp'));
  return h('section', { class: 'card' },
    h('div', { class: 'toolbar' }, h('h2', {}, 'Shown on the client dashboard'),
      live && o.feeds.length ? h('button', { onclick: () => act(() => api(`/api/staff/clients/${state.clientId}/feeds/refresh`, {}), 'Refreshed from ClickUp') }, 'Refresh now') : null),
    h('p', { class: 'muted small' }, 'Editorial calendar: the client\'s blog/content calendar list. Waiting on you: pick the client\'s whole space. Anything in a review status ("client review", "ready for review") or assigned to someone with a login for this client shows up, and they can approve, request changes or mark it done right here; the answer is written back to ClickUp. Only titles and dates are shown, never descriptions or comments. Refreshed every 30 minutes.'),
    o.feeds.length ? h('table', {}, h('tbody', {}, o.feeds.map((f) => h('tr', {},
      h('td', {}, h('strong', {}, KIND[f.kind])), h('td', { class: 'small' }, `${{ space: 'Whole space', folder: 'Folder', list: 'List' }[f.scope || 'list']} ${f.list_id}${f.label ? ` · ${f.label}` : ''}`),
      h('td', { class: 'small' }, f.last_error ? h('span', { class: 'error' }, f.last_error) : `${f.items} items · updated ${fmtDateTime(f.refreshed_at)}`),
      h('td', { class: 'row-actions' }, h('button', { class: 'danger', onclick: () => {
        if (!confirm(`Stop showing this ${KIND[f.kind].toLowerCase()} to the client?`)) return;
        act(() => api(`/api/staff/clients/${state.clientId}/feeds/${f.id}/remove`, {}), 'Removed');
      } }, 'Remove'))))))
      : h('p', { class: 'muted small' }, 'Nothing linked yet.'),
    h('h3', {}, 'Add a list'), picker,
    h('div', { class: 'row' }, h('label', {}, 'Show as', kind), h('label', {}, 'ClickUp list or space', list),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => act(() => api(`/api/staff/clients/${state.clientId}/feeds`, { kind: kind.value, listId: list.value }), 'Added') }, 'Add'))));
}

function renderHubSpotCard(o) {
  const st = o.sync.hubspot; const linked = o.client.hubspot_company_id;
  return h('section', { class: 'card' }, h('div', { class: 'toolbar' }, h('h2', {}, 'HubSpot company record'),
      o.hubspot.configured && linked ? h('button', { class: 'secondary', onclick: () => act(() => api(`/api/staff/clients/${state.clientId}/hubspot-sync`, {}), 'Balance sent to HubSpot') }, 'Update HubSpot now') : null),
    h('p', { class: 'muted small' }, 'Allocated, used, committed and available points (plus contract end) are copied onto this client\'s HubSpot company record within a few minutes of any change, so your team can see them, report on them and use them in workflows.'),
    !o.hubspot.configured ? h('p', { class: 'small' }, 'Not connected yet: the HubSpot app token has not been added to the server (see the publishing guide).')
      : !linked ? h('p', { class: 'small' }, 'This client is not linked to a HubSpot company yet. Add it under Admin → Clients → Edit.')
      : h('p', { class: 'small' }, `Linked to company ${linked} · last update ${fmtDateTime(st.last_success_at)}`),
    st.recent_failures.length ? h('p', { class: 'error small' }, `Last error: ${st.recent_failures[0].error}`) : null);
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
  // Pick ClickUp lists from the connected workspace instead of pasting IDs.
  const picker = h('div', { class: 'actions' });
  if (o.connector_mode.clickup === 'live') {
    picker.append(h('button', { type: 'button', class: 'secondary', onclick: async (e) => {
      e.target.disabled = true; e.target.textContent = 'Loading ClickUp…';
      try {
        const tree = await api('/api/staff/clickup/browse');
        const sel = h('select', { 'aria-label': 'ClickUp list or space' }, h('option', { value: '' }, '— choose a ClickUp list or space —'),
          tree.map((t) => h('optgroup', { label: `${t.workspace} · ${t.space.name}` },
            h('option', { value: `clickup_space:${t.space.id}`, 'data-label': `${t.space.name} (whole space)` }, `Whole space: ${t.space.name}`),
            t.lists.map((l) => h('option', { value: `clickup_list:${l.id}`, 'data-label': `${t.space.name} › ${l.folder ? `${l.folder} › ` : ''}${l.name}` }, `${l.folder ? `${l.folder} › ` : ''}${l.name}`)))));
        sel.addEventListener('change', () => {
          if (!sel.value) return;
          const [t, id] = sel.value.split(':'); type.value = t; value.value = id;
          label.value = sel.selectedOptions[0].dataset.label;
        });
        picker.replaceChildren(h('label', {}, 'Pick from ClickUp', sel));
      } catch (ex) { toast(ex.message, 'error'); e.target.disabled = false; e.target.textContent = 'Browse ClickUp'; }
    } }, 'Browse ClickUp'));
  }
  const form = h('form', {},
    picker,
    h('div', { class: 'row' }, h('label', {}, 'Source', type), h('label', {}, 'Which one', value)),
    h('div', { class: 'row' }, h('label', {}, 'What kind of work is in it', scope), h('label', {}, 'Label (optional)', label)),
    h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Add source')));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    act(() => api(`/api/staff/clients/${state.clientId}/mappings`, { sourceType: type.value, value: value.value, scope: scope.value, label: label.value }), 'Source added');
  });
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
      h('p', { class: 'small' }, o.connector_mode.clickup === 'live' ? 'ClickUp is connected. It syncs every hour, or click "Sync ClickUp now".'
        : o.connector_mode.clickup === 'sample' ? 'This is the demo: it reads built-in sample data, not your real ClickUp.'
        : 'ClickUp is not connected yet. Follow the three steps in the ClickUp box above.'),
      h('ol', { class: 'small' },
        h('li', {}, 'Every hour (or when you click "Sync ClickUp now"), the server asks ClickUp for tasks in the lists above that changed since the last sync. It only reads tasks. The one exception is a client answering an item in "Waiting on you" (approve, request changes, mark done): that sets the task\'s status and adds a comment.'),
        h('li', {}, 'Points-tracker lists (like "2026 Service Point Tracking") are read directly: "Service Point Status" gives the stage (Planned = forecast, In Progress = committed, Completed = used) and "Total Points" gives the amount. Month headings are ignored.'),
        h('li', {}, 'Other lists: it uses the task status, plus an optional "Service Menu Item" field or a menu:CODE tag. Subtasks without their own points roll up into their parent.'),
        h('li', {}, 'Emails that contain the task link (app.clickup.com/t/…) or its ID (CU-…) are grouped with that task, so one deliverable becomes one suggestion.'),
        h('li', {}, 'It turns what it found into suggestions in the Review queue. Nothing changes the balance until a consultant approves.'))));
}
// ------------------------------------------------------------------ quick links on the client dashboard
function renderLinksCard(list) {
  const label = h('input', { placeholder: 'e.g. Your SharePoint folder', maxlength: '60', 'aria-label': 'Name' });
  const url = h('input', { type: 'url', placeholder: 'https://…', 'aria-label': 'Web address' });
  const note = h('input', { placeholder: 'Optional: one line on what\'s there', maxlength: '140', 'aria-label': 'Description' });
  const preset = (t, n) => h('button', { type: 'button', class: 'ghost small', onclick: () => { label.value = t; note.value = n; url.focus(); } }, t);
  const form = h('form', { class: 'row' }, h('label', {}, 'Name', label), h('label', {}, 'Web address', url), h('label', {}, 'Description', note),
    h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Add link')));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    act(() => api(`/api/staff/clients/${state.clientId}/links`, { label: label.value, url: url.value, note: note.value }), 'Link added');
  });
  return h('section', { class: 'card' },
    h('h2', {}, 'Quick links on the client\'s dashboard'),
    h('p', { class: 'muted small' }, 'Cards at the top of their dashboard: their SharePoint folder, ClickUp board, brand assets, anything. They open in a new tab, and the client still needs their own access to whatever the link points to (for ClickUp, a guest invite to that board).'),
    list.length ? h('table', {}, h('tbody', {}, list.map((l, i) => h('tr', {},
      h('td', {}, h('strong', {}, l.label), l.note ? h('div', { class: 'muted small' }, l.note) : null),
      h('td', { class: 'small' }, h('a', { href: l.url, target: '_blank', rel: 'noopener noreferrer' }, l.url.length > 60 ? `${l.url.slice(0, 57)}…` : l.url)),
      h('td', { class: 'row-actions' },
        i > 0 ? h('button', { class: 'ghost', title: 'Move up', 'aria-label': `Move ${l.label} up`, onclick: () => act(() => api(`/api/staff/clients/${state.clientId}/links/${l.id}/up`, {}), 'Moved') }, '↑') : null,
        h('button', { class: 'danger', onclick: () => { if (confirm(`Remove "${l.label}" from the client's dashboard?`)) act(() => api(`/api/staff/clients/${state.clientId}/links/${l.id}/remove`, {}), 'Removed'); } }, 'Remove'))))))
      : h('p', { class: 'muted small' }, 'No links yet.'),
    h('div', { class: 'presets' }, h('span', { class: 'muted small' }, 'Quick start: '),
      preset('Your SharePoint folder', 'Shared files, reports and approved assets'),
      preset('Your project board', 'See everything we\'re working on in ClickUp'),
      preset('Book time with your consultant', 'Schedule a call')),
    form);
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
    h('section', { class: 'card access' },
      h('div', {}, h('strong', {}, c.show_planned ? 'Planned work is shown to the client' : 'Planned work is hidden from the client'),
        h('p', { class: 'muted small' }, 'Planned items appear in the month-by-month view (striped) with a note on what remains if all planned work goes ahead. They never change the four balance numbers.')),
      h('button', { onclick: () => act(() => api(`/api/staff/clients/${state.clientId}/show-planned`, { enabled: !c.show_planned }), c.show_planned ? 'Planned work hidden' : 'Planned work shown') },
        c.show_planned ? 'Hide planned work' : 'Show planned work')),
    logins,
    renderLinksCard(state.overview.links || []),
    h('h2', { class: 'preview-title' }, 'What the client sees'),
    h('div', { class: 'preview-frame' }, renderClientView(v, { preview: true, clientId: state.clientId })));
}

// ------------------------------------------------------------------ shared: one-time setup link
function linkCard(who, r) {
  const input = h('input', { value: r.link, readonly: true, 'aria-label': 'Setup link' });
  return h('div', { class: 'card warn' },
    h('strong', {}, `Send this link to ${who}`),
    h('p', { class: 'small' }, `They open it, choose their own password, then sign in. It works once and expires ${fmtDate(r.expires_at)}. Copy it now: for security it isn't shown again (you can always make a new one).`),
    h('div', { class: 'invite-link' }, input, h('button', { class: 'primary', onclick: async () => {
      input.select();
      try { await navigator.clipboard.writeText(r.link); } catch { document.execCommand('copy'); }
      toast('Link copied');
    } }, 'Copy link')));
}
const STATUS_TEXT = { active: 'Active', invited: 'Invite sent', invite_expired: 'Link expired' };

// ------------------------------------------------------------------ admin: clients
async function renderClients() {
  const [clients, menus] = await Promise.all([api('/api/staff/clients-admin'), api('/api/staff/menus')]);
  const open = (id, tab) => { state.clientId = id; document.getElementById('client').value = String(id); setArea('workspace', tab); };

  const list = clients.length ? h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['Client', 'Contract term', 'Allocated', 'Menu', 'Setup', ''].map((t) => h('th', {}, t)))),
    h('tbody', {}, clients.map((c) => {
      const todo = [
        !c.opening_reconciled_at && 'import opening balance',
        !c.sources && 'add ClickUp/email sources',
        !c.logins && 'add client logins',
        !c.portal_enabled && 'turn on access',
      ].filter(Boolean);
      return h('tr', {},
        h('td', {}, h('strong', {}, c.name), c.aliases.length ? h('div', { class: 'muted small' }, `Also known as: ${c.aliases.join(', ')}`) : null),
        h('td', {}, `${fmtDate(c.term_start)} – ${fmtDate(c.term_end)}`),
        h('td', { class: 'num' }, `${c.allocated} pts`), h('td', {}, c.menu_code || '—'),
        h('td', { class: 'small' }, todo.length ? h('span', { class: 'status invited' }, `To do: ${todo.join(', ')}`) : h('span', { class: 'status active' }, 'Live')),
        h('td', { class: 'row-actions' },
          h('button', { class: 'secondary', onclick: () => open(c.id, 'review') }, 'Open'),
          h('button', { onclick: () => editClient(c) }, 'Edit')));
    })))) : h('div', { class: 'empty' }, h('p', {}, 'No clients yet. Add your first one below.'));

  // Add-client form
  const f = (name, attrs = {}) => h('input', { name, ...attrs });
  const menuSel = h('select', { name: 'menuVersionId', required: true }, menus.length
    ? menus.map((m) => h('option', { value: m.id }, `${m.code} · ${m.name}`))
    : h('option', { value: '' }, 'Create a service menu first (Service menu tab)'));
  const tracker = h('input', { type: 'checkbox', name: 'fromTracker' });
  const unitSel = h('select', { name: 'unit' }, h('option', { value: 'points' }, 'Service points'), h('option', { value: 'hours' }, 'Hours'));
  const baseIn = f('basePoints', { type: 'number', min: '0', step: '1', required: true });
  const bonusIn = f('bonusPoints', { type: 'number', min: '0', step: '1', value: '0' });
  const allocLabel = document.createTextNode('Points allocated'); const bonusLabel = document.createTextNode('Bonus points (optional)');
  const usedLabel = document.createTextNode('Points already used'); const comLabel = document.createTextNode('Points committed (approved, not done)');
  unitSel.addEventListener('change', () => {
    const hrs = unitSel.value === 'hours'; const w = hrs ? 'Hours' : 'Points';
    allocLabel.textContent = `${w} allocated`; bonusLabel.textContent = `Bonus ${w.toLowerCase()} (optional)`;
    usedLabel.textContent = `${w} already used`; comLabel.textContent = `${w} committed (approved, not done)`;
    for (const el of form.querySelectorAll('input[name=basePoints], input[name=bonusPoints], input[name=openingUsed], input[name=openingCommitted]')) el.step = hrs ? '0.25' : '1';
  });
  const trackerFields = h('div', { class: 'form-grid', hidden: true },
    h('label', {}, 'Balance as of (date)', f('openingDate', { type: 'date' })),
    h('label', {}, usedLabel, f('openingUsed', { type: 'number', min: '0', step: '1', value: '0' })),
    h('label', {}, comLabel, f('openingCommitted', { type: 'number', min: '0', step: '1', value: '0' })));
  tracker.addEventListener('change', () => { trackerFields.hidden = !tracker.checked; });
  const form = h('form', { class: 'card' },
    h('h2', {}, 'Add a client'),
    h('div', { class: 'form-section' }, 'Client'),
    h('div', { class: 'form-grid' },
      h('label', {}, 'Client name', f('name', { required: true, placeholder: 'e.g. Harbor Point Logistics' })),
      h('label', {}, 'Other names they go by (optional, comma-separated)', f('aliases', { placeholder: 'e.g. Harbor Point, HPL' })),
      h('label', {}, 'HubSpot company (optional: paste the record URL)', f('hubspotCompanyId', { placeholder: 'https://app.hubspot.com/contacts/…/record/0-2/123456' }))),
    h('div', { class: 'form-section' }, 'Contract (from the signed agreement)'),
    h('div', { class: 'form-grid' },
      h('label', {}, 'Term starts', f('termStart', { type: 'date', required: true })),
      h('label', {}, 'Term ends', f('termEnd', { type: 'date', required: true })),
      h('label', {}, 'Service menu', menuSel),
      h('label', {}, 'Agreement reference', f('agreementRef', { required: true, placeholder: 'e.g. Services Agreement signed 2026-03-18' }))),
    h('div', { class: 'form-section' }, 'Points or hours'),
    h('div', { class: 'form-grid' },
      h('label', {}, 'This client buys', unitSel),
      h('label', {}, allocLabel, baseIn),
      h('label', {}, bonusLabel, bonusIn),
      h('label', {}, 'HubSpot support hours bank (optional)', f('supportHours', { type: 'number', min: '0', step: '0.5', value: '0' }))),
    h('label', { class: 'check' }, tracker, 'This client already has history in our old tracker'),
    h('p', { class: 'muted small' }, 'Leave unchecked for a brand-new client: they start at zero used. If checked, enter the reconciled totals from the tracker; then import the tracker file on the Import tab (tick "reconciled opening balance") and the app checks it matches.'),
    trackerFields,
    h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Add client')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const data = Object.fromEntries(new FormData(form).entries());
    if (!tracker.checked) { delete data.openingUsed; delete data.openingCommitted; delete data.openingDate; }
    try {
      const r = await api('/api/staff/clients', data);
      await loadClients(r.id);
      toast(`${data.name} added. Next: add their ClickUp lists and email domain.`);
      setArea('workspace', r.needs_opening_import ? 'entry' : 'sources');
    } catch (ex) { toast(ex.message, 'error'); }
  });

  return h('div', {}, renderFinder(), h('section', { class: 'card' }, h('h2', {}, `Clients (${clients.length})`), list), form);
}

// Find every client's points tracker in ClickUp and set them all up in one go.
function renderFinder() {
  const box = h('div', {});
  const STATUS = { new: 'New client', client_exists: 'Client exists: will link', linked: 'Already linked' };
  const scan = async (btn) => {
    btn.disabled = true; btn.textContent = 'Scanning ClickUp…';
    try {
      const found = await api('/api/staff/clickup/trackers');
      if (!found.length) { box.replaceChildren(h('p', { class: 'muted' }, 'No tracker lists found. Lists are recognized by names like "Service Point Tracking", "Point Tracker" or "Call & Training Tracking".')); return; }
      const rows = found.map((f) => {
        const pick = h('input', { type: 'checkbox', checked: f.status !== 'linked', 'aria-label': `Include ${f.client_name}` });
        const name = h('input', { value: f.client_name, 'aria-label': 'Client name', disabled: f.status === 'linked' });
        const alloc = h('input', { type: 'number', min: '0', step: f.kind === 'hours' ? '0.25' : '1', value: f.allocation ?? '', placeholder: f.kind === 'hours' ? 'auto' : '?', title: f.kind === 'hours' ? 'Leave blank to use the tracker\'s CONTRACT ALLOCATION rows' : null, class: 'pts-in', 'aria-label': f.kind === 'hours' ? 'Hours allocated' : 'Points allocated', disabled: f.status === 'linked' });
        const ts = h('input', { type: 'date', 'aria-label': 'Term starts', disabled: f.status !== 'new' }); const te = h('input', { type: 'date', 'aria-label': 'Term ends', disabled: f.status !== 'new' });
        const cal = f.calendar && !f.calendar.linked ? h('input', { type: 'checkbox', checked: true, 'aria-label': `Show ${f.calendar.name}` }) : null;
        const col = f.collaboration && !f.collaboration.linked ? h('input', { type: 'checkbox', checked: true, 'aria-label': `Show ${f.collaboration.name}` }) : null;
        if ((cal || col) && f.status === 'linked') pick.checked = true;
        return { f, pick, name, alloc, ts, te, cal, col };
      });
      const go = h('button', { class: 'primary', onclick: async () => {
        const items = rows.filter((r) => r.pick.checked).map((r) => ({ listId: r.f.list_id, listName: r.f.list_name, name: r.name.value,
          kind: r.f.kind, allocation: r.f.status === 'linked' || r.alloc.value === '' ? null : Number(r.alloc.value), termStart: r.ts.value || null, termEnd: r.te.value || null,
          calendarListId: r.cal && r.cal.checked ? r.f.calendar.id : null, collabListId: r.col && r.col.checked ? r.f.collaboration.id : null }));
        if (!items.length) return toast('Tick at least one tracker', 'error');
        if (!confirm(`Set up ${items.length} client(s) from ClickUp? Each tracker is read and loaded (Completed = used, In Progress = committed, the rest = planned). Safe to run again.`)) return;
        go.disabled = true; go.textContent = `Importing ${items.length}… (about 5–20 seconds each)`;
        try {
          const results = await api('/api/staff/clickup/trackers/import', { items });
          box.replaceChildren(h('table', {}, h('thead', {}, h('tr', {}, ['Client', 'Result', 'Allocated', 'Used', 'Committed', 'Planned', 'Available'].map((t) => h('th', {}, t)))),
            h('tbody', {}, results.map((r) => h('tr', {}, h('td', {}, h('strong', {}, r.name || r.listId)),
              h('td', { class: 'small' }, r.error ? h('span', { class: 'error' }, r.error)
                : `${r.created ? 'Created' : 'Updated'} · ${r.found} items found, ${r.added} added${r.term ? ` · term ${fmtDate(r.term.term_start)} – ${fmtDate(r.term.term_end)} (from ${r.term.from})` : ''}${r.linked_feeds && r.linked_feeds.length ? ` · now showing ${r.linked_feeds.map((k) => (k === 'calendar' ? 'editorial calendar' : 'approvals')).join(' + ')}` : ''}${r.warning ? ` · ⚠ ${r.warning}` : ''}`),
              ...(r.balance ? [r.balance.allocated, r.balance.used, r.balance.committed, r.balance.forecast, r.balance.available].map((n) => h('td', { class: 'num' }, `${num(n)}${r.unit === 'hours' ? ' h' : ''}`)) : [h('td', { colspan: 5 })]))))),
            h('p', { class: 'muted small' }, 'Check each new client\'s contract term and agreement reference under Edit, then add their logins on Client access.'));
          await loadClients();
          toast('Import finished');
        } catch (ex) { toast(ex.message, 'error'); go.disabled = false; go.textContent = 'Import selected'; }
      } }, 'Import selected');
      box.replaceChildren(
        h('p', { class: 'muted small' }, `Found ${found.length} tracker list(s). Points come from the list name; leave the term blank to work it out from the tracker's month headings. Two trackers with the same client name become one client, and the second tracker's points are added to its allocation; rename one row to keep them separate.`),
        h('div', { class: 'table-wrap' }, h('table', { class: 'menu-table' },
          h('thead', {}, h('tr', {}, ['', 'Client', 'ClickUp tracker', 'Also show the client', 'Points / hours', 'Term starts', 'Term ends', 'Status'].map((t) => h('th', {}, t)))),
          h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.pick), h('td', {}, r.name), h('td', { class: 'small' }, r.f.list_name, ' ', h('span', { class: `status ${r.f.kind === 'hours' ? 'invited' : 'active'}` }, r.f.kind === 'hours' ? 'Hours' : 'Points')),
            h('td', { class: 'small' },
              r.f.calendar ? h('label', { class: 'check' }, r.cal || '✓', ` Calendar: ${r.f.calendar.name}`) : null,
              r.f.collaboration ? h('label', { class: 'check' }, r.col || '✓', ` Approvals: ${r.f.collaboration.name}`) : null,
              !r.f.calendar && !r.f.collaboration ? h('span', { class: 'muted' }, '—') : null),
            h('td', {}, r.alloc), h('td', {}, r.ts), h('td', {}, r.te),
            h('td', {}, h('span', { class: `status ${r.f.status === 'linked' ? 'active' : 'invited'}` }, r.f.status === 'linked' ? `Linked to ${r.f.linked_to}` : STATUS[r.f.status]))))))),
        h('div', { class: 'actions' }, go));
    } catch (ex) { box.replaceChildren(h('p', { class: 'error small' }, ex.message)); }
    finally { btn.disabled = false; btn.textContent = 'Scan ClickUp again'; }
  };
  return h('section', { class: 'card' },
    h('div', { class: 'toolbar' }, h('h2', {}, 'Find clients in ', h('em', {}, 'ClickUp')),
      h('button', { class: 'secondary', onclick: (e) => scan(e.target) }, 'Scan ClickUp for point & hours trackers')),
    h('p', { class: 'muted small' }, 'Looks through every ClickUp space for point-tracker lists and hours trackers (like "Call & Training Tracking"; templates are skipped), then creates each client and loads its tracker in one step. Hours trackers: each call\'s Time Estimate is its length, and "CONTRACT ALLOCATION" rows set the contracted hours.'),
    box);
}

function editClient(c) {
  const dlg = h('dialog', { class: 'add-points' });
  const close = () => { dlg.close(); dlg.remove(); };
  const name = h('input', { value: c.name, required: true }); const aliases = h('input', { value: c.aliases.join(', ') });
  const ts = h('input', { type: 'date', value: c.term_start }); const te = h('input', { type: 'date', value: c.term_end });
  const ref = h('input', { value: c.agreement_ref || '' });
  const hs = h('input', { value: c.hubspot_company_id || '', placeholder: 'Paste the HubSpot company record URL' });
  const unit = h('select', {}, h('option', { value: 'points', selected: c.unit !== 'hours' }, 'Service points'), h('option', { value: 'hours', selected: c.unit === 'hours' }, 'Hours'));
  const form = h('form', { class: 'dlg-body' },
    h('label', {}, 'Client name', name), h('label', {}, 'Other names they go by (comma-separated)', aliases),
    h('div', { class: 'row' }, h('label', {}, 'Term starts', ts), h('label', {}, 'Term ends', te)),
    h('label', {}, 'Agreement reference', ref),
    h('label', {}, 'HubSpot company (record URL or ID)', hs),
    h('label', {}, 'This client buys', unit),
    h('p', { class: 'muted small' }, 'Switching only changes the labels: the numbers already recorded stay as they are. To change points, use "+ Add points → Add to allocation" in the client workspace. To change their menu, use the Service menu tab.'),
    h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Save'), h('button', { type: 'button', onclick: close }, 'Cancel')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api(`/api/staff/clients/${c.id}`, { name: name.value, aliases: aliases.value, termStart: ts.value, termEnd: te.value, agreementRef: ref.value, hubspotCompanyId: hs.value, unit: unit.value });
      close(); await loadClients(); toast('Client updated'); render();
    } catch (ex) { toast(ex.message, 'error'); }
  });
  dlg.append(h('div', { class: 'dlg-head' }, h('h2', {}, `Edit ${c.name}`), h('button', { type: 'button', onclick: close }, 'Close')), form);
  dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
  document.body.append(dlg); dlg.showModal();
}

// ------------------------------------------------------------------ admin: LeadG2 team
async function renderTeam() {
  const { me, members } = await api('/api/staff/team');
  const linkBox = h('div', {});
  if (state.pendingLink) { linkBox.append(linkCard(state.pendingLink.who, state.pendingLink.r)); state.pendingLink = null; }
  const name = h('input', { required: true, placeholder: 'e.g. Jordan Smith' });
  const email = h('input', { type: 'email', required: true, placeholder: 'jordan@leadg2.com' });
  const form = h('form', { class: 'row' }, h('label', {}, 'Name', name), h('label', {}, 'Work email', email),
    h('div', { class: 'actions' }, h('button', { class: 'primary', type: 'submit' }, 'Add team member & get link')));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try { const r = await api('/api/staff/team', { name: name.value, email: email.value }); state.pendingLink = { who: name.value, r }; render(); }
    catch (ex) { toast(ex.message, 'error'); }
  });
  return h('section', { class: 'card' },
    h('h2', {}, 'LeadG2 team'),
    h('p', { class: 'muted small' }, 'Team members can see every client, review and approve points, edit the menu, and manage clients and other team members. Clients never see this area.'),
    h('div', { class: 'table-wrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Name', 'Email', 'Status', ''].map((t) => h('th', {}, t)))),
      h('tbody', {}, members.map((u) => h('tr', {},
        h('td', {}, u.name, u.id === me ? h('span', { class: 'muted small' }, ' (you)') : null), h('td', {}, u.email),
        h('td', {}, h('span', { class: `status ${u.status}` }, STATUS_TEXT[u.status])),
        h('td', { class: 'row-actions' },
          h('button', { onclick: async () => {
            try { linkBox.replaceChildren(linkCard(u.name, await api(`/api/staff/team/${u.id}/link`, {}))); } catch (ex) { toast(ex.message, 'error'); }
          } }, u.status === 'active' ? 'Password reset link' : 'New link'),
          u.id === me ? null : h('button', { class: 'danger', onclick: () => {
            if (!confirm(`Remove ${u.name}? They will be signed out immediately and lose access.`)) return;
            act(() => api(`/api/staff/team/${u.id}/remove`, {}), 'Team member removed');
          } }, 'Remove'))))))),
    linkBox, h('h3', {}, 'Add a team member'), form);
}

// ------------------------------------------------------------------ service menu editor
async function renderMenu() {
  const menus = await api('/api/staff/menus');
  if (!menus.length) return renderFirstMenu();
  if (!menus.some((m) => m.id === state.menuId)) state.menuId = menus[0].id;
  const v = menus.find((m) => m.id === state.menuId) || menus[0];
  const assignSel = h('select', {}, state.clients.map((c) => h('option', { value: c.id }, c.name)));
  const range = (i) => (i.points_min === i.points_max ? `${i.points_min}` : `${i.points_min}–${i.points_max}`);

  const picker = h('select', { onchange: (e) => { state.menuId = Number(e.target.value); render(); } },
    menus.map((m) => h('option', { value: m.id, selected: m.id === v.id }, `${m.code} · ${m.name}${m.clients.length ? ` (used by ${m.clients.map((c) => c.name).join(', ')})` : ''}`)));

  // Version details
  const vName = h('input', { value: v.name }); const vDate = h('input', { type: 'date', value: v.effective_date });
  const details = h('section', { class: 'card' },
    h('div', { class: 'toolbar' }, h('h2', {}, `Menu ${v.code}`),
      h('span', { class: 'muted small' }, v.clients.length ? `Used by ${v.clients.map((c) => c.name).join(', ')}` : 'Not used by any client yet')),
    h('div', { class: 'hint' }, 'Editing a menu never changes points already approved: each approved item keeps the amount it was approved at. Changes apply to new suggestions and entries. Every change is recorded in the audit log.'),
    h('div', { class: 'row' }, h('label', {}, 'Menu name', vName), h('label', {}, 'Takes effect', vDate),
      h('div', { class: 'actions' }, h('button', { onclick: () => act(() => api(`/api/staff/menus/${v.id}`, { name: vName.value, effectiveDate: vDate.value }), 'Menu details saved') }, 'Save details'))),
    h('p', { class: 'muted small' }, `${v.items.length} items · ${v.approved_work_items} approved work items reference this version`),
    state.clients.length ? h('div', { class: 'row' }, h('label', {}, 'Switch a client to this menu', assignSel),
      h('div', { class: 'actions' }, h('button', { class: 'secondary', onclick: () => {
        const c = state.clients.find((x) => x.id === Number(assignSel.value));
        if (!confirm(`Switch ${c.name} to menu ${v.code}?\n\nNew suggestions and entries will use these prices. Work already approved keeps its original points.`)) return;
        act(async () => { await api(`/api/staff/clients/${c.id}/menu`, { versionId: v.id }); }, `${c.name} now uses ${v.code}`);
      } }, 'Use this menu'))) : null);

  // Items table
  const itemRow = (i) => {
    const f = {
      name: h('input', { value: i ? i.name : '', placeholder: 'e.g. Landing page build', 'aria-label': 'Name' }),
      code: h('input', { value: i ? i.code : '', placeholder: 'LP-BUILD', size: '10', 'aria-label': 'Short code' }),
      min: h('input', { type: 'number', min: '0', step: '1', value: i ? i.points_min : '', class: 'pts-in', 'aria-label': 'Points (min)' }),
      max: h('input', { type: 'number', min: '0', step: '1', value: i && i.points_max !== i.points_min ? i.points_max : '', placeholder: 'same', class: 'pts-in', 'aria-label': 'Points (max, for ranges)' }),
      category: h('input', { value: i ? (i.category || '') : '', placeholder: 'e.g. Sales', 'aria-label': 'Category (shown to clients as the type)' }),
      keywords: h('input', { value: i ? i.keywords.join(', ') : '', placeholder: 'landing page, lp', 'aria-label': 'Matching keywords' }),
      notes: h('input', { value: i ? (i.notes || '') : '', placeholder: 'optional', 'aria-label': 'Notes' }),
    };
    const save = () => act(() => api(`/api/staff/menus/${v.id}/items`, { itemId: i ? i.id : null, name: f.name.value, code: f.code.value,
      pointsMin: f.min.value, pointsMax: f.max.value, category: f.category.value, keywords: f.keywords.value, notes: f.notes.value }), i ? 'Item saved' : 'Item added');
    return h('tr', { class: i ? '' : 'new-row' },
      h('td', {}, f.name), h('td', {}, f.code), h('td', {}, f.min), h('td', {}, f.max), h('td', {}, f.category), h('td', {}, f.keywords), h('td', {}, f.notes),
      h('td', { class: 'row-actions' }, h('button', { class: i ? '' : 'primary', onclick: save }, i ? 'Save' : '+ Add'),
        i ? h('button', { class: 'danger', onclick: () => {
          if (!confirm(`Remove "${i.name}" from menu ${v.code}? Work already approved with it is not affected.`)) return;
          act(() => api(`/api/staff/menus/${v.id}/items/${i.id}/delete`, {}), 'Item removed');
        } }, 'Remove') : null));
  };
  const csvInput = h('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': 'Menu CSV file' });
  const importBox = h('details', { class: 'small' }, h('summary', {}, 'Import or update items from a CSV file'),
    h('p', { class: 'muted small' }, 'Columns: code, name, points_min, points_max, category, keywords, notes. Rows are matched by code, so re-importing an updated file changes prices without duplicating items.'),
    h('div', { class: 'actions' }, csvInput, h('button', { onclick: () => act(async () => {
      const file = csvInput.files[0]; if (!file) throw new Error('Choose a CSV file');
      const r = await api(`/api/staff/menus/${v.id}/import`, { csv: await file.text() });
      toast(`Imported: ${r.added} added, ${r.updated} updated`);
    }) }, 'Import')));
  const items = h('section', { class: 'card' }, h('h2', {}, 'Menu items'), importBox,
    h('p', { class: 'muted small' }, 'For a fixed price, fill in only "Points". For a range (reviewer confirms the amount), also fill in "Up to". Keywords help the app recognize the item in ClickUp tasks and emails.'),
    h('div', { class: 'table-wrap' }, h('table', { class: 'menu-table' },
      h('thead', {}, h('tr', {}, ['Item', 'Code', 'Points', 'Up to', 'Category (client sees)', 'Keywords', 'Internal notes', ''].map((t) => h('th', {}, t)))),
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

  const tplBtn = h('button', { onclick: () => {
    if (!confirm('Add the LeadG2 Service Points 2026 menu (40 items) as a new menu version? Your existing menus are not changed.')) return;
    act(async () => { const r = await api('/api/staff/menu-templates/leadg2-2026', {}); state.menuId = r.id; toast(`Menu ${r.code} loaded: ${r.added} items`); });
  } }, 'Load LeadG2 2026 menu as a new version');
  return h('div', {}, h('div', { class: 'card' }, h('div', { class: 'row' }, h('label', {}, 'Menu version', picker), h('div', { class: 'actions' }, tplBtn))), details, items, newVersion);
}

function renderFirstMenu() {
  const code = h('input', { placeholder: 'e.g. 2027.1', required: true }); const date = h('input', { type: 'date', required: true });
  return h('div', {},
    h('section', { class: 'card' }, h('h2', {}, 'Start with the LeadG2 2026 menu'),
      h('p', { class: 'muted small' }, 'Loads the 40 items from the "LeadG2 Service Points 2026" one-pager (Consulting & Support, Content/Promotion, Sales) with their point values. You can edit any item afterwards.'),
      h('div', { class: 'actions' }, h('button', { class: 'primary', onclick: () => act(async () => {
        const r = await api('/api/staff/menu-templates/leadg2-2026', {});
        state.menuId = r.id; toast(`Menu ${r.code} loaded: ${r.added} items`);
      }) }, 'Load the LeadG2 2026 menu'))),
    h('section', { class: 'card' }, h('h2', {}, 'Or start an empty menu'),
      h('div', { class: 'row' }, h('label', {}, 'Version label', code), h('label', {}, 'Takes effect', date)),
      h('div', { class: 'actions' }, h('button', { onclick: () => act(async () => {
        state.menuId = (await api('/api/staff/menus', { code: code.value, effectiveDate: date.value })).id;
      }, 'Menu created') }, 'Create empty menu'))));
}

async function renderAudit() {
  const rows = await api(`/api/staff/clients/${state.clientId}/audit`);
  return h('section', { class: 'card' }, h('h2', {}, 'Audit log'), h('div', { class: 'table-wrap' }, h('table', {},
    h('thead', {}, h('tr', {}, ['When', 'Who', 'Action', 'Reason', 'Detail'].map((t) => h('th', {}, t)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, fmtDateTime(r.created_at)), h('td', {}, r.actor), h('td', {}, r.action), h('td', {}, r.reason || ''), h('td', { class: 'small' }, r.detail || '')))))));
}

init().catch((e) => panel.replaceChildren(h('p', { class: 'error' }, e.message)));
