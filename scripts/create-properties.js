#!/usr/bin/env node
/**
 * One-time setup: creates the normalizer's contact properties.
 *
 *   npm run properties:create                       DRY_RUN=true (default): prints the payloads only
 *   DRY_RUN=false npm run properties:create         creates them (SANDBOX_MODE still applies)
 *
 * PROPERTY_GROUP_NAME selects the property group (default: contactinformation).
 * Properties that already exist (HTTP 409) are reported and left unchanged.
 */
import { loadContext } from '../src/index.js';
import { isPlaceholder, validateNormalizerConfig } from '../src/core/config.js';
import { SUPPORTED_COUNTRIES } from '../src/core/phone.js';
import { buildAccountDetailsRequest, buildPropertyCreateRequests, enforceSandbox } from '../src/core/hubspot.js';
import { createHttpClient } from '../src/core/pipeline.js';
import { createMockHubSpot } from '../src/core/mocks.js';

export async function createProperties(context, { log = console.log, http } = {}) {
  const { config, env } = context;
  const { errors } = validateNormalizerConfig(config, { supportedCountries: SUPPORTED_COUNTRIES });
  const blocking = errors.filter((error) => !error.startsWith('WEBHOOK_SECRET'));
  if (blocking.length) throw new Error(`Configuration invalid:\n- ${blocking.join('\n- ')}`);
  const send = http || (config.mode === 'demo' ? createMockHubSpot().request : createHttpClient({ authorization: `Bearer ${config.hubspot.token}`, secrets: [config.hubspot.token] }));
  const account = await send(buildAccountDetailsRequest(config));
  const gate = enforceSandbox(account.body, config);
  if (!gate.ok) throw new Error(gate.reason);
  const groupName = isPlaceholder(env.PROPERTY_GROUP_NAME) ? 'contactinformation' : String(env.PROPERTY_GROUP_NAME).trim();
  const results = [];
  for (const request of buildPropertyCreateRequests(config, groupName)) {
    if (config.dryRun || config.mode === 'demo') {
      log(`[${config.mode === 'demo' ? 'DEMO' : 'DRY RUN'}] would POST /crm/v3/properties/contacts ${JSON.stringify(request.body)}`);
      results.push({ name: request.body.name, outcome: 'planned' });
      continue;
    }
    const response = await send(request);
    const outcome = response.status === 409 ? 'already exists' : response.status >= 200 && response.status < 300 ? 'created' : `failed (${response.status})`;
    log(`${request.body.name}: ${outcome}`);
    results.push({ name: request.body.name, outcome });
  }
  return results;
}

if (process.argv[1] && process.argv[1].endsWith('create-properties.js')) {
  createProperties(loadContext()).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
