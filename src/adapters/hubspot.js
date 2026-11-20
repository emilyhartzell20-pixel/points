'use strict';
// Pushes each client's point balance onto their HubSpot company record, so the LeadG2 team can see
// balances in the CRM and build reports and workflows on them.
// This is the app's ONLY write to an outside system, and it only ever writes the lg2_points_*
// properties listed below on companies a LeadG2 admin has explicitly linked.
const API = 'https://api.hubapi.com';
const GROUP = 'leadg2_service_points';
const PROPERTIES = [
  { name: 'lg2_points_allocated', label: 'Service points: allocated', type: 'number', fieldType: 'number' },
  { name: 'lg2_points_used', label: 'Service points: used', type: 'number', fieldType: 'number' },
  { name: 'lg2_points_committed', label: 'Service points: committed', type: 'number', fieldType: 'number' },
  { name: 'lg2_points_available', label: 'Service points: available', type: 'number', fieldType: 'number' },
  { name: 'lg2_points_contract_end', label: 'Service points: contract term ends', type: 'date', fieldType: 'date' },
  { name: 'lg2_points_updated_at', label: 'Service points: balance last updated', type: 'datetime', fieldType: 'date' },
];

class HubSpotSync {
  constructor({ token = process.env.HUBSPOT_PRIVATE_APP_TOKEN, fetchImpl = globalThis.fetch } = {}) {
    this.token = token; this.fetchImpl = fetchImpl; this.ready = false;
  }
  get configured() { return Boolean(this.token); }

  async call(method, path, body) {
    if (!this.token) throw new Error('HubSpot is not configured (HUBSPOT_PRIVATE_APP_TOKEN missing on the server)');
    const res = await this.fetchImpl(`${API}${path}`, {
      method, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && method === 'GET') return null;
    if (!res.ok) throw new Error(`HubSpot responded ${res.status} to ${method} ${path.split('?')[0]}`); // never echo the token or body
    return res.status === 204 ? {} : res.json();
  }

  /** Create the property group and properties the first time; later calls are no-ops. */
  async ensureProperties() {
    if (this.ready) return;
    if (!(await this.call('GET', `/crm/v3/properties/companies/groups/${GROUP}`))) {
      await this.call('POST', '/crm/v3/properties/companies/groups', { name: GROUP, label: 'LeadG2 service points', displayOrder: -1 });
    }
    for (const p of PROPERTIES) {
      if (!(await this.call('GET', `/crm/v3/properties/companies/${p.name}`))) {
        await this.call('POST', '/crm/v3/properties/companies', { ...p, groupName: GROUP,
          description: 'Maintained automatically by the LeadG2 Service Points app. Edits here are overwritten.' });
      }
    }
    this.ready = true;
  }

  async pushBalance(companyId, b) {
    await this.ensureProperties();
    return this.call('PATCH', `/crm/v3/objects/companies/${encodeURIComponent(companyId)}`, { properties: toProperties(b) });
  }
}

function toProperties(b) {
  return {
    lg2_points_allocated: String(b.allocated), lg2_points_used: String(b.used),
    lg2_points_committed: String(b.committed), lg2_points_available: String(b.available),
    lg2_points_contract_end: b.term_end, lg2_points_updated_at: b.last_updated || new Date().toISOString(),
  };
}

/** Accept a pasted HubSpot company URL or a bare ID. */
function parseCompanyId(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  const m = /\/record\/0-2\/(\d+)/.exec(s) || /\/company\/(\d+)/.exec(s) || /^(\d+)$/.exec(s);
  return m ? m[1] : undefined;
}

module.exports = { HubSpotSync, PROPERTIES, GROUP, toProperties, parseCompanyId };
