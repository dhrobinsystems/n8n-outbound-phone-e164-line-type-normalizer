/**
 * HubSpot request builders and response parsers (no network access, no tokens in request objects).
 */
import { isPlaceholder, SANDBOX_ACCOUNT_TYPES } from './config.js';

export function hubspotUrl(config, path) {
  return `${config.hubspot.baseUrl}${path}`;
}

export function buildAccountDetailsRequest(config) {
  return { method: 'GET', url: hubspotUrl(config, '/account-info/v3/details') };
}

/** Refuses to continue when SANDBOX_MODE=true and the token belongs to a production portal. */
export function enforceSandbox(account, config) {
  const portalId = account && account.portalId !== undefined && account.portalId !== null ? String(account.portalId) : null;
  const accountType = account && account.accountType ? String(account.accountType).toUpperCase() : null;
  if (!config.sandboxMode) return { ok: true, portalId, accountType, reason: 'SANDBOX_MODE=false, so production portals are allowed' };
  if (accountType && SANDBOX_ACCOUNT_TYPES.includes(accountType)) return { ok: true, portalId, accountType, reason: `account type ${accountType} is a sandbox or test account` };
  if (portalId && !isPlaceholder(config.hubspot.sandboxPortalId) && portalId === config.hubspot.sandboxPortalId) return { ok: true, portalId, accountType, reason: 'portal ID matches HUBSPOT_SANDBOX_PORTAL_ID' };
  return {
    ok: false,
    portalId,
    accountType,
    reason: `SANDBOX_MODE=true, but the connected portal (account type ${accountType || 'unknown'}) is not a sandbox or developer test account and does not match HUBSPOT_SANDBOX_PORTAL_ID. I refuse to continue.`,
  };
}

/** Every property the normalizer reads: the source fields, the country hint and its own outputs (for caching and diffs). */
export function contactPropertiesToRead(config) {
  const names = new Set([config.normalization.countryProperty]);
  for (const field of config.normalization.phoneFields) {
    for (const name of [field.source, field.e164Property, field.lineTypeProperty, field.statusProperty]) names.add(name);
  }
  for (const name of Object.values(config.properties)) names.add(name);
  return [...names].sort();
}

export function buildContactReadRequest(config, contactId) {
  return {
    method: 'GET',
    url: hubspotUrl(config, `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}?properties=${encodeURIComponent(contactPropertiesToRead(config).join(','))}`),
  };
}

/** A missing or malformed contact response becomes { found: false }, so one bad lead never blocks the rest. */
export function parseContactResponse(contactId, body) {
  if (body && typeof body === 'object' && body.id !== undefined && body.properties && typeof body.properties === 'object') {
    return { contactId: String(body.id), found: true, properties: body.properties, error: null };
  }
  const message = body && typeof body === 'object'
    ? (typeof body.error === 'object' && body.error ? body.error.message : body.message || body.error)
    : null;
  return { contactId: String(contactId), found: false, properties: {}, error: String(message || 'contact_not_readable').slice(0, 200) };
}

export function buildContactUpdateRequest(config, contactId, properties) {
  return {
    method: 'PATCH',
    url: hubspotUrl(config, `/crm/v3/objects/contacts/${encodeURIComponent(contactId)}`),
    body: { properties },
  };
}

export function parseContactUpdateResponse(contactId, body) {
  const ok = Boolean(body && typeof body === 'object' && body.id !== undefined && !body.error);
  return { contactId: String(contactId), ok, error: ok ? null : String((body && (body.message || (body.error && body.error.message) || body.error)) || 'update_failed').slice(0, 200) };
}

/* ---------- one-time property setup (scripts/create-properties.js) ---------- */

const LINE_TYPE_OPTIONS = [
  ['Mobile', 'mobile'], ['Landline', 'landline'], ['Fixed VoIP', 'fixed_voip'], ['Non-fixed VoIP', 'non_fixed_voip'],
  ['Toll-free', 'toll_free'], ['Other', 'other'], ['Unknown', 'unknown'],
];
const STATUS_OPTIONS = [['Valid', 'valid'], ['Invalid', 'invalid'], ['Fictional / reserved', 'fictional'], ['Missing', 'missing']];

function enumeration(name, label, options, groupName, description) {
  return { name, label, description, groupName, type: 'enumeration', fieldType: 'select', options: options.map(([optionLabel, value], displayOrder) => ({ label: optionLabel, value, displayOrder })) };
}

export function buildPropertyDefinitions(config, groupName = 'contactinformation') {
  const definitions = [];
  for (const field of config.normalization.phoneFields) {
    definitions.push({ name: field.e164Property, label: `${field.source} (E.164)`, description: `Strict E.164 form of ${field.source}, set by the phone normalizer.`, groupName, type: 'string', fieldType: 'text' });
    definitions.push(enumeration(field.lineTypeProperty, `${field.source} line type`, LINE_TYPE_OPTIONS, groupName, `Carrier line type of ${field.source}.`));
    definitions.push(enumeration(field.statusProperty, `${field.source} normalization status`, STATUS_OPTIONS, groupName, `Format check result for ${field.source}.`));
  }
  const p = config.properties;
  const bool = (name, label, description) => ({ name, label, description, groupName, type: 'enumeration', fieldType: 'booleancheckbox', options: [{ label: 'Yes', value: 'true', displayOrder: 0 }, { label: 'No', value: 'false', displayOrder: 1 }] });
  definitions.push(bool(p.smsEligible, 'Outbound SMS eligible', 'True when at least one number is a line type allowed for SMS. Line type only; consent is checked separately.'));
  definitions.push(bool(p.dialEligible, 'Outbound dial eligible', 'True when at least one number is a line type allowed for dialing.'));
  definitions.push({ name: p.bestSmsNumber, label: 'Best SMS number (E.164)', description: 'First SMS-eligible number in field priority order.', groupName, type: 'string', fieldType: 'phonenumber' });
  definitions.push({ name: p.bestDialNumber, label: 'Best dial number (E.164)', description: 'First dial-eligible number in field priority order.', groupName, type: 'string', fieldType: 'phonenumber' });
  definitions.push({ name: p.carrier, label: 'Phone carrier', description: 'Carrier of the best number, when the lookup returns one.', groupName, type: 'string', fieldType: 'text' });
  definitions.push({ name: p.extension, label: 'Phone extension', description: 'Extension removed from the source number during normalization.', groupName, type: 'string', fieldType: 'text' });
  definitions.push({ name: p.checkedAt, label: 'Phone line type checked at', description: 'When a carrier lookup last ran for this contact.', groupName, type: 'datetime', fieldType: 'date' });
  definitions.push({ name: p.issues, label: 'Phone normalizer issues', description: 'Plain-language notes from the last normalization.', groupName, type: 'string', fieldType: 'textarea' });
  return definitions;
}

export function buildPropertyCreateRequests(config, groupName) {
  return buildPropertyDefinitions(config, groupName).map((body) => ({ method: 'POST', url: hubspotUrl(config, '/crm/v3/properties/contacts'), body }));
}
