// City Blocks: a 4 × 4 downtown grid of original, sign-free buildings with an avenue, crosswalks, street lamps and a
// plaza; generic cars drive and mannequin pedestrians walk. Shots for drone and phone takes at street and roof level.
import { NO_BRANDS, NO_BRANDS_TAG, walkKeys, cameraKeys, focusAt, lerp, smooth, r3 } from '../kit.mjs';

const STREETS = [-46, 0, 46], HALF = 6, KERB = 0.15;
const BLOCKS = [[-86, -52], [-40, -6], [6, 40], [52, 86]];
const inBlock = (x, z) => BLOCKS.some(([a, b]) => x >= a && x <= b) && BLOCKS.some(([a, b]) => z >= a && z <= b);
const ground = (x, z) => (inBlock(x, z) ? KERB : 0);
// Heights (m) per block, row by row (z from north to south); 0 is the plaza. Two numbers split the block in two.
const HEIGHTS = [[[22], [36, 18], [28], [16, 24]], [[44], [30], [48], [20]], [[18, 26], [34], [0], [40]], [[24], [14, 20], [32], [26, 12]]];
const COLOURS = ['#8c8478', '#6e7680', '#a39586', '#5d6670', '#9a8f80', '#787f86', '#b0a493', '#646b73'];

export default {
  slug: 'city-blocks',
  title: 'City Blocks',
  async build(h) {
    h.op({ op: 'set_scene', patch: { name: 'Downtown grid', environment: { preset: 'stage', description: 'A compact downtown grid on a clear spring afternoon: mid-rise and high-rise blocks, wide asphalt streets with zebra crosswalks, street lamps, and a small paved plaza with a fountain and young trees', style: `Photoreal contemporary city film. Bright afternoon sun, crisp shadows, clean natural colour. ${NO_BRANDS}` } } });
    h.add({ name: 'Outskirts', shape: 'terrain', model: 'terrain', kind: 'environment', position: [0, -0.6, 0], scale: [2, 0.05, 2], color: '#6f7f5a', notes: 'Low green hills on the horizon beyond the city' });
    // Asphalt in 50 m tiles (an object is at most 50× its shape), edge to edge, never overlapping.
    const tiles = [];
    for (const x of [-75, -25, 25, 75]) for (const z of [-75, -25, 25, 75]) { const n = `Asphalt ${tiles.length + 1}`; tiles.push(n); h.add({ name: n, shape: 'box', kind: 'environment', position: [x, -0.1, z], scale: [50, 0.1, 50], color: '#3b3e44', ...(tiles.length === 1 ? { notes: 'Dark grey asphalt streets with faint tyre marks' } : { lookFrom: 'Asphalt 1' }) }); }
    h.op({ op: 'group', ids: tiles, name: 'Streets' });
    const pave = [], builds = [];
    let colour = 0;
    BLOCKS.forEach(([z0, z1], row) => BLOCKS.forEach(([x0, x1], col) => {
      const name = `Sidewalk ${row + 1}-${col + 1}`; pave.push(name);
      h.add({ name, shape: 'box', kind: 'environment', position: [(x0 + x1) / 2, 0, (z0 + z1) / 2], scale: [x1 - x0, KERB, z1 - z0], color: '#a2a19c', ...(pave.length === 1 ? { notes: 'Pale concrete sidewalks with a low kerb' } : { lookFrom: 'Sidewalk 1-1' }) });
      const heights = HEIGHTS[row][col];
      if (!heights[0]) return;
      const w = (x1 - x0 - 6) / heights.length;
      heights.forEach((ht, k) => {
        const bname = `Building ${row + 1}-${col + 1}${heights.length > 1 ? `${'ab'[k]}` : ''}`; builds.push(bname);
        const cx = x0 + 3 + w * (k + 0.5), bw = w - (heights.length > 1 ? 1 : 0);
        h.add({ name: bname, shape: 'building', kind: 'environment', position: [cx, KERB, (z0 + z1) / 2], scale: r3([bw / 6, ht / 12, (z1 - z0 - 6) / 6]), color: COLOURS[colour++ % COLOURS.length], ...(builds.length === 1 ? { notes: 'City buildings with concrete, brick and glass facades and regular window grids, plain ground-floor glazing, no signs' } : { lookFrom: 'Building 1-1' }) });
      });
    }));
    h.op({ op: 'group', ids: pave, name: 'Sidewalks' });
    // Rooftop of the 48 m tower (row 2, column 3): a water tank and a plant box for parallax.
    h.add({ name: 'Water tank', shape: 'cylinder', kind: 'environment', position: [31, 48.15, -31], scale: [3.5, 2, 3.5], color: '#7b6a58', notes: 'A timber rooftop water tank on steel legs' });
    h.add({ name: 'Rooftop plant', shape: 'box', kind: 'environment', position: [14, 48.15, -33], scale: [5, 1.6, 3], color: '#8e9296', lookFrom: 'Building 1-1' });
    builds.push('Water tank', 'Rooftop plant');
    h.op({ op: 'group', ids: builds, name: 'Buildings' });
    // Zebra crosswalks, 2 mm above the asphalt; a dashed centre line on the avenue.
    const stripes = [];
    const stripe = (name, x, z, along) => { stripes.push(name); h.add({ name, shape: 'box', kind: 'environment', position: [x, 0.002, z], scale: along === 'z' ? [0.7, 0.02, 3] : [3, 0.02, 0.7], color: '#e8e6df', ...(stripes.length === 1 ? { notes: 'Freshly painted white zebra crosswalk stripes' } : { lookFrom: stripes[0] }) }); };
    for (let i = 0; i < 8; i++) stripe(`Crosswalk N ${i + 1}`, -51.2 + i * 1.4, -7.8, 'z');
    for (let i = 0; i < 8; i++) stripe(`Crosswalk W ${i + 1}`, -55.5, -4.9 + i * 1.4, 'x');
    for (let i = 0; i < 8; i++) stripe(`Crosswalk E ${i + 1}`, 9.5, -4.9 + i * 1.4, 'x');
    h.op({ op: 'group', ids: stripes, name: 'Crosswalks' });
    const dashes = [];
    for (let x = -82; x <= 82; x += 9) if (!STREETS.some(c => Math.abs(x - c) < HALF + 3)) { const n = `Centre line ${dashes.length + 1}`; dashes.push(n); h.add({ name: n, shape: 'box', kind: 'environment', position: [x, 0.002, 0], scale: [3, 0.02, 0.15], color: '#d8c86a', ...(dashes.length === 1 ? { notes: 'Yellow dashed centre line' } : { lookFrom: dashes[0] }) }); }
    h.op({ op: 'group', ids: dashes, name: 'Centre line' });
    const lamps = [];
    for (const z of [-6.6, 6.6]) for (const x of [-78, -62, -30, -14, 14, 30, 62, 78]) { const n = `Street lamp ${lamps.length + 1}`; lamps.push(n); h.add({ name: n, shape: 'lamp', kind: 'environment', position: [x, KERB, z], rotation: z < 0 ? 0 : 180, scale: [1, 1.5, 1], color: '#4a4f55', ...(lamps.length === 1 ? { notes: 'Slim dark-grey street lamps with a simple head' } : { lookFrom: lamps[0] }) }); }
    h.op({ op: 'group', ids: lamps, name: 'Street lamps' });
    // The plaza (row 3, column 3): a fountain, four young trees and two benches.
    h.add({ name: 'Fountain basin', shape: 'cylinder', kind: 'environment', position: [23, KERB, 23], scale: [10, 0.5, 10], color: '#b9b4aa', notes: 'A round stone fountain basin with a low rim and a central column of water' });
    h.add({ name: 'Fountain column', shape: 'cylinder', kind: 'environment', position: [23, KERB + 0.6, 23], scale: [1, 1.6, 1], color: '#b9b4aa', lookFrom: 'Fountain basin' });
    const plaza = ['Fountain basin', 'Fountain column'];
    for (const [i, [x, z]] of [[12, 12], [34, 12], [12, 34], [34, 34]].entries()) { const n = `Plaza tree ${i + 1}`; plaza.push(n); h.add({ name: n, shape: 'tree', kind: 'environment', position: [x, KERB, z], scale: [1, 1.2, 1], color: '#5f8f4f', ...(i ? { lookFrom: 'Plaza tree 1' } : { notes: 'Young plane trees in fresh spring leaf' }) }); }
    for (const [i, [x, z, rot]] of [[23, 15.7, 0], [15.7, 23, 90]].entries()) { const n = `Bench ${i + 1}`; plaza.push(n); h.add({ name: n, shape: 'box', kind: 'environment', position: [x, KERB, z], rotation: rot, scale: [2.2, 0.45, 0.6], color: '#8a6a4a', ...(i ? { lookFrom: 'Bench 1' } : { notes: 'Plain wooden slatted benches' }) }); }
    h.op({ op: 'group', ids: plaza, name: 'Plaza' });
    // Generic cars, no badges. The red hatchback leads; nothing meets in an intersection.
    const car = (name, color, notes, keys, extra = {}) => { h.add({ name, shape: 'car', kind: 'vehicle', position: keys[0].position, color, notes, ...extra }); return { object: name, mode: 'replace', keys }; };
    const drive = (from, to) => [{ t: 0, position: from, ease: 'linear' }, { t: 20, position: to }];
    const anims = [
      car('Red hatchback', '#b23a3a', 'A generic compact five-door hatchback in glossy red, dark tinted windows, plain silver wheels; no badges, logos or lettering', drive([-90, 0, 3], [110, 0, 3])),
      car('Blue sedan', '#2f4f7f', 'A generic mid-size four-door sedan in deep blue; no badges, logos or lettering', drive([170, 0, -3], [-30, 0, -3])),
      car('Silver van', '#b8bcc0', 'A generic boxy silver delivery van with plain panels; no badges, logos or lettering', drive([-3, 0, -150], [-3, 0, 50]), { scale: [1.05, 1.35, 1.15] }),
    ];
    h.add({ name: 'Parked car 1', shape: 'car', kind: 'vehicle', position: [-50.8, 0, 22], color: '#5b6b4a', notes: 'Generic parked cars in muted colours; no badges, logos or lettering' });
    h.add({ name: 'Parked car 2', shape: 'car', kind: 'vehicle', position: [-41.2, 0, -26], rotation: 180, color: '#d8d4cc', lookFrom: 'Parked car 1' });
    await h.flush();
    await h.animate(anims);

    // People: the imported mannequin (Walk and Idle clips). The commuter steps off the kerb onto the crosswalk at 15.7 s.
    const commuter = [[-72, -7.8], [-30, -7.8]];
    const step = (pts, t1 = 20) => walkKeys(pts, { t0: 0, t1, ground, step: 0.5 });
    const lead = await h.mannequin('Commuter', { colour: 'sand', position: [-72, KERB, -7.8], rotation: 90 });
    h.op({ op: 'update_entity', id: 'Commuter', patch: { notes: 'An adult commuter in a long camel coat, dark trousers, white canvas shoes and a grey shoulder bag; short curly black hair', styleNotes: 'Plain clothing without logos or lettering' } });
    const people = [['Passer-by 1', 'slate', [[40, 7.8], [0, 7.8]]], ['Passer-by 2', 'sand', [[-38, -7.8], [0, -7.8]]], ['Passer-by 3', 'slate', [[-38.2, -36], [-38.2, 0]]], ['Passer-by 4', 'sand', [[8.5, 38], [8.5, 0]]]];
    const slate = await h.mannequin('Rooftop visitor', { colour: 'slate', position: [20, 48.15, -12.2] });
    h.op({ op: 'update_entity', id: 'Rooftop visitor', patch: { notes: 'An adult in a navy windbreaker, grey beanie and dark jeans, standing at the roof edge looking out over the city', styleNotes: 'Plain clothing without logos or lettering' } });
    for (const [name, c, pts] of people) h.clone(c === 'sand' ? lead : slate, name, { position: [pts[0][0], KERB, pts[0][1]], ...(name === 'Passer-by 1' ? { notes: 'Passers-by in plain everyday coats, sweaters and jeans in muted colours' } : { lookFrom: 'Passer-by 1' }) });
    h.clone(slate, 'Plaza visitor', { position: [29, KERB, 25.5], rotation: 250, lookFrom: 'Passer-by 1' });
    h.clone(lead, 'Bench reader', { position: [23, KERB, 16.05], rotation: 0, lookFrom: 'Passer-by 1' });
    await h.animate([{ object: 'Commuter', mode: 'replace', keys: step(commuter) }, ...people.map(([name, , pts]) => ({ object: name, mode: 'replace', keys: step(pts) }))]);
    for (const n of ['Commuter', ...people.map(p => p[0])]) await h.perform({ object: n, clip: 'Walk', offset: (n.length % 5) * 0.2 });
    await h.perform({ object: 'Rooftop visitor', clip: 'Idle' });
    await h.perform({ object: 'Plaza visitor', clip: 'Idle', offset: 1.2 });
    await h.perform({ object: 'Bench reader', clip: null, pose: 'sit' });
    h.op({ op: 'group', ids: ['Passer-by 1', 'Passer-by 2', 'Passer-by 3', 'Passer-by 4', 'Plaza visitor', 'Bench reader'], name: 'Pedestrians' });
    const p = await h.project(), at = (n, t) => focusAt(p, n, t);

    // 1 · Drone rise: from head height in the avenue, straight up between the façades, holding on the commuter.
    const rise = cameraKeys(5, 40, t => { const u = smooth(t / 5); return { p: [-27 - 6 * u, 1.6 + 36 * u ** 1.2, -0.5 + 3 * u], look: lerp(at('Commuter', t), [-60, 0, -4], 0.25 * u), mm: 28 }; });
    // 2 · Street-level track with the red hatchback, from the opposite lane, a little ahead (front three-quarter).
    const track = cameraKeys(5, 25, t => { const c = at('Red hatchback', 5 + t); return { p: [c[0] + 3.2, 1.1, -4.2], look: [c[0] - 0.3, 0.75, 3], mm: 28 }; });
    // 3 · Rooftop orbit: 140° around the visitor from the roof side, so the avenue and the plaza lie beyond the edge.
    const orbit = cameraKeys(5, 40, t => { const a = (105 + 140 * smooth(t / 5)) * Math.PI / 180, f = at('Rooftop visitor', 10 + t); return { p: [f[0] + 8 * Math.sin(a), 48.15 + 2.6, f[2] + 8 * Math.cos(a)], look: [f[0], f[1] - 0.5, f[2]], mm: 24 }; });
    // 4 · Pedestrian follow: behind the commuter's right shoulder as they step down and cross on the zebra.
    const follow = cameraKeys(5, 25, t => { const f = at('Commuter', 15 + t), x = f[0] - 4.6, z = -7; return { p: [x, ground(x, z) + 1.9, z], look: [f[0] + 2.5, f[1] - 0.2, f[2] - 0.3], mm: 35 }; });
    const style = (lens, movement) => ({ movement, cuts: ['continuous take, no cuts'], lens, filter: ['deep focus', NO_BRANDS_TAG] });
    const shots = [
      { title: 'Drone rise', start: 0, description: '@commuter walks east along the sidewalk past street lamps; @red-hatchback drives up the avenue toward the intersection in the afternoon sun.', camera: { move: 'custom', target: 'Commuter', keys: rise, timing: 'linear', mm: 28 }, style: style(['24mm wide'], ['crane up', 'drone flyover']), cast: { include: ['Commuter'], exclude: [] } },
      { title: 'Car track', start: 5, description: '@red-hatchback cruises east through the intersection at a steady city speed, reflections sliding over its paint and glass.', camera: { move: 'custom', target: 'Red hatchback', keys: track, timing: 'linear', mm: 28 }, style: style(['24mm wide'], ['tracking shot']) },
      { title: 'Rooftop orbit', start: 10, description: '@rooftop-visitor stands at the edge of the tower roof, shifting their weight and looking out across the streets and the plaza far below.', camera: { move: 'custom', target: 'Rooftop visitor', keys: orbit, timing: 'linear', mm: 28 }, style: style(['24mm wide'], ['orbit around the subject']) },
      { title: 'Pedestrian follow', start: 15, description: '@commuter steps down off the kerb and crosses the side street on the zebra crosswalk at an easy pace, bag strap over one shoulder.', camera: { move: 'custom', target: 'Commuter', keys: follow, timing: 'linear', mm: 35 }, style: style(['35mm natural'], ['steadicam follow']) },
    ];
    shots.forEach((s, i) => h.op(i === 0 ? { op: 'update_shot', id: 1, patch: { ...s, duration: 5 } } : { op: 'add_shot', shot: { ...s, duration: 5 } }));
    await h.flush();
    shots.forEach((s, i) => h.op({ op: 'update_shot', id: i + 1, patch: { style: s.style, ...(s.cast ? { cast: s.cast } : {}) } }));
    await h.flush();
  },
};
