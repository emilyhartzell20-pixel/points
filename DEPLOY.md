# LeadG2 Service Points: deployment guide for IT

This is a small internal web app for LeadG2. Consultants use it to track client "service points", and LeadG2 clients sign in to see their own point balance. This guide covers hosting it at a Center for Sales Strategy address, for example `points.thecenterforsalesstrategy.com`.

## At a glance

| | |
|---|---|
| What it is | One Node.js 22 process. It has **no third-party npm dependencies** and uses SQLite through Node's built-in `node:sqlite`. |
| Packaging | `Dockerfile` and `compose.yaml` are included. |
| Resources | Very small: 1 vCPU, 256–512 MB RAM, 1 GB disk is plenty for the pilot. |
| State | A single SQLite file at `/data/leadg2.db`, on a persistent volume. **This volume is the only thing that must be backed up.** |
| Port | 3000 (HTTP). TLS terminates at your reverse proxy or load balancer. |
| Health check | `GET /healthz` returns `200 {"ok":true}`. |
| Users | LeadG2 staff (admins) and client users. Sign-in uses email and password, with cookie sessions. |

## 1. DNS and TLS

1. Choose the hostname (suggested: `points.thecenterforsalesstrategy.com`) and point it at the server or load balancer.
2. Terminate HTTPS at your reverse proxy and forward to `127.0.0.1:3000`. Pass the `Host` and `X-Forwarded-For` headers through.
3. Serve the app only over HTTPS. In production the app marks its cookies `Secure` and sends HSTS.

## 2. Configure

```bash
cp .env.example .env
```

Fill in `.env`:

| Variable | Required | Notes |
|---|---|---|
| `PUBLIC_URL` | yes | The exact public HTTPS address, with no trailing slash. It is used to build invite and password-reset links. |
| `ADMIN_EMAIL`, `ADMIN_NAME` | first start | Creates the first LeadG2 admin. Use the person LeadG2 names as owner. These values are ignored once an admin exists. |
| `CONNECTOR_MODE=live` + ClickUp/Outlook values | later | Leave these commented out until LeadG2 asks to connect live accounts. See section 6. |

`.env` holds secrets once the connectors are on. Keep it out of source control; it is already listed in `.gitignore`.

## 3. Run

```bash
docker compose up -d --build
```

```bash
docker compose logs app
```

On first start the log prints a line like this:

```
First admin created for owner@… Open this link within 7 days to choose a password:
  https://points.thecenterforsalesstrategy.com/setup#t=…
```

Send that link **privately** to the admin named in `ADMIN_EMAIL`. It works once and lets them choose their own password. From then on, LeadG2 manages everything inside the app (Admin → LeadG2 team / Clients), with no further IT involvement.

If the link expires before it's used:

```bash
docker compose exec app npm run -s create-admin -- other.person@leadg2.com "Name"
```

This creates another admin and prints a new link.

## 4. Back up

- **Nightly snapshot.** This is safe while the app is running, and it keeps the newest 30 files in `/data/backups`:

```bash
docker compose exec -T app npm run -s backup
```

  Example cron entry on the host:

  ```
  15 2 * * * cd /opt/leadg2-points && docker compose exec -T app npm run -s backup >> /var/log/leadg2-backup.log 2>&1
  ```

- **Copy off the server.** Also copy `/data/backups` off the server (or use your volume or VM snapshot tooling), because a backup on the same disk doesn't survive losing that disk.
- **Restore.** Stop the app, copy a backup file over `/data/leadg2.db`, then start the app.

## 5. Update to a new version

```bash
git pull
```

Or unpack the new zip over the old copy, keeping `.env`. Then:

```bash
docker compose up -d --build
```

Database schema changes are applied automatically on start. The changes are additive only, so they don't remove data. Take a backup first anyway.

## 6. Later: connecting ClickUp and Outlook (read-only)

Do this only when LeadG2 asks. Until then the app runs without these connections.

| Connector | What to provision | `.env` |
|---|---|---|
| ClickUp | An API token from a ClickUp member with access to the client spaces. Read-only use is enforced in code (the connector only issues GET requests). | `CLICKUP_API_TOKEN` |
| Outlook | An Entra ID app registration with **Microsoft Graph `Mail.Read` (application)** permission, restricted by an **Exchange application access policy** to the single shared mailbox LeadG2 designates. | `OUTLOOK_MAILBOX`, `MS_TENANT_ID`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET` |

Then set `CONNECTOR_MODE=live` and set `INTERNAL_EMAIL_DOMAINS=leadg2.com,thecenterforsalesstrategy.com`.

**Outbound network.** The server needs to reach `api.clickup.com`, `graph.microsoft.com` and `login.microsoftonline.com`. Browsers additionally load fonts from `fonts.googleapis.com` and `fonts.gstatic.com`.

## Security notes

- **Sensitive data.** The database holds client names, work summaries, point balances, and, once connectors are on, excerpts of ClickUp tasks and emails used as evidence. Only LeadG2 staff can see that evidence; clients only ever see their own balance and approved summaries. Treat the volume and backups as confidential, and encrypt them at rest using your standard tooling.
- **Passwords.** Passwords are hashed with scrypt. Session and invite tokens are stored only as hashes. Invite links carry the token in the URL fragment, so it isn't sent to servers or written to proxy logs.
- **Sign-in limits.** Sign-in is throttled to 10 failures per email or IP per 15 minutes. `TRUST_PROXY=1` is set in `compose.yaml` so the app sees real client IPs behind your proxy.
- **Response headers.** Every response has a strict Content-Security-Policy, `X-Content-Type-Options` and `frame-ancestors 'none'`.
- **Single-instance design.** Run one container. Don't scale horizontally against the same SQLite file.
- **Single sign-on.** If you'd prefer staff to sign in with Microsoft (Entra ID SSO) instead of passwords, that can be added. Talk to LeadG2.

## Quick checks after deploying

- [ ] `https://<host>/healthz` returns `{"ok":true}`
- [ ] `https://<host>/login` shows the LeadG2 sign-in page, with **no** demo login hint
- [ ] The admin can use the setup link, sign in, and reach the Admin area
- [ ] The nightly backup job ran and a file appears in `/data/backups`
