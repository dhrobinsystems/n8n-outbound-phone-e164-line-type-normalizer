/**
 * The decision engine: analyses each contact's phone fields, plans carrier lookups (with caching,
 * de-duplication and a daily budget), and decides which HubSpot properties change.
 * Pure functions; the only state is the lookup budget object the caller passes in.
 */
import { usesLiveLookups } from './config.js';
import { normalizePhone, resolveCountry, maskPhone } from './phone.js';
import { buildTwilioLookupRequest, mockTwilioLookup, parseTwilioLookup } from './lineType.js';

const DAY_MS = 86400000;

function text(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

/** Normalises every configured phone field of one contact. */
export function analyzeContact(contact, config) {
  const countryHint = resolveCountry(text(contact.properties[config.normalization.countryProperty]));
  const fields = config.normalization.phoneFields.map((field) => {
    const raw = text(contact.properties[field.source]);
    const normalized = normalizePhone(raw, { defaultCountry: config.normalization.defaultCountry, countryHint });
    return {
      field,
      raw,
      normalized,
      previous: {
        e164: text(contact.properties[field.e164Property]),
        lineType: text(contact.properties[field.lineTypeProperty]),
        status: text(contact.properties[field.statusProperty]),
      },
    };
  });
  return { contactId: contact.contactId, found: contact.found, error: contact.error, countryHint, properties: contact.properties, fields };
}

function cachedLineType(analysis, e164, config, now) {
  if (config.lookup.cacheDays <= 0) return null;
  const checkedAt = Date.parse(text(analysis.properties[config.properties.checkedAt]));
  if (!Number.isFinite(checkedAt) || now - checkedAt > config.lookup.cacheDays * DAY_MS) return null;
  for (const entry of analysis.fields) {
    if (entry.previous.e164 === e164 && entry.previous.lineType && entry.previous.lineType !== 'unknown') {
      return { lineType: entry.previous.lineType, carrier: text(analysis.properties[config.properties.carrier]) || null };
    }
  }
  return null;
}

function utcDay(now) {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Decides, for every distinct number across all contacts, whether to reuse a cached line type,
 * skip the lookup, simulate it (mock provider) or call the carrier API.
 * `budget` ({ day, used }) is mutated so a daily lookup cap holds across executions.
 */
export function planLookups(analyses, config, budget, now) {
  const day = utcDay(now);
  if (budget.day !== day) { budget.day = day; budget.used = 0; }
  const live = usesLiveLookups(config);
  const meta = { cacheHits: {}, skipped: {}, mockResults: {}, budgetDay: day, budgetUsedBefore: budget.used, budgetLimit: config.lookup.maxLookupsPerDay };
  const requests = [];
  const seen = new Set();
  for (const analysis of analyses) {
    if (!analysis.found) continue;
    for (const entry of analysis.fields) {
      const { status, e164 } = entry.normalized;
      if (!e164 || !['valid', 'fictional'].includes(status) || seen.has(e164)) continue;
      seen.add(e164);
      const cached = cachedLineType(analysis, e164, config, now);
      if (cached) { meta.cacheHits[e164] = cached; continue; }
      if (status === 'fictional' && live && !config.lookup.lookupFictionalNumbers) { meta.skipped[e164] = 'fictional_number_not_looked_up'; continue; }
      if (!live) { meta.mockResults[e164] = mockTwilioLookup(e164); continue; }
      if (budget.used >= config.lookup.maxLookupsPerDay) { meta.skipped[e164] = 'daily_lookup_budget_exhausted'; continue; }
      budget.used += 1;
      requests.push({ e164, request: buildTwilioLookupRequest(config, e164) });
    }
  }
  meta.budgetUsedAfter = budget.used;
  return { requests, meta };
}

function resolveLookup(e164, meta, lookupBodies) {
  if (meta.cacheHits[e164]) return { source: 'cache', outcome: 'ok', ...meta.cacheHits[e164] };
  if (meta.skipped[e164]) return { source: 'skipped', outcome: 'skipped', lineType: 'unknown', carrier: null, error: meta.skipped[e164] };
  if (meta.mockResults[e164]) return { source: 'mock', ...parseTwilioLookup(meta.mockResults[e164]) };
  if (Object.prototype.hasOwnProperty.call(lookupBodies, e164)) return { source: 'carrier', ...parseTwilioLookup(lookupBodies[e164]) };
  return { source: 'missing', outcome: 'failed', lineType: 'unknown', carrier: null, error: 'lookup_response_missing' };
}

const ISSUE_TEXT = {
  contains_letters: 'contains letters',
  invalid_characters: 'contains characters that are not part of a phone number',
  misplaced_plus: 'has a misplaced +',
  no_digits: 'has no digits',
  too_short: 'is too short for its country',
  too_long: 'is too long for its country',
  wrong_length: 'does not have 10 digits (North America)',
  invalid_area_code: 'has an invalid area code',
  invalid_exchange: 'has an invalid exchange code',
  unexpected_trunk_prefix: 'has an unexpected trunk prefix',
  reserved_fictional_range: 'is in a reserved fictional range',
  multiple_numbers_in_field: 'held more than one number (the first was used)',
  trunk_prefix_in_international_format: 'had a trunk 0 after the country code (removed)',
  missing_international_prefix: 'was missing its + prefix (added)',
  unrecognised_country_code: 'uses a country code this normalizer has no length rules for',
  carrier_reports_invalid: 'was reported invalid by the carrier',
  fictional_number_not_looked_up: 'was not looked up because it is fictional',
  daily_lookup_budget_exhausted: 'was not looked up because the daily lookup budget is used up',
};

function describe(code) {
  return ISSUE_TEXT[code] || code.replace(/_/g, ' ');
}

/**
 * Decides the target property values for one contact and the subset that actually changes.
 * The checked-at timestamp only moves when a fresh lookup (carrier or mock) ran.
 */
export function decideContact(analysis, meta, lookupBodies, config, now) {
  if (!analysis.found) {
    return { contactId: analysis.contactId, found: false, error: analysis.error, outcome: 'contact_not_found', fields: [], target: {}, changes: {}, write: false };
  }
  const props = config.properties;
  const target = {};
  const issues = [];
  const fields = [];
  let freshLookup = false;
  let extension = null;

  for (const entry of analysis.fields) {
    const { field, normalized } = entry;
    let status = normalized.status;
    let lineType = 'unknown';
    let lookup = null;
    if (normalized.e164 && ['valid', 'fictional'].includes(status)) {
      lookup = resolveLookup(normalized.e164, meta, lookupBodies);
      if (lookup.source === 'carrier' || lookup.source === 'mock') freshLookup = freshLookup || lookup.outcome !== 'failed';
      if (lookup.outcome === 'invalid') status = 'invalid';
      else lineType = lookup.lineType || 'unknown';
      if (lookup.outcome === 'failed') issues.push(`${field.source} line type lookup failed (${lookup.error})`);
      if (lookup.outcome === 'skipped' || lookup.outcome === 'invalid') issues.push(`${field.source} ${describe(lookup.error)}`);
    }
    if (status === 'invalid' && normalized.reason) issues.push(`${field.source} ${describe(normalized.reason)}`);
    if (status === 'fictional') issues.push(`${field.source} ${describe('reserved_fictional_range')}`);
    for (const code of normalized.issues) issues.push(`${field.source} ${describe(code)}`);
    if (!extension && normalized.extension) extension = normalized.extension;

    const e164 = ['valid', 'fictional'].includes(status) ? normalized.e164 : '';
    target[field.e164Property] = e164 || '';
    target[field.lineTypeProperty] = status === 'missing' ? '' : lineType;
    target[field.statusProperty] = status;
    if (config.normalization.overwriteSourceFields && status === 'valid' && normalized.e164 && entry.raw !== normalized.e164 && !normalized.extension) {
      target[field.source] = normalized.e164;
    }
    fields.push({ source: field.source, status, lineType: status === 'missing' ? null : lineType, e164: e164 || null, masked: maskPhone(e164 || entry.raw), lookupSource: lookup ? lookup.source : null, lookupOutcome: lookup ? lookup.outcome : null, carrier: lookup && lookup.outcome === 'ok' ? lookup.carrier || null : null, reason: normalized.reason });
  }

  const usable = fields.filter((entry) => entry.e164);
  const bestSms = usable.find((entry) => config.eligibility.smsLineTypes.includes(entry.lineType)) || null;
  const bestDial = usable.find((entry) => config.eligibility.dialLineTypes.includes(entry.lineType)) || null;
  target[props.smsEligible] = bestSms ? 'true' : 'false';
  target[props.dialEligible] = bestDial ? 'true' : 'false';
  target[props.bestSmsNumber] = bestSms ? bestSms.e164 : '';
  target[props.bestDialNumber] = bestDial ? bestDial.e164 : '';
  const carrierSource = bestSms || bestDial;
  target[props.carrier] = carrierSource && carrierSource.carrier ? carrierSource.carrier : (carrierSource && carrierSource.lookupSource === 'cache' ? text(analysis.properties[props.carrier]) : '');
  target[props.extension] = extension || '';
  const issueText = [...new Set(issues)].join('; ');
  target[props.issues] = issueText.length > 1000 ? `${issueText.slice(0, 997)}...` : issueText;

  const changes = {};
  for (const [name, value] of Object.entries(target)) {
    if (text(analysis.properties[name]) !== text(value)) changes[name] = value;
  }
  if (freshLookup) changes[props.checkedAt] = new Date(now).toISOString();
  const write = Object.keys(changes).length > 0;
  const outcome = !usable.length
    ? (fields.every((entry) => entry.status === 'missing') ? 'no_phone' : 'no_usable_phone')
    : bestSms ? 'sms_ready' : bestDial ? 'dial_only' : 'not_contactable';
  return { contactId: analysis.contactId, found: true, outcome, smsEligible: Boolean(bestSms), dialEligible: Boolean(bestDial), fields, target, changes, write, issues: [...new Set(issues)] };
}

export function decideAll(analyses, meta, lookupBodies, config, now) {
  return analyses.map((analysis) => decideContact(analysis, meta, lookupBodies, config, now));
}
