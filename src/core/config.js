/**
 * Configuration for the phone normalizer. Every switch fails safe:
 * - DRY_RUN and SANDBOX_MODE stay on unless explicitly set to false/0/no/off.
 * - A placeholder HubSpot token puts the normalizer in demo mode (bundled contacts, no network).
 * - LOOKUP_PROVIDER defaults to "mock", so no paid carrier lookup runs until a provider is chosen.
 * - Live mode (DRY_RUN=false and SANDBOX_MODE=false) refuses to start with placeholders or mock lookups.
 */

export const DEFAULT_HUBSPOT_BASE_URL = 'https://api.hubapi.com';
export const DEFAULT_TWILIO_BASE_URL = 'https://lookups.twilio.com';
export const SANDBOX_ACCOUNT_TYPES = Object.freeze(['SANDBOX', 'DEVELOPER_TEST']);
export const LOOKUP_PROVIDERS = Object.freeze(['mock', 'twilio']);
export const LINE_TYPES = Object.freeze(['mobile', 'landline', 'fixed_voip', 'non_fixed_voip', 'toll_free', 'other', 'unknown']);
export const NORMALIZATION_STATUSES = Object.freeze(['valid', 'invalid', 'fictional', 'missing']);
export const MIN_WEBHOOK_SECRET_LENGTH = 24;

export const DEFAULT_SETTINGS = Object.freeze({
  normalization: {
    defaultCountry: 'US',
    countryProperty: 'country',
    overwriteSourceFields: false,
    phoneFields: [
      { source: 'phone', e164Property: 'phone_e164', lineTypeProperty: 'phone_line_type', statusProperty: 'phone_normalization_status' },
      { source: 'mobilephone', e164Property: 'mobilephone_e164', lineTypeProperty: 'mobilephone_line_type', statusProperty: 'mobilephone_normalization_status' },
    ],
  },
  eligibility: {
    smsLineTypes: ['mobile'],
    dialLineTypes: ['mobile', 'landline', 'fixed_voip', 'non_fixed_voip'],
  },
  properties: {
    smsEligible: 'outbound_sms_eligible',
    dialEligible: 'outbound_dial_eligible',
    bestSmsNumber: 'outbound_best_sms_number',
    bestDialNumber: 'outbound_best_dial_number',
    carrier: 'outbound_phone_carrier',
    extension: 'outbound_phone_extension',
    checkedAt: 'outbound_phone_checked_at',
    issues: 'outbound_phone_issues',
  },
  lookup: {
    provider: 'mock',
    maxLookupsPerDay: 500,
    cacheDays: 90,
  },
  maxLeadsPerRequest: 100,
});

const PLACEHOLDER_PATTERN = /^(?:|your_[a-z0-9_]*_here|changeme|change_me|placeholder|x{3,})$/i;
const EMBEDDED_PLACEHOLDER_PATTERN = /your_[a-z0-9_]*_here/i;
const PROPERTY_NAME_PATTERN = /^[a-z][a-z0-9_]{0,99}$/;

/** True for empty values and template placeholders such as YOUR_HUBSPOT_TOKEN_HERE. */
export function isPlaceholder(value) {
  if (value === undefined || value === null) return true;
  const text = String(value).trim();
  return PLACEHOLDER_PATTERN.test(text) || EMBEDDED_PLACEHOLDER_PATTERN.test(text);
}

/** Only recognised true/false words change a switch; anything else keeps the safe fallback. */
export function readBooleanEnv(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim().toLowerCase();
  if (text === '') return fallback;
  if (['false', '0', 'no', 'off'].includes(text)) return false;
  if (['true', '1', 'yes', 'on'].includes(text)) return true;
  return fallback;
}

function readList(value) {
  if (value === undefined || value === null || String(value).trim() === '' || isPlaceholder(value)) return null;
  return String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
}

function readNumber(raw, fallback, { min, max, integer }, name, problems) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const number = Number(String(raw).trim());
  if (!Number.isFinite(number) || (integer && !Number.isInteger(number)) || number < min || number > max) {
    problems.push(`${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max} (received "${raw}")`);
    return fallback;
  }
  return number;
}

function parseDocument(raw, problems) {
  if (raw === undefined || raw === null || isPlaceholder(raw)) return null;
  try {
    const parsed = JSON.parse(String(raw));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      problems.push('NORMALIZER_CONFIG_JSON must be a JSON object');
      return null;
    }
    return parsed;
  } catch (error) {
    problems.push(`NORMALIZER_CONFIG_JSON is not valid JSON (${error.message})`);
    return null;
  }
}

function pickObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Builds runtime configuration from n8n `$env` or `process.env`.
 * options.document replaces NORMALIZER_CONFIG_JSON (CLI); options.forceMode pins the mode.
 */
export function loadNormalizerConfig(env = {}, options = {}) {
  const source = env || {};
  const problems = [];
  const read = (name) => {
    const value = source[name];
    return value === undefined || value === null ? undefined : String(value);
  };
  const document = options.document !== undefined ? options.document : parseDocument(read('NORMALIZER_CONFIG_JSON'), problems);
  const doc = pickObject(document);
  const docNormalization = pickObject(doc.normalization);
  const docEligibility = pickObject(doc.eligibility);
  const docLookup = pickObject(doc.lookup);

  const phoneFields = Array.isArray(docNormalization.phoneFields) && docNormalization.phoneFields.length
    ? docNormalization.phoneFields.map((field) => ({
      source: String(field.source || '').trim(),
      e164Property: String(field.e164Property || '').trim(),
      lineTypeProperty: String(field.lineTypeProperty || '').trim(),
      statusProperty: String(field.statusProperty || '').trim(),
    }))
    : DEFAULT_SETTINGS.normalization.phoneFields.map((field) => ({ ...field }));

  const token = (read('HUBSPOT_PRIVATE_APP_TOKEN') || '').trim();
  const provider = String(read('LOOKUP_PROVIDER') || docLookup.provider || DEFAULT_SETTINGS.lookup.provider).trim().toLowerCase();

  const config = {
    mode: options.forceMode || (isPlaceholder(token) ? 'demo' : 'hubspot'),
    dryRun: readBooleanEnv(read('DRY_RUN'), true),
    sandboxMode: readBooleanEnv(read('SANDBOX_MODE'), true),
    hubspot: {
      token,
      baseUrl: ((read('HUBSPOT_BASE_URL') || '').trim() || DEFAULT_HUBSPOT_BASE_URL).replace(/\/+$/, ''),
      sandboxPortalId: (read('HUBSPOT_SANDBOX_PORTAL_ID') || '').trim(),
    },
    webhook: {
      secret: (read('WEBHOOK_SECRET') || '').trim(),
      headerName: ((read('WEBHOOK_SECRET_HEADER') || '').trim() || 'x-webhook-secret').toLowerCase(),
    },
    lookup: {
      provider,
      twilio: {
        accountSid: (read('TWILIO_ACCOUNT_SID') || '').trim(),
        authToken: (read('TWILIO_AUTH_TOKEN') || '').trim(),
        baseUrl: ((read('TWILIO_LOOKUP_BASE_URL') || '').trim() || DEFAULT_TWILIO_BASE_URL).replace(/\/+$/, ''),
      },
      lookupFictionalNumbers: readBooleanEnv(read('LOOKUP_FICTIONAL_NUMBERS'), false),
      maxLookupsPerDay: readNumber(read('MAX_LOOKUPS_PER_DAY') ?? docLookup.maxLookupsPerDay, DEFAULT_SETTINGS.lookup.maxLookupsPerDay, { min: 0, max: 1000000, integer: true }, 'MAX_LOOKUPS_PER_DAY', problems),
      cacheDays: readNumber(read('LOOKUP_CACHE_DAYS') ?? docLookup.cacheDays, DEFAULT_SETTINGS.lookup.cacheDays, { min: 0, max: 3650, integer: true }, 'LOOKUP_CACHE_DAYS', problems),
    },
    normalization: {
      defaultCountry: String(read('DEFAULT_COUNTRY') || docNormalization.defaultCountry || DEFAULT_SETTINGS.normalization.defaultCountry).trim().toUpperCase(),
      countryProperty: String(docNormalization.countryProperty || DEFAULT_SETTINGS.normalization.countryProperty).trim(),
      overwriteSourceFields: readBooleanEnv(read('OVERWRITE_SOURCE_PHONE_FIELDS'), docNormalization.overwriteSourceFields === true),
      phoneFields,
    },
    eligibility: {
      smsLineTypes: readList(read('SMS_ELIGIBLE_LINE_TYPES')) || (Array.isArray(docEligibility.smsLineTypes) ? docEligibility.smsLineTypes.map(String) : [...DEFAULT_SETTINGS.eligibility.smsLineTypes]),
      dialLineTypes: readList(read('DIAL_ELIGIBLE_LINE_TYPES')) || (Array.isArray(docEligibility.dialLineTypes) ? docEligibility.dialLineTypes.map(String) : [...DEFAULT_SETTINGS.eligibility.dialLineTypes]),
    },
    properties: { ...DEFAULT_SETTINGS.properties, ...Object.fromEntries(Object.entries(pickObject(doc.properties)).filter(([key, value]) => key in DEFAULT_SETTINGS.properties && typeof value === 'string' && value.trim()).map(([key, value]) => [key, value.trim()])) },
    audit: { webhookUrl: (read('AUDIT_WEBHOOK_URL') || '').trim() },
    alerts: { webhookUrl: (read('ALERT_WEBHOOK_URL') || '').trim() },
    maxLeadsPerRequest: readNumber(read('MAX_LEADS_PER_REQUEST') ?? doc.maxLeadsPerRequest, DEFAULT_SETTINGS.maxLeadsPerRequest, { min: 1, max: 1000, integer: true }, 'MAX_LEADS_PER_REQUEST', problems),
    manualTestContactIds: readList(read('MANUAL_TEST_CONTACT_IDS')) || [],
    nowOverride: (read('NORMALIZER_NOW') || '').trim() || null,
    problems,
  };
  if (config.nowOverride && !Number.isFinite(Date.parse(config.nowOverride))) problems.push(`NORMALIZER_NOW must be an ISO 8601 timestamp (received "${config.nowOverride}")`);
  return config;
}

export function isLiveMode(config) {
  return !config.dryRun && !config.sandboxMode;
}

export function usesLiveLookups(config) {
  return config.lookup.provider !== 'mock';
}

export function resolveNow(config) {
  const parsed = config.nowOverride ? Date.parse(config.nowOverride) : NaN;
  return Number.isFinite(parsed) ? parsed : Date.now();
}

export function describeSafety(config) {
  return {
    mode: config.mode,
    dryRun: config.dryRun,
    sandboxMode: config.sandboxMode,
    lookupProvider: config.lookup.provider,
    writesPossible: config.mode === 'hubspot' && !config.dryRun,
  };
}

function usableHttpsUrl(url) {
  return !isPlaceholder(url) && /^https:\/\/[^\s]+$/.test(url);
}

export function auditEnabled(config) {
  return usableHttpsUrl(config.audit.webhookUrl);
}

export function alertsEnabled(config) {
  return usableHttpsUrl(config.alerts.webhookUrl);
}

/** Returns { errors, warnings }. Any error stops the workflow before it touches HubSpot or a carrier API. */
export function validateNormalizerConfig(config, { supportedCountries = null } = {}) {
  const errors = [...config.problems];
  const warnings = [];
  const live = isLiveMode(config);

  if (!LOOKUP_PROVIDERS.includes(config.lookup.provider)) errors.push(`LOOKUP_PROVIDER must be one of ${LOOKUP_PROVIDERS.join(', ')}`);
  if (config.lookup.provider === 'twilio') {
    if (isPlaceholder(config.lookup.twilio.accountSid) || isPlaceholder(config.lookup.twilio.authToken)) errors.push('LOOKUP_PROVIDER=twilio needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN (or set LOOKUP_PROVIDER=mock)');
    if (!/^https:\/\//.test(config.lookup.twilio.baseUrl)) errors.push('TWILIO_LOOKUP_BASE_URL must use https://');
  }
  if (supportedCountries && !supportedCountries.includes(config.normalization.defaultCountry)) errors.push(`DEFAULT_COUNTRY "${config.normalization.defaultCountry}" is not supported (supported: ${supportedCountries.join(', ')})`);

  for (const [name, list] of [['SMS_ELIGIBLE_LINE_TYPES', config.eligibility.smsLineTypes], ['DIAL_ELIGIBLE_LINE_TYPES', config.eligibility.dialLineTypes]]) {
    const unknown = list.filter((type) => !LINE_TYPES.includes(type));
    if (unknown.length) errors.push(`${name} contains unknown line types: ${unknown.join(', ')} (allowed: ${LINE_TYPES.join(', ')})`);
  }
  if (config.eligibility.smsLineTypes.some((type) => ['landline', 'unknown'].includes(type))) warnings.push('SMS_ELIGIBLE_LINE_TYPES includes landline or unknown numbers; SMS to those usually fails.');

  const names = [];
  for (const field of config.normalization.phoneFields) {
    for (const key of ['source', 'e164Property', 'lineTypeProperty', 'statusProperty']) {
      if (!PROPERTY_NAME_PATTERN.test(field[key])) errors.push(`phoneFields entry "${field.source || '?'}": ${key} "${field[key]}" is not a valid HubSpot property name`);
    }
    names.push(field.e164Property, field.lineTypeProperty, field.statusProperty);
  }
  for (const [key, name] of Object.entries(config.properties)) {
    if (!PROPERTY_NAME_PATTERN.test(name)) errors.push(`properties.${key} "${name}" is not a valid HubSpot property name`);
    names.push(name);
  }
  const duplicates = names.filter((name, index) => names.indexOf(name) !== index);
  if (duplicates.length) errors.push(`output property names must be unique (duplicated: ${[...new Set(duplicates)].join(', ')})`);
  const sources = config.normalization.phoneFields.map((field) => field.source);
  const clobbered = sources.filter((name) => names.includes(name));
  if (clobbered.length) errors.push(`an output property may not be a source phone field (${clobbered.join(', ')})`);

  for (const [name, url] of [['AUDIT_WEBHOOK_URL', config.audit.webhookUrl], ['ALERT_WEBHOOK_URL', config.alerts.webhookUrl]]) {
    if (!isPlaceholder(url) && !/^https:\/\//.test(url)) errors.push(`${name} must use https://`);
  }

  if (config.mode === 'demo') {
    if (live) errors.push('Live mode (DRY_RUN=false and SANDBOX_MODE=false) needs a real HUBSPOT_PRIVATE_APP_TOKEN. Replace the placeholder or turn DRY_RUN back on.');
    warnings.push('HUBSPOT_PRIVATE_APP_TOKEN is a placeholder, so the normalizer runs against bundled demo contacts and makes no HubSpot calls.');
    return { errors, warnings };
  }

  if (!/^https:\/\//.test(config.hubspot.baseUrl)) errors.push('HUBSPOT_BASE_URL must use https://');
  if (isPlaceholder(config.webhook.secret) || config.webhook.secret.length < MIN_WEBHOOK_SECRET_LENGTH) errors.push(`WEBHOOK_SECRET must be set to a random value of at least ${MIN_WEBHOOK_SECRET_LENGTH} characters`);
  if (!isPlaceholder(config.hubspot.sandboxPortalId) && !/^\d+$/.test(config.hubspot.sandboxPortalId)) errors.push('HUBSPOT_SANDBOX_PORTAL_ID must be numeric when set');
  if (!usesLiveLookups(config)) {
    if (!config.dryRun) {
      const message = 'LOOKUP_PROVIDER=mock returns simulated line types. Writing those into HubSpot is only allowed while SANDBOX_MODE=true.';
      if (!config.sandboxMode) errors.push(message);
      else warnings.push(`${message} The sandbox portal will receive simulated values.`);
    }
  }
  if (config.lookup.lookupFictionalNumbers && live) errors.push('LOOKUP_FICTIONAL_NUMBERS=true is for stub or test lookup endpoints only and is not allowed in live mode');
  if (live && !alertsEnabled(config)) warnings.push('Live mode without ALERT_WEBHOOK_URL: failures are only visible in the n8n execution log.');
  return { errors, warnings };
}
