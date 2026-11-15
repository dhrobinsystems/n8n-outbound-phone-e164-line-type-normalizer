/**
 * In-memory stand-ins for HubSpot and the Twilio Lookup API, used by demo mode, the tests and
 * the workflow simulation. No network access.
 */
import { mockTwilioLookup } from './lineType.js';

export const DEMO_NOW = '2026-11-16T09:00:00.000Z';

/** Fictional contacts. Every number is in a reserved fictional range (NANP 555-01XX, Ofcom, ACMA). */
export function createDemoContacts() {
  return {
    101: { company: 'Acme Corp', country: 'United States', phone: '(555) 555-0100' },
    102: { company: 'Acme Corp', country: 'US', phone: '555.555.0101 ext. 204', mobilephone: '+1 555 555 0102' },
    103: { company: 'Example Company Inc.', country: 'United Kingdom', phone: '+44 (0)20 7946 0018', mobilephone: '07700 900123' },
    104: { company: 'Example Company Inc.', country: 'United States', phone: 'call me maybe' },
    105: { company: 'Acme Corp', country: 'United States', phone: '555-0199' },
    106: {
      company: 'Acme Corp', country: 'United States', phone: '+15555550103',
      phone_e164: '+15555550103', phone_line_type: 'fixed_voip', phone_normalization_status: 'fictional',
      mobilephone_e164: '', mobilephone_line_type: '', mobilephone_normalization_status: 'missing',
      outbound_sms_eligible: 'false', outbound_dial_eligible: 'true', outbound_best_sms_number: '', outbound_best_dial_number: '+15555550103',
      outbound_phone_carrier: 'Example Business Voice', outbound_phone_extension: '', outbound_phone_checked_at: '2026-11-06T09:00:00.000Z',
      outbound_phone_issues: 'phone is in a reserved fictional range',
    },
    107: { company: 'Example Company Inc.', country: 'United States', phone: '1-800-555-0104' },
    108: { company: 'Example Company Inc.', country: 'Australia', mobilephone: '0491 570 156' },
    109: { company: 'Acme Corp', country: 'United Kingdom', phone: '00 44 7700 900456' },
    110: { company: 'Acme Corp', country: 'United States' },
    111: { company: 'Example Company Inc.', country: 'United States', phone: '+1 (555) 555-0105', mobilephone: '555 555 0105' },
  };
}

export function createMockHubSpot({ contacts = createDemoContacts(), account = { portalId: 'DEMO', accountType: 'SANDBOX', uiDomain: 'app.hubspot.com' }, failUpdatesFor = [] } = {}) {
  const calls = [];
  const state = { contacts, account, propertyDefinitions: [] };

  async function request(req) {
    const method = String(req.method || 'GET').toUpperCase();
    const url = new URL(req.url);
    calls.push({ method, path: url.pathname, search: url.search, body: req.body === undefined ? null : JSON.parse(JSON.stringify(req.body)), headers: req.headers || {} });
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (method === 'GET' && url.pathname === '/account-info/v3/details') return { status: 200, body: { ...state.account } };
    if (parts[0] === 'crm' && parts[1] === 'v3' && parts[2] === 'objects' && parts[3] === 'contacts' && parts[4]) {
      const id = parts[4];
      const contact = state.contacts[id];
      if (!contact) return { status: 404, body: { status: 'error', category: 'OBJECT_NOT_FOUND', message: `resource not found for contact ${id}` } };
      if (method === 'GET') {
        const names = (url.searchParams.get('properties') || '').split(',').filter(Boolean);
        const properties = { hs_object_id: id };
        for (const name of names) properties[name] = contact[name] === undefined ? null : contact[name];
        return { status: 200, body: { id, properties, archived: false } };
      }
      if (method === 'PATCH') {
        if (failUpdatesFor.includes(id)) return { status: 500, body: { status: 'error', message: 'Internal error' } };
        Object.assign(contact, req.body.properties);
        return { status: 200, body: { id, properties: { ...req.body.properties } } };
      }
    }
    if (parts.join('/') === 'crm/v3/properties/contacts' && method === 'POST') {
      if (state.propertyDefinitions.includes(req.body.name)) return { status: 409, body: { status: 'error', message: 'Property already exists' } };
      state.propertyDefinitions.push(req.body.name);
      return { status: 201, body: req.body };
    }
    return { status: 404, body: { status: 'error', message: `Mock HubSpot has no route for ${method} ${url.pathname}` } };
  }
  return { request, calls, state };
}

/** Twilio-compatible mock server for the workflow simulation and HTTP-level tests. */
export function createMockTwilio({ failFor = [] } = {}) {
  const calls = [];
  async function request(req) {
    const url = new URL(req.url);
    calls.push({ method: req.method, path: url.pathname, search: url.search, headers: req.headers || {} });
    const match = url.pathname.match(/^\/v2\/PhoneNumbers\/(.+)$/);
    if (!match) return { status: 404, body: { code: 20404, message: 'Not found', status: 404 } };
    const e164 = decodeURIComponent(match[1]);
    if (failFor.includes(e164)) return { status: 503, body: { code: 20503, message: 'Service unavailable', status: 503 } };
    return { status: 200, body: mockTwilioLookup(e164) };
  }
  return { request, calls };
}
