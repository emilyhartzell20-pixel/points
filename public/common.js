'use strict';
// Show which version (commit) is running in the footer, so it's easy to check a deploy went out.
fetch('/api/config').then((r) => r.json()).then((c) => {
  const f = document.querySelector('.site-footer .brand-word');
  if (c.version && f) f.append(` · version ${c.version}`);
}).catch(() => {});
// Use the official LeadG2 logo if one has been dropped into public/brand/; otherwise keep the text wordmark.
document.querySelectorAll('.brand-logo').forEach((img) => {
  const show = () => { img.hidden = false; const w = img.parentElement.querySelector('.brand-word'); if (w) w.hidden = true; };
  if (img.complete && img.naturalWidth) show(); else img.addEventListener('load', show);
});
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

/** The client dashboard. Shared by the client page and the staff preview, so both show exactly the same. */
function renderClientView(v, opts = {}) {
  const stat = (label, value, cls, note) => h('div', { class: `stat ${cls || ''}` },
    h('div', { class: 'stat-label' }, label), h('div', { class: 'stat-value' }, String(value)), note ? h('div', { class: 'stat-note' }, note) : null);
  const bd = v.allocation_breakdown;
  const allocNote = [bd.base && `${bd.base} base`, bd.bonus && `${bd.bonus} bonus`, bd.purchase && `${bd.purchase} purchased`].filter(Boolean).join(' + ');
  const showPlanned = !!v.planned;
  const pend = v.pending_summaries;
  const months = v.by_month;
  return h('div', { class: 'client-view' },
    h('header', { class: 'cv-head' },
      h('p', { class: 'eyebrow' }, v.client.name),
      h('h1', {}, 'Your service points, ', h('em', {}, 'at a glance.')),
      h('p', { class: 'lede' }, `Contract term ${fmtDate(v.contract_term.start)} – ${fmtDate(v.contract_term.end)} · Balance last updated ${fmtDateTime(v.last_updated)}`)),
    renderLinks(v.links),
    renderWaiting(v.content, opts),
    h('section', { class: 'stats', 'aria-label': 'Point balance' },
      stat('Total allocated', v.balance.allocated, '', allocNote),
      stat('Used', v.balance.used, 'used', 'Completed work'),
      stat('Committed', v.balance.committed, 'committed', 'Approved, not yet complete'),
      stat('Available', v.balance.available, 'available', 'Allocated − used − committed')),
    showPlanned ? h('p', { class: 'planned-note' }, h('span', { class: 'tip-key seg-planned' }),
      `${v.planned.points} more points are planned. If all planned work goes ahead, ${v.planned.available_after} points remain.`) : null,
    months ? renderOutlook(months.look_ahead, { showPlanned, forClient: true }) : null,
    v.editorial_page ? renderEditorialPage(v.editorial_page, opts) : renderCalendar(v.content),
    months ? h('section', { class: 'card' }, h('h2', {}, 'Points by ', h('em', {}, 'month')), monthChart(months.months, {
      showPlanned, onPick: (key) => { const el = document.getElementById(`month-${key}`); if (el) { el.open = true; el.scrollIntoView({ behavior: 'smooth', block: 'start' }); } } })) : null,
    months ? h('section', { class: 'card' }, h('h2', {}, 'Your work, ', h('em', {}, 'month by month')),
      monthList(months, { showPlanned, forClient: true, renderItem: (it) => h('span', { class: 'work-desc' }, it.description) })) : null,
    pend.count ? h('p', { class: 'muted small' }, `${pend.count} item(s) totaling ${pend.used_points + pend.committed_points} points are included in the numbers above; their descriptions are being finalized.`) : null,
    v.support_hours ? h('section', { class: 'card' }, h('h2', {}, 'HubSpot support hours'),
      h('p', {}, `${v.support_hours.remaining} of ${v.support_hours.purchased} hours remaining (${v.support_hours.used} used). Support hours are tracked separately from points.`)) : null);
}

// ------------------------------------------------------------------ "By month" visuals (shared)
// Stage colors are one hue, dark → light (used → committed → planned); planned is also striped because it
// isn't counted. Type colors are the validated categorical palette in fixed alphabetical slots, always
// shown next to the type's name so color never carries meaning alone.
const STAGE_LABEL = { used: 'Completed', committed: 'Approved', planned: 'Planned' };
const SVGNS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs || {})) if (v != null) el.setAttribute(k, v);
  for (const c of kids.flat()) if (c != null) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}

function typeChip(t, onclick, active = true) {
  return h(onclick ? 'button' : 'span', { class: `type-chip t${t.slot}${active ? '' : ' off'}`, type: onclick ? 'button' : null, onclick, 'aria-pressed': onclick ? String(active) : null },
    h('span', { class: 'type-dot', 'aria-hidden': 'true' }), t.name);
}

function monthChart(months, { showPlanned = true, onPick } = {}) {
  const W = 56, H = 170, top = 14, bottom = 26, left = 34, gap = 2;
  const totals = months.map((m) => m.used + m.committed + (showPlanned ? m.planned : 0));
  const max = Math.max(4, ...totals);
  const step = max <= 20 ? 5 : max <= 60 ? 10 : max <= 150 ? 25 : 50;
  const yMax = Math.ceil(max / step) * step;
  const plotH = H - top - bottom;
  const y = (v) => top + plotH - (v / yMax) * plotH;
  const width = left + months.length * W + 8;
  const nowKey = new Date().toISOString().slice(0, 7);
  const svg = s('svg', { viewBox: `0 0 ${width} ${H}`, class: 'month-chart', role: 'img', 'aria-label': 'Points by month: completed, approved and planned' },
    s('defs', {}, s('pattern', { id: 'planned-hatch', width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
      s('rect', { width: 6, height: 6, class: 'seg-planned-bg' }), s('line', { x1: 0, y1: 0, x2: 0, y2: 6, class: 'seg-planned-line' }))));
  for (let v = 0; v <= yMax; v += step) {
    svg.append(s('line', { x1: left, x2: width - 4, y1: y(v), y2: y(v), class: v === 0 ? 'axis-base' : 'grid' }),
      s('text', { x: left - 6, y: y(v) + 4, class: 'axis-label', 'text-anchor': 'end' }, String(v)));
  }
  const tip = h('div', { class: 'chart-tip', hidden: true });
  months.forEach((m, i) => {
    const x = left + i * W + 10, bw = W - 20;
    const segs = [['used', m.used], ['committed', m.committed], ...(showPlanned ? [['planned', m.planned]] : [])].filter(([, v]) => v > 0);
    let base = 0;
    segs.forEach(([stage, v], j) => {
      const y0 = y(base), y1 = y(base + v); base += v;
      const hgt = Math.max(1, y0 - y1 - (j > 0 ? gap : 0));
      const yTop = y0 - (j > 0 ? gap : 0) - hgt;
      const isTop = j === segs.length - 1, r = Math.min(4, hgt / 2, bw / 2);
      const d = isTop
        ? `M${x},${yTop + hgt} V${yTop + r} Q${x},${yTop} ${x + r},${yTop} H${x + bw - r} Q${x + bw},${yTop} ${x + bw},${yTop + r} V${yTop + hgt} Z`
        : `M${x},${yTop + hgt} V${yTop} H${x + bw} V${yTop + hgt} Z`;
      svg.append(s('path', { d, class: `seg seg-${stage}` }));
    });
    const [yy, mm] = m.key.split('-');
    const short = new Date(Date.UTC(+yy, +mm - 1, 15)).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
    svg.append(s('text', { x: x + bw / 2, y: H - 10, class: `axis-label${m.key === nowKey ? ' now' : ''}`, 'text-anchor': 'middle' }, i === 0 || mm === '01' ? `${short} ’${yy.slice(2)}` : short));
    const hit = s('rect', { x: left + i * W, y: top, width: W, height: plotH + 4, class: 'hit', tabindex: '0', 'aria-label': `${m.label}: ${m.used} completed, ${m.committed} approved${showPlanned ? `, ${m.planned} planned` : ''}` });
    const show = () => {
      tip.replaceChildren(h('strong', {}, m.label),
        ...['used', 'committed', ...(showPlanned ? ['planned'] : [])].map((k) => h('div', { class: 'tip-row' }, h('span', { class: `tip-key seg-${k}` }), `${STAGE_LABEL[k]}`, h('span', { class: 'tip-val' }, `${m[k]} pts`))));
      tip.hidden = false;
      const pct = ((left + i * W + W / 2) / width) * 100;
      tip.style.left = `${Math.min(80, Math.max(2, pct - 10))}%`;
    };
    hit.addEventListener('mouseenter', show); hit.addEventListener('focus', show);
    hit.addEventListener('mouseleave', () => { tip.hidden = true; }); hit.addEventListener('blur', () => { tip.hidden = true; });
    if (onPick) hit.addEventListener('click', () => onPick(m.key));
    svg.append(hit);
  });
  const legend = h('div', { class: 'chart-legend' },
    ...['used', 'committed', ...(showPlanned ? ['planned'] : [])].map((k) => h('span', { class: 'legend-item' }, h('span', { class: `tip-key seg-${k}` }), STAGE_LABEL[k])));
  return h('div', { class: 'chart-wrap' }, legend, h('div', { class: 'chart-scroll' }, svg), tip);
}

/** Month-by-month list. renderItem(item) returns the row's main text node(s). */
function monthList(data, { renderItem, showPlanned = true, forClient = false }) {
  const typeBySlot = Object.fromEntries(data.types.map((t) => [t.name, t]));
  const active = new Set(data.types.map((t) => t.name));
  const nowKey = new Date().toISOString().slice(0, 7);
  const sections = [];
  const apply = () => {
    for (const row of document.querySelectorAll('.month-item')) row.hidden = !active.has(row.dataset.type);
    filterBar.querySelectorAll('.type-chip').forEach((c) => c.classList.toggle('off', !active.has(c.dataset.name)));
  };
  const filterBar = h('div', { class: 'type-filter', role: 'group', 'aria-label': 'Filter by type' },
    h('span', { class: 'muted small' }, 'Types:'),
    ...data.types.map((t) => { const c = typeChip(t, () => { if (active.has(t.name) && active.size > 1) active.delete(t.name); else active.add(t.name); apply(); }); c.dataset.name = t.name; return c; }),
    data.types.length > 1 ? h('button', { type: 'button', class: 'linklike', onclick: () => { data.types.forEach((t) => active.add(t.name)); apply(); } }, 'Show all') : null);
  for (const m of data.months) {
    const totalShown = m.used + m.committed + (showPlanned ? m.planned : 0);
    if (forClient && !totalShown) continue;
    const near = Math.abs((+m.key.slice(0, 4) * 12 + +m.key.slice(5)) - (+nowKey.slice(0, 4) * 12 + +nowKey.slice(5))) <= 1;
    const parts = [m.used && `${m.used} completed`, m.committed && `${m.committed} approved`, showPlanned && m.planned && `${m.planned} planned`].filter(Boolean);
    sections.push(h('details', { class: `month${m.key === nowKey ? ' current' : ''}`, id: `month-${m.key}`, open: near ? true : null },
      h('summary', {}, h('span', { class: 'month-name' }, m.label, m.key === nowKey ? h('span', { class: 'now-pill' }, 'This month') : null),
        h('span', { class: 'month-total' }, totalShown ? `${totalShown} pts` : 'No work yet'), h('span', { class: 'month-parts muted small' }, parts.join(' · '))),
      m.items.length || m.other_points ? h('ul', { class: 'month-items' },
        m.items.map((it) => h('li', { class: `month-item stage-${it.stage}`, 'data-type': it.type },
          typeChip(typeBySlot[it.type] || { name: it.type, slot: 9 }),
          h('div', { class: 'month-item-main' }, renderItem(it)),
          h('span', { class: `stage-pill ${it.stage}` }, STAGE_LABEL[it.stage]),
          h('span', { class: 'month-item-pts' }, `${it.points} pts`))),
        m.other_points ? h('li', { class: 'month-item other' }, h('span', { class: 'muted small' }, `${m.other_points} more points of work (descriptions being finalized)`)) : null)
        : h('p', { class: 'muted small empty-month' }, 'Nothing scheduled.')));
  }
  return h('div', { class: 'month-list' }, data.types.length ? filterBar : null, ...sections);
}

/** "Looking ahead": each month from now to the end of the contract, and what remains after it. */
function renderOutlook(o, { showPlanned = true, forClient = false } = {}) {
  if (!o || !o.months.length) return null;
  const endLabel = fmtDate(o.term_end);
  const over = o.remaining_at_end < 0;
  const rows = o.months.map((m) => h('tr', { class: `${m.key === o.from ? 'now' : ''}${m.after_term ? ' after-term' : ''}${m.key === 'earlier' ? ' earlier' : ''}` },
    h('td', {}, m.label, m.key === o.from ? h('span', { class: 'now-pill' }, 'This month') : null, m.after_term ? h('span', { class: 'muted small' }, ' · after contract end') : null),
    h('td', { class: 'num' }, m.committed ? `${m.committed}` : '–'),
    showPlanned ? h('td', { class: 'num' }, m.planned ? `${m.planned}` : '–') : null,
    h('td', { class: `num remaining${m.remaining_after < 0 ? ' neg' : ''}` }, m.remaining_after < 0 ? `⚠ ${m.remaining_after}` : String(m.remaining_after))));
  return h('section', { class: 'card outlook' },
    h('div', { class: 'toolbar' }, h('h2', {}, 'Looking ', h('em', {}, 'ahead')),
      h('span', { class: 'muted small' }, `Contract runs through ${endLabel} · ${o.months_left} month${o.months_left === 1 ? '' : 's'} left`)),
    h('p', { class: `outlook-summary${over ? ' neg' : ''}` }, over
      ? `⚠ If everything ${showPlanned ? 'planned' : 'approved'} goes ahead, the allocation runs out: ${Math.abs(o.remaining_at_end)} points over by ${endLabel}.`
      : showPlanned
        ? `${o.available_now} points available today. If everything planned goes ahead, ${o.remaining_at_end} points remain at the end of the contract (${endLabel}).`
        : `${o.available_now} points available today, through the end of the contract (${endLabel}).`),
    h('div', { class: 'table-wrap' }, h('table', { class: 'outlook-table' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Month'), h('th', { class: 'num' }, 'Approved'), showPlanned ? h('th', { class: 'num' }, 'Planned') : null,
        h('th', { class: 'num' }, forClient ? 'Points left after' : 'Remaining after'))),
      h('tbody', {}, rows))),
    h('p', { class: 'muted small' }, 'Approved points are already reserved, so they’re included in today’s available number. Planned points come off as each month goes ahead.'));
}

// ------------------------------------------------------------------ client content: waiting on you + editorial calendar
const CAL_STAGE = { published: 'Published', in_review: 'In review', in_progress: 'In progress', planned: 'Planned' };
function renderWaiting(c, { preview = false, onAnswered } = {}) {
  if (!c || !c.waiting) return null;
  const n = c.waiting.length;
  const item = (w) => {
    const li = h('li', { class: 'waiting-item' });
    const msg = h('p', { class: 'error small', role: 'alert', hidden: true });
    const send = async (decision, comment, btns) => {
      btns.forEach((b) => { b.disabled = true; });
      try {
        await api(`/api/client/reviews/${encodeURIComponent(w.id)}`, { decision, comment });
        li.replaceChildren(h('div', { class: 'work-desc' }, w.title),
          h('p', { class: 'answered' }, decision === 'approve' ? '✓ Approved. Thank you!' : decision === 'done' ? '✓ Marked done. Thank you!' : '✓ Sent. We\'ll make your changes and send it back for review.'));
        li.classList.add('done');
        if (onAnswered) setTimeout(onAnswered, 2500);
      } catch (e) { msg.textContent = e.message; msg.hidden = false; btns.forEach((b) => { b.disabled = false; }); }
    };
    const open = w.url ? h('a', { class: 'small', href: w.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open in ClickUp ↗') : null;
    const approve = h('button', { type: 'button', class: 'primary', disabled: preview || null }, 'Approve');
    const changes = h('button', { type: 'button', disabled: preview || null }, 'Request changes');
    const box = h('div', { class: 'changes-box', hidden: true });
    const ta = h('textarea', { rows: '3', maxlength: '2000', placeholder: 'What would you like changed?', 'aria-label': `Changes for ${w.title}` });
    const sendChanges = h('button', { type: 'button', class: 'primary' }, 'Send changes');
    const cancel = h('button', { type: 'button', class: 'ghost' }, 'Cancel');
    box.append(ta, h('div', { class: 'row-actions' }, sendChanges, cancel));
    approve.onclick = () => { if (confirm(`Approve "${w.title}"?`)) send('approve', '', [approve, changes]); };
    if (w.action === 'assigned') {
      const done = h('button', { type: 'button', class: 'primary', disabled: preview || null }, 'Mark done');
      done.onclick = () => { if (confirm(`Mark "${w.title}" as done?`)) send('done', '', [done]); };
      li.append(h('div', { class: 'waiting-row' },
        h('div', {}, h('div', { class: 'work-desc' }, w.title, ' ', h('span', { class: 'tag-assigned' }, 'Assigned to you')),
          h('div', { class: 'work-meta' }, w.due ? `Due ${fmtDate(w.due)}` : 'No due date', open ? ' · ' : '', open)),
        h('div', { class: 'row-actions' }, done)), msg);
      return li;
    }
    changes.onclick = () => { box.hidden = false; changes.hidden = true; approve.hidden = true; ta.focus(); };
    cancel.onclick = () => { box.hidden = true; changes.hidden = false; approve.hidden = false; };
    sendChanges.onclick = () => {
      if (!ta.value.trim()) { msg.textContent = 'Tell us what you would like changed.'; msg.hidden = false; ta.focus(); return; }
      send('changes', ta.value, [sendChanges, cancel]);
    };
    li.append(
      h('div', { class: 'waiting-row' },
        h('div', {}, h('div', { class: 'work-desc' }, w.title), h('div', { class: 'work-meta' }, w.due ? `Due ${fmtDate(w.due)}` : 'No due date', open ? ' · ' : '', open)),
        h('div', { class: 'row-actions' }, approve, changes)),
      box, msg);
    return li;
  };
  return h('section', { class: `card waiting${n ? ' has-items' : ''}` },
    h('div', { class: 'toolbar' }, h('h2', {}, 'Waiting ', h('em', {}, 'on you')), h('span', { class: 'muted small' }, n ? `${n} item${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} you` : 'Nothing needs you right now')),
    preview && n ? h('p', { class: 'muted small' }, 'Preview: the buttons work only for the client.') : null,
    n ? h('ul', { class: 'waiting-list' }, c.waiting.map(item))
      : h('p', { class: 'muted small' }, 'When we send something for your review or approval, it will appear here.'));
}
const LINK_ICON = { sharepoint: 'SP', clickup: 'CU', hubspot: 'HS', google: 'G', teams: 'T', canva: 'C', link: '↗' };
const LINK_KIND = { sharepoint: 'SharePoint', clickup: 'ClickUp', hubspot: 'HubSpot', google: 'Google', teams: 'Teams', canva: 'Canva', link: 'Link' };
function renderLinks(list) {
  if (!list || !list.length) return null;
  return h('nav', { class: 'quick-links', 'aria-label': 'Quick links' }, list.map((l) =>
    h('a', { class: `quick-link k-${l.kind}`, href: l.url, target: '_blank', rel: 'noopener noreferrer' },
      h('span', { class: 'ql-icon', 'aria-hidden': 'true' }, LINK_ICON[l.kind] || '↗'),
      h('span', { class: 'ql-text' }, h('span', { class: 'ql-label' }, l.label),
        h('span', { class: 'ql-note' }, l.note || `Opens in ${LINK_KIND[l.kind] || 'a new tab'}`)),
      h('span', { class: 'ql-arrow', 'aria-hidden': 'true' }, '↗'))));
}
function renderEditorialPage(pg, { preview = false, clientId } = {}) {
  const src = pg.kind === 'url' ? pg.url : preview ? `/api/staff/clients/${clientId}/editorial` : '/api/client/editorial';
  return h('section', { class: 'card editorial-page' },
    h('div', { class: 'toolbar' }, h('h2', {}, 'Editorial ', h('em', {}, 'calendar')),
      h('a', { class: 'small', href: src, target: '_blank', rel: 'noopener noreferrer' }, 'Open full screen ↗')),
    h('iframe', { class: 'editorial-frame', src, title: 'Editorial calendar', loading: 'lazy', referrerpolicy: 'no-referrer',
      sandbox: 'allow-scripts allow-popups allow-popups-to-escape-sandbox' }),
    pg.updated_at ? h('p', { class: 'muted small' }, `Updated ${fmtDateTime(pg.updated_at)}`) : null);
}
function renderCalendar(c) {
  if (!c || !c.calendar) return null;
  const byMonth = {};
  for (const i of c.calendar) (byMonth[i.date.slice(0, 7)] = byMonth[i.date.slice(0, 7)] || []).push(i);
  const keys = Object.keys(byMonth).sort();
  const label = (k) => new Date(`${k}-15T00:00:00Z`).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return h('section', { class: 'card' },
    h('h2', {}, 'Editorial ', h('em', {}, 'calendar')),
    keys.length ? keys.map((k) => h('div', { class: 'cal-month' }, h('h3', {}, label(k)),
      h('ul', { class: 'cal-list' }, byMonth[k].map((i) => {
        const d = new Date(`${i.date}T12:00:00Z`);
        return h('li', { class: `cal-item ${i.stage}` },
          h('div', { class: 'cal-date' }, h('span', { class: 'cal-dow' }, d.toLocaleDateString(undefined, { weekday: 'short', timeZone: 'UTC' })), h('span', { class: 'cal-day' }, String(d.getUTCDate()))),
          h('div', { class: 'cal-title' }, i.title),
          h('span', { class: `cal-stage ${i.stage}` }, CAL_STAGE[i.stage]));
      }))))
      : h('p', { class: 'muted small' }, 'No scheduled content yet.'),
    c.refreshed_at ? h('p', { class: 'muted small' }, `Updated ${fmtDateTime(c.refreshed_at)}`) : null);
}
