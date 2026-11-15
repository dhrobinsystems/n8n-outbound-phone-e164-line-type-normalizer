import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildWorkflow, NODE, serializeWorkflow, WORKFLOW_PATH } from '../scripts/build-workflow.js';
import { runWorkflow } from './n8n-simulator.js';
import { createMockHubSpot, createMockTwilio, DEMO_NOW } from '../src/core/mocks.js';
import { loadNormalizerConfig } from '../src/core/config.js';
import { processContacts, runDemo } from '../src/core/pipeline.js';

const workflow = JSON.parse(readFileSync(WORKFLOW_PATH, 'utf8'));
const SECRET = 'test-secret-value-that-is-long-enough';
const ENV = {
  HUBSPOT_PRIVATE_APP_TOKEN: 'test-hubspot-token',
  WEBHOOK_SECRET: SECRET,
  LOOKUP_PROVIDER: 'twilio',
  TWILIO_ACCOUNT_SID: 'test-account-sid',
  TWILIO_AUTH_TOKEN: 'test-twilio-token',
  LOOKUP_FICTIONAL_NUMBERS: 'true',
  NORMALIZER_NOW: DEMO_NOW,
  AUDIT_WEBHOOK_URL: 'https://audit.example.com/events',
  ALERT_WEBHOOK_URL: 'https://alerts.example.com/hook',
};
const BASIC = `Basic ${Buffer.from('test-account-sid:test-twilio-token').toString('base64')}`;

function services(options = {}) {
  const hubspot = createMockHubSpot({ account: { portalId: 123, accountType: 'SANDBOX' }, ...options.hubspot });
  const twilio = createMockTwilio(options.twilio);
  const posted = [];
  const http = async (request) => {
    if (request.url.startsWith('https://lookups.twilio.com/')) {
      assert.equal(request.headers.Authorization, BASIC, 'Twilio auth is built from $env');
      return twilio.request(request);
    }
    if (request.url.startsWith('https://api.hubapi.com/')) {
      assert.equal(request.headers.Authorization, 'Bearer test-hubspot-token', 'HubSpot auth is built from $env');
      return hubspot.request(request);
    }
    posted.push(request);
    return { status: 200, body: { ok: true } };
  };
  return { hubspot, twilio, posted, http };
}

const webhook = (body, headers = { 'x-webhook-secret': SECRET }) => ({ startNode: NODE.webhook, triggerItems: [{ json: { headers, params: {}, query: {}, body } }] });

test('workflow.json is exactly what the build script produces', () => {
  assert.equal(readFileSync(WORKFLOW_PATH, 'utf8'), serializeWorkflow());
});

test('structure: inactive, executions not saved on success, valid connections, every node reachable', () => {
  assert.equal(workflow.active, false);
  assert.equal(workflow.settings.saveDataSuccessExecution, 'none');
  const names = new Set(workflow.nodes.map((node) => node.name));
  assert.equal(names.size, workflow.nodes.length);
  for (const [source, { main }] of Object.entries(workflow.connections)) {
    assert.ok(names.has(source), source);
    for (const branch of main) for (const connection of branch) assert.ok(names.has(connection.node), connection.node);
  }
  const reachable = new Set();
  const visit = (name) => { if (reachable.has(name)) return; reachable.add(name); for (const branch of (workflow.connections[name] || { main: [] }).main) for (const c of branch) visit(c.node); };
  for (const trigger of [NODE.webhook, NODE.manual, NODE.errorTrigger]) visit(trigger);
  assert.deepEqual(workflow.nodes.map((node) => node.name).filter((name) => !reachable.has(name)), [NODE.note]);
});

test('no embedded credentials or hardcoded endpoint URLs: every HTTP node reads $env or planned requests', () => {
  const text = JSON.stringify(buildWorkflow());
  assert.ok(!/pat-(?:na|eu)\d-/.test(text));
  assert.ok(!/hooks\.slack\.com\/services\/T/.test(text));
  for (const node of workflow.nodes.filter((entry) => entry.type === 'n8n-nodes-base.httpRequest')) {
    assert.match(node.parameters.url, /^=\{\{ (?:\$json\.request\.url|\$env\.[A-Z_]+) \}\}$/, node.name);
    const header = node.parameters.headerParameters && node.parameters.headerParameters.parameters[0];
    if (header) assert.match(header.value, /\$env\./, node.name);
    assert.equal(node.credentials, undefined, `${node.name} has no stored credentials`);
  }
});

test('manual run in demo mode matches the Node.js demo and makes no HTTP calls', async () => {
  const run = await runWorkflow(workflow, { env: {}, http: async () => { throw new Error('demo mode must not call HTTP'); } });
  const mirror = await runDemo({ config: loadNormalizerConfig({}) });
  assert.deepEqual(run.output(NODE.demo)[0].decisions, mirror.decisions);
  const summary = run.output(NODE.finalize)[0];
  assert.equal(summary.counters.smsEligible, 5);
  assert.equal(summary.counters.writesSucceeded, 0);
  assert.equal(summary.today.runs, 1, 'daily metrics live in workflow static data');
});

test('webhook in HubSpot mode with Twilio matches the mirror, responds 202 and writes to the sandbox', async () => {
  const env = { ...ENV, DRY_RUN: 'false' };
  const n8n = services();
  const run = await runWorkflow(workflow, { env, http: n8n.http, ...webhook([{ objectId: 101 }, { objectId: 103 }, { objectId: 111 }, { objectId: 999 }]) });
  const mirror = services();
  const expected = await processContacts({ config: loadNormalizerConfig(env), contactIds: ['101', '103', '111', '999'], hubspotHttp: mirror.hubspot.request, lookupHttp: mirror.twilio.request, now: Date.parse(DEMO_NOW) });

  assert.equal(run.responses[0].statusCode, 202);
  assert.equal(run.responses[0].body.accepted, 4);
  assert.deepEqual(run.output(NODE.decide)[0].decisions, expected.decisions);
  assert.deepEqual(n8n.hubspot.state.contacts, mirror.hubspot.state.contacts, 'HubSpot ends in the same state');
  assert.equal(n8n.twilio.calls.length, 4);
  const audit = n8n.posted.find((request) => request.url === 'https://audit.example.com/events');
  assert.ok(audit, 'audit event delivered');
  assert.ok(!JSON.stringify(audit.body).includes('5555550100'), 'audit event is masked');
  assert.equal(run.output(NODE.finalize)[0].counters.contactsNotFound, 1);
});

test('DRY_RUN reads and looks up but never reaches the update node', async () => {
  const n8n = services();
  const run = await runWorkflow(workflow, { env: ENV, http: n8n.http, ...webhook({ objectId: 101 }) });
  assert.ok(!run.executed.includes(NODE.update));
  assert.equal(n8n.hubspot.calls.filter((call) => call.method === 'PATCH').length, 0);
  assert.equal(n8n.twilio.calls.length, 1);
});

test('the daily lookup budget persists across executions through static data', async () => {
  const staticData = {};
  const env = { ...ENV, MAX_LOOKUPS_PER_DAY: '1' };
  const first = services();
  await runWorkflow(workflow, { env, http: first.http, staticData, ...webhook({ objectId: 101 }) });
  const second = services();
  const run = await runWorkflow(workflow, { env, http: second.http, staticData, ...webhook({ objectId: 109 }) });
  assert.equal(second.twilio.calls.length, 0);
  assert.equal(run.output(NODE.finalize)[0].counters.lookupsSkipped, 1);
  assert.equal(staticData.lookupBudget.used, 1);
});

test('wrong secret gets 401 and stops; misconfiguration gets 503 and fails the execution', async () => {
  const n8n = services();
  const denied = await runWorkflow(workflow, { env: ENV, http: n8n.http, ...webhook({ objectId: 101 }, { 'x-webhook-secret': 'wrong' }) });
  assert.equal(denied.responses[0].statusCode, 401);
  assert.ok(!denied.executed.includes(NODE.route));
  assert.equal(n8n.hubspot.calls.length, 0);

  await assert.rejects(runWorkflow(workflow, { env: { ...ENV, WEBHOOK_SECRET: 'short' }, http: n8n.http, ...webhook({ objectId: 101 }) }), /Configuration invalid/);
});

test('sandbox refusal stops before any contact is read', async () => {
  const n8n = services({ hubspot: { account: { portalId: 9, accountType: 'STANDARD' } } });
  await assert.rejects(runWorkflow(workflow, { env: ENV, http: n8n.http, ...webhook({ objectId: 101 }) }), /SANDBOX_MODE=true, but the connected portal/);
  assert.deepEqual(n8n.hubspot.calls.map((call) => call.path), ['/account-info/v3/details']);
});

test('a failing carrier lookup becomes line type unknown without failing the batch', async () => {
  const n8n = services({ twilio: { failFor: ['+15555550100'] } });
  const run = await runWorkflow(workflow, { env: { ...ENV, DRY_RUN: 'false' }, http: n8n.http, ...webhook([{ objectId: 101 }, { objectId: 109 }]) });
  const decisions = run.output(NODE.decide)[0].decisions;
  assert.equal(decisions[0].fields[0].lineType, 'unknown');
  assert.equal(decisions[0].smsEligible, false);
  assert.equal(decisions[1].outcome, 'sms_ready');
  assert.equal(run.output(NODE.finalize)[0].counters.lookupFailures, 1);
});

test('a failed HubSpot update fails the execution at Finalize after the audit is recorded', async () => {
  const n8n = services({ hubspot: { failUpdatesFor: ['101'] } });
  await assert.rejects(runWorkflow(workflow, { env: { ...ENV, DRY_RUN: 'false' }, http: n8n.http, ...webhook([{ objectId: 101 }, { objectId: 109 }]) }), /1 HubSpot contact update\(s\) failed/);
  assert.ok(n8n.posted.some((request) => request.url === 'https://audit.example.com/events'));
  assert.equal(n8n.hubspot.state.contacts[109].outbound_best_sms_number, '+447700900456', 'successful updates are kept');
});

test('the error branch posts a redacted alert', async () => {
  const n8n = services();
  const failure = { execution: { id: '77', lastNodeExecuted: NODE.lookup, error: { message: 'Auth failed with Basic dGVzdDp0ZXN0 token test-twilio-token for +1 555 555 0100' } }, workflow: { name: workflow.name } };
  const run = await runWorkflow(workflow, { env: ENV, http: n8n.http, startNode: NODE.errorTrigger, triggerItems: [{ json: failure }] });
  assert.ok(run.executed.includes(NODE.sendAlert));
  const alert = n8n.posted.find((request) => request.url === 'https://alerts.example.com/hook');
  const text = JSON.stringify(alert.body);
  for (const fragment of ['dGVzdDp0ZXN0', 'test-twilio-token', '555 0100']) assert.ok(!text.includes(fragment), fragment);
});
