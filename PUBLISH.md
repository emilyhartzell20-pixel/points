# Publishing LeadG2 Service Points on Render at points.leadg2.com

This guide is for the person who manages the leadg2.com domain and HubSpot. It takes about 30–45 minutes. You need:

- a GitHub account
- a Render account (render.com), with a card on file
- access to the DNS settings for leadg2.com
- HubSpot super admin access, only for the optional HubSpot step

Cost: Render's **Starter** web service plus a 1 GB disk, roughly $7–10 a month. Check render.com/pricing for current prices.

---

## Step 1: Put the code on GitHub

Render deploys from a GitHub repository.

1. On github.com, click **New repository**. Name it `leadg2-points`, choose **Private**, and create it empty, with no README.
2. Get the code into it. Either:
   - **Let Claude push it.** Connect GitHub at https://claude.ai/connect-github, then tell Claude the repository name. This is the easiest option.
   - **Upload it yourself.** Unzip `leadg2-points.zip`, open the new repository on GitHub, click **uploading an existing file**, and drag in everything *inside* the `leadg2-points` folder (including the `src`, `public`, `scripts` and `data` folders). Then click **Commit changes**.

## Step 2: Create the app on Render

1. Sign in to Render, click **New +** and choose **Blueprint**.
2. Connect your GitHub account when asked, then pick the `leadg2-points` repository. Render reads the included `render.yaml`, which already sets up:
   - a web service called **leadg2-points** with a 1 GB disk for the database
   - health checks
   - automatic daily backups
3. Render asks for three values:

   | Setting | What to enter |
   |---|---|
   | `ADMIN_EMAIL` | Your email. This makes you the first admin. |
   | `ADMIN_NAME` | Your name |
   | `HUBSPOT_PRIVATE_APP_TOKEN` | Leave blank for now (see Step 5) |

4. Click **Apply**. The first build takes a few minutes.
5. When it shows **Live**, open the service's **Logs** tab and find the line that starts with **First admin created**. Copy the link under it. Don't open it yet: it points to points.leadg2.com, which isn't set up until Step 3.

## Step 3: Point points.leadg2.com at Render

1. In Render, open the **leadg2-points** service → **Settings** → **Custom Domains** → **Add Custom Domain**, and enter `points.leadg2.com`.
2. Render shows the DNS record to create. It's a **CNAME** record:

   | Type | Name / Host | Value / Target |
   |---|---|---|
   | CNAME | `points` | the address Render shows, like `leadg2-points.onrender.com` |

3. Add that record wherever leadg2.com's DNS is managed. This doesn't affect the main leadg2.com redirect or your HubSpot website; it only adds the new `points` address.
4. Back in Render, click **Verify**. Once DNS updates (usually minutes, occasionally up to a few hours), Render issues the HTTPS certificate automatically.

## Step 4: Sign in and set up

1. Open the link you copied in Step 2. It works once and expires in 7 days. Choose your password.
   - If the link has expired: in Render, change `ADMIN_EMAIL` to a different address of yours, or ask Claude for another way.
2. Sign in at **https://points.leadg2.com**, then work through these in order:
   1. **Admin → Service menu:** create your menu.
   2. **Admin → LeadG2 team:** invite your teammates. Each gets their own setup link.
   3. **Admin → Clients:** add your pilot client. Paste their HubSpot company record URL into the HubSpot field.
   4. **Sources & sync:** add their ClickUp lists and email domain. These stay in sample mode until live connectors are turned on.
   5. **Client access:** check the preview, add client logins, then turn access on.

## Step 5 (optional): Show balances on HubSpot company records

The app copies **allocated, used, committed and available** points, plus the contract end date, onto each linked client's HubSpot company record. They appear in a property group called **LeadG2 service points**, so you can add them to the company sidebar, reports and workflows (for example, "notify the consultant when available points drop below 20").

1. In HubSpot, go to **Settings → Integrations → Private Apps**. In newer accounts this may be under **Development → Legacy apps**. Create an app named **LeadG2 Service Points**.
2. Give it exactly these scopes, and nothing more:
   - `crm.objects.companies.read`
   - `crm.objects.companies.write`
   - `crm.schemas.companies.read`
   - `crm.schemas.companies.write`
3. Copy the access token. In Render, open **leadg2-points → Environment**, set `HUBSPOT_PRIVATE_APP_TOKEN` to the token, and save. Render restarts the app.
4. Within a few minutes, linked clients' company records show the point fields. **Sources & sync → Update HubSpot now** pushes one immediately.

The app creates those six `lg2_points_*` properties the first time. It only ever writes those properties, and only on companies you've linked to a client. Anyone editing them by hand in HubSpot will see them overwritten by the next update.

---

## Looking after it

- **Backups:** the app saves a full copy of its database every day to `/data/backups` and keeps 30 days. Render also snapshots the disk daily. To restore, ask whoever supports the app; restores use the app's backups, not Render's disk snapshots.
- **Updates:** when Claude or a developer changes the code in GitHub, Render redeploys automatically. Data on the disk is kept.
- **Health:** Render watches `/healthz` and restarts the app if it stops responding.
- **Removing someone's access:** use Admin → LeadG2 team or Client access → Remove. It takes effect immediately.
- **Connecting live ClickUp and Outlook:** this is a later step. It needs a ClickUp API token and a read-only Microsoft mail permission. The settings are in `.env.example`, and DEPLOY.md, section 6, describes them.
