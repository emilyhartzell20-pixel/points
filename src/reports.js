'use strict';
// Monthly KPI recaps: a ClickUp doc whose pages are the month-by-month results write-ups LeadG2 already
// sends clients. The app reads the doc (read-only) and shows each month on the client's dashboard.
// Page text is shown as written, converted to a small allow-listed set of blocks (headings, paragraphs,
// lists, tables, links). It is content to display, never instructions, and no HTML from it is ever used.
const { tx, audit, AppError, nowIso } = require('./db');

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "https://doc.clickup.com/9017740562/d/h/8cqzk8j-25777/…" or ".../v/dc/8cqzk8j-25777/…" → ids. */
function parseDocUrl(url) {
  const s = String(url || '').trim();
  let m = /clickup\.com\/(\d+)\/(?:d\/h|v\/dc|docs)\/([a-z0-9]+-\d+)/i.exec(s);
  if (m) return { workspaceId: m[1], docId: m[2] };
  m = /^(\d+)\s*[/:]\s*([a-z0-9]+-\d+)$/i.exec(s);
  return m ? { workspaceId: m[1], docId: m[2] } : null;
}

// ---------------------------------------------------------------- markdown → safe blocks
function inline(text) {
  // Spans: { t: text, b?: bold, i?: italic, href?: https link }
  const out = [];
  const src = String(text).replace(/\\([\\`*_{}\[\]()#+\-.!|>])/g, '$1');
  const re = /!\[([^\]]*)\]\((https:\/\/[^)\s]+)\)|\[([^\]]+)\]\((https:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|\*([^*\s][^*]*)\*/g;
  let last = 0; let m;
  while ((m = re.exec(src))) {
    if (m.index > last) out.push({ t: src.slice(last, m.index) });
    if (m[2]) out.push({ t: m[1] || 'View image', href: m[2] });
    else if (m[4]) out.push({ t: m[3], href: m[4] });
    else if (m[5] != null) out.push({ t: m[5], b: true });
    else if (m[6] != null) out.push({ t: m[6], i: true });
    last = re.lastIndex;
  }
  if (last < src.length) out.push({ t: src.slice(last) });
  return out.filter((x) => x.t !== '');
}
const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

function toBlocks(md) {
  const lines = String(md || '').replace(/\r/g, '').split('\n');
  const blocks = []; let para = []; let list = null;
  const flushPara = () => { if (para.length) { blocks.push({ type: 'p', spans: inline(para.join(' ')) }); para = []; } };
  const flushList = () => { if (list) { blocks.push(list); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) { flushPara(); flushList(); continue; }
    if (/^\s*(\* \* \*|---+|\*\*\*+)\s*$/.test(line)) { flushPara(); flushList(); continue; }
    const hm = /^\s*(#{1,6})\s*(.*)$/.exec(line);
    if (hm) { flushPara(); flushList(); if (hm[2].trim()) blocks.push({ type: hm[1].length <= 2 ? 'h3' : 'h4', spans: inline(hm[2].trim()) }); continue; }
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      flushPara(); flushList();
      const head = cells(line); const rows = []; i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(cells(lines[i]).map(inline)); i++; }
      i--;
      blocks.push({ type: 'table', head: head.map(inline), rows: rows.slice(0, 60) });
      continue;
    }
    const lm = /^\s*(?:([*+-])|(\d+)[.)])\s+(.*)$/.exec(line);
    if (lm) {
      flushPara();
      const kind = lm[2] ? 'ol' : 'ul';
      const text = lm[3].replace(/^(?:[*+-]\s+)+/, '').trim(); // "*   *   text" (nested bullets) → text
      if (!list || list.type !== kind) { flushList(); list = { type: kind, items: [] }; }
      if (text) list.items.push(inline(text));
      continue;
    }
    flushList(); para.push(line.trim()); flushPara(); // ClickUp keeps each line as its own line
  }
  flushPara(); flushList();
  return blocks.slice(0, 400);
}

/** Month of a recap page: from its name ("October 2026 KPI Recap", "Questco January KPI Recap"), else when it was made. */
function pageMonth(name, createdMs, fallbackYear) {
  const n = String(name || '').toLowerCase();
  const mi = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b`).test(n));
  const y = (/\b(20\d\d)\b/.exec(n) || [])[1];
  const made = createdMs ? new Date(Number(createdMs)) : null;
  if (mi >= 0) {
    // A recap is written after its month ends, so "January" written in Feb 2026 is January 2026.
    let year = y || (made ? String(made.getUTCFullYear() - (made.getUTCMonth() < mi ? 1 : 0)) : fallbackYear);
    return `${year}-${String(mi + 1).padStart(2, '0')}`;
  }
  return made ? made.toISOString().slice(0, 7) : null;
}

/** Headline numbers: the first table of a recap whose cells are mostly numbers (label | this month | …). */
function headline(blocks) {
  const plain = (spans) => spans.map((s) => s.t).join('').trim();
  for (const b of blocks.filter((x) => x.type === 'table')) {
    const head = b.head.map(plain);
    if (head.length < 2 || !/(kpi|metric|measure)/i.test(head[0]) && !/^\s*$/.test(head[0])) continue;
    const trendCol = head.findIndex((h) => /(trend|change|vs)/i.test(h));
    const out = [];
    for (const r of b.rows) {
      const label = plain(r[0] || []); const value = plain(r[1] || []);
      if (!label || !/\d/.test(value)) continue;
      out.push({ label, value, trend: trendCol > 1 ? plain(r[trendCol] || []) || null : null, compare: head.length > 2 && trendCol !== 2 ? { label: head[2], value: plain(r[2] || []) } : null });
    }
    if (out.length) return { month_label: head[1], items: out.slice(0, 8) };
  }
  return null;
}

// ---------------------------------------------------------------- storage
function getReport(db, clientId) {
  return db.prepare('SELECT * FROM client_reports WHERE client_id = ?').get(clientId) || null;
}

function setReport(db, { clientId, url, actor }) {
  const ids = parseDocUrl(url);
  if (!ids) throw new AppError(400, 'Paste the link to the ClickUp doc (for example https://doc.clickup.com/9017740562/d/h/…)');
  const taken = db.prepare('SELECT r.client_id, c.name FROM client_reports r JOIN clients c ON c.id = r.client_id WHERE r.doc_id = ? AND r.client_id != ?').get(ids.docId, clientId);
  if (taken) throw new AppError(409, `That doc is already shown for ${taken.name}`);
  tx(db, () => {
    db.prepare('DELETE FROM report_pages WHERE client_id = ?').run(clientId);
    db.prepare(`INSERT INTO client_reports (client_id, workspace_id, doc_id, url, added_by) VALUES (?,?,?,?,?)
      ON CONFLICT(client_id) DO UPDATE SET workspace_id = excluded.workspace_id, doc_id = excluded.doc_id, url = excluded.url,
      added_by = excluded.added_by, refreshed_at = NULL, last_error = NULL`).run(clientId, ids.workspaceId, ids.docId, String(url).trim(), actor);
  });
  audit(db, { clientId, actor, action: 'report_doc.set', detail: ids });
  return getReport(db, clientId);
}

function removeReport(db, { clientId, actor }) {
  tx(db, () => {
    db.prepare('DELETE FROM report_pages WHERE client_id = ?').run(clientId);
    db.prepare('DELETE FROM client_reports WHERE client_id = ?').run(clientId);
  });
  audit(db, { clientId, actor, action: 'report_doc.remove' });
}

/** Re-read each linked recap doc from ClickUp (one client, or all). */
async function refreshReports(db, adapter, { clientId = null } = {}) {
  if (!adapter || adapter.mode !== 'live' || typeof adapter.docPages !== 'function') return { refreshed: 0 };
  const reports = clientId ? [getReport(db, clientId)].filter(Boolean) : db.prepare('SELECT * FROM client_reports').all();
  let refreshed = 0;
  for (const r of reports) {
    try {
      const pages = await adapter.docPages(r.workspace_id, r.doc_id);
      const flat = [];
      const walk = (list) => { for (const p of list || []) { flat.push(p); walk(p.pages); } };
      walk(pages);
      const year = String(new Date().getUTCFullYear());
      const months = flat.filter((p) => !p.deleted && !p.archived && String(p.content || '').trim())
        .map((p) => ({ id: String(p.id), title: String(p.name || '').trim() || 'Recap', month: pageMonth(p.name, p.date_created, year),
          blocks: toBlocks(p.content), updated: p.date_updated ? new Date(Number(p.date_updated)).toISOString() : null }))
        .filter((p) => p.month);
      tx(db, () => {
        db.prepare('DELETE FROM report_pages WHERE client_id = ?').run(r.client_id);
        const ins = db.prepare('INSERT INTO report_pages (client_id, page_id, title, month, blocks, page_updated) VALUES (?,?,?,?,?,?)');
        for (const p of months) ins.run(r.client_id, p.id, p.title.slice(0, 120), p.month, JSON.stringify(p.blocks), p.updated);
        db.prepare('UPDATE client_reports SET refreshed_at = ?, last_error = NULL, pages = ? WHERE client_id = ?').run(nowIso(), months.length, r.client_id);
      });
      refreshed++;
    } catch (e) {
      db.prepare('UPDATE client_reports SET last_error = ? WHERE client_id = ?').run(String(e.message).slice(0, 300), r.client_id);
    }
  }
  return { refreshed };
}

/** What the client sees: each month's recap (newest first) and the headline numbers from the newest one. */
function clientResults(db, clientId) {
  const r = getReport(db, clientId);
  if (!r) return null;
  const pages = db.prepare('SELECT title, month, blocks, page_updated FROM report_pages WHERE client_id = ? ORDER BY month DESC').all(clientId)
    .map((p) => ({ title: p.title, month: p.month, blocks: JSON.parse(p.blocks), updated: p.page_updated }));
  // Work completed in each recap month, from the ledger, so results sit next to the effort that produced them.
  const used = Object.fromEntries(db.prepare(`SELECT substr(work_date, 1, 7) m, SUM(points) p FROM work_items
    WHERE client_id = ? AND state = 'used' GROUP BY m`).all(clientId).map((x) => [x.m, Number(x.p)]));
  return {
    months: pages.map((p) => ({ ...p, work_completed: used[p.month] || 0 })),
    headline: pages.length ? headline(pages[0].blocks) : null,
    refreshed_at: r.refreshed_at,
  };
}

module.exports = { parseDocUrl, toBlocks, pageMonth, headline, getReport, setReport, removeReport, refreshReports, clientResults };
