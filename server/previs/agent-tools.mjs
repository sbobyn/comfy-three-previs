// [agent] The stdio MCP server the built-in agent runner hands to Claude Code. One project, one
// message: every tool is scoped by PREVIS_PROJECT / PREVIS_MESSAGE, edits become a proposal the user
// reviews in the workspace (nothing is applied here), and nothing can render or spend money.
// Loopback only; the Previs server is the sole authority.
import { createInterface } from 'node:readline';

const base = process.env.PREVIS_URL || 'http://127.0.0.1:5190';
if (!/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(base)) throw Error('PREVIS_URL must be loopback');
const projectId = process.env.PREVIS_PROJECT || '';
const messageId = process.env.PREVIS_MESSAGE || '';
if (!/^[a-f0-9-]{36}$/.test(projectId) || !/^[a-f0-9-]{36}$/.test(messageId)) throw Error('PREVIS_PROJECT and PREVIS_MESSAGE are required');

const OPS_DOC = 'ops is an array of: ' +
  '{op:"add_entity",entity:{name,shape,kind?,position:[x,y,z],rotation?,pose?,scale?:[x,y,z],color?:"#rrggbb",notes? (Cast Card description),styleNotes?}} (shape: person, car, box, table, chair, sphere, cylinder, lamp, building, wall, tree, rock; kind: character, vehicle, prop, environment); ' +
  '{op:"update_entity",id,patch:{name?,position?,rotation?,pose?,scale?,color?,notes?,styleNotes?,lookFrom?: object name to share its look (null to unlink)}}; ' +
  '{op:"remove_entity",id}; ' +
  '{op:"add_shot",shot:{title,description,duration (0.5-5 s),start?,camera},index?}; ' +
  '{op:"update_shot",id,patch:{title?,description?,duration?,start?,camera?,prompts?:{video?:{text,edited:true}|null,image?:{text,edited:true}|null},cast?:{include:[names],exclude:[names]}}}; ' +
  '{op:"remove_shot",id}; {op:"reorder_shots",ids}; ' +
  '{op:"set_scene",patch:{name?,environment:{preset?:"stage"|"street"|"interior",description?,style?}}}; {op:"set_project",patch:{title}}. ' +
  'Object ids may be names; shot ids may be titles or 1-based numbers. ' +
  'camera: {move: static|dolly-in|dolly-out|truck-left|truck-right|pan-left|pan-right|orbit-left|orbit-right|crane-up|crane-down|tilt-up, target: object name, distance m, height m, angle deg around target (0 front, 90 screen right, 180 behind), mm}. ' +
  'Units: metres, ground y=0, +z toward the default camera, -x is screen left; rotation is yaw degrees, 0 faces the camera. In descriptions mention objects as @handle (lowercase name, spaces to dashes).';

const tools = [
  { name: 'previs_get_scene', description: 'Read the project: world, every object with its Cast Card, every shot with its camera, the current shot number, and any changes you already proposed this turn (shown as if applied). Read before you propose.', path: '/api/director/agent/scene', inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
  { name: 'previs_get_prompt', description: 'Read the auto-composed generation prompt for a shot (assembled from its Cast Cards, world, action, camera and style tags) plus the user’s edited prompt if there is one. Use this as the basis for any prompt you write; do not invent descriptions that contradict the Cast Cards.', path: '/api/director/agent/prompt', inputSchema: { type: 'object', properties: { shot: { type: 'string', description: 'Shot number, title or id' }, kind: { type: 'string', enum: ['video', 'image'], description: 'video (no camera-motion words: the blockout is the camera) or image (one still frame)' } }, required: ['shot'], additionalProperties: false } },
  { name: 'previs_propose_edit', description: 'Propose blockout/shot/camera edits. They are NOT applied: the user sees a card summarising them and clicks Apply or Discard. Batch everything for one request into one call. Returns the plain-language summary and the ids of new objects/shots, and warnings first when an object would share a plane with another (z-fighting): propose a fix that lifts the thinner one at least 2 mm along the shared normal. ' + OPS_DOC, path: '/api/director/agent/propose', inputSchema: { type: 'object', properties: { ops: { type: 'array', items: { type: 'object' }, minItems: 1, maxItems: 60 } }, required: ['ops'], additionalProperties: false } },
  { name: 'previs_propose_animation', description: 'Propose keyframe animation on the scene timeline (seconds); reviewed with Apply/Discard like edits. animations: [{object: name, keys: [{t, position?:[x,y,z], rotation?: yaw degrees, scale?, pose?:{joint:[x,y,z] degrees}, ease?:"linear"|"smoothstep"}], mode?: "merge"|"replace"} | {object, removeTimes:[t]} | {object, clear:true}]. Pose joints: body, head, armL/R, forearmL/R, thighL/R, shinL/R, wingL/R, tipL/R, tail, steerL/R, wheelFL/FR/RL/RR. Pose angles blend; ease belongs to the outgoing segment. Position defaults to a smooth spline; with no rotation keys the object faces its direction of travel. Shots show [shot.start, shot.start + duration].', path: '/api/director/agent/propose', inputSchema: { type: 'object', properties: { animations: { type: 'array', minItems: 1, maxItems: 40, items: { type: 'object', properties: { object: { type: 'string' }, keys: { type: 'array', items: { type: 'object', properties: { t: { type: 'number' }, position: { type: 'array', items: { type: 'number' } }, rotation: { type: 'number' }, pose: { type: 'object', additionalProperties: { type: 'array', items: { type: 'number' }, minItems: 3, maxItems: 3 } }, ease: { type: 'string', enum: ['linear', 'smoothstep'] }, pitch: { type: 'number' }, roll: { type: 'number' }, scale: { type: 'array', items: { type: 'number' } } }, required: ['t'] } }, mode: { type: 'string', enum: ['merge', 'replace'] }, removeTimes: { type: 'array', items: { type: 'number' } }, clear: { type: 'boolean' } }, required: ['object'] } } }, required: ['animations'], additionalProperties: false } },
  { name: 'previs_suggest_prompt', description: 'Offer a finished generation prompt for a shot. The user gets a “Use as shot prompt” button (undoable); nothing is written until they click it. Use after previs_get_prompt. Keep it one paragraph, concrete, consistent with the Cast Cards.', path: '/api/director/agent/suggest', inputSchema: { type: 'object', properties: { shot: { type: 'string' }, kind: { type: 'string', enum: ['video', 'image'] }, text: { type: 'string', maxLength: 4000 } }, required: ['shot', 'kind', 'text'], additionalProperties: false } },
  { name: 'previs_progress', description: 'Show a short live status line under the user’s message (e.g. "Checking shot 3’s framing"). Post one before each meaningful step so the user is never left waiting.', path: '/api/director/agent/progress', inputSchema: { type: 'object', properties: { text: { type: 'string', maxLength: 120 } }, required: ['text'], additionalProperties: false } },
];

async function call(tool, args) {
  const body = { projectId, messageId, ...args };
  if (tool.name === 'previs_propose_animation') {
    body.ops = args.animations.map(a => a.clear ? { op: 'clear_animation', id: a.object } : Array.isArray(a.removeTimes) ? { op: 'remove_keyframes', id: a.object, times: a.removeTimes } : { op: 'set_keyframes', id: a.object, keys: a.keys, mode: a.mode });
    delete body.animations;
  }
  const response = await fetch(base + tool.path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Previs-Agent': '1' }, body: JSON.stringify(body) });
  const result = await response.json();
  return { isError: !response.ok, content: [{ type: 'text', text: JSON.stringify(result) }] };
}

async function handle(message) {
  if (message.method === 'initialize') return { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'previs', version: '0.2.0' } };
  if (message.method === 'ping') return {};
  if (message.method === 'tools/list') return { tools: tools.map(({ path, ...tool }) => tool) };
  if (message.method === 'tools/call') {
    const tool = tools.find(t => t.name === message.params?.name); if (!tool) throw Error('Unknown tool');
    try { return await call(tool, message.params.arguments || {}); }
    catch { return { isError: true, content: [{ type: 'text', text: 'Comfy Previs server unavailable.' }] }; }
  }
  throw Error('Unknown method');
}

for await (const line of createInterface({ input: process.stdin })) {
  let msg; try { msg = JSON.parse(line); if (msg.id === undefined) continue; const result = await handle(msg); process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n'); }
  catch (e) { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg?.id ?? null, error: { code: -32603, message: e.message } }) + '\n'); }
}
