/**
 * Webhook intake: shared-secret check (constant time), payload parsing and lead extraction.
 * Accepts HubSpot workflow webhooks ({ objectId } / { hs_object_id }), HubSpot app webhook
 * arrays ([{ objectId }]) and plain { contactId } bodies.
 */
import { isPlaceholder } from './config.js';

export function constantTimeEqual(a, b) {
  const left = String(a ?? '');
  const right = String(b ?? '');
  let mismatch = left.length === right.length ? 0 : 1;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    mismatch |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return mismatch === 0;
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return Array.isArray(value) ? String(value[0] ?? '') : String(value ?? '');
  }
  return '';
}

function contactIdOf(entry) {
  if (entry === null || entry === undefined) return null;
  if (typeof entry === 'number' || typeof entry === 'string') return String(entry).trim();
  if (typeof entry !== 'object') return null;
  const nested = entry.properties && entry.properties.hs_object_id;
  const candidates = [entry.contactId, entry.objectId, entry.hs_object_id, entry.vid, entry.id, nested && typeof nested === 'object' ? nested.value : nested];
  const found = candidates.find((value) => value !== undefined && value !== null && String(value).trim() !== '');
  return found === undefined ? null : String(found).trim();
}

export function extractContactIds(body, maxLeads) {
  let entries = body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    if (Array.isArray(body.contactIds)) entries = body.contactIds;
    else if (Array.isArray(body.events)) entries = body.events;
    else entries = [body];
  }
  if (!Array.isArray(entries)) entries = [entries];
  const accepted = [];
  let rejected = 0;
  for (const entry of entries) {
    const id = contactIdOf(entry);
    if (id && /^\d{1,20}$/.test(id)) {
      if (!accepted.includes(id)) accepted.push(id);
    } else {
      rejected += 1;
    }
  }
  const overflow = Math.max(0, accepted.length - maxLeads);
  return { contactIds: accepted.slice(0, maxLeads), rejected: rejected + overflow, overflow };
}

export function newRequestId(now) {
  return `pn-${now.toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Returns { accepted, statusCode, response, contactIds, requestId, configError }.
 * Responses never echo the secret, the payload or any phone number.
 */
export function validateIntake({ headers, body }, config, configErrors, now) {
  const requestIdHeader = headerValue(headers, 'x-request-id');
  const requestId = /^[A-Za-z0-9._-]{6,64}$/.test(requestIdHeader) ? requestIdHeader : newRequestId(now);
  const reply = (statusCode, response, extra = {}) => ({ accepted: false, statusCode, response: { requestId, ...response }, contactIds: [], requestId, configError: false, ...extra });

  if (configErrors.length) return reply(503, { error: 'normalizer_not_configured' }, { configError: true });
  const secretConfigured = !isPlaceholder(config.webhook.secret);
  if (config.mode === 'hubspot' || secretConfigured) {
    if (!constantTimeEqual(headerValue(headers, config.webhook.headerName), config.webhook.secret)) return reply(401, { error: 'unauthorized' });
  }
  let payload = body;
  if (typeof payload === 'string') {
    try { payload = JSON.parse(payload); } catch { return reply(400, { error: 'invalid_json' }); }
  }
  const { contactIds, rejected, overflow } = extractContactIds(payload, config.maxLeadsPerRequest);
  if (!contactIds.length) return reply(400, { error: 'no_contact_ids', rejected });
  return {
    accepted: true,
    statusCode: 202,
    response: { requestId, accepted: contactIds.length, rejected, overflow, mode: config.mode, dryRun: config.dryRun },
    contactIds,
    requestId,
    configError: false,
  };
}
