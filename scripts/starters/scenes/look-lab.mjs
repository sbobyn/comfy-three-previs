// Look Lab: one small-town street, one 4 s blockout (a walker passes a tree, a bench and a lamp post toward the lens
// on a slow push), duplicated into twelve variant shots with the same camera, timing and scene, so every variant has
// the same blocking signature and the same blockout. Variants differ only in prompt sections: the world (season, time),
// the look (style), the walker's Cast Card text (clothing, person) and the format line. Sized for Kling O1 edit and
// Seedance 2.5 edit (4 s).
import { NO_BRANDS, NO_BRANDS_TAG, walkKeys, cameraKeys, focusAt, lerp, smooth, r3 } from '../kit.mjs';

const KERB = 0.15, WALK_X = 6;
const PERSON = 'Adult in their thirties, shoulder-length brown hair';
// key → [title, { world, style, walker, intro: [video, image] }]; only the parts given are overridden.
export const VARIANTS = [
  ['a · Summer day (base)', {}],
  ['b · Night', { world: 'Set: the same street at night, lamplight on the pavement, lit shop windows.', style: 'Look: photoreal night, warm lamplight, cool moonlight.' }],
  ['c · Spring', { world: 'Set: the same street on a spring morning, the maple in pale new leaf, tulips in planters.', style: 'Look: photoreal, soft fresh morning light.', walker: `${PERSON}, denim jacket, white T-shirt, beige chinos, white canvas shoes.` }],
  ['d · Fall', { world: 'Set: the same street on a crisp autumn afternoon, the maple orange and red, leaves on the pavement.', style: 'Look: photoreal, low golden autumn sun.', walker: `${PERSON}, rust knit sweater, wool scarf, dark jeans, brown leather boots.` }],
  ['e · Winter', { world: 'Set: the same street on a snowy winter morning, snow on roofs and the bench, a bare maple.', style: 'Look: photoreal, cold soft winter light.', walker: `${PERSON}, charcoal puffer coat, knitted hat, gloves, jeans, snow boots.` }],
  ['f · Clothing A · raincoat', { walker: `${PERSON}, bright yellow hooded raincoat, dark jeans, green rubber boots.` }],
  ['g · Clothing B · formal suit', { walker: `${PERSON}, tailored charcoal two-piece suit, white shirt, dark tie, black shoes.` }],
  ['h · Different person', { walker: 'Older man in his seventies, short white hair, neat white beard, slim build, light blue shirt, beige chinos, white canvas shoes.' }],
  ['i · Anime', { intro: ['Hand-drawn anime shot.', 'Hand-drawn anime film still, single frame.'], style: 'Look: hand-drawn anime, clean ink lines, flat cel shading, painted backgrounds, bright light.' }],
  ['j · Claymation', { intro: ['Stop-motion claymation shot.', 'Stop-motion claymation film still, single frame.'], style: 'Look: handmade plasticine stop-motion, fingerprinted clay texture, miniature set, soft studio light.' }],
  ['k · Stylised 3D animated feature', { intro: ['Stylised 3D animated feature shot.', 'Stylised 3D animated feature film still, single frame.'], style: 'Look: stylised 3D animated feature, soft rounded shapes, expressive proportions, warm bounce light.' }],
  ['l · Watercolour', { intro: ['Animated watercolour painting.', 'Watercolour painting, single frame.'], style: 'Look: loose watercolour in motion, soft bleeding washes, paper texture, light pencil lines.' }],
];

export default {
  slug: 'look-lab',
  title: 'Look Lab',
  render: (sh, i) => i === 0, // one blockout: every variant has the same blocking signature
  async build(h) {
    h.op({ op: 'set_scene', patch: { name: 'Small-town main street', environment: { preset: 'stage', description: 'A quiet small-town main street on a sunny summer afternoon: painted shopfronts, a leafy maple and hills beyond', style: `Photoreal, warm afternoon sun, soft shadows, natural colour. ${NO_BRANDS}` } } });
    h.add({ name: 'Hills', shape: 'terrain', model: 'terrain', kind: 'environment', position: [0, -0.6, 0], scale: [2, 0.05, 2], color: '#6f8f4e', notes: 'Rolling green hills beyond the town' });
    const ground = [];
    for (const z of [-25, 25]) {
      for (const [n, x, w, y, hgt, c] of [['Road', 0, 8, -0.1, 0.1, '#45484d'], ['Sidewalk east', 6, 4, 0, KERB, '#b3aea4'], ['Sidewalk west', -6, 4, 0, KERB, '#b3aea4'], ['Verge east', 14, 12, -0.1, 0.1, '#6d8f4f'], ['Verge west', -14, 12, -0.1, 0.1, '#6d8f4f']]) {
        const name = `${n} ${z < 0 ? 'north' : 'south'}`; ground.push(name);
        h.add({ name, shape: 'box', kind: 'environment', position: [x, y, z], scale: [w, hgt, 50], color: c, ...(z < 0 ? { notes: { Road: 'A two-lane asphalt street with a faded centre line', 'Sidewalk east': 'Pale concrete sidewalks with a low kerb', 'Verge east': 'Neat grass verges behind the shops' }[n] || '' } : {}), ...(z > 0 || n.endsWith('west') ? { lookFrom: `${n.replace('west', 'east')} north` } : {}) });
      }
    }
    h.op({ op: 'group', ids: ground, name: 'Street' });
    // Shopfronts on both sides, set back from the sidewalk.
    const shops = [], east = [[-30, 9, 7.5, '#c9a27e'], [-20.5, 9, 8.5, '#9fb4c0'], [-11, 9, 7, '#d7c9a7'], [-1.5, 9, 9, '#b87a6a'], [8, 9, 7.5, '#a8b89a'], [17.5, 9, 8, '#cdb6a0']];
    for (const [side, sx] of [['East', 12], ['West', -12]]) east.forEach(([z, w, ht, c], i) => {
      const name = `${side} shop ${i + 1}`; shops.push(name);
      h.add({ name, shape: 'building', kind: 'environment', position: [sx, 0, z + (side === 'West' ? 4 : 0)], scale: r3([8 / 6, ht / 12, (w - 0.6) / 6]), color: side === 'West' ? east[(i + 2) % east.length][3] : c, ...(shops.length === 1 ? { notes: 'Two-storey small-town shopfronts in painted brick and clapboard, large plain windows and fabric awnings with no lettering' } : { lookFrom: 'East shop 1' }) });
    });
    h.op({ op: 'group', ids: shops, name: 'Shops' });
    // The three things the walker passes, and a parked car at the kerb.
    h.add({ name: 'Tree trunk', shape: 'cylinder', kind: 'environment', position: [7.4, KERB, -12.6], scale: [0.45, 2.6, 0.45], color: '#5a4430' });
    h.add({ name: 'Street tree', shape: 'sphere', kind: 'environment', position: [7.4, 2.4, -12.6], scale: [3.6, 3.2, 3.6], color: '#4f8a4a', notes: 'A mature maple street tree with a full rounded crown' });
    h.add({ name: 'Bench', shape: 'box', kind: 'prop', position: [7.55, KERB, -10.6], rotation: 90, scale: [1.8, 0.45, 0.55], color: '#7a5a3c', notes: 'A plain wooden park bench on cast-iron legs' });
    h.add({ name: 'Bench back', shape: 'box', kind: 'prop', position: [7.85, KERB + 0.45, -10.6], rotation: 90, scale: [1.8, 0.45, 0.08], color: '#7a5a3c' });
    h.add({ name: 'Lamp post', shape: 'lamp', kind: 'prop', position: [4.45, KERB, -9.4], scale: [1, 1.05, 1], color: '#2e3236', notes: 'A black cast-iron street lamp post with a lantern head' });
    h.add({ name: 'Parked car', shape: 'car', kind: 'vehicle', position: [2.9, 0, -19], color: '#6c8aa0', notes: 'A generic small hatchback in pale blue; no badges, logos or lettering' });
    h.op({ op: 'group', ids: ['Tree trunk', 'Street tree', 'Bench', 'Bench back'], name: 'Street furniture' });
    await h.flush();

    // The walker: the imported mannequin on its Walk clip, 4 s from z = -14.5 toward the lens, past all three.
    const walker = await h.mannequin('Walker', { colour: 'sand', position: [WALK_X, KERB, -14.5] });
    h.op({ op: 'update_entity', id: 'Walker', patch: { notes: `${PERSON}, light blue cotton shirt, beige chinos, white canvas shoes` } });
    await h.animate([{ object: 'Walker', mode: 'replace', keys: walkKeys([[WALK_X, -14.5], [WALK_X, 10]], { t0: 0, t1: 4, ground: () => KERB, step: 0.5 }) }]);
    await h.perform({ object: 'Walker', clip: 'Walk' });
    const p = await h.project(), at = t => focusAt(p, 'Walker', t);
    // A slow push: 1.5 m in over 4 s, lens 40 mm, framed on the walker with room ahead of them.
    const keys = cameraKeys(4, 16, t => { const u = smooth(t / 4); return { p: [4.7 - 0.1 * u, 1.55, 2.6 - 1.5 * u], look: lerp(at(t), [at(t)[0] - 0.3, at(t)[1] - 0.15, at(t)[2]], 0.5), mm: 40 }; });
    const action = '@walker strolls along the sidewalk toward us, past @street-tree, @bench and @lamp-post.';
    VARIANTS.forEach(([title], i) => h.op(i === 0
      ? { op: 'update_shot', id: 1, patch: { title, description: action, duration: 4, start: 0, camera: { move: 'custom', target: 'Walker', keys, timing: 'linear', mm: 40 } } }
      : { op: 'add_shot', shot: { title, description: action, duration: 4, start: 0, camera: { move: 'custom', target: 'Walker', keys, timing: 'linear', mm: 40 } } }));
    await h.flush();
    VARIANTS.forEach((_, i) => h.op({ op: 'update_shot', id: i + 1, patch: { style: { movement: ['slow push-in'], cuts: ['continuous take, no cuts'], lens: ['40mm'], filter: [NO_BRANDS_TAG] } } }));
    await h.flush();
    // Each variant's look lives in its own prompt sections (video and image), set with the agent's section tool.
    for (const [i, [, v]] of VARIANTS.entries()) for (const kind of ['video', 'image']) {
      const set = (section, text) => h.call('previs_director_set_prompt_section', { projectId: h.projectId, shot: String(i + 1), kind, section, mode: 'override', text });
      if (v.world) await set('world', v.world);
      if (v.style) await set('style', v.style);
      if (v.walker) await set(`obj:${walker.id}`, v.walker);
      if (v.intro) await set('intro', v.intro[kind === 'video' ? 0 : 1]);
    }
  },
};
