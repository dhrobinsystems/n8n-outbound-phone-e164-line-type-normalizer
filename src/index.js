#!/usr/bin/env node
/**
 * Command-line runner (the Node.js mirror of workflow.json).
 *
 *   node src/index.js normalize "+44 (0)20 7946 0018" [--country GB]   offline E.164 check, no lookup
 *   node src/index.js demo [--json]                                  bundled fictional contacts
 *   node src/index.js run --contacts 101,102 [--json]                 process HubSpot contacts
 *   node src/index.js serve [--port 8787]                             local webhook (POST /webhook)
 *
 * Variables come from the shell, then .env, then the "environment" block of config.json.
 * The lookup budget and daily metrics persist in data/state.json.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isPlaceholder, loadNormalizerConfig, resolveNow, validateNormalizerConfig } from './core/config.js';
import { maskPhone, normalizePhone, SUPPORTED_COUNTRIES } from './core/phone.js';
import { validateIntake } from './core/intake.js';
import { runNormalizer } from './core/pipeline.js';

export function parseDotEnv(text) {
  const values = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '');
    values[match[1]] = value;
  }
  return values;
}

export function loadContext({ cwd = process.cwd(), baseEnv = process.env, configPath = null } = {}) {
  const dotEnvPath = resolve(cwd, '.env');
  const dotEnv = existsSync(dotEnvPath) ? parseDotEnv(readFileSync(dotEnvPath, 'utf8')) : {};
  const path = configPath ? resolve(cwd, configPath) : resolve(cwd, 'config.json');
  let fileEnvironment = {};
  let document;
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    fileEnvironment = parsed.environment || {};
    const { environment, _comment, ...rest } = parsed;
    document = rest;
  } else if (configPath) {
    throw new Error(`Config file not found: ${path}`);
  }
  const env = { ...fileEnvironment, ...dotEnv, ...baseEnv };
  const useDocument = document && isPlaceholder(env.NORMALIZER_CONFIG_JSON);
  return { env, config: loadNormalizerConfig(env, useDocument ? { document } : {}), statePath: resolve(cwd, 'data', 'state.json') };
}

export function loadState(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return { lookupBudget: { day: null, used: 0 } }; }
}

export function saveState(path, state) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`);
}

function option(argv, name) {
  const index = argv.indexOf(name);
  return index >= 0 ? argv[index + 1] : null;
}

function printDecisions(result, log) {
  for (const decision of result.decisions) {
    if (!decision.found) { log(`${decision.contactId.padEnd(8)} contact not found (${decision.error})`); continue; }
    const fields = decision.fields.map((field) => `${field.source}=${field.status}${field.lineType ? `/${field.lineType}` : ''}${field.masked ? ` ${field.masked}` : ''}`).join('  ');
    log(`${decision.contactId.padEnd(8)} ${decision.outcome.padEnd(16)} ${decision.write ? 'changes' : 'no change'}  ${fields}`);
  }
  const c = result.audit.counters;
  log(`\n${c.leads} lead(s): ${c.smsEligible} SMS-ready, ${c.dialOnly} dial-only, ${c.notContactable} not contactable, ${c.contactsNotFound} not found`);
  log(`Lookups: ${c.lookupsCarrier} carrier, ${c.lookupsMock} mock, ${c.lookupCacheHits} cached, ${c.lookupsSkipped} skipped, ${c.lookupFailures} failed`);
  log(`Writes: ${c.writesPlanned} planned, ${c.writesSucceeded} written, ${c.writesFailed} failed${result.audit.safety.dryRun ? ' (DRY_RUN: nothing written)' : ''}`);
}

async function runBatch(context, contactIds, { json, log, trigger }) {
  const state = loadState(context.statePath);
  state.lookupBudget = state.lookupBudget || { day: null, used: 0 };
  const result = await runNormalizer({ config: context.config, contactIds, budget: state.lookupBudget, metricsState: state, requestId: `cli-${Date.now().toString(36)}`, trigger });
  if (context.config.mode !== 'demo') saveState(context.statePath, state);
  if (json) log(JSON.stringify({ decisions: result.decisions, audit: result.audit, writeResults: result.writeResults }, null, 2));
  else printDecisions(result, log);
  return result;
}

export function startServer(context, { port = 8787, log = console.log } = {}) {
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/webhook') { response.writeHead(404).end(); return; }
    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => { size += chunk.length; if (size <= 1_000_000) chunks.push(chunk); });
    request.on('end', () => {
      const { errors } = validateNormalizerConfig(context.config, { supportedCountries: SUPPORTED_COUNTRIES });
      if (size > 1_000_000) { response.writeHead(413, { 'Content-Type': 'application/json' }).end('{"error":"payload_too_large"}'); return; }
      const intake = validateIntake({ headers: request.headers, body: Buffer.concat(chunks).toString('utf8') }, context.config, errors, resolveNow(context.config));
      response.writeHead(intake.statusCode, { 'Content-Type': 'application/json' }).end(JSON.stringify(intake.response));
      if (!intake.accepted) { if (intake.configError) log(`Rejected request: configuration invalid:\n- ${errors.join('\n- ')}`); return; }
      runBatch(context, intake.contactIds, { json: false, log, trigger: 'webhook' }).catch((error) => log(`Request ${intake.requestId} failed: ${error.message}`));
    });
  });
  server.listen(port, () => log(`Listening on http://localhost:${port}/webhook (${context.config.mode} mode, DRY_RUN=${context.config.dryRun})`));
  return server;
}

export async function main(argv = process.argv.slice(2), { log = console.log, errorLog = console.error } = {}) {
  const command = argv[0] || 'demo';
  const json = argv.includes('--json');
  try {
    const context = loadContext({ configPath: option(argv, '--config') });
    if (command === 'normalize') {
      const input = argv[1];
      if (!input) throw new Error('Usage: node src/index.js normalize "<phone number>" [--country GB]');
      const parsed = normalizePhone(input, { defaultCountry: context.config.normalization.defaultCountry, countryHint: option(argv, '--country') });
      log(JSON.stringify({ ...parsed, input: undefined, masked: maskPhone(parsed.e164 || input) }, null, 2));
      return parsed.status === 'invalid' ? 2 : 0;
    }
    if (command === 'demo') {
      const demoContext = { ...context, config: loadNormalizerConfig({ ...context.env, HUBSPOT_PRIVATE_APP_TOKEN: '' }, { forceMode: 'demo' }) };
      await runBatch(demoContext, null, { json, log, trigger: 'demo' });
      return 0;
    }
    if (command === 'run') {
      const ids = String(option(argv, '--contacts') || '').split(',').map((id) => id.trim()).filter(Boolean);
      if (!ids.length && context.config.mode !== 'demo') throw new Error('Usage: node src/index.js run --contacts 123,456');
      for (const warning of validateNormalizerConfig(context.config, { supportedCountries: SUPPORTED_COUNTRIES }).warnings) errorLog(`warning: ${warning}`);
      await runBatch(context, ids, { json, log, trigger: 'cli' });
      return 0;
    }
    if (command === 'serve') {
      startServer(context, { port: Number(option(argv, '--port')) || 8787, log });
      return null;
    }
    throw new Error(`Unknown command "${command}". Use normalize, demo, run or serve.`);
  } catch (error) {
    errorLog(error.message);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().then((code) => { if (code !== null) process.exitCode = code; });
}
