'use strict';
// Shared helpers. All dynamic text goes through textContent (never innerHTML), so task and email
// content can never inject markup or script.
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'href') { if (/^https:\/\//.test(v) || v.startsWith('/')) el.setAttribute('href', v); }
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { location.href = '/login'; throw new Error('Sign in required'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const fmtDate = (d) => {
  if (!d) return '—';
  const dt = new Date(d.length === 10 ? `${d}T12:00:00Z` : d);
  return dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
};
const fmtDateTime = (d) => (d ? new Date(d).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

function toast(msg, kind = 'ok') {
  const t = h('div', { class: `toast ${kind}`, role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 6000 : 3000);
}

async function logout() { await api('/api/logout', {}); location.href = '/login'; }

/** Render the four-number balance + term. Shared by the client dashboard and staff preview. */
function renderClientView(v) {
  const stat = (label, value, cls, note) => h('div', { class: `stat ${cls || ''}` },
    h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, String(value)), note ? h('div', { class: 'stat-note' }, note) : null);
  const bd = v.allocation_breakdown;
  const allocNote = [bd.base && `${bd.base} base`, bd.bonus && `${bd.bonus} bonus`, bd.purchase && `${bd.purchase} purchased`].filter(Boolean).join(' + ');
  const row = (i, label) => h('li', { class: 'work-row' },
    h('div', { class: 'work-main' }, h('div', { class: 'work-desc' }, i.description), h('div', { class: 'work-meta' }, `${label} · ${fmtDate(i.date)}`)),
    h('div', { class: 'work-pts' }, `${i.points} pts`));
  const pend = v.pending_summaries;
  return h('div', { class: 'client-view' },
    h('header', { class: 'cv-head' },
      h('h1', {}, v.client.name),
      h('p', { class: 'muted' }, `Contract term ${fmtDate(v.contract_term.start)} – ${fmtDate(v.contract_term.end)} · Balance last updated ${fmtDateTime(v.last_updated)}`)),
    h('section', { class: 'stats', 'aria-label': 'Point balance' },
      stat('Total allocated', v.balance.allocated, '', allocNote),
      stat('Used', v.balance.used, 'used', 'Completed work'),
      stat('Committed', v.balance.committed, 'committed', 'Approved, not yet complete'),
      stat('Available', v.balance.available, 'available', 'Allocated − used − committed')),
    h('section', { class: 'card' }, h('h2', {}, 'Approved upcoming work'),
      v.upcoming.length ? h('ul', { class: 'work-list' }, v.upcoming.map((i) => row(i, 'Approved'))) : h('p', { class: 'muted' }, 'No approved upcoming work right now.')),
    h('section', { class: 'card' }, h('h2', {}, 'Completed work'),
      v.completed.length ? h('ul', { class: 'work-list' }, v.completed.map((i) => row(i, 'Completed'))) : h('p', { class: 'muted' }, 'No completed work yet this term.')),
    pend.count ? h('p', { class: 'muted small' }, `${pend.count} item(s) totaling ${pend.used_points + pend.committed_points} points are included in the numbers above; their descriptions are being finalized.`) : null,
    v.support_hours ? h('section', { class: 'card' }, h('h2', {}, 'HubSpot support hours'),
      h('p', {}, `${v.support_hours.remaining} of ${v.support_hours.purchased} hours remaining (${v.support_hours.used} used). Support hours are tracked separately from points.`)) : null);
}
