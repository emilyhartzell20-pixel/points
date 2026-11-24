'use strict';
// SQLite storage (built-in node:sqlite). One file per environment; ':memory:' for tests.
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS clients (
  id INTEGER PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',          -- JSON array of names used to spot uncertain matches
  portal_enabled INTEGER NOT NULL DEFAULT 0,   -- client logins blocked until staff grant access
  pilot INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Service point menu, versioned. Approved work snapshots the amount, so later edits never rewrite history.
CREATE TABLE IF NOT EXISTS menu_versions (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  effective_date TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY,
  menu_version_id INTEGER NOT NULL REFERENCES menu_versions(id),
  code TEXT NOT NULL,
  name TEXT NOT NULL,
  points_min INTEGER NOT NULL,
  points_max INTEGER NOT NULL,             -- equal to points_min for fixed-price items
  keywords TEXT NOT NULL DEFAULT '[]',
  notes TEXT,
  UNIQUE (menu_version_id, code)
);

-- Contract term. The signed agreement / verified opening balance is the source of truth.
CREATE TABLE IF NOT EXISTS contracts (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  term_start TEXT NOT NULL,
  term_end TEXT NOT NULL,
  menu_version_id INTEGER NOT NULL REFERENCES menu_versions(id),
  agreement_ref TEXT,
  opening_balance_date TEXT,               -- ingest source activity from this date forward
  opening_used INTEGER,                    -- reconciliation totals from the existing tracker
  opening_committed INTEGER,
  opening_reconciled_at TEXT,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS allocations (
  id INTEGER PRIMARY KEY,
  contract_id INTEGER NOT NULL REFERENCES contracts(id),
  kind TEXT NOT NULL CHECK (kind IN ('base','bonus','purchase')),
  points INTEGER NOT NULL,
  source_ref TEXT NOT NULL,                -- agreement / order form reference
  verified_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- HubSpot support-hours bank: tracked in HOURS, never mixed into points.
CREATE TABLE IF NOT EXISTS support_hour_banks (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  hours_purchased REAL NOT NULL,
  source_ref TEXT NOT NULL,
  term_start TEXT, term_end TEXT
);
CREATE TABLE IF NOT EXISTS support_hour_entries (
  id INTEGER PRIMARY KEY,
  bank_id INTEGER NOT NULL REFERENCES support_hour_banks(id),
  work_date TEXT NOT NULL,
  hours REAL NOT NULL,
  description TEXT NOT NULL,
  suggestion_id INTEGER,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A deliverable. state drives the ledger; points are the approved, snapshotted amount.
CREATE TABLE IF NOT EXISTS work_items (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  contract_id INTEGER NOT NULL REFERENCES contracts(id),
  group_key TEXT,                          -- stable deliverable key, e.g. clickup:abc123
  external_ref TEXT,                       -- tracker:<id> / manual:<uuid> for idempotent imports
  title TEXT NOT NULL,                     -- internal title
  client_summary TEXT,                     -- plain-language summary for the client
  summary_approved INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('forecast','committed','used','canceled')),
  points INTEGER NOT NULL,
  menu_version_id INTEGER REFERENCES menu_versions(id),
  menu_item_code TEXT,
  menu_item_name TEXT,
  work_date TEXT NOT NULL,                 -- approval date (committed) or completion date (used)
  origin TEXT NOT NULL CHECK (origin IN ('opening','suggestion','manual','import')),
  internal_notes TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (client_id, external_ref)
);
CREATE UNIQUE INDEX IF NOT EXISTS work_items_group ON work_items(client_id, group_key) WHERE group_key IS NOT NULL;

-- Append-only ledger. Balance = sums of deltas. Completion moves points committed -> used.
CREATE TABLE IF NOT EXISTS ledger_events (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  work_item_id INTEGER NOT NULL REFERENCES work_items(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('reserve','consume','consume_direct','release','correction','opening')),
  committed_delta INTEGER NOT NULL DEFAULT 0,
  used_delta INTEGER NOT NULL DEFAULT 0,
  actor TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Explicit client-to-source mappings (read-only connectors only look at mapped sources).
CREATE TABLE IF NOT EXISTS source_mappings (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  source_type TEXT NOT NULL CHECK (source_type IN ('clickup_space','clickup_list','email_domain','email_address')),
  value TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'points' CHECK (scope IN ('points','consulting','project','support_hours')),
  label TEXT,
  UNIQUE (source_type, value)
);

-- Raw evidence, keyed by stable source id. Re-importing the same id is an update, never a duplicate.
CREATE TABLE IF NOT EXISTS source_records (
  id INTEGER PRIMARY KEY,
  source_type TEXT NOT NULL CHECK (source_type IN ('clickup_task','outlook_message')),
  external_id TEXT NOT NULL,
  client_id INTEGER REFERENCES clients(id),
  match_status TEXT NOT NULL CHECK (match_status IN ('matched','uncertain','ignored')),
  match_candidates TEXT NOT NULL DEFAULT '[]',
  match_reason TEXT,
  scope TEXT NOT NULL DEFAULT 'points',
  thread_id TEXT,                          -- outlook conversationId / clickup parent id
  linked_task_id TEXT,                     -- clickup task id referenced by an email
  group_key TEXT,
  group_override TEXT,                     -- set by reviewer merges; survives re-imports
  occurred_at TEXT NOT NULL,
  url TEXT,
  title TEXT,
  status TEXT,
  author TEXT,
  body TEXT,
  data TEXT NOT NULL,                      -- normalized JSON
  content_hash TEXT NOT NULL,
  first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (source_type, external_id)
);

CREATE TABLE IF NOT EXISTS sync_runs (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  source TEXT NOT NULL,                    -- clickup | outlook | tracker
  mode TEXT NOT NULL,                      -- sample | live | file
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('running','success','failed')),
  since TEXT,
  records_seen INTEGER NOT NULL DEFAULT 0,
  records_new INTEGER NOT NULL DEFAULT 0,
  records_updated INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

-- Review queue.
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  group_key TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('forecast','approve','complete','cancel','change','support_hours')),
  work_item_id INTEGER REFERENCES work_items(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','dismissed','merged')),
  title TEXT NOT NULL,
  menu_item_code TEXT,
  proposed_points INTEGER,                 -- NULL when the reviewer must confirm (range/unclear)
  points_min INTEGER, points_max INTEGER,
  proposed_hours REAL,
  evidence_date TEXT,                      -- approval / completion / cancel date taken from the evidence
  rationale TEXT NOT NULL,
  flags TEXT NOT NULL DEFAULT '[]',
  evidence_hash TEXT,
  edited INTEGER NOT NULL DEFAULT 0,      -- reviewer edits are preserved when evidence refreshes
  reviewer_note TEXT,
  merged_into INTEGER REFERENCES suggestions(id),
  resolved_by TEXT, resolved_at TEXT, resolution_note TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (client_id, group_key, action)
);
CREATE TABLE IF NOT EXISTS suggestion_evidence (
  suggestion_id INTEGER NOT NULL REFERENCES suggestions(id),
  source_record_id INTEGER NOT NULL REFERENCES source_records(id),
  signal TEXT,
  PRIMARY KEY (suggestion_id, source_record_id)
);
CREATE TABLE IF NOT EXISTS work_item_evidence (
  work_item_id INTEGER NOT NULL REFERENCES work_items(id),
  source_record_id INTEGER NOT NULL REFERENCES source_records(id),
  PRIMARY KEY (work_item_id, source_record_id)
);

-- Client-facing ClickUp lists shown on the dashboard (not points): an editorial calendar and the
-- collaboration list where work waits for the client's review. Snapshots are refreshed by sync.
CREATE TABLE IF NOT EXISTS client_feeds (
  id INTEGER PRIMARY KEY,
  client_id INTEGER NOT NULL REFERENCES clients(id),
  kind TEXT NOT NULL CHECK (kind IN ('calendar','collaboration')),
  list_id TEXT NOT NULL,
  label TEXT,
  refreshed_at TEXT,
  last_error TEXT,
  UNIQUE (kind, list_id)
);
CREATE TABLE IF NOT EXISTS feed_items (
  feed_id INTEGER NOT NULL REFERENCES client_feeds(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT,
  status_type TEXT,
  due_date TEXT,
  url TEXT,
  PRIMARY KEY (feed_id, task_id)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY,
  client_id INTEGER,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT, entity_id INTEGER,
  reason TEXT,
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('staff','client')),
  client_id INTEGER REFERENCES clients(id),
  password_hash TEXT NOT NULL,
  password_set INTEGER NOT NULL DEFAULT 1,  -- 0 until an invited user chooses their password
  CHECK ((role = 'client') = (client_id IS NOT NULL))
);
-- One-time links that let an invited client choose their own password (staff never see it).
CREATE TABLE IF NOT EXISTS invites (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_by TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at TEXT NOT NULL
);
`;

function openDb(file) {
  const target = file || process.env.DB_FILE || path.join(__dirname, '..', 'data', 'leadg2.db');
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Additive migrations for databases created by earlier versions.
function migrate(db) {
  const has = (table, col) => db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === col);
  if (!has('users', 'password_set')) db.exec('ALTER TABLE users ADD COLUMN password_set INTEGER NOT NULL DEFAULT 1');
  if (!has('clients', 'pilot')) db.exec('ALTER TABLE clients ADD COLUMN pilot INTEGER NOT NULL DEFAULT 0');
  if (!has('menu_items', 'category')) {
    db.exec('ALTER TABLE menu_items ADD COLUMN category TEXT');
    // Menus loaded from the LeadG2 template stored the category as the first part of the notes.
    db.exec(`UPDATE menu_items SET category = CASE
        WHEN notes LIKE 'Consulting & Support%' THEN 'Consulting & Support'
        WHEN notes LIKE 'Content/Promotion%' THEN 'Content/Promotion'
        WHEN notes = 'Sales' OR notes LIKE 'Sales · %' THEN 'Sales' END
      WHERE category IS NULL`);
  }
  if (!has('work_items', 'category')) db.exec('ALTER TABLE work_items ADD COLUMN category TEXT');
  if (!has('clients', 'show_planned')) db.exec('ALTER TABLE clients ADD COLUMN show_planned INTEGER NOT NULL DEFAULT 1');
  if (!has('clients', 'hubspot_company_id')) db.exec('ALTER TABLE clients ADD COLUMN hubspot_company_id TEXT');
  if (!has('clients', 'hubspot_synced')) db.exec('ALTER TABLE clients ADD COLUMN hubspot_synced TEXT');
  db.exec(`CREATE TABLE IF NOT EXISTS client_pages (client_id INTEGER PRIMARY KEY REFERENCES clients(id), html TEXT, url TEXT,
    file_name TEXT, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS hours_trackers (list_id TEXT PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id),
    label TEXT, imported_at TEXT, last_error TEXT)`);
  if (!has('work_items', 'phase')) db.exec('ALTER TABLE work_items ADD COLUMN phase TEXT');
  if (!has('clients', 'unit')) db.exec("ALTER TABLE clients ADD COLUMN unit TEXT NOT NULL DEFAULT 'points'");
  if (!has('invites', 'replaced_at')) db.exec('ALTER TABLE invites ADD COLUMN replaced_at TEXT');
  if (!has('client_feeds', 'scope')) db.exec("ALTER TABLE client_feeds ADD COLUMN scope TEXT NOT NULL DEFAULT 'list'");
  if (!has('feed_items', 'list_id')) db.exec('ALTER TABLE feed_items ADD COLUMN list_id TEXT');
  if (!has('feed_items', 'assigned_to_client')) db.exec('ALTER TABLE feed_items ADD COLUMN assigned_to_client INTEGER NOT NULL DEFAULT 0');
  db.exec(`CREATE TABLE IF NOT EXISTS client_links (id INTEGER PRIMARY KEY, client_id INTEGER NOT NULL REFERENCES clients(id),
    label TEXT NOT NULL, url TEXT NOT NULL, note TEXT, sort INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, created_by TEXT NOT NULL)`);
  if (!has('client_feeds', 'statuses')) db.exec('ALTER TABLE client_feeds ADD COLUMN statuses TEXT');
  if (!has('suggestions', 'evidence_date')) db.exec('ALTER TABLE suggestions ADD COLUMN evidence_date TEXT');
}

// Run fn inside a transaction (nested calls join the outer one).
function tx(db, fn) {
  if (db.__inTx) return fn();
  db.exec('BEGIN IMMEDIATE');
  db.__inTx = true;
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.__inTx = false;
  }
}

function audit(db, { clientId = null, actor, action, entity = null, entityId = null, reason = null, detail = null }) {
  db.prepare(`INSERT INTO audit_log (client_id, actor, action, entity, entity_id, reason, detail)
              VALUES (?,?,?,?,?,?,?)`).run(clientId, actor, action, entity, entityId, reason,
    detail == null ? null : JSON.stringify(detail));
}

const nowIso = () => new Date().toISOString();

class AppError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// A client tracks either service points (whole numbers) or hours (quarter hours allowed).
const UNITS = ['points', 'hours'];
function unitOf(db, clientId) {
  const r = clientId == null ? null : db.prepare('SELECT unit FROM clients WHERE id = ?').get(clientId);
  return r && r.unit === 'hours' ? 'hours' : 'points';
}
function amountOk(n, unit, { positive = false } = {}) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || (positive && n === 0)) return false;
  return unit === 'hours' ? Number.isInteger(n * 4) : Number.isInteger(n);
}
function assertAmount(n, unit, { positive = false, what } = {}) {
  if (!amountOk(n, unit, { positive })) {
    throw new AppError(400, unit === 'hours'
      ? `${what || 'Hours'} must be ${positive ? 'more than zero' : 'zero or more'}, in quarter hours (for example 1.5 or 0.25)`
      : `${what || 'Points'} must be a ${positive ? 'positive' : 'non-negative'} whole number`);
  }
}

module.exports = { openDb, tx, audit, nowIso, AppError, UNITS, unitOf, amountOk, assertAmount };
