import { createHash } from 'node:crypto';

export const workflowTasks = ['transform-video', 'control-video', 'first-frame', 'passthrough'];
export const outputMediaTypes = ['image/png', 'video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'];
const semantics = ['sourceVideo', 'controlVideo', 'firstFrame', 'lastFrame', 'referenceImage', 'image', 'prompt', 'audio'];
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const has = (value, key) => Object.hasOwn(value, key);
const fail = message => { throw Error(message); };
const stable = value => Array.isArray(value) ? value.map(stable) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export const hashValue = value => createHash('sha256').update(JSON.stringify(stable(value))).digest('hex');
export const hashBytes = bytes => createHash('sha256').update(bytes).digest('hex');
const freeze = value => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

// Reject, never redact an authored graph: redaction could silently change execution.
export function assertNoSecrets(value) {
  const secrets = Object.entries(process.env).filter(([key, val]) => /(?:key|token|secret|password)/i.test(key) && val?.length >= 12).map(([, val]) => val);
  function visit(item) {
    if (typeof item === 'string') {
      if (/\b(?:Bearer\s+\S+|sk-[\w-]{16,}|hf_[\w]{16,}|gh[pousr]_[\w]{16,}|-----BEGIN [\w ]*PRIVATE KEY-----)/i.test(item) || secrets.some(secret => item.includes(secret))) fail('Literal credentials are forbidden in saved workflows and requests');
      if (/(?:[?&](?:api[_-]?key|token|access_token|signature|x-amz-signature|x-goog-signature)=|https?:\/\/[^/\s]+:[^/\s]+@)/i.test(item)) fail('Credential-bearing URLs are forbidden in saved workflows and requests');
    } else if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) {
        if (/^(?:__proto__|prototype|constructor)$/i.test(key) || /^(?:.*[_-])?(?:api[_-]?key(?:_comfy_org)?|auth(?:orization)?|auth_token(?:_comfy_org)?|access_token|refresh_token|private_key|password|secrets?|credentials?|token|cookie)$/i.test(key) || /^(?:apiKey|accessToken|authToken|clientSecret|privateKey)$/i.test(key)) fail('Credential keys are forbidden in saved workflows and requests');
        visit(child);
      }
    }
  }
  visit(value);
  return value;
}

function graphShape(graph) {
  if (!object(graph) || !Object.keys(graph).length || Object.keys(graph).length > 2000 || JSON.stringify(graph).length > 2_000_000) fail('Expected an API-format graph under 2 MB with 1–2000 nodes');
  assertNoSecrets(graph);
  for (const [id, node] of Object.entries(graph)) {
    if (!/^[\w:-]{1,128}$/.test(id) || !object(node) || typeof node.class_type !== 'string' || !node.class_type || !object(node.inputs)) fail('Each API graph node needs an ID, class_type and inputs object');
  }
}

export function validateWorkflowDefinition(input) {
  assertNoSecrets(input);
  if (!object(input) || input.version !== 1 || typeof input.id !== 'string' || !input.id || !workflowTasks.includes(input.task)) fail('WorkflowDefinition needs version 1, an id and a supported task');
  graphShape(input.graph);
  const result = structuredClone(input);
  delete result.graphHash; delete result.definitionHash;
  result.inputs ||= {}; result.parameters ||= {}; result.constraints ||= {};
  result.backendRequirements ||= {}; result.pricing ||= { status: 'unknown' }; result.provenance ||= {};
  result.verification ||= { status: 'imported' };
  if (!['imported', 'schema-compatible', 'executed', 'visually-reviewed'].includes(result.verification.status)) fail('Invalid workflow verification status');
  if (![result.inputs, result.parameters, result.constraints, result.backendRequirements, result.pricing, result.provenance].every(object)) fail('Workflow mappings and metadata must be objects');
  const targets = new Set();
  for (const [name, mapping] of [...Object.entries(result.inputs), ...Object.entries(result.parameters)]) {
    if (!object(mapping) || typeof mapping.nodeId !== 'string' || !has(result.graph, mapping.nodeId) || typeof mapping.input !== 'string' || !mapping.input) fail(`Invalid mapping ${name}: select an existing node and input`);
    const key = `${mapping.nodeId}/${mapping.input}`;
    if (targets.has(key)) fail(`Duplicate mapping target ${key}`);
    targets.add(key);
  }
  if (Object.keys(result.inputs).some(name => !semantics.includes(name))) fail('Unknown semantic input mapping');
  if (result.task === 'transform-video' && !result.inputs.sourceVideo) fail('transform-video requires sourceVideo');
  if (result.task === 'control-video' && (!result.inputs.controlVideo || typeof result.inputs.controlVideo.pass !== 'string' || !result.inputs.controlVideo.pass)) fail('control-video requires an explicit controlVideo pass');
  if (result.task === 'first-frame' && !result.inputs.firstFrame) fail('first-frame requires firstFrame');
  if (!Array.isArray(result.outputs) || !result.outputs.length || result.outputs.length > 32 || result.outputs.some(output => !has(result.graph, output.nodeId) || !outputMediaTypes.includes(output.mediaType)) || new Set(result.outputs.map(output => output.nodeId)).size !== result.outputs.length) fail('Declare distinct output node IDs and supported PNG/video media types');
  result.graphHash = hashValue(result.graph);
  result.definitionHash = hashValue(result);
  return freeze(result);
}

export function legacyWorkflowDefinition(binding) {
  return validateWorkflowDefinition({ version: 1, id: binding.id, task: 'passthrough', graph: binding.graph, inputs: { image: { nodeId: binding.imageNodeId, input: 'image' } }, outputs: binding.outputNodeIds.map(nodeId => ({ nodeId, mediaType: 'image/png' })), provenance: { source: 'legacy-passthrough' } });
}

// DynamicCombo API graphs use dotted nested input names, e.g. format.codec.
export function inputSchema(schema, inputs) {
  const fields = {};
  function expand(groups, prefix = '') {
    for (const group of ['required', 'optional']) for (const [name, spec] of Object.entries(groups?.[group] || {})) {
      const key = prefix + name;
      fields[key] = { spec, required: group === 'required' };
      if (spec?.[0] === 'COMFY_DYNAMICCOMBO_V3') {
        const branch = spec[1]?.options?.find(option => option.key === inputs[key]);
        if (branch) expand(branch.inputs, key + '.');
      }
    }
  }
  expand(schema?.input);
  return fields;
}
const choicesOf = spec => Array.isArray(spec?.[0]) ? spec[0] : spec?.[0] === 'COMBO' ? spec[1]?.options : spec?.[0] === 'COMFY_DYNAMICCOMBO_V3' ? spec[1]?.options?.map(option => option.key) : null;
const link = value => Array.isArray(value) && value.length === 2 && typeof value[0] === 'string' && Number.isInteger(value[1]);
const compatibleType = (a, b) => a === '*' || b === '*' || String(a).split(',').some(type => String(b).split(',').includes(type));
const uploadKind = spec => spec?.[1]?.video_upload ? 'video' : spec?.[1]?.image_upload ? 'image' : spec?.[1]?.audio_upload ? 'audio' : null;

export function validateGraph(graph, objectInfo, { deferredInputs = [] } = {}) {
  graphShape(graph);
  if (!object(objectInfo)) fail('Expected live /object_info node definitions');
  const issues = [], defaults = [], relevant = {};
  const deferred = new Map(deferredInputs.map(mapping => [`${mapping.nodeId}/${mapping.input}`, mapping]));
  const add = (code, nodeId, input, message, detail = {}) => issues.push({ code, nodeId, ...(input ? { input } : {}), message, ...detail });
  for (const [nodeId, node] of Object.entries(graph)) {
    const schema = objectInfo[node.class_type]; relevant[node.class_type] = schema || null;
    if (!schema) { add('missing-node', nodeId, null, `Missing node ${node.class_type}`, { classType: node.class_type }); continue; }
    const fields = inputSchema(schema, node.inputs);
    for (const [name, { spec, required }] of Object.entries(fields)) {
      if (has(spec?.[1] || {}, 'default')) defaults.push({ nodeId, input: name, value: spec[1].default, required });
      if (required && !has(node.inputs, name) && !deferred.has(`${nodeId}/${name}`)) add('missing-input', nodeId, name, `Required input ${node.class_type}.${name} is absent; schema defaults do not populate API graphs`, { default: spec?.[1]?.default ?? null });
    }
    for (const name of new Set([...Object.keys(node.inputs), ...deferredInputs.filter(mapping => mapping.nodeId === nodeId).map(mapping => mapping.input)])) {
      const field = fields[name], value = node.inputs[name], mapping = deferred.get(`${nodeId}/${name}`);
      if (!field) { add('unsupported-input', nodeId, name, `Input ${node.class_type}.${name} is not declared by this schema`); continue; }
      const spec = field.spec, choices = choicesOf(spec), expected = choices ? 'COMBO' : spec?.[0];
      if (mapping) {
        const kind = uploadKind(spec);
        // V1 LoadImage uses image_upload; custom loaders must advertise media support.
        if (!kind || kind !== mapping.kind) add('unsupported-media-loader', nodeId, name, `${node.class_type}.${name} does not advertise a ${mapping.kind} upload input`);
        const formats = spec?.[1]?.formats || spec?.[1]?.extensions;
        if (Array.isArray(formats) && !formats.some(format => format === mapping.mime || String(mapping.filename || '').toLowerCase().endsWith(String(format).replace(/^\*/, '').toLowerCase()))) add('unsupported-media-format', nodeId, name, 'Media format is not advertised by the loader', { formats, mime: mapping.mime });
        continue;
      }
      if (link(value)) {
        const upstream = graph[value[0]], outputs = objectInfo[upstream?.class_type]?.output;
        if (!upstream || value[1] < 0 || !Array.isArray(outputs) || value[1] >= outputs.length) add('invalid-link', nodeId, name, `Missing source node or output ${value[0]}:${value[1]}`);
        else if (!compatibleType(outputs[value[1]], expected)) add('type-mismatch', nodeId, name, `Link type ${outputs[value[1]]} cannot feed ${expected}`, { expected, actual: outputs[value[1]] });
        continue;
      }
      if (spec?.[1]?.forceInput) { add('link-required', nodeId, name, 'Input requires a typed connection'); continue; }
      if (choices) {
        const values = spec?.[1]?.multiselect && Array.isArray(value) ? value : [value];
        if (!values.every(item => choices.includes(item))) add(/(?:model|ckpt|lora|vae|unet|clip).*name|checkpoint/i.test(name) ? 'missing-model' : 'invalid-choice', nodeId, name, `Selected value is unavailable for ${node.class_type}.${name}`, { value, choices });
      } else if (!((expected === 'STRING' && typeof value === 'string') || (expected === 'INT' && Number.isSafeInteger(value)) || (expected === 'FLOAT' && Number.isFinite(value)) || (expected === 'BOOLEAN' && typeof value === 'boolean'))) {
        add('unsupported-value', nodeId, name, `Expected ${expected}; this input requires a typed link or a supported literal`, { expected });
      }
      if (typeof value === 'number' && ((Number.isFinite(spec?.[1]?.min) && value < spec[1].min) || (Number.isFinite(spec?.[1]?.max) && value > spec[1].max))) add('out-of-range', nodeId, name, 'Value is outside the schema range', { min: spec[1].min, max: spec[1].max, value });
    }
  }
  const visiting = new Set(), visited = new Set();
  function visit(id) {
    if (visiting.has(id)) { add('cycle', id, null, 'Graph contains a dependency cycle'); return; }
    if (visited.has(id) || !graph[id]) return;
    visiting.add(id);
    for (const value of Object.values(graph[id].inputs)) if (link(value)) visit(value[0]);
    visiting.delete(id); visited.add(id);
  }
  Object.keys(graph).forEach(visit);
  // Uploaded filenames are mutable backend inventory, not a schema change.
  const schemaForHash = structuredClone(relevant);
  for (const schema of Object.values(schemaForHash)) for (const group of ['required', 'optional']) for (const spec of Object.values(schema?.input?.[group] || {})) if (uploadKind(spec)) {
    if (Array.isArray(spec[0])) spec[0] = [];
    if (spec[1]?.options) spec[1].options = [];
  }
  return { compatible: !issues.length, issues, defaults, schemaHash: hashValue(schemaForHash) };
}

const safeNativeModules = { LoadImage: 'nodes', SaveImage: 'nodes', ImageInvert: 'nodes', LoadVideo: 'comfy_extras.nodes_video', GetVideoComponents: 'comfy_extras.nodes_video', CreateVideo: 'comfy_extras.nodes_video', SaveVideo: 'comfy_extras.nodes_video' };
export function workflowCost(graph, objectInfo, backend) {
  const nodes = Object.entries(graph).map(([nodeId, node]) => {
    const schema = objectInfo[node.class_type];
    const native = schema && safeNativeModules[node.class_type] === schema.python_module && !schema.api_node && !schema.price_badge;
    return { nodeId, classType: node.class_type, status: native ? 'known' : 'unknown', amount: native ? 0 : null, apiNode: schema?.api_node === true, priceBadge: schema?.price_badge || null };
  });
  const free = backend.kind === 'local' && nodes.every(node => node.status === 'known');
  return { status: free ? 'known' : 'unknown', amount: free ? 0 : null, currency: 'USD', nodes, reason: free ? 'Known native media operations on ordinary local ComfyUI; no billed API nodes.' : 'Custom/model/API node or Cloud charges are not a verified total. Imported pricing is provenance, not authorization.' };
}

export function validateApproval(approval, fingerprint, quote) {
  if (approval?.approved !== true || approval.fingerprint !== fingerprint) fail('Explicit approval must match the current quote fingerprint');
  const allowance = approval.allowance;
  if (!allowance || allowance.currency !== quote.currency || !Number.isFinite(allowance.maxAmount) || allowance.maxAmount < 0) fail('Explicit matching currency and nonnegative allowance are required');
  if (quote.status === 'unknown' && allowance.allowUnknownCharges !== true) fail('Unknown charges require explicit allowUnknownCharges approval; an allowance is not a backend spending cap');
  if (quote.status === 'known' && quote.amount > allowance.maxAmount) fail('Quote exceeds the approved allowance');
  return true;
}
