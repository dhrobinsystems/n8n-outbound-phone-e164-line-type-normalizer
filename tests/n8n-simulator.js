/**
 * A small executor for workflow.json, used by the tests. It runs the real Code node source,
 * evaluates the IF and HTTP Request expressions, follows pagination and paired items, and sends
 * every HTTP request to a caller-supplied handler (normally the in-memory HubSpot mock).
 * It covers only the node types and parameters this workflow uses.
 */
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;

const clone = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));

// n8n adds string helpers such as base64Encode() to expressions; the simulator provides the one this workflow uses.
if (!String.prototype.base64Encode) {
  // eslint-disable-next-line no-extend-native
  Object.defineProperty(String.prototype, 'base64Encode', { value() { return Buffer.from(String(this)).toString('base64'); }, configurable: true });
}

function evaluateJs(source, scope) {
  const names = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  return new Function(...names, `return (${source});`)(...names.map((name) => scope[name]));
}

export function evaluateExpression(value, scope) {
  if (typeof value !== 'string' || !value.startsWith('=')) return value;
  const body = value.slice(1);
  const whole = body.match(/^\{\{([\s\S]*)\}\}$/);
  if (whole) return evaluateJs(whole[1], scope);
  return body.replace(/\{\{([\s\S]*?)\}\}/g, (match, inner) => String(evaluateJs(inner, scope)));
}

export async function runWorkflow(workflow, { env = {}, http, startNode = 'Manual Run', triggerItems = [{ json: {} }], staticData = {} }) {
  const nodes = Object.fromEntries(workflow.nodes.map((node) => [node.name, node]));
  const runs = {};
  const requests = [];
  const responses = [];

  function outputsOf(name) {
    if (!runs[name]) throw new Error(`Node "${name}" has not been executed`);
    return runs[name].output[0] || [];
  }

  function makeDollar(current) {
    return (name) => ({
      get isExecuted() { return Boolean(runs[name]); },
      all: () => outputsOf(name).map((item) => ({ json: clone(item.json) })),
      first: () => {
        const items = outputsOf(name);
        return items.length ? { json: clone(items[0].json) } : undefined;
      },
      itemMatching: (index) => {
        let nodeName = current.parent.name;
        let outputIndex = current.parent.outputIndex;
        let itemIndex = index;
        for (let guard = 0; guard < 100; guard += 1) {
          const item = runs[nodeName].output[outputIndex][itemIndex];
          if (!item) throw new Error(`Paired item ${itemIndex} missing in "${nodeName}"`);
          if (nodeName === name) return { json: clone(item.json) };
          itemIndex = item.pairedItem.item;
          const parent = runs[nodeName].parent;
          if (!parent) throw new Error(`No paired path from "${current.name}" back to "${name}"`);
          nodeName = parent.name;
          outputIndex = parent.outputIndex;
        }
        throw new Error('Paired item walk did not terminate');
      },
    });
  }

  async function runCode(node, input, current) {
    const fn = new AsyncFunction('$input', '$env', '$', '$getWorkflowStaticData', node.parameters.jsCode);
    const $input = {
      all: () => input.map((item) => ({ json: clone(item.json) })),
      first: () => (input.length ? { json: clone(input[0].json) } : undefined),
    };
    const result = await fn($input, env, makeDollar(current), () => staticData);
    if (!Array.isArray(result)) throw new Error(`Code node "${node.name}" must return an array`);
    return [result.map((item, index) => ({ json: clone(item.json), pairedItem: item.pairedItem || { item: Math.min(index, Math.max(0, input.length - 1)) } }))];
  }

  function runIf(node, input) {
    const condition = node.parameters.conditions.conditions[0];
    const yes = [];
    const no = [];
    input.forEach((item, index) => {
      const left = evaluateExpression(condition.leftValue, { $json: item.json, $env: env });
      (left === condition.rightValue ? yes : no).push({ json: item.json, pairedItem: { item: index } });
    });
    return [yes, no];
  }

  async function send(node, request) {
    requests.push({ node: node.name, ...clone(request) });
    const response = await http(request);
    if (!response || response.status < 200 || response.status >= 300) {
      if (node.onError === 'continueRegularOutput') {
        const body = response && response.body && typeof response.body === 'object' ? response.body : {};
        return { status: response ? response.status : 0, body: { error: { status: response ? response.status : 0, message: body.message || 'request failed' } } };
      }
      throw new Error(`HTTP node "${node.name}" received ${response ? response.status : 'no response'}`);
    }
    return response;
  }

  async function runHttp(node, input) {
    const parameters = node.parameters;
    const output = [];
    for (let index = 0; index < input.length; index += 1) {
      const scope = { $json: input[index].json, $env: env };
      const headers = {};
      if (parameters.sendHeaders) for (const header of parameters.headerParameters.parameters) headers[header.name] = evaluateExpression(header.value, scope);
      const url = evaluateExpression(parameters.url, scope);
      const body = parameters.sendBody ? JSON.parse(evaluateExpression(parameters.jsonBody, scope)) : undefined;
      const pagination = parameters.options && parameters.options.pagination && parameters.options.pagination.pagination;
      if (!pagination) {
        const response = await send(node, { method: parameters.method, url, headers, body });
        output.push({ json: response.body, pairedItem: { item: index } });
        continue;
      }
      let after = null;
      for (let page = 0; page < pagination.maxRequests; page += 1) {
        const pageUrl = after ? `${url}${url.includes('?') ? '&' : '?'}after=${encodeURIComponent(after)}` : url;
        const response = await send(node, { method: parameters.method, url: pageUrl, headers, body });
        output.push({ json: response.body, pairedItem: { item: index } });
        const responseScope = { ...scope, $response: { body: response.body, statusCode: response.status } };
        if (evaluateExpression(pagination.completeExpression, responseScope) === true) break;
        after = evaluateExpression(pagination.parameters.parameters[0].value, responseScope);
      }
    }
    return [output];
  }

  async function execute(name, input, parent) {
    const node = nodes[name];
    if (!node) throw new Error(`Unknown node "${name}"`);
    const current = { name, parent };
    let output;
    switch (node.type) {
      case 'n8n-nodes-base.respondToWebhook': {
        const item = input[0];
        const scope = { $json: item.json, $env: env };
        responses.push({ statusCode: Number(evaluateExpression(node.parameters.options.responseCode, scope)), body: JSON.parse(evaluateExpression(node.parameters.responseBody, scope)) });
        output = [input.map((entry, index) => ({ json: clone(entry.json), pairedItem: { item: index } }))];
        break;
      }
      case 'n8n-nodes-base.webhook':
      case 'n8n-nodes-base.manualTrigger':
      case 'n8n-nodes-base.scheduleTrigger':
      case 'n8n-nodes-base.errorTrigger':
        output = [input.map((item) => ({ json: clone(item.json), pairedItem: { item: 0 } }))];
        break;
      case 'n8n-nodes-base.code':
        output = await runCode(node, input, current);
        break;
      case 'n8n-nodes-base.if':
        output = runIf(node, input);
        break;
      case 'n8n-nodes-base.httpRequest':
        output = await runHttp(node, input);
        break;
      default:
        throw new Error(`The simulator does not support ${node.type}`);
    }
    runs[name] = { output, parent };
    const outgoing = (workflow.connections[name] && workflow.connections[name].main) || [];
    for (let outputIndex = 0; outputIndex < outgoing.length; outputIndex += 1) {
      const items = output[outputIndex] || [];
      if (!items.length) continue;
      for (const connection of outgoing[outputIndex]) await execute(connection.node, items, { name, outputIndex });
    }
  }

  await execute(startNode, triggerItems, null);
  return {
    runs,
    requests,
    responses,
    staticData,
    executed: Object.keys(runs),
    output: (name) => (runs[name] ? runs[name].output[0].map((item) => item.json) : null),
  };
}
