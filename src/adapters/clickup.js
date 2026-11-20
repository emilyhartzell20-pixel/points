'use strict';
// ClickUp adapter. Reads tasks from the lists/spaces explicitly mapped to a client.
// Sample mode reads data/sample/clickup-tasks.json, which uses the same shape as the ClickUp v2 API,
// so the normalizer below is exercised by both modes.
const fs = require('node:fs');
const path = require('node:path');
const { getJson } = require('./http');

const API = 'https://api.clickup.com/api/v2';

function msToIso(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? new Date(n).toISOString() : new Date(v).toISOString();
}

function customField(task, name) {
  const f = (task.custom_fields || []).find((c) => String(c.name).toLowerCase() === name.toLowerCase());
  if (!f || f.value == null || f.value === '') return null;
  if (f.type === 'drop_down' && f.type_config && Array.isArray(f.type_config.options)) {
    const opt = f.type_config.options.find((o) => o.id === f.value || o.orderindex === f.value);
    return opt ? opt.name : f.value;
  }
  return f.value;
}

/** Convert a raw ClickUp task into the normalized evidence record. */
function normalizeTask(task) {
  const tags = (task.tags || []).map((t) => String(t.name || t).toLowerCase());
  const menuTag = tags.find((t) => t.startsWith('menu:'));
  // Points trackers (like "2026 Service Point Tracking") keep the real numbers in custom fields:
  // Total Points (= Point Value x How Many) and a "Service Point Status" dropdown.
  const totalField = customField(task, 'Total Points');
  const pointsField = totalField != null ? totalField : customField(task, 'Points');
  const hoursField = customField(task, 'Hours');
  const trackerStatus = customField(task, 'Service Point Status');
  const num = (v) => (v == null || v === '' ? null : Number(v));
  const points = num(pointsField);
  return {
    source_type: 'clickup_task',
    external_id: String(task.id),
    occurred_at: msToIso(task.date_updated || task.date_created),
    url: task.url || `https://app.clickup.com/t/${task.id}`,
    title: task.name,
    status: trackerStatus || (task.status && (task.status.status || task.status)),
    author: task.creator && (task.creator.email || task.creator.username) || null,
    body: task.text_content || task.description || '',
    thread_id: task.parent || null,
    data: {
      list_id: task.list && String(task.list.id),
      list_name: task.list && task.list.name,
      space_id: task.space && String(task.space.id),
      // A task with its own points is its own deliverable, even when it sits under a month heading.
      parent_id: points != null ? null : (task.parent || null),
      raw_parent: task.parent || null,
      tags,
      menu_code: customField(task, 'Service Menu Item') || (menuTag ? menuTag.slice(5).toUpperCase() : null),
      points,
      from_tracker: trackerStatus != null || totalField != null,
      point_value: num(customField(task, 'Point Value')),
      how_many: num(customField(task, 'How Many')),
      delivery_month: msToIso(customField(task, '📆 Delivery Month') || customField(task, 'Delivery Month')),
      // Type: Questco-style trackers use Department; others use Deliverable Type or Service Point Category.
      department: customField(task, 'Department') || customField(task, '🗂️ Deliverable Type') || customField(task, 'Deliverable Type') || customField(task, 'Service Point Category'),
      delivery_month_name: customField(task, 'Point Delivery Month'),
      tracker_notes: customField(task, 'Notes'),
      hours: num(hoursField),
      date_created: msToIso(task.date_created),
      date_closed: msToIso(task.date_closed || task.date_done),
    },
  };
}

class SampleClickUp {
  constructor(file = path.join(__dirname, '..', '..', 'data', 'sample', 'clickup-tasks.json')) { this.file = file; this.mode = 'sample'; }
  async fetchTasks({ mappings }) {
    const tasks = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    const lists = new Set(mappings.filter((m) => m.source_type === 'clickup_list').map((m) => m.value));
    const spaces = new Set(mappings.filter((m) => m.source_type === 'clickup_space').map((m) => m.value));
    return tasks.filter((t) => lists.has(String(t.list && t.list.id)) || spaces.has(String(t.space && t.space.id)));
  }
}

class LiveClickUp {
  constructor({ token = process.env.CLICKUP_API_TOKEN, fetchImpl } = {}) {
    this.token = token; this.fetchImpl = fetchImpl; this.mode = 'live';
  }
  async get(urlPath) {
    if (!this.token) throw new Error('ClickUp is not configured (CLICKUP_API_TOKEN missing on the server)');
    return getJson(`${API}${urlPath}`, { Authorization: this.token, Accept: 'application/json' }, { fetchImpl: this.fetchImpl });
  }
  async listIdsForSpace(spaceId) {
    const ids = [];
    const loose = await this.get(`/space/${encodeURIComponent(spaceId)}/list?archived=false`);
    for (const l of loose.lists || []) ids.push(String(l.id));
    const folders = await this.get(`/space/${encodeURIComponent(spaceId)}/folder?archived=false`);
    for (const f of folders.folders || []) for (const l of f.lists || []) ids.push(String(l.id));
    return ids;
  }
  /** Workspaces → spaces → lists, so staff can pick lists instead of pasting IDs. Read-only. */
  /** One task by id (used to look up a month heading the sync hasn't seen). Read-only. */
  async fetchTaskById(id) {
    return this.get(`/task/${encodeURIComponent(id)}`);
  }

  async listHierarchy() {
    const out = [];
    const teams = await this.get('/team');
    for (const t of teams.teams || []) {
      const spaces = await this.get(`/team/${encodeURIComponent(t.id)}/space?archived=false`);
      for (const sp of spaces.spaces || []) {
        const lists = [];
        const loose = await this.get(`/space/${encodeURIComponent(sp.id)}/list?archived=false`);
        for (const l of loose.lists || []) lists.push({ id: String(l.id), name: l.name, folder: null });
        const folders = await this.get(`/space/${encodeURIComponent(sp.id)}/folder?archived=false`);
        for (const f of folders.folders || []) for (const l of f.lists || []) lists.push({ id: String(l.id), name: l.name, folder: f.name });
        out.push({ workspace: t.name, space: { id: String(sp.id), name: sp.name }, lists });
      }
    }
    return out;
  }

  async fetchTasks({ mappings, since }) {
    const listIds = new Set(mappings.filter((m) => m.source_type === 'clickup_list').map((m) => m.value));
    for (const m of mappings.filter((x) => x.source_type === 'clickup_space')) {
      for (const id of await this.listIdsForSpace(m.value)) listIds.add(id);
    }
    const sinceMs = since ? Date.parse(since) : 0;
    const out = [];
    for (const listId of listIds) {
      for (let page = 0; page < 100; page++) {
        const q = new URLSearchParams({ include_closed: 'true', subtasks: 'true', page: String(page) });
        if (sinceMs) q.set('date_updated_gt', String(sinceMs));
        const res = await this.get(`/list/${encodeURIComponent(listId)}/task?${q}`);
        out.push(...(res.tasks || []));
        if (res.last_page !== false || !(res.tasks || []).length) break;
      }
    }
    return out;
  }
}

/** Shared entry point used by the sync pipeline. */
async function fetchClickUp(adapter, ctx) {
  const tasks = await adapter.fetchTasks(ctx);
  return tasks.map(normalizeTask);
}

/** Used in production until a ClickUp key is configured: never falls back to sample data. */
class NotConnected {
  constructor(what, howTo) { this.mode = 'not_connected'; this.message = `${what} isn't connected yet. ${howTo}`; }
  async fetchTasks() { throw new Error(this.message); }
  async fetchMessages() { throw new Error(this.message); }
}

module.exports = { NotConnected, normalizeTask, SampleClickUp, LiveClickUp, fetchClickUp };
