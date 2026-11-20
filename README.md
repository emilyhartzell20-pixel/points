# LeadG2 Service Points: pilot

This app tracks each client's service points. It has a ledger, an internal review queue, and a client dashboard. Adapters read ClickUp and Outlook as evidence. The pilot runs on **sample data**: one pilot client (Harbor Point Logistics) and one second client (Bluebird Dental Group) that the isolation tests use.

It needs nothing installed beyond Node.js 22.13 or later. It uses only built-in `node:http`, `node:sqlite` and `node:test`.

```bash
npm test                 # 23 tests
npm run demo             # seed + sample sync, review queue left pending → http://localhost:3000
npm run demo:reviewed    # same, plus the scripted consultant review → 250 / 103 / 23 / 124
```

Demo logins:
- Staff: `consultant@leadg2.example` / `demo-consultant`
- Client: `dana@harborpoint.example` / `demo-client`

With `npm run demo`, first grant access under **Client preview & access**. Every demo run resets `data/leadg2.db`.

## Adding points by hand

Use the **+ Add points** button in the staff console (top right, and on the Ledger tab). It has two modes:

- **Log work:** for work that never showed up in ClickUp or email, such as a call, a Teams message or a hallway request. Pick a menu item or "Custom – not on the menu", set the status (completed uses points, approved reserves them, planned is forecast only), and say how you know it was approved. Custom work and amounts outside the menu need a "why this amount" note. You can attach an optional evidence link, which stays internal. A live preview shows how the balance will change before you save. Each entry is logged with your name.
- **Add to allocation:** for bonus points or additional purchased points. This requires a reference to the signed agreement or order form.

## Publishing (hosting)

The app ships as a container (`Dockerfile`) with no dependencies. Any host that runs a container with a **persistent disk** will work.
- Mount a persistent volume at `/data`, where the database lives.
- Set these environment variables:

| Variable | Value |
|---|---|
| `PUBLIC_URL` | The public address, e.g. `https://points.leadg2.com` (used in invite links) |
| `ADMIN_EMAIL`, `ADMIN_NAME` | Used once, on first start, to create the first admin. Their one-time setup link is printed in the server logs. |
| `TRUST_PROXY` | `1` when behind the host's HTTPS proxy, so sign-in throttling sees real visitor addresses |
| `CONNECTOR_MODE` + ClickUp/Outlook credentials | Only when you're ready to connect live accounts (see below) |

`NODE_ENV=production` is set in the container. It turns on Secure cookies and HSTS, and it hides the demo sign-in hints.
- **Health check:** `GET /healthz`.
- **Backups:** `npm run backup` writes a snapshot to `/data/backups` and keeps the latest 30. Run it on a daily schedule, and also use your host's volume snapshots.
- **Sign-in protection:** 10 failed attempts per email or IP in 15 minutes blocks further tries for that window.

## The admin area

Sign in as staff and click **Admin** at the top right. It has three tabs:
- **Clients:** every customer, with a setup checklist ("To do: add sources, add logins, turn on access"), plus the **Add a client** form (name, contract term, menu, agreement reference, points, optional bonus and support hours).
- **LeadG2 team:** add or remove admins. New admins get a one-time link to set their own password. You can't remove yourself, and the last admin can't be removed.
- **Service menu:** see below.

**Client workspace** (top right) is where day-to-day work happens for the client picked in the dropdown.

### Starting for real (no sample data)

```bash
npm run create-admin -- you@leadg2.com "Your Name"
```

```bash
npm start
```

Open the printed link, choose a password and sign in. Then:
1. Admin → Service menu: create the menu.
2. Admin → Clients: add a client.
3. Sources & sync: map their ClickUp lists and email domain.
4. Client access: add logins and turn on access.

## Editing the service menu

Open the **Service menu** tab.
- **Edit an item in place and click Save.** For a fixed price, fill in only "Points". For a range, also fill in "Up to"; the reviewer then confirms the amount. Use the blank last row to add an item.
- **Start a new menu version** (for example at the yearly price change). Copy the current menu, adjust it, then use **Use this menu for <client>** to switch each client when their new term starts.
- **History is safe.** Approved work keeps the amount, item and version it was approved at. Every menu change is in the audit log.

## Giving a client access

Open the **Client access** tab.
1. Check the preview. It is exactly what the client sees.
2. **Add a login** (name and email). You get a one-time link to send them; it expires in 7 days. They open it and choose their own password, so LeadG2 never sees it.
3. Click **Turn on access**. Until then, nobody at that client can sign in.

Use **Password reset link** for forgotten passwords and **Remove** to take a person's access away. Turning access off signs everyone at the client out. When the app is hosted, set `PUBLIC_URL` (e.g. `https://points.leadg2.com`) so the links point to the right address.

## How it talks to ClickUp

On the **Sources & sync** tab you list which ClickUp lists or spaces (paste the URL or ID) and which email domains belong to the client, and what kind of work each holds. Clicking **Sync ClickUp now** calls the ClickUp API (read-only) for tasks in those lists that changed since the last sync. It reads:
- each task's status
- an optional "Service Menu Item" custom field or a `menu:CODE` tag
- an optional "Points" field
- an optional "Hours" field for support work

Emails that contain a task link or `CU-<id>` are grouped with that task. Everything lands in the Review queue as suggestions.

## Branding

The look matches leadg2.com:
- **Colors:** orange `#e17226`, navy `#1b263b` and deep navy `#0d1b2a`.
- **Type:** Inter Tight for headings and numbers, Mulish for the interface, and Lora for body copy, including the orange italic phrase that finishes headings ("Your service points, *at a glance.*").
- **Layout:** a white header with the full-color logo (`public/brand/logo.png`), white cards with an orange left edge, 6px-radius orange buttons, deep-navy feature panels and a light-gray footer.

## The worked example

| Step | Allocated | Used | Committed | Available |
|---|---|---|---|---|
| Opening balance reconciled from tracker (as of 2026‑10‑01) | 250 (200 base + 25 bonus + 25 purchased) | 85 | 26 | 139 |
| After sample ClickUp/Outlook sync (suggestions only) | 250 | 85 | 26 | 139 |
| Lead scoring completed (8 committed → used) | 250 | 93 | 18 | 139 |
| Carrier landing page completed (client approved + confirmed live) | 250 | 103 | 18 | 129 |
| Webinar emails canceled by client (release 8) | 250 | 103 | 10 | 137 |
| Exception routing workflow approved (menu range 8–15, reviewer confirms 13) | **250** | **103** | **23** | **124** |

The scripted review also makes these decisions. None of them change the point balance:
- The dashboard request is tracked as a forecast only.
- The consulting task, the fixed-scope project task and the injection email are dismissed with reasons.
- 1.5 h goes to the separate support-hours bank.
- The uncertain personal-email match is assigned to Harbor Point and then dismissed.
- The "chatbot idea" email stays open, because an email mention alone never charges points.

## How the business rules map to code

| Rule | Where |
|---|---|
| Allocation comes from the agreement or a verified opening balance. Opening import must reconcile against contract totals or nothing is imported | `contracts`, `allocations`; `importer.importTracker({opening:true})` |
| Available = allocated − used − committed. Forecast is shown but never counted | `ledger.balance` |
| Approved → committed (reserve). Completed + confirmed → the *same* points move committed → used. Cancel → release. Used work cannot be canceled, only corrected | `ledger.transition`; append-only `ledger_events` |
| Corrections need a reason and log who and why | `ledger.correct` → `audit_log` |
| Menu versions per contract. The approved amount, item and version are snapshotted on the work item | `menu_versions`, `menu_items`, `work_items.points/menu_*` |
| Ranges, unclear costs, consulting/project scope, disagreeing sources and missing client approval are flagged. The reviewer confirms the amount | `ingest.evaluateGroup` flags; `review.approveSuggestion` validation |
| Support-hours bank is kept in hours and never mixed into points | `support_hour_banks/entries`; `support_hours` suggestions |
| Stable source IDs make repeat imports safe. Tasks, subtasks and email threads group into one deliverable | `source_records UNIQUE(source_type, external_id)`, `ingest.regroup`, `suggestions UNIQUE(client, group, action)` |
| A sync never charges points. Only a consultant's approval writes to the ledger | `ingest.js` has no ledger writes |
| Uncertain client matches go to a queue | `ingest.matchRecord` → `match_status='uncertain'` |
| Manual entry and CSV import are idempotent (`tracker_id` or form idempotency key) | `importer.js` |
| Last successful sync and sync failures are shown | `sync_runs`, **Sources & sync** tab |
| The client view is built from an allow-list. Only approved summaries appear, and staff preview uses the same function | `clientView.clientDashboard` |
| Client isolation happens on the server. Client routes take the client from the session only, and staff routes need the staff role | `server.js` |

## Security notes

- **Task and email text is evidence only.** It is regex-classified for signals (requested, approved, completed, canceled, changed) and shown escaped (`textContent`, strict CSP). It is never treated as instructions. Text that looks like instructions is flagged `embedded_instructions`.
- **Connectors are read-only.** `adapters/http.js` refuses any method except GET. Tokens are read from server environment variables, sent only in headers, and never written to sync errors or the browser.
- **Sessions:** HttpOnly, SameSite=Strict cookies. Tokens are stored hashed. Passwords use scrypt. POST requests must be JSON. Revoking a client's access ends their sessions.

## Connecting real accounts (after the pilot sign-off)

Set `CONNECTOR_MODE=live` and provide the credentials server-side:

| Source | Env vars | Permissions |
|---|---|---|
| ClickUp | `CLICKUP_API_TOKEN` | A read-only member's personal token, or an OAuth app limited to the pilot space |
| Outlook | `OUTLOOK_MAILBOX` plus `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` (or `OUTLOOK_ACCESS_TOKEN`) | Graph `Mail.Read` application permission, scoped with an Exchange application access policy to the shared mailbox |

Then replace the sample `source_mappings` with the pilot's real ClickUp space/list IDs and email domains, and import the reconciled tracker CSV with "This is the reconciled opening balance" checked. `INTERNAL_EMAIL_DOMAINS` (default `leadg2.com`) controls which participants are ignored when matching clients.

## Not done yet / next steps

- User management UI (users are seeded). Add SSO (Entra ID) for staff before production.
- No scheduled sync yet. Syncs run from the UI or API. Add a cron to call `syncSource` per client.
- Signal detection is keyword-based. It is deterministic and auditable, but it will miss some phrasing, which is why everything goes through review.
- Remove the demo credentials hint from `public/login.html`, and set `NODE_ENV=production` for Secure cookies behind HTTPS.
- `node:sqlite` is fine for the pilot. Move to Postgres for multi-user production.
