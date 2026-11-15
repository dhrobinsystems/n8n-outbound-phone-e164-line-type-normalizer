import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { isPlaceholder, loadNormalizerConfig, readBooleanEnv, validateNormalizerConfig } from '../src/core/config.js';
import { maskPhone, normalizePhone, resolveCountry, SUPPORTED_COUNTRIES } from '../src/core/phone.js';
import { mapTwilioLineType, parseTwilioLookup, buildTwilioLookupRequest } from '../src/core/lineType.js';
import { constantTimeEqual, extractContactIds, validateIntake } from '../src/core/intake.js';
import { analyzeContact, decideContact, planLookups } from '../src/core/normalizer.js';
import { buildPropertyDefinitions, contactPropertiesToRead, enforceSandbox, parseContactResponse } from '../src/core/hubspot.js';
import { buildAuditEvent, buildFailureAlert, recordMetrics, redactSecrets } from '../src/core/audit.js';
import { createMockHubSpot, createMockTwilio, DEMO_NOW } from '../src/core/mocks.js';
import { processContacts, runDemo, runNormalizer, createHttpClient } from '../src/core/pipeline.js';
import { parseDotEnv } from '../src/index.js';

const NOW = Date.parse(DEMO_NOW);
// Built at runtime so the lint secret scan does not flag a fake Twilio SID in source.
const FAKE_SID = `AC${'0123456789abcdef'.repeat(2)}`;
const SECRET = 'test-secret-value-that-is-long-enough';
const LIVE_LOOKUP_ENV = { LOOKUP_PROVIDER: 'twilio', TWILIO_ACCOUNT_SID: 'test-account-sid', TWILIO_AUTH_TOKEN: 'test-twilio-token' };
// Tests only use reserved fictional numbers, so stub-endpoint mode lets them reach the (mock) carrier.
const STUB_LOOKUP_ENV = { ...LIVE_LOOKUP_ENV, LOOKUP_FICTIONAL_NUMBERS: 'true' };
const validate = (config) => validateNormalizerConfig(config, { supportedCountries: SUPPORTED_COUNTRIES });
const parse = (raw, defaultCountry = 'US', countryHint = null) => normalizePhone(raw, { defaultCountry, countryHint });
const contact = (properties, contactId = '1') => ({ contactId, found: true, error: null, properties });

/* ---------- E.164 parsing ---------- */

test('North American formats normalise to +1 and the 555-01XX range is flagged fictional', () => {
  for (const input of ['(555) 555-0100', '555.555.0100', '555 555 0100', '1-555-555-0100', '+1 555 555 0100', '+15555550100', 'tel:+1-555-555-0100', '1 (555) 555-0100']) {
    const result = parse(input);
    assert.equal(result.e164, '+15555550100', input);
    assert.equal(result.status, 'fictional', input);
  }
});

test('international prefixes: +, 00 and 011 from North America', () => {
  assert.equal(parse('00 44 7700 900456').e164, '+447700900456');
  assert.equal(parse('011 44 7700 900456').e164, '+447700900456');
  assert.equal(parse('011 44 7700 900456', 'GB').status, 'invalid', '011 is only an international prefix inside North America');
  assert.equal(parse('+61 491 570 156').countryIso, 'AU');
});

test('trunk prefixes and the (0) convention are removed', () => {
  assert.equal(parse('07700 900123', 'GB').e164, '+447700900123');
  assert.equal(parse('+44 (0)20 7946 0018').e164, '+442079460018');
  assert.equal(parse('+44 020 7946 0018').e164, '+442079460018');
  assert.ok(parse('+44 020 7946 0018').issues.includes('trunk_prefix_in_international_format'));
  assert.equal(parse('0491 570 156', 'US', 'Australia').e164, '+61491570156', 'the contact country overrides the default country');
});

test('extensions are split off and multi-number fields keep the first number', () => {
  const withExtension = parse('555.555.0101 ext. 204');
  assert.equal(withExtension.e164, '+15555550101');
  assert.equal(withExtension.extension, '204');
  assert.equal(parse('+1 555 555 0101 x9').extension, '9');
  assert.equal(parse('+1 555 555 0101 #77').extension, '77');
  const multi = parse('555-555-0100 / 555-555-0101');
  assert.equal(multi.e164, '+15555550100');
  assert.ok(multi.issues.includes('multiple_numbers_in_field'));
});

test('invalid input is rejected with a reason', () => {
  const cases = {
    'call me maybe': 'contains_letters',
    '555-0199': 'wrong_length',
    '(155) 555-0100': 'invalid_area_code',
    '(911) 555-0100': 'invalid_area_code',
    '(555) 155-0100': 'invalid_exchange',
    '555*555*0100': 'invalid_characters',
    '55+5 555 0100': 'misplaced_plus',
    '+44 7700 90': 'too_short',
  };
  for (const [input, reason] of Object.entries(cases)) {
    const result = parse(input);
    assert.equal(result.status, 'invalid', input);
    assert.equal(result.reason, reason, input);
    assert.equal(result.e164, null);
  }
  assert.equal(parse('').status, 'missing');
  assert.equal(parse('   ').status, 'missing');
  assert.equal(parse(null).status, 'missing');
});

test('international numbers typed without + are recovered', () => {
  const result = parse('447700900123', 'US');
  assert.equal(result.e164, '+447700900123');
  assert.ok(result.issues.includes('missing_international_prefix'));
});

test('unknown country codes pass as E.164 with an issue, and E.164 never exceeds 15 digits', () => {
  const unknown = parse('+999 1234 5678');
  assert.equal(unknown.status, 'valid');
  assert.ok(unknown.issues.includes('unrecognised_country_code'));
  assert.equal(parse('+999 1234 5678 9012 34').status, 'invalid');
});

test('country names and aliases resolve to ISO codes', () => {
  assert.equal(resolveCountry('United Kingdom'), 'GB');
  assert.equal(resolveCountry('uk'), 'GB');
  assert.equal(resolveCountry('usa'), 'US');
  assert.equal(resolveCountry('de'), 'DE');
  assert.equal(resolveCountry('Atlantis'), null);
});

test('masking keeps only the country code and last four digits', () => {
  assert.equal(maskPhone('+15555550100'), '+1 ******0100');
  assert.equal(maskPhone('+447700900123'), '+44 ******0123');
  assert.equal(maskPhone('12'), '****');
});

/* ---------- configuration ---------- */

test('boolean switches keep their safe fallback for unrecognised values', () => {
  assert.equal(readBooleanEnv('flase', true), true);
  assert.equal(readBooleanEnv('OFF', true), false);
  assert.equal(isPlaceholder('YOUR_HUBSPOT_TOKEN_HERE'), true);
  assert.equal(isPlaceholder('https://example.com/YOUR_PATH_HERE'), true);
});

test('an empty environment is demo mode with every safety default on', () => {
  const config = loadNormalizerConfig({});
  assert.equal(config.mode, 'demo');
  assert.equal(config.dryRun, true);
  assert.equal(config.sandboxMode, true);
  assert.equal(config.lookup.provider, 'mock');
  assert.deepEqual(validate(config).errors, []);
});

test('live mode refuses placeholders, mock lookups and stub-only switches', () => {
  assert.match(validate(loadNormalizerConfig({ DRY_RUN: 'false', SANDBOX_MODE: 'false' })).errors.join('\n'), /needs a real HUBSPOT_PRIVATE_APP_TOKEN/);
  const live = { HUBSPOT_PRIVATE_APP_TOKEN: 'test-token', WEBHOOK_SECRET: SECRET, DRY_RUN: 'false', SANDBOX_MODE: 'false' };
  assert.match(validate(loadNormalizerConfig(live)).errors.join('\n'), /LOOKUP_PROVIDER=mock returns simulated line types/);
  assert.deepEqual(validate(loadNormalizerConfig({ ...live, ...LIVE_LOOKUP_ENV })).errors, []);
  assert.match(validate(loadNormalizerConfig({ ...live, ...LIVE_LOOKUP_ENV, LOOKUP_FICTIONAL_NUMBERS: 'true' })).errors.join('\n'), /LOOKUP_FICTIONAL_NUMBERS=true is for stub/);
});

test('hubspot mode requires a strong webhook secret and real Twilio credentials when Twilio is chosen', () => {
  const errors = validate(loadNormalizerConfig({ HUBSPOT_PRIVATE_APP_TOKEN: 'test-token', WEBHOOK_SECRET: 'short', LOOKUP_PROVIDER: 'twilio' })).errors.join('\n');
  assert.match(errors, /WEBHOOK_SECRET must be set/);
  assert.match(errors, /needs TWILIO_ACCOUNT_SID and TWILIO_AUTH_TOKEN/);
});

test('bad line types, property names, countries and URLs are rejected', () => {
  const config = loadNormalizerConfig({ SMS_ELIGIBLE_LINE_TYPES: 'mobile,pigeon', DEFAULT_COUNTRY: 'ZZ', AUDIT_WEBHOOK_URL: 'http://example.com/audit', LOOKUP_PROVIDER: 'carrier-pigeon' }, {
    document: { properties: { smsEligible: 'Not Valid', dialEligible: 'phone_e164' } },
  });
  const errors = validate(config).errors.join('\n');
  assert.match(errors, /unknown line types: pigeon/);
  assert.match(errors, /DEFAULT_COUNTRY "ZZ" is not supported/);
  assert.match(errors, /AUDIT_WEBHOOK_URL must use https/);
  assert.match(errors, /LOOKUP_PROVIDER must be one of/);
  assert.match(errors, /"Not Valid" is not a valid HubSpot property name/);
  assert.match(errors, /must be unique/);
});

test('config.example.json loads cleanly and every environment value is a placeholder or safe default', () => {
  const document = JSON.parse(readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
  const { environment, _comment, ...rest } = document;
  const config = loadNormalizerConfig(environment, { document: rest });
  assert.deepEqual(validate(config).errors, []);
  assert.equal(config.mode, 'demo');
  for (const value of Object.values(environment)) {
    assert.ok(isPlaceholder(value) || ['true', 'mock', 'x-webhook-secret', 'https://api.hubapi.com', 'https://lookups.twilio.com'].includes(value), value);
  }
});

/* ---------- intake ---------- */

test('intake: constant-time secret check, payload shapes and de-duplication', () => {
  const config = loadNormalizerConfig({ HUBSPOT_PRIVATE_APP_TOKEN: 'test-token', WEBHOOK_SECRET: SECRET });
  const headers = { 'X-Webhook-Secret': SECRET };
  assert.equal(validateIntake({ headers: {}, body: { objectId: 1 } }, config, [], NOW).statusCode, 401);
  assert.equal(validateIntake({ headers: { 'x-webhook-secret': `${SECRET}x` }, body: { objectId: 1 } }, config, [], NOW).statusCode, 401);
  const ok = validateIntake({ headers, body: [{ objectId: 5 }, { objectId: 5 }, { hs_object_id: '6' }, { properties: { hs_object_id: { value: '7' } } }, { objectId: 'abc' }] }, config, [], NOW);
  assert.equal(ok.statusCode, 202);
  assert.deepEqual(ok.contactIds, ['5', '6', '7']);
  assert.equal(ok.response.rejected, 1);
  assert.equal(validateIntake({ headers, body: '{bad json' }, config, [], NOW).statusCode, 400);
  assert.equal(validateIntake({ headers, body: {} }, config, [], NOW).statusCode, 400);
  assert.equal(validateIntake({ headers, body: { objectId: 1 } }, config, ['broken'], NOW).statusCode, 503);
  assert.ok(!JSON.stringify(ok.response).includes(SECRET));
  assert.equal(constantTimeEqual('abc', 'abc'), true);
  assert.equal(constantTimeEqual('abc', 'abd'), false);
  assert.equal(constantTimeEqual('abc', 'abcd'), false);
});

test('intake caps the number of leads per request', () => {
  const { contactIds, overflow } = extractContactIds({ contactIds: ['1', '2', '3'] }, 2);
  assert.deepEqual(contactIds, ['1', '2']);
  assert.equal(overflow, 1);
});

/* ---------- carrier lookups ---------- */

test('Twilio line types map to the normalizer vocabulary', () => {
  assert.equal(mapTwilioLineType('mobile'), 'mobile');
  assert.equal(mapTwilioLineType('nonFixedVoip'), 'non_fixed_voip');
  assert.equal(mapTwilioLineType('tollFree'), 'toll_free');
  assert.equal(mapTwilioLineType('pager'), 'other');
  assert.equal(mapTwilioLineType('somethingNew'), 'unknown');
});

test('Twilio responses: success, invalid number, package error and unexpected shapes', () => {
  assert.deepEqual(parseTwilioLookup({ valid: true, country_code: 'US', line_type_intelligence: { type: 'mobile', carrier_name: 'Example Wireless', error_code: null } }), { outcome: 'ok', lineType: 'mobile', carrier: 'Example Wireless', countryIso: 'US', providerType: 'mobile', error: null });
  assert.equal(parseTwilioLookup({ valid: false, validation_errors: ['TOO_SHORT'] }).outcome, 'invalid');
  assert.equal(parseTwilioLookup({ valid: true, line_type_intelligence: { type: null, error_code: 60600 } }).error, 'twilio_error_60600');
  assert.equal(parseTwilioLookup({ code: 20003, message: 'Authenticate', status: 401 }).outcome, 'failed');
  assert.equal(parseTwilioLookup({ error: { status: 503, message: 'request failed' } }).outcome, 'failed');
  assert.equal(parseTwilioLookup(null).outcome, 'failed');
  assert.equal(parseTwilioLookup({ valid: true }).error, 'line_type_intelligence_missing');
});

test('lookup requests carry no credentials and URL-encode the number', () => {
  const request = buildTwilioLookupRequest(loadNormalizerConfig(LIVE_LOOKUP_ENV), '+15555550100');
  assert.equal(request.url, 'https://lookups.twilio.com/v2/PhoneNumbers/%2B15555550100?Fields=line_type_intelligence');
  assert.ok(!JSON.stringify(request).includes('test-twilio-token'));
});

/* ---------- decisions ---------- */

test('lookup planning: de-duplication, cache hits, fictional skip and the daily budget', () => {
  const config = loadNormalizerConfig({ ...STUB_LOOKUP_ENV, MAX_LOOKUPS_PER_DAY: '1' });
  const analyses = [
    analyzeContact(contact({ phone: '+1 555 555 0100', mobilephone: '(555) 555-0100' }, '1'), config),
    analyzeContact(contact({ phone: '+44 7700 900123' }, '2'), config),
    analyzeContact(contact({ phone: '+1 555 555 0177', phone_e164: '+15555550177', phone_line_type: 'mobile', outbound_phone_checked_at: '2026-11-01T00:00:00.000Z' }, '3'), config),
    analyzeContact(contact({ phone: '+1 555 555 0111' }, '4'), config),
  ];
  const budget = { day: null, used: 0 };
  const { requests, meta } = planLookups(analyses, config, budget, NOW);
  assert.deepEqual(requests.map((request) => request.e164), ['+15555550100'], 'duplicate numbers are looked up once');
  assert.equal(meta.skipped['+447700900123'], 'daily_lookup_budget_exhausted');
  const strict = loadNormalizerConfig({ ...LIVE_LOOKUP_ENV });
  assert.equal(planLookups([analyses[1]], strict, { day: null, used: 0 }, NOW).meta.skipped['+447700900123'], 'fictional_number_not_looked_up', 'fictional numbers never reach a real carrier');
  assert.equal(meta.cacheHits['+15555550177'].lineType, 'mobile');
  assert.equal(meta.skipped['+15555550111'], 'daily_lookup_budget_exhausted');
  assert.equal(budget.used, 1);
  const nextDay = planLookups([analyses[3]], config, budget, NOW + 86400000);
  assert.equal(nextDay.requests.length, 1, 'the budget resets each UTC day');
});

test('expired cache entries are looked up again', () => {
  const config = loadNormalizerConfig({ ...STUB_LOOKUP_ENV, LOOKUP_CACHE_DAYS: '5' });
  const analysis = analyzeContact(contact({ phone: '+1 555 555 0177', phone_e164: '+15555550177', phone_line_type: 'mobile', outbound_phone_checked_at: '2026-11-01T00:00:00.000Z' }), config);
  assert.equal(planLookups([analysis], config, { day: null, used: 0 }, NOW).requests.length, 1);
});

test('eligibility: SMS only for mobile numbers, best numbers follow field priority', () => {
  const config = loadNormalizerConfig({});
  const analysis = analyzeContact(contact({ phone: '(555) 555-0101', mobilephone: '(555) 555-0100' }), config);
  const { meta } = planLookups([analysis], config, { day: null, used: 0 }, NOW);
  const decision = decideContact(analysis, meta, {}, config, NOW);
  assert.equal(decision.outcome, 'sms_ready');
  assert.equal(decision.target.outbound_best_sms_number, '+15555550100');
  assert.equal(decision.target.outbound_best_dial_number, '+15555550101', 'the phone field comes first for dialing');
  assert.equal(decision.target.outbound_sms_eligible, 'true');
  assert.equal(decision.changes.outbound_phone_checked_at, DEMO_NOW);
});

test('a failed lookup leaves the line type unknown and the number ineligible for SMS', () => {
  const config = loadNormalizerConfig({ ...STUB_LOOKUP_ENV });
  const analysis = analyzeContact(contact({ phone: '+1 555 555 0100' }), config);
  const { meta } = planLookups([analysis], config, { day: null, used: 0 }, NOW);
  const decision = decideContact(analysis, meta, { '+15555550100': { error: { status: 503, message: 'request failed' } } }, config, NOW);
  assert.equal(decision.fields[0].lineType, 'unknown');
  assert.equal(decision.smsEligible, false);
  assert.equal(decision.dialEligible, false);
  assert.equal(decision.changes.outbound_phone_checked_at, undefined, 'a failed lookup does not refresh the cache timestamp');
  assert.match(decision.target.outbound_phone_issues, /line type lookup failed/);
});

test('a number the carrier reports invalid is cleared', () => {
  const config = loadNormalizerConfig({ ...STUB_LOOKUP_ENV });
  const analysis = analyzeContact(contact({ phone: '+1 555 555 0100', phone_e164: '+15555550100' }), config);
  const { meta } = planLookups([analysis], config, { day: null, used: 0 }, NOW);
  const decision = decideContact(analysis, meta, { '+15555550100': { valid: false, validation_errors: ['NOT_A_NUMBER'] } }, config, NOW);
  assert.equal(decision.target.phone_normalization_status, 'invalid');
  assert.equal(decision.changes.phone_e164, '');
});

test('source fields are only overwritten when enabled, and only with valid numbers', () => {
  const overwrite = loadNormalizerConfig({ OVERWRITE_SOURCE_PHONE_FIELDS: 'true' });
  const valid = analyzeContact(contact({ phone: '+999 1234 5678' }), overwrite);
  assert.equal(valid.fields[0].normalized.status, 'valid');
  const plan = planLookups([valid], overwrite, { day: null, used: 0 }, NOW);
  assert.equal(decideContact(valid, plan.meta, {}, overwrite, NOW).changes.phone, '+99912345678');
  assert.equal(decideContact(valid, plan.meta, {}, loadNormalizerConfig({}), NOW).changes.phone, undefined);
  const fictional = analyzeContact(contact({ phone: '(555) 555-0100' }), overwrite);
  const fictionalPlan = planLookups([fictional], overwrite, { day: null, used: 0 }, NOW);
  assert.equal(decideContact(fictional, fictionalPlan.meta, {}, overwrite, NOW).changes.phone, undefined);
});

test('contacts that could not be read are reported, not written', () => {
  const config = loadNormalizerConfig({});
  const decision = decideContact(analyzeContact(parseContactResponse('9', { error: { status: 404, message: 'not found' } }), config), { cacheHits: {}, skipped: {}, mockResults: {} }, {}, config, NOW);
  assert.equal(decision.outcome, 'contact_not_found');
  assert.equal(decision.write, false);
});

/* ---------- HubSpot ---------- */

test('sandbox enforcement and the property list', () => {
  const config = loadNormalizerConfig({ HUBSPOT_PRIVATE_APP_TOKEN: 'test-token', HUBSPOT_SANDBOX_PORTAL_ID: '42' });
  assert.equal(enforceSandbox({ portalId: 1, accountType: 'SANDBOX' }, config).ok, true);
  assert.equal(enforceSandbox({ portalId: 42, accountType: 'STANDARD' }, config).ok, true);
  assert.equal(enforceSandbox({ portalId: 1, accountType: 'STANDARD' }, config).ok, false);
  const properties = contactPropertiesToRead(config);
  for (const name of ['phone', 'mobilephone', 'country', 'phone_e164', 'outbound_phone_checked_at']) assert.ok(properties.includes(name), name);
  const definitions = buildPropertyDefinitions(config);
  assert.equal(definitions.length, 14);
  assert.equal(new Set(definitions.map((definition) => definition.name)).size, 14);
});

/* ---------- audit ---------- */

test('audit events carry masked numbers only, and daily metrics roll up and expire', async () => {
  const state = {};
  const { audit } = await runDemo({ config: loadNormalizerConfig({}), metricsState: state });
  const text = JSON.stringify(audit);
  assert.ok(!text.includes('5555550100'), 'no full numbers');
  assert.ok(text.includes('******0100'));
  assert.equal(audit.counters.leads, 11);
  assert.equal(state.phoneNormalizerMetrics.days['2026-11-16'].runs, 1);
  recordMetrics(state, { ...audit, at: '2027-01-30T00:00:00.000Z' });
  assert.equal(state.phoneNormalizerMetrics.days['2026-11-16'], undefined, 'buckets older than 30 days are pruned');
});

test('redaction removes tokens, SIDs, webhook URLs and phone numbers', () => {
  const output = redactSecrets('Bearer abc.def failed for +1 (555) 555-0100 at https://hooks.slack.com/services/EXAMPLE/X with Basic dGVzdDp0ZXN0 and ' + FAKE_SID, ['my-extra-secret']);
  for (const fragment of ['abc.def', '555-0100', 'hooks.slack.com', 'dGVzdDp0ZXN0', 'AC0123456789']) assert.ok(!output.includes(fragment), fragment);
  assert.equal(redactSecrets('value my-extra-secret here', ['my-extra-secret']), 'value [redacted] here');
  const alert = buildFailureAlert({ errorMessage: 'token test-hubspot-token rejected', config: loadNormalizerConfig({}), secrets: ['test-hubspot-token'] });
  assert.ok(!JSON.stringify(alert).includes('test-hubspot-token'));
  assert.match(alert.text, /DRY RUN \/ SANDBOX/);
});

/* ---------- end to end ---------- */

test('the demo classifies every fictional contact as designed and writes nothing', async () => {
  const { decisions, writeResults, hubspot } = await runDemo({ config: loadNormalizerConfig({}) });
  const outcomes = Object.fromEntries(decisions.map((decision) => [decision.contactId, decision.outcome]));
  assert.deepEqual(outcomes, { 101: 'sms_ready', 102: 'dial_only', 103: 'sms_ready', 104: 'no_usable_phone', 105: 'no_usable_phone', 106: 'dial_only', 107: 'not_contactable', 108: 'sms_ready', 109: 'sms_ready', 110: 'no_phone', 111: 'sms_ready' });
  assert.equal(decisions.find((decision) => decision.contactId === '106').write, false, 'cached and unchanged');
  assert.equal(decisions.find((decision) => decision.contactId === '102').target.outbound_phone_extension, '204');
  assert.equal(writeResults.length, 0);
  assert.equal(hubspot.calls.filter((call) => call.method === 'PATCH').length, 0);
});

test('sandbox writes with Twilio, idempotent second run, and a failed update is reported', async () => {
  const hubspot = createMockHubSpot({ failUpdatesFor: ['103'] });
  const twilio = createMockTwilio();
  const env = { HUBSPOT_PRIVATE_APP_TOKEN: 'test-token', WEBHOOK_SECRET: SECRET, DRY_RUN: 'false', ...STUB_LOOKUP_ENV };
  const config = loadNormalizerConfig(env);
  const budget = { day: null, used: 0 };
  const first = await processContacts({ config, contactIds: ['101', '103', '111'], hubspotHttp: hubspot.request, lookupHttp: twilio.request, now: NOW, budget });
  assert.equal(twilio.calls.length, 4);
  assert.deepEqual(first.writeResults.map((result) => [result.contactId, result.ok]), [['101', true], ['103', false], ['111', true]]);
  assert.equal(first.audit.counters.writesFailed, 1);
  assert.equal(hubspot.state.contacts[101].outbound_best_sms_number, '+15555550100');
  assert.equal(hubspot.state.contacts[101].phone, '(555) 555-0100', 'source fields are untouched by default');

  const second = await processContacts({ config, contactIds: ['101', '111'], hubspotHttp: hubspot.request, lookupHttp: twilio.request, now: NOW + 3600000, budget });
  assert.equal(twilio.calls.length, 4, 'cached line types: no new lookups');
  assert.equal(second.writeResults.length, 0, 'nothing changed');
});

test('runNormalizer refuses production portals in sandbox mode and invalid configuration', async () => {
  const hubspot = createMockHubSpot({ account: { portalId: 9, accountType: 'STANDARD' } });
  const config = loadNormalizerConfig({ HUBSPOT_PRIVATE_APP_TOKEN: 'test-token', WEBHOOK_SECRET: SECRET });
  await assert.rejects(runNormalizer({ config, contactIds: ['101'], hubspotHttp: hubspot.request }), /SANDBOX_MODE=true, but the connected portal/);
  await assert.rejects(runNormalizer({ config: loadNormalizerConfig({ HUBSPOT_PRIVATE_APP_TOKEN: 'test-token' }), contactIds: ['101'] }), /WEBHOOK_SECRET/);
});

test('a batch where no contact can be read stops instead of reporting silence', async () => {
  const hubspot = createMockHubSpot();
  const config = loadNormalizerConfig({ HUBSPOT_PRIVATE_APP_TOKEN: 'test-token', WEBHOOK_SECRET: SECRET });
  await assert.rejects(processContacts({ config, contactIds: ['998', '999'], hubspotHttp: hubspot.request, lookupHttp: async () => ({}), now: NOW }), /No contact could be read/);
});

test('the HTTP client retries 429 and redacts secrets from network errors', async () => {
  let calls = 0;
  const fetchImpl = async (url, init) => {
    calls += 1;
    assert.equal(init.headers.Authorization, 'Bearer test-token');
    if (calls === 1) return { status: 429, headers: { get: () => '0.01' }, text: async () => '{}' };
    return { status: 200, headers: { get: () => null }, text: async () => '{"ok":true}' };
  };
  const send = createHttpClient({ authorization: 'Bearer test-token', fetchImpl, baseDelayMs: 1 });
  assert.deepEqual((await send({ method: 'GET', url: 'https://api.hubapi.com/x' })).body, { ok: true });
  const failing = createHttpClient({ authorization: 'x', fetchImpl: async () => { throw new Error('socket closed for test-token'); }, maxRetries: 0, secrets: ['test-token'] });
  await assert.rejects(failing({ method: 'GET', url: 'https://api.hubapi.com/x' }), (error) => !error.message.includes('test-token'));
});

test('.env parsing handles quotes, comments and export', () => {
  assert.deepEqual(parseDotEnv('# c\nA=1\nexport B="two words"\nC=three # note\n'), { A: '1', B: 'two words', C: 'three' });
});

test('audit events count carrier lookups from the budget delta', () => {
  const event = buildAuditEvent({ requestId: 'r', decisions: [], meta: { budgetUsedBefore: 3, budgetUsedAfter: 5, cacheHits: {}, skipped: {}, mockResults: {} }, writeResults: [], config: loadNormalizerConfig({}), now: NOW, trigger: 'test' });
  assert.equal(event.counters.lookupsCarrier, 2);
});
