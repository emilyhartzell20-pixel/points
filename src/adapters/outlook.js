'use strict';
// Outlook adapter (Microsoft Graph, Mail.Read). Only searches for mail involving the client's
// mapped domains/addresses, plus client-name aliases (those land in the uncertain-match queue).
const fs = require('node:fs');
const path = require('node:path');
const { getJson } = require('./http');

const GRAPH = 'https://graph.microsoft.com/v1.0';

function htmlToText(html) {
  return String(html || '')
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

const addr = (r) => (r && r.emailAddress && r.emailAddress.address ? r.emailAddress.address.toLowerCase() : null);

/** Convert a raw Graph message into the normalized evidence record. */
function normalizeMessage(m) {
  const body = m.body ? (m.body.contentType === 'html' ? htmlToText(m.body.content) : String(m.body.content || '')) : (m.bodyPreview || '');
  const participants = [addr(m.from), ...(m.toRecipients || []).map(addr), ...(m.ccRecipients || []).map(addr)].filter(Boolean);
  return {
    source_type: 'outlook_message',
    external_id: String(m.internetMessageId || m.id),
    occurred_at: new Date(m.receivedDateTime || m.sentDateTime).toISOString(),
    url: m.webLink || null,
    title: m.subject || '(no subject)',
    status: null,
    author: addr(m.from),
    body: body.slice(0, 8000),
    thread_id: m.conversationId || null,
    data: { participants: [...new Set(participants)], from: addr(m.from), graph_id: m.id },
  };
}

class SampleOutlook {
  constructor(file = path.join(__dirname, '..', '..', 'data', 'sample', 'outlook-messages.json')) { this.file = file; this.mode = 'sample'; }
  async fetchMessages({ mappings, aliases }) {
    const msgs = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    // Emulate the Graph search the live adapter runs: participant match OR alias mention.
    const domains = mappings.filter((x) => x.source_type === 'email_domain').map((x) => x.value.toLowerCase());
    const addrs = mappings.filter((x) => x.source_type === 'email_address').map((x) => x.value.toLowerCase());
    return msgs.filter((m) => {
      const n = normalizeMessage(m);
      const hit = n.data.participants.some((p) => addrs.includes(p) || domains.includes(p.split('@')[1]));
      const text = `${n.title}\n${n.body}`.toLowerCase();
      return hit || aliases.some((a) => text.includes(a.toLowerCase()));
    });
  }
}

class LiveOutlook {
  constructor({ mailbox = process.env.OUTLOOK_MAILBOX, accessToken = process.env.OUTLOOK_ACCESS_TOKEN,
    tenantId = process.env.MS_TENANT_ID, clientId = process.env.MS_CLIENT_ID, clientSecret = process.env.MS_CLIENT_SECRET, fetchImpl } = {}) {
    Object.assign(this, { mailbox, accessToken, tenantId, clientId, clientSecret, fetchImpl, mode: 'live' });
  }
  async token() {
    if (this.accessToken) return this.accessToken;
    if (!(this.tenantId && this.clientId && this.clientSecret)) {
      throw new Error('Outlook is not configured (set OUTLOOK_ACCESS_TOKEN or MS_TENANT_ID/MS_CLIENT_ID/MS_CLIENT_SECRET on the server)');
    }
    // OAuth client-credentials token request (authentication only; the app registration should grant Mail.Read only).
    const f = this.fetchImpl || globalThis.fetch;
    const res = await f(`https://login.microsoftonline.com/${encodeURIComponent(this.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret, grant_type: 'client_credentials',
        scope: 'https://graph.microsoft.com/.default' }),
    });
    if (!res.ok) throw new Error(`Microsoft identity platform responded ${res.status}`);
    const j = await res.json();
    this.accessToken = j.access_token;
    return this.accessToken;
  }
  async fetchMessages({ mappings, aliases, since }) {
    const tok = await this.token();
    const box = this.mailbox ? `/users/${encodeURIComponent(this.mailbox)}` : '/me';
    const date = since ? since.slice(0, 10) : null;
    const terms = [
      ...mappings.filter((x) => x.source_type === 'email_domain' || x.source_type === 'email_address').map((x) => `participants:${x.value}`),
      ...aliases.map((a) => `"${a.replace(/"/g, '')}"`),
    ];
    const seen = new Map();
    for (const term of terms) {
      const kql = date ? `${term} AND received>=${date}` : term;
      const select = 'id,internetMessageId,conversationId,subject,body,bodyPreview,from,toRecipients,ccRecipients,receivedDateTime,sentDateTime,webLink';
      let url = `${GRAPH}${box}/messages?$search=${encodeURIComponent(`"${kql.replace(/"/g, '\\"')}"`)}&$top=50&$select=${select}`;
      for (let i = 0; url && i < 50; i++) {
        const res = await getJson(url, { Authorization: `Bearer ${tok}`, Prefer: 'outlook.body-content-type="text"' }, { fetchImpl: this.fetchImpl });
        for (const m of res.value || []) seen.set(m.id, m);
        url = res['@odata.nextLink'] || null;
      }
    }
    return [...seen.values()];
  }
}

async function fetchOutlook(adapter, ctx) {
  const msgs = await adapter.fetchMessages(ctx);
  return msgs.map(normalizeMessage);
}

module.exports = { normalizeMessage, htmlToText, SampleOutlook, LiveOutlook, fetchOutlook };
