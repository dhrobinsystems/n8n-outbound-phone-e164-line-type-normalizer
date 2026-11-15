/**
 * Audit metrics. Events carry counts and masked numbers only (country code + last four digits).
 * Daily buckets are kept for 30 days in whatever state object the caller provides
 * (n8n workflow static data, or a JSON file for the CLI).
 */
import { describeSafety, LINE_TYPES } from './config.js';

const RETENTION_DAYS = 30;

function emptyCounters() {
  const counters = { leads: 0, contactsNotFound: 0, numbersSeen: 0, valid: 0, invalid: 0, fictional: 0, missing: 0, lookupsCarrier: 0, lookupsMock: 0, lookupCacheHits: 0, lookupsSkipped: 0, lookupFailures: 0, smsEligible: 0, dialOnly: 0, notContactable: 0, writesPlanned: 0, writesSucceeded: 0, writesFailed: 0 };
  for (const type of LINE_TYPES) counters[`lineType_${type}`] = 0;
  return counters;
}

export function buildAuditEvent({ requestId, decisions, meta, writeResults, config, now, trigger }) {
  const counters = emptyCounters();
  for (const decision of decisions) {
    counters.leads += 1;
    if (!decision.found) { counters.contactsNotFound += 1; continue; }
    if (decision.outcome === 'sms_ready') counters.smsEligible += 1;
    else if (decision.outcome === 'dial_only') counters.dialOnly += 1;
    else counters.notContactable += 1;
    for (const field of decision.fields) {
      if (field.status === 'missing') { counters.missing += 1; continue; }
      counters.numbersSeen += 1;
      counters[field.status] += 1;
      if (field.lineType) counters[`lineType_${field.lineType}`] += 1;
    }
    if (decision.write) counters.writesPlanned += 1;
  }
  counters.lookupsCarrier = Math.max(0, meta.budgetUsedAfter - meta.budgetUsedBefore);
  counters.lookupsMock = Object.keys(meta.mockResults || {}).length;
  counters.lookupCacheHits = Object.keys(meta.cacheHits || {}).length;
  counters.lookupsSkipped = Object.keys(meta.skipped || {}).length;
  counters.lookupFailures = decisions.reduce((sum, decision) => sum + decision.fields.filter((field) => field.lookupOutcome === 'failed').length, 0);
  for (const result of writeResults) {
    if (result.ok) counters.writesSucceeded += 1;
    else counters.writesFailed += 1;
  }
  return {
    type: 'phone_normalizer.run',
    requestId,
    trigger,
    at: new Date(now).toISOString(),
    safety: describeSafety(config),
    lookupBudget: { day: meta.budgetDay, used: meta.budgetUsedAfter, limit: meta.budgetLimit },
    counters,
    contacts: decisions.map((decision) => ({
      contactId: decision.contactId,
      outcome: decision.found ? decision.outcome : 'contact_not_found',
      written: decision.write ? (config.dryRun ? 'dry_run' : (writeResults.find((result) => result.contactId === decision.contactId) || {}).ok === true ? 'yes' : 'failed') : 'no_change',
      fields: decision.fields.map((field) => ({ source: field.source, status: field.status, lineType: field.lineType, number: field.masked, lookup: field.lookupSource })),
      changedProperties: Object.keys(decision.changes || {}),
    })),
  };
}

/** Adds an event's counters to rolling daily totals and prunes buckets older than 30 days. */
export function recordMetrics(state, event) {
  const store = state.phoneNormalizerMetrics || (state.phoneNormalizerMetrics = { days: {} });
  const day = event.at.slice(0, 10);
  const bucket = store.days[day] || (store.days[day] = { runs: 0, ...emptyCounters() });
  bucket.runs += 1;
  for (const [key, value] of Object.entries(event.counters)) bucket[key] = (bucket[key] || 0) + value;
  const cutoff = new Date(Date.parse(`${day}T00:00:00Z`) - RETENTION_DAYS * 86400000).toISOString().slice(0, 10);
  for (const key of Object.keys(store.days)) if (key < cutoff) delete store.days[key];
  return bucket;
}

const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /Basic\s+[A-Za-z0-9+/=]{8,}/gi,
  /pat-[a-z0-9]+-[A-Za-z0-9-]+/gi,
  /\bAC[0-9a-f]{32}\b/gi,
  /https:\/\/hooks\.slack\.com\/[^\s"']+/gi,
  /\+?\d[\d\s().-]{7,}\d/g,
];

/** Removes tokens, Twilio SIDs, webhook URLs and anything that looks like a phone number. */
export function redactSecrets(value, extraSecrets = []) {
  let output = String(value ?? '');
  for (const secret of extraSecrets) if (secret && String(secret).length >= 6) output = output.split(String(secret)).join('[redacted]');
  for (const pattern of SECRET_PATTERNS) output = output.replace(pattern, '[redacted]');
  return output;
}

export function buildFailureAlert({ errorMessage, lastNode, executionId, workflowName, config, secrets }) {
  const message = redactSecrets(errorMessage || 'Unknown error', secrets).slice(0, 1500);
  const label = config.dryRun || config.sandboxMode ? ' [DRY RUN / SANDBOX]' : '';
  return {
    text: `Phone normalizer failed${label}${lastNode ? ` in "${lastNode}"` : ''}: ${message}`,
    blocks: [
      { type: 'header', text: { type: 'plain_text', text: 'Phone normalizer failed', emoji: true } },
      { type: 'section', text: { type: 'mrkdwn', text: `:x: Node: *${lastNode || 'unknown'}*${label}\n\`\`\`${message}\`\`\`` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `Workflow ${workflowName || 'n8n-outbound-phone-e164-line-type-normalizer'} · execution ${executionId || 'unknown'}` }] },
    ],
  };
}
