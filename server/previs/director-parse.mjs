// Built-in, offline direction parser. It covers common blockout and camera phrases
// so the workspace works without a connected agent. Free-form direction is the
// connected MCP agent's job; this never calls a model or a paid service.
import { randomUUID } from 'node:crypto';
import { SHAPES, MOVES, handleOf, uniqueName, entitySize, clampDuration, MAX_DURATION } from '../../shared/director.mjs';

const NOUNS = [
  ['person', 'people|persons?|m[ae]n|wom[ae]n|guys?|girls?|boys?|kids?|child(?:ren)?|characters?|heroes|hero|heroines?|actors?|actress(?:es)?|villains?|detectives?|runners?|dancers?|soldiers?|figures?|cops?|drivers?|pedestrians?|strangers?|robots?|astronauts?|subjects?'],
  ['car', 'flying cars?|cars?|trucks?|vans?|taxis?|cabs?|bus(?:es)?|vehicles?|suvs?|jeeps?|motorcycles?|motorbikes?|bikes?|spaceships?|hovercars?'],
  ['table', 'tables?|desks?|counters?'],
  ['chair', 'chairs?|stools?|benches|bench|sofas?|couch(?:es)?'],
  ['sphere', 'balls?|spheres?|orbs?|globes?|planets?'],
  ['cylinder', 'barrels?|pillars?|columns?|cylinders?|pedestals?|plinths?|drums?|posts?'],
  ['lamp', 'street ?lamps?|street ?lights?|lamp ?posts?|lamps?|light poles?|poles?'],
  ['building', 'buildings?|towers?|skyscrapers?|houses?|shops?|stores?|warehouses?'],
  ['wall', 'walls?|fences?|barriers?|partitions?'],
  ['tree', 'trees?|bush(?:es)?|plants?|palms?'],
  ['rock', 'rocks?|boulders?|stones?'],
  ['box', 'boxe?s?|crates?|cubes?|packages?|suitcases?|bags?|chests?|blocks?|props?'],
];
const NOUN_ALT = NOUNS.map(([, r]) => r).join('|');
const NOUN_RE = new RegExp(`\\b(${NOUN_ALT})\\b`, 'i');
// An indefinite noun phrase ("a detective", "two trees") introduces something new.
const NEW_RE = new RegExp(`\\b(?:a|an|one|two|three|four|five|six|some|another|couple of|few|several|\\d+)\\s+(?:[\\w-]+\\s+){0,2}?(${NOUN_ALT})\\b`, 'i');
const COLORS = { red: '#d9534f', blue: '#3f7fd6', green: '#4f9a5b', yellow: '#e8c547', orange: '#e8873a', purple: '#8e5bd6', pink: '#e27fb0', black: '#222428', white: '#eeeeee', grey: '#8a8f98', gray: '#8a8f98', silver: '#c3c7cf', gold: '#d4a93a', brown: '#8a5a3a', teal: '#3aa6a0' };
const COUNT = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, couple: 2, few: 3, several: 3 };

function shapeOf(word) {
  for (const [shape, re] of NOUNS) if (new RegExp(`^(?:${re})$`, 'i').test(word)) return shape;
  return null;
}
const plural = word => /s$/i.test(word) && !/(bus|glass|boss|actress)$/i.test(word);
const title = s => s.replace(/\b\w/g, c => c.toUpperCase());
const singular = w => w.replace(/(ches|shes|sses|xes)$/i, m => m.slice(0, -2)).replace(/ies$/i, 'y').replace(/([^s])s$/i, '$1').replace(/^(m|wom)en$/i, '$1an').replace(/^people$/i, 'person').replace(/^children$/i, 'child');

export function findEntity(text, entities) {
  const at = text.match(/@([a-z0-9-]+)/i);
  if (at) { const hit = entities.find(e => handleOf(e.name) === at[1].toLowerCase()); if (hit) return hit; }
  const lower = ' ' + text.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ') + ' ';
  const byName = [...entities].sort((a, b) => b.name.length - a.name.length).find(e => lower.includes(' ' + e.name.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ') + ' '));
  if (byName) return byName;
  const noun = text.match(NOUN_RE);
  if (noun) { const shape = shapeOf(noun[1]); const same = entities.filter(e => e.shape === shape); if (same.length === 1) return same[0]; }
  return null;
}

function relative(clause, entities, self) {
  const others = entities.filter(e => e !== self);
  const rel = clause.match(/\b(next to|beside|by|behind|in front of|on top of|on|near|left of|right of|facing)\s+(?:the\s+)?(@?[\w-]+(?:\s+[\w-]+)?)/i);
  if (rel) {
    const target = findEntity(rel[2], others);
    if (target && rel[1].toLowerCase() !== 'facing') {
      const [w, h, d] = entitySize(target), p = target.position;
      switch (rel[1].toLowerCase()) {
        case 'behind': return [p[0], 0, p[2] - d / 2 - 1.5];
        case 'in front of': return [p[0], 0, p[2] + d / 2 + 1.5];
        case 'on top of': case 'on': return [p[0], p[1] + h, p[2]];
        case 'left of': return [p[0] - w / 2 - 1.2, 0, p[2]];
        default: return [p[0] + (/\bleft\b/i.test(clause) ? -1 : 1) * (w / 2 + 1.2), 0, p[2]];
      }
    }
  }
  const at = clause.match(/\bat\s*\(?\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*\)?/);
  if (at) return [Number(at[1]), 0, Number(at[2])];
  let x = null, z = null;
  if (/\b(on the left|to the left|left side|screen left|camera left|at left)\b/i.test(clause)) x = -3;
  if (/\b(on the right|to the right|right side|screen right|camera right|at right)\b/i.test(clause)) x = 3;
  if (/\b(cent(er|re)|middle)\b/i.test(clause)) x = 0, z = 0;
  if (/\b(background|in the back|far away|far back|distance)\b/i.test(clause)) z = -7;
  if (/\b(foreground|close to (the )?camera|up front|in front)\b/i.test(clause)) z = 3;
  return x === null && z === null ? null : [x ?? self?.position[0] ?? 0, 0, z ?? self?.position[2] ?? 0];
}

function facing(clause, entities, self, position) {
  if (/\bfacing (the )?camera\b|\btoward(s)? (the )?camera\b/i.test(clause)) return 0;
  if (/\bfacing away\b|\bback to (the )?camera\b/i.test(clause)) return 180;
  if (/\bfacing (the )?left\b/i.test(clause)) return 270;
  if (/\bfacing (the )?right\b/i.test(clause)) return 90;
  const face = clause.match(/\b(?:facing|faces|face|looking at|looks at)\s+(?:the\s+)?(@?[\w-]+(?:\s+[\w-]+)?)/i);
  if (face) { const t = findEntity(face[1], entities.filter(e => e !== self)); if (t) { const p = position || self?.position || [0, 0, 0]; return ((Math.atan2(t.position[0] - p[0], t.position[2] - p[2]) * 180) / Math.PI + 360) % 360; } }
  return null;
}

const CAMERA_RE = /\b(camera|cam|lens|\d+\s*mm|dolly|push(?:es|ing)?\s*in|pull(?:s|ing)?\s*(?:back|out)|truck|track(?:s|ing)?\s*(?:left|right)|crab|pan|orbit|circle|arc|crane|jib|boom|tilt|locked[- ]off|static|close[- ]?up|wide shot|establishing|medium shot|low angle|high angle|eye level|overhead|top[- ]down|bird'?s[- ]eye|seconds?|secs?)\b/i;

function cameraPatch(clause, entities, shot) {
  const patch = {}, cam = {};
  const m = (re) => re.test(clause);
  if (m(/\b(dolly|push(es|ing)?|move|creep)s?\s*in\b|\bpush-in\b/i)) cam.move = 'dolly-in';
  else if (m(/\b(dolly|pull(s|ing)?|move)\s*(out|back)\b|\bpullback\b|\breveal\b/i)) cam.move = 'dolly-out';
  else if (m(/\b(truck|track|slide|crab)(s|ing)?\s*left\b/i)) cam.move = 'truck-left';
  else if (m(/\b(truck|track|slide|crab)(s|ing)?\s*right\b|\b(truck|tracking shot|crab)\b/i)) cam.move = 'truck-right';
  else if (m(/\bpan(s|ning)?\s*left\b/i)) cam.move = 'pan-left';
  else if (m(/\bpan(s|ning)?\b/i)) cam.move = 'pan-right';
  else if (m(/\b(orbit|circle|arc|go(es)? around|360)/i)) cam.move = m(/\b(left|counter-?clockwise|anti-?clockwise)\b/i) ? 'orbit-left' : 'orbit-right';
  else if (m(/\b(crane|jib|boom|pedestal|rise|rises|rising)\s*(up)?\b/i) && !m(/\b(down|descend)/i)) cam.move = 'crane-up';
  else if (m(/\b(crane|jib|boom)\s*down\b|\bdescend/i)) cam.move = 'crane-down';
  else if (m(/\btilt(s|ing)?\s*up\b/i)) cam.move = 'tilt-up';
  else if (m(/\b(static|locked[- ]off|lock(ed)? off|stationary|hold(s)? still|no (camera )?movement)\b/i)) cam.move = 'static';
  const target = findEntity(clause.replace(CAMERA_RE, ' '), entities);
  if (target) cam.target = target.id;
  const mm = clause.match(/(\d{1,3})\s*mm\b/i);
  if (mm) cam.mm = Number(mm[1]);
  if (m(/\bextreme close[- ]?up\b/i)) Object.assign(cam, { distance: 1.2, mm: cam.mm ?? 85 });
  else if (m(/\bclose[- ]?up\b/i)) Object.assign(cam, { distance: 2.5, mm: cam.mm ?? 50 });
  else if (m(/\bmedium shot\b/i)) cam.distance = 4.5;
  else if (m(/\b(wide shot|establishing)\b/i)) Object.assign(cam, { distance: 12, mm: cam.mm ?? 24 });
  if (m(/\bultra[- ]?wide\b/i) && !mm) cam.mm = 16;
  else if (m(/\bwide( lens| angle lens)?\b/i) && !mm && cam.mm === undefined) cam.mm = 24;
  if (m(/\b(telephoto|long lens|tele)\b/i) && !mm) cam.mm = 85;
  if (m(/\bworm'?s?[- ]eye\b/i)) cam.height = 0.25;
  else if (m(/\blow[- ]angle\b/i)) cam.height = 0.5;
  else if (m(/\b(overhead|top[- ]down|bird'?s[- ]eye)\b/i)) cam.height = 12;
  else if (m(/\bhigh[- ]angle\b/i)) cam.height = 5;
  else if (m(/\beye[- ]level\b/i)) cam.height = 1.6;
  if (m(/\bfrom behind\b/i)) cam.angle = 180;
  else if (m(/\bfrom the left\b/i)) cam.angle = -90;
  else if (m(/\bfrom the right\b|\bside (angle|view|on)\b/i)) cam.angle = 90;
  else if (m(/\bthree[- ]quarter|3\/4\b/i)) cam.angle = 35;
  else if (m(/\bfrom the front\b/i)) cam.angle = 0;
  const secs = clause.match(/(\d+(?:\.\d+)?)\s*(?:s|secs?|seconds?)\b/i);
  let clamped = false;
  if (secs) { patch.duration = clampDuration(Number(secs[1])); clamped = Number(secs[1]) > MAX_DURATION; }
  else if (m(/\b(slow(ly)?|gentle|gently)\b/i)) patch.duration = Math.max(shot.duration, 4.5);
  else if (m(/\b(fast|quick(ly)?|whip)\b/i)) patch.duration = 2;
  if (Object.keys(cam).length) patch.camera = cam;
  return { patch, clamped };
}

const s = n => (n === 1 ? '' : 's');
// Returns { ops, reply, understood }. Ops are applied by the director store.
export function interpret(text, project, shotId, attachments = []) {
  const entities = structuredClone(project.scene.entities);
  const shots = project.shots;
  let shot = shots.find(x => x.id === shotId) || shots[0] || null;
  const ops = [], said = [];
  const describe = line => {
    const prior = ops.filter(o => o.op === 'update_shot' && o.id === shot.id && o.patch.description !== undefined).at(-1)?.patch.description ?? shots.find(x => x.id === shot.id)?.description ?? '';
    ops.push({ op: 'update_shot', id: shot.id, patch: { description: [prior.trim().replace(/([^.!?])$/, '$1.'), line.replace(/[.!]?$/, '.')].filter(Boolean).join(' ') } });
  };
  const clauses = String(text).split(/(?:\n+|;|(?<!\d)\.(?!\d)|\bthen\b|\band then\b)/i).map(c => c.trim()).filter(Boolean);
  for (const original of clauses) {
    const clause = original.replace(/^(please|ok(ay)?|now|also|and)\s+/i, '');
    let m;
    if ((m = clause.match(/^(?:new|next|add(?: a| another)?|create(?: a)?)\s+shot\b\s*[:,-]?\s*(.*)$/i))) {
      const id = randomUUID(), rest = m[1];
      const camera = cameraPatch(rest, entities, { duration: 3 });
      ops.push({ op: 'add_shot', shot: { id, title: rest ? title(rest.split(/\s+/).slice(0, 5).join(' ')).slice(0, 60) : undefined, description: rest, ...camera.patch, camera: { ...(shot ? { ...shot.camera, keys: null, move: shot.camera.move === 'custom' ? 'static' : shot.camera.move } : {}), ...camera.patch.camera } } });
      shot = { id, duration: camera.patch.duration ?? 3, camera: {} };
      said.push(`Created shot ${shots.length + ops.filter(o => o.op === 'add_shot').length}${rest ? ` — “${rest}”` : ''}.`);
      continue;
    }
    if ((m = clause.match(/^(?:shot )?(?:description|describe(?: this shot)?|this shot(?: is)?|action)\s*[:,-]\s*(.+)$/i)) && shot) {
      ops.push({ op: 'update_shot', id: shot.id, patch: { description: m[1] } });
      said.push('Updated the shot description.');
      continue;
    }
    if ((m = clause.match(/^(?:the )?(?:environment|location|setting|set(?:ting)? in|scene is)\s*[:,-]?\s*(.+)$/i))) {
      const preset = /\b(street|city|road|alley)\b/i.test(m[1]) ? 'street' : /\b(room|kitchen|interior|office|bar|inside)\b/i.test(m[1]) ? 'interior' : undefined;
      ops.push({ op: 'set_scene', patch: { environment: { description: m[1], ...(preset ? { preset } : {}) } } });
      said.push(`Environment set to “${m[1]}”.`);
      continue;
    }
    if ((m = clause.match(/^(?:remove|delete|get rid of|lose)\s+(?:the\s+)?(.+)$/i))) {
      const target = findEntity(m[1], entities);
      if (target) { ops.push({ op: 'remove_entity', id: target.id }); entities.splice(entities.indexOf(target), 1); said.push(`Removed ${target.name}.`); }
      else said.push(`I couldn't find “${m[1]}” in the scene.`);
      continue;
    }
    if ((m = clause.match(/^(?:rename|call)\s+(?:the\s+)?(.+?)\s+(?:to\s+)?["“]?([\w -]{1,40}?)["”]?$/i))) {
      const target = findEntity(m[1], entities);
      if (target) { const name = uniqueName(entities.filter(e => e !== target), title(m[2])); ops.push({ op: 'update_entity', id: target.id, patch: { name } }); said.push(`Renamed ${target.name} to ${name}.`); target.name = name; continue; }
    }
    const isCamera = shot && CAMERA_RE.test(clause) && !/^(add|place|put|create|insert)\b/i.test(clause);
    const existing = findEntity(clause, entities);
    const editVerb = /^(?:move|put|place|set|make|turn|rotate|spin|scale|shift|slide|push|have)\b|\b(?:moves?|walks?|stands?|sits?|faces?|is)\s/i;
    const addVerb = /^(?:add|place|put|create|insert|spawn|include|there(?:'s| is| are| should be)|we (?:see|have)|give me|i want)\b/i;
    const fresh = clause.match(NEW_RE);
    const noun = fresh ? { 1: fresh[1], index: fresh.index + fresh[0].length - fresh[1].length } : clause.match(NOUN_RE);
    const linkOnly = attachments.length && existing && /\b(looks? like|reference|ref|this is|matches|for)\b/i.test(clause);
    if (linkOnly) {
      const role = /\bstyle\b/i.test(clause) ? 'style' : existing.kind === 'character' ? 'character' : existing.kind === 'environment' ? 'environment' : 'prop';
      for (const ref of attachments) ops.push({ op: 'update_reference', shotId: shot?.id, referenceId: ref, patch: { entityId: existing.id, role } });
      said.push(`Linked ${attachments.length} reference${s(attachments.length)} to ${existing.name}.`);
      continue;
    }
    if (isCamera && !fresh && !(existing && editVerb.test(clause) && !/\bcamera\b/i.test(clause))) {
      const { patch, clamped } = cameraPatch(clause, entities, shot);
      const onlyTarget = Object.keys(patch).length === 1 && patch.camera && Object.keys(patch.camera).join() === 'target' && !/^(camera|cam)\b|\b(on|frame|follow)\b/i.test(clause);
      if (Object.keys(patch).length && !onlyTarget) {
        ops.push({ op: 'update_shot', id: shot.id, patch });
        const bits = [];
        if (patch.camera?.move) bits.push(MOVES[patch.camera.move].toLowerCase());
        if (patch.camera?.target) bits.push(`on ${entities.find(e => e.id === patch.camera.target)?.name}`);
        if (patch.camera?.mm) bits.push(`${patch.camera.mm}mm`);
        if (patch.camera?.height !== undefined) bits.push(`height ${patch.camera.height}m`);
        if (patch.camera?.distance !== undefined) bits.push(`${patch.camera.distance}m away`);
        if (patch.duration) bits.push(`${patch.duration}s`);
        said.push(`Camera: ${bits.join(', ')}.${clamped ? ` Shots export up to ${MAX_DURATION}s, so I capped the duration.` : ''}`);
        continue;
      }
    }
    if (existing && !fresh && (editVerb.test(clause) || !addVerb.test(clause))) {
      const patch = {};
      const rest = clause.replace(new RegExp(existing.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
      const pos = relative(rest, entities, existing);
      if (pos) patch.position = pos;
      if (/\b(flying|hover(s|ing)?|floating|in the air|airborne)\b/i.test(clause)) patch.position = [...(patch.position || existing.position)].map((v, i) => (i === 1 ? 3 : v));
      const color = Object.keys(COLORS).find(c => new RegExp(`\\b${c}\\b`, 'i').test(clause));
      if (color && /\b(make|paint|colou?r|turn|is)\b/i.test(clause)) patch.color = COLORS[color];
      const k = /\b(bigger|larger|huge|giant)\b/i.test(clause) ? 1.5 : /\b(smaller|tiny|little)\b/i.test(clause) ? 0.66 : /\btaller\b/i.test(clause) ? [1, 1.3, 1] : null;
      if (k) patch.scale = existing.scale.map((v, i) => +(v * (Array.isArray(k) ? k[i] : k)).toFixed(3));
      const deg = clause.match(/(?:rotate|turn|spin)\w*\s.*?(-?\d+)\s*(?:deg|degrees|°)/i);
      if (deg) patch.rotation = (existing.rotation + Number(deg[1]) + 360) % 360;
      const face = facing(clause, entities, existing, patch.position);
      if (face !== null) patch.rotation = Math.round(face);
      if (Object.keys(patch).length) {
        ops.push({ op: 'update_entity', id: existing.id, patch });
        Object.assign(existing, patch);
        said.push(`Updated ${existing.name}${patch.position ? ' position' : ''}${patch.rotation !== undefined ? ' facing' : ''}${patch.color ? ' colour' : ''}${patch.scale ? ' size' : ''}.`);
        if (shot && !/^(move|put|place|set|make|turn|rotate|spin|scale|shift|slide|push|have)\b/i.test(clause) && clause.split(/\s+/).length >= 4) { describe(original); said.push('Added the action to the shot description.'); }
        continue;
      }
    }
    if (existing && !fresh && !addVerb.test(clause)) {
      // Talking about something already in the scene never creates a duplicate.
      if (/\b(looks? like|reference|ref|matches)\b/i.test(clause)) { said.push(`Attach an image with that message to link it to ${existing.name}.`); continue; }
      if (shot && clause.split(/\s+/).length >= 4) { describe(original); said.push('Added that to the shot description.'); continue; }
      said.push(`Nothing to change on ${existing.name} — try moving, turning, recolouring or resizing it.`);
      continue;
    }
    if (noun) {
      const word = noun[1], shape = shapeOf(word);
      const before = clause.slice(0, noun.index).toLowerCase();
      const countWord = before.match(/\b(a|an|one|two|three|four|five|six|couple|few|several|\d+)\s+(?:[\w-]+\s+){0,2}$/);
      let count = countWord ? (COUNT[countWord[1]] ?? Number(countWord[1])) : plural(word) ? 3 : 1;
      count = Math.max(1, Math.min(8, count || 1));
      const named = clause.match(/\b(?:called|named)\s+["“]?([\w -]{1,40}?)["”]?(?:\s+(?:on|in|at|next|behind|beside|by|near|facing|to|who|that|with)\b|[,.]|$)/i);
      const descriptor = before.match(/(?:^|\s)((?!a\b|an\b|the\b|add\b|place\b|put\b|create\b|two\b|three\b)[a-z]+)\s*$/i)?.[1];
      const color = Object.keys(COLORS).find(c => new RegExp(`\\b${c}\\b`, 'i').test(clause.slice(0, noun.index + word.length)));
      const flying = /\bflying|hover/i.test(clause);
      const base = named ? title(named[1].trim()) : title(singular(word.replace(/^flying\s+/i, '')));
      const anchor = relative(clause, entities, null) || [entities.length ? 0 : 0, 0, 0];
      const spacing = Math.max(1.2, SHAPES[shape].size[0] * 1.6);
      const added = [];
      for (let i = 0; i < count; i++) {
        const name = uniqueName(entities, base);
        const position = [anchor[0] + (i - (count - 1) / 2) * spacing, flying ? 3 : anchor[1], anchor[2]];
        const entity = { id: randomUUID(), name, shape, position, rotation: 0, scale: [1, 1, 1], color: color ? COLORS[color] : SHAPES[shape].color, kind: SHAPES[shape].kind, notes: [descriptor && !COLORS[descriptor] && !/^(the|some|and|with|of)$/.test(descriptor) ? descriptor : '', flying ? 'flying' : ''].filter(Boolean).join(', ') };
        const face = facing(clause, entities, null, position);
        if (face !== null) entity.rotation = Math.round(face);
        ops.push({ op: 'add_entity', entity });
        entities.push({ ...entity, scale: [1, 1, 1] });
        added.push(name);
      }
      if (attachments.length && added.length === 1) {
        const role = SHAPES[shape].kind === 'character' ? 'character' : SHAPES[shape].kind === 'environment' ? 'environment' : 'prop';
        for (const ref of attachments) ops.push({ op: 'update_reference', shotId: shot?.id, referenceId: ref, patch: { entityId: entities.at(-1).id, role } });
      }
      said.push(`Added ${added.join(', ')}.`);
      continue;
    }
    // Commands the parser can't map are reported, never pasted into the description.
    const command = /^(ok(ay)?|fix|make|add|change|can|could|please|i want|let'?s|use|set|show|give|try|update|remove|delete|move|turn|go)\b/i.test(clause);
    if (shot && !command && clause.split(/\s+/).length >= 4) {
      // Action and story beats become part of the shot description.
      describe(original);
      said.push('Added that to the shot description.');
      continue;
    }
    said.push(`Skipped “${original}”.`);
  }
  const understood = ops.length > 0;
  const reply = understood
    ? said.join(' ')
    : 'The built-in parser couldn’t map that to the blockout. Try “add a red car on the left”, “dolly in on the runner over 4 seconds” or “new shot: wide establishing orbit”. Connect your agent over MCP for free-form direction.';
  return { ops, reply, understood };
}
