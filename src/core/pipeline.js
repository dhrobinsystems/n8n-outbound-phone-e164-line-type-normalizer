/**
 * Node.js mirror of workflow.json: the same functions in the same order as the n8n nodes.
 */
import { resolveNow, usesLiveLookups, validateNormalizerConfig } from './config.js';
import { SUPPORTED_COUNTRIES } from './phone.js';
import { analyzeContact, decideAll, planLookups } from './normalizer.js';
import { buildAccountDetailsRequest, buildContactReadRequest, buildContactUpdateRequest, enforceSandbox, parseContactResponse, parseContactUpdateResponse } from './hubspot.js';
import { buildAuditEvent, recordMetrics, redactSecrets } from './audit.js';
import { createMockHubSpot, DEMO_NOW } from './mocks.js';

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

export function basicAuthHeader(accountSid, authToken) {
  return `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`;
}

/**
 * fetch wrapper with retries on 429/5xx (Retry-After honoured). Returns { status, body } for every
 * response, so callers decide how to treat 4xx answers.
 */
export function createHttpClient({ authorization, fetchImpl = globalThis.fetch, maxRetries = 3, baseDelayMs = 1000, secrets = [] }) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch is not available. Use Node.js 20 or newer.');
  return async function send(req) {
    for (let attempt = 0; ; attempt += 1) {
      let response;
      try {
        response = await fetchImpl(req.url, {
          method: req.method,
          headers: { Authorization: authorization, Accept: 'application/json', ...(req.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          body: req.body === undefined ? undefined : JSON.stringify(req.body),
        });
      } catch (error) {
        if (attempt < maxRetries) { await sleep(baseDelayMs * 2 ** attempt); continue; }
        throw new Error(redactSecrets(`Request to ${new URL(req.url).host} failed: ${error.message}`, secrets));
      }
      const raw = await response.text();
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = { message: raw.slice(0, 200) }; }
      if ((response.status === 429 || response.status >= 500) && attempt < maxRetries) {
        const retryAfter = Number(response.headers && response.headers.get ? response.headers.get('retry-after') : NaN);
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : baseDelayMs * 2 ** attempt);
        continue;
      }
      return { status: response.status, body };
    }
  };
}

function unwrap(response) {
  if (response.status >= 200 && response.status < 300) return response.body;
  const body = response.body && typeof response.body === 'object' ? response.body : {};
  return { error: { status: response.status, message: body.message || `HTTP ${response.status}` } };
}

/**
 * Processes a batch of contact IDs end to end.
 * hubspotHttp and lookupHttp resolve to { status, body }. budget is { day, used } and is mutated.
 */
export async function processContacts({ config, contactIds, hubspotHttp, lookupHttp, now, budget = { day: null, used: 0 }, metricsState = null, requestId = 'local', trigger = 'cli' }) {
  const accountResponse = await hubspotHttp(buildAccountDetailsRequest(config));
  if (accountResponse.status < 200 || accountResponse.status >= 300) throw new Error(`HubSpot account check failed with ${accountResponse.status}`);
  const gate = enforceSandbox(accountResponse.body, config);
  if (!gate.ok) throw new Error(gate.reason);

  const contacts = [];
  for (const contactId of contactIds) {
    contacts.push(parseContactResponse(contactId, unwrap(await hubspotHttp(buildContactReadRequest(config, contactId)))));
  }
  if (contacts.length && contacts.every((contact) => !contact.found)) {
    throw new Error(`No contact could be read (first error: ${contacts[0].error}). Check the token scopes and the contact IDs.`);
  }

  const analyses = contacts.map((contact) => analyzeContact(contact, config));
  const { requests, meta } = planLookups(analyses, config, budget, now);
  const lookupBodies = {};
  for (const plan of requests) lookupBodies[plan.e164] = unwrap(await lookupHttp(plan.request));

  const decisions = decideAll(analyses, meta, lookupBodies, config, now);
  const writeResults = [];
  if (!config.dryRun) {
    for (const decision of decisions.filter((entry) => entry.write)) {
      const request = buildContactUpdateRequest(config, decision.contactId, decision.changes);
      writeResults.push(parseContactUpdateResponse(decision.contactId, unwrap(await hubspotHttp(request))));
    }
  }
  const audit = buildAuditEvent({ requestId, decisions, meta, writeResults, config, now, trigger });
  if (metricsState) recordMetrics(metricsState, audit);
  return { portal: { portalId: gate.portalId, accountType: gate.accountType }, decisions, meta, writeResults, audit };
}

/** Demo mode: bundled contacts behind the HubSpot mock, mock line types, fixed clock. */
export async function runDemo({ config, contactIds = null, metricsState = null, requestId = 'demo', trigger = 'demo' }) {
  const hubspot = createMockHubSpot();
  const ids = contactIds && contactIds.length ? contactIds : Object.keys(hubspot.state.contacts);
  const result = await processContacts({
    config,
    contactIds: ids,
    hubspotHttp: hubspot.request,
    lookupHttp: async () => { throw new Error('demo mode never calls a carrier API'); },
    now: Date.parse(DEMO_NOW),
    metricsState,
    requestId,
    trigger,
  });
  return { ...result, hubspot };
}

/** Runs a batch with real HTTP clients (or injected ones), after validating configuration. */
export async function runNormalizer({ config, contactIds, fetchImpl = globalThis.fetch, budget, metricsState, hubspotHttp, lookupHttp, requestId, trigger = 'cli' }) {
  const { errors } = validateNormalizerConfig(config, { supportedCountries: SUPPORTED_COUNTRIES });
  if (errors.length) throw new Error(`Configuration invalid:\n- ${errors.join('\n- ')}`);
  if (config.mode === 'demo') return runDemo({ config, contactIds, metricsState, requestId, trigger });
  const secrets = [config.hubspot.token, config.lookup.twilio.authToken];
  return processContacts({
    config,
    contactIds,
    hubspotHttp: hubspotHttp || createHttpClient({ authorization: `Bearer ${config.hubspot.token}`, fetchImpl, secrets }),
    lookupHttp: lookupHttp || (usesLiveLookups(config)
      ? createHttpClient({ authorization: basicAuthHeader(config.lookup.twilio.accountSid, config.lookup.twilio.authToken), fetchImpl, secrets })
      : async () => { throw new Error('mock provider never calls a carrier API'); }),
    now: resolveNow(config),
    budget,
    metricsState,
    requestId,
    trigger,
  });
}
