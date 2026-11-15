/**
 * Carrier line-type lookups. Request builders and parsers only; the HTTP Request node (n8n) or
 * pipeline.js (Node.js) performs the call. Credentials never appear in a request object: the
 * n8n node builds the Basic auth header from $env at request time.
 *
 * Twilio Lookup v2: GET /v2/PhoneNumbers/{E.164}?Fields=line_type_intelligence
 */

const TWILIO_TYPE_MAP = Object.freeze({
  mobile: 'mobile',
  landline: 'landline',
  fixedVoip: 'fixed_voip',
  nonFixedVoip: 'non_fixed_voip',
  tollFree: 'toll_free',
  personal: 'other',
  premium: 'other',
  sharedCost: 'other',
  uan: 'other',
  voicemail: 'other',
  pager: 'other',
  unknown: 'unknown',
});

export function mapTwilioLineType(type) {
  return TWILIO_TYPE_MAP[type] || 'unknown';
}

export function buildTwilioLookupRequest(config, e164) {
  return {
    method: 'GET',
    url: `${config.lookup.twilio.baseUrl}/v2/PhoneNumbers/${encodeURIComponent(e164)}?Fields=line_type_intelligence`,
  };
}

/**
 * Normalises a Twilio v2 response (or anything else the HTTP node returned) into
 * { outcome: "ok" | "invalid" | "failed", lineType, carrier, countryIso, providerType, error }.
 * Unexpected shapes are treated as failures, never as a line type.
 */
export function parseTwilioLookup(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { outcome: 'failed', lineType: 'unknown', carrier: null, countryIso: null, providerType: null, error: 'empty_response' };
  if (body.error || body.code || body.status >= 400) {
    const message = typeof body.error === 'object' && body.error ? body.error.message : body.message || body.error || body.code;
    return { outcome: 'failed', lineType: 'unknown', carrier: null, countryIso: null, providerType: null, error: String(message || 'lookup_error').slice(0, 200) };
  }
  if (body.valid === false) {
    return { outcome: 'invalid', lineType: 'unknown', carrier: null, countryIso: body.country_code || null, providerType: null, error: Array.isArray(body.validation_errors) && body.validation_errors.length ? body.validation_errors.join(',') : 'carrier_reports_invalid' };
  }
  const intelligence = body.line_type_intelligence;
  if (!intelligence || typeof intelligence !== 'object') return { outcome: 'failed', lineType: 'unknown', carrier: null, countryIso: body.country_code || null, providerType: null, error: 'line_type_intelligence_missing' };
  if (intelligence.error_code !== null && intelligence.error_code !== undefined) {
    return { outcome: 'failed', lineType: 'unknown', carrier: null, countryIso: body.country_code || null, providerType: null, error: `twilio_error_${intelligence.error_code}` };
  }
  return {
    outcome: 'ok',
    lineType: mapTwilioLineType(intelligence.type),
    carrier: intelligence.carrier_name || null,
    countryIso: body.country_code || null,
    providerType: intelligence.type || null,
    error: null,
  };
}

/* ---------- mock provider (demo mode, tests and sandbox dry runs) ---------- */

const MOCK_DIRECTORY = Object.freeze({
  '+15555550100': ['mobile', 'Example Wireless'],
  '+15555550101': ['landline', 'Example Telephone Co.'],
  '+15555550102': ['nonFixedVoip', 'Example VoIP Cloud'],
  '+15555550103': ['fixedVoip', 'Example Business Voice'],
  '+18005550104': ['tollFree', null],
  '+15555550105': ['mobile', 'Example Wireless'],
  '+15555550106': ['mobile', 'Example Wireless'],
  '+442079460018': ['landline', 'Example UK Telecom'],
  '+447700900123': ['mobile', 'Example UK Mobile'],
  '+447700900456': ['mobile', 'Example UK Mobile'],
  '+61491570156': ['mobile', 'Example AU Mobile'],
});

const MOCK_FALLBACK = ['mobile', 'mobile', 'mobile', 'mobile', 'landline', 'landline', 'nonFixedVoip', 'fixedVoip', 'mobile', 'unknown'];

/** Returns a Twilio-shaped body so the same parser handles mock and live responses. */
export function mockTwilioLookup(e164) {
  const entry = MOCK_DIRECTORY[e164] || [MOCK_FALLBACK[Number(e164.slice(-1)) || 0], 'Example Carrier'];
  const [type, carrier] = entry;
  const country = e164.startsWith('+44') ? 'GB' : e164.startsWith('+61') ? 'AU' : e164.startsWith('+1') ? 'US' : null;
  return {
    calling_country_code: null,
    country_code: country,
    phone_number: e164,
    valid: true,
    validation_errors: [],
    line_type_intelligence: { carrier_name: type === 'tollFree' ? null : carrier, error_code: null, mobile_country_code: null, mobile_network_code: null, type },
    url: `mock://lookup/${encodeURIComponent(e164)}`,
  };
}
