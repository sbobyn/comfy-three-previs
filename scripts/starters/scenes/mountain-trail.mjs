// Mountain Trail: an alpine valley built for flying. A hiker (the imported mannequin playing its Walk clip) crosses an
// open meadow on a dirt trail toward a lake and a cabin; four shots for Fly camera, drone and phone takes.
import { terrainHeight } from '../../../shared/terrain.mjs';
import { NO_BRANDS, NO_BRANDS_TAG, along, walkKeys, cameraKeys, focusAt, lerp, smooth, r3 } from '../kit.mjs';

const TERRAIN = { position: [0, 0, 0], scale: [1.4, 0.45, 1.4] };
const g = (x, z) => terrainHeight(TERRAIN, x, z);
// The trail from the south slope to the cabin porch; the hiker walks 25 m of it in 20 s, from s = 58 m.
const TRAIL = [[-2, 112], [2, 88], [6, 66], [8, 55], [14, 32], [20, 12], [27, -1]];
const S0 = 57.9, SPEED = 1.27;
let seed = 11;
const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

export default {
  slug: 'mountain-trail',
  title: 'Mountain Trail',
  async build(h) {
    h.op({ op: 'set_scene', patch: { name: 'Alpine valley', environment: { preset: 'stage', description: 'A wide alpine valley on an early-autumn morning: green-gold meadows, a still blue-green lake, dark pine stands, a lone timber cabin, a packed-dirt trail and granite ridges with fresh snow on the summits', style: `Photoreal outdoor adventure film. Low morning sun, crisp clear air, light haze on the distant ridges, natural colour. ${NO_BRANDS}` } } });
    h.add({ name: 'Alpine terrain', shape: 'terrain', model: 'terrain', kind: 'environment', position: TERRAIN.position, scale: TERRAIN.scale, color: '#7b8f4e', notes: 'Alpine valley floor of green-gold meadow grass and late wildflowers, granite ridges and scree slopes, fresh snow on the highest summits' });
    h.add({ name: 'Glacial lake', shape: 'cylinder', model: 'lake', kind: 'environment', position: [-45, 0.3, -45], scale: [60, 0.05, 50], color: '#2f7f8f', notes: 'Still glacial lake, deep blue-green, mirror reflections of the peaks' });
    // The trail: thin packed-dirt strips laid on the ground, following the slope.
    for (let i = 1; i < TRAIL.length; i++) {
      const [a, b] = [TRAIL[i - 1], TRAIL[i]], len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.ceil(len / 5);
      for (let k = 0; k < n; k++) {
        const u0 = k / n, u1 = (k + 1) / n, p0 = lerp(a, b, u0), p1 = lerp(a, b, u1), mid = lerp(a, b, (u0 + u1) / 2);
        const y0 = g(...p0), y1 = g(...p1), seg = len / n + 0.6;
        const name = `Trail ${i}.${k + 1}`;
        h.add({ name, shape: 'box', kind: 'environment', position: r3([mid[0], Math.max(y0, y1, g(...mid)) - 0.02, mid[1]]), rotation: Math.round(Math.atan2(b[0] - a[0], b[1] - a[1]) * 180 / Math.PI * 10) / 10,
          pitch: Math.round(Math.atan2(y1 - y0, len / n) * 180 / Math.PI * 10) / 10, scale: [1.3, 0.08, seg], color: '#9c8462', ...(name === 'Trail 1.1' ? { notes: 'Narrow packed-dirt hiking trail worn into the meadow' } : { lookFrom: 'Trail 1.1' }) });
      }
    }
    // The cabin (front and porch face the trail, +z).
    const C = [30, g(30, -10), -10];
    h.add({ name: 'Cabin', shape: 'box', kind: 'environment', position: r3(C), scale: [7, 3, 5], color: '#7a5636', notes: 'Small weathered log cabin with a dark green metal roof, a stone chimney and a covered front porch' });
    for (const [s, n] of [[1, 'south'], [-1, 'north']]) h.add({ name: `Cabin roof ${n}`, shape: 'box', kind: 'environment', position: r3([C[0], C[1] + 3.05, C[2] + s * 1.35]), pitch: -s * 32, scale: [7.8, 0.18, 3.35], color: '#2f4a3a' });
    h.add({ name: 'Cabin chimney', shape: 'box', kind: 'environment', position: r3([C[0] + 2.6, C[1] + 2.4, C[2] - 0.6]), scale: [0.7, 2.6, 0.7], color: '#8a8580' });
    h.add({ name: 'Cabin door', shape: 'box', kind: 'environment', position: r3([C[0] - 1, C[1] + 0.2, C[2] + 2.504]), scale: [1, 2, 0.06], color: '#4a3020' });
    h.add({ name: 'Cabin porch', shape: 'box', kind: 'environment', position: r3([C[0], C[1], C[2] + 3.4]), scale: [7, 0.2, 1.8], color: '#6b4a2e' });
    h.op({ op: 'group', ids: ['Cabin', 'Cabin roof south', 'Cabin roof north', 'Cabin chimney', 'Cabin door', 'Cabin porch'], name: 'Cabin set' });
    // A moraine ridge east of the trail: the aerial reveal starts low behind it.
    const ridge = [[49, 40, 9, 8, 12, 20], [51, 55, 8, 6.5, 11, -15], [47, 68, 7, 5, 9, 40], [53, 28, 6, 4.5, 8, 5]];
    ridge.forEach(([x, z, sx, sy, sz, rot], i) => h.add({ name: `Moraine ${i + 1}`, shape: 'rock', kind: 'environment', position: r3([x, g(x, z) - 0.4, z]), rotation: rot, scale: [sx, sy, sz], color: '#8a8478', ...(i ? { lookFrom: 'Moraine 1' } : { notes: 'Lichen-grey granite boulders piled into a low moraine ridge' }) }));
    h.op({ op: 'group', ids: ridge.map((_, i) => `Moraine ${i + 1}`), name: 'Moraine ridge' });
    // Boulders on the meadow (clear of the trail) and pine stands around the valley.
    for (const [i, [x, z, s]] of [[-18, 40, 1.6], [-30, 10, 2.2], [35, 60, 1.4], [-8, 20, 1.1], [24, 48, 1.3], [-55, 30, 2.6], [60, 0, 1.8], [-12, -12, 1.5]].entries())
      h.add({ name: `Boulder ${i + 1}`, shape: 'rock', kind: 'environment', position: r3([x, g(x, z) - 0.1, z]), rotation: Math.round(rand() * 360), scale: [s, s * 0.8, s * 1.1], color: '#8a8478', lookFrom: 'Moraine 1' });
    const stands = [['West shore', -80, -40, 9, 14], ['North wood', -10, -95, 8, 16], ['Behind the cabin', 48, -26, 6, 9], ['South slope', -32, 100, 7, 12], ['East slope', 112, 104, 6, 12]];
    let first = true;
    for (const [label, cx, cz, n, r] of stands) {
      const names = [];
      for (let i = 0; i < n; i++) {
        const x = cx + (rand() - 0.5) * 2 * r, z = cz + (rand() - 0.5) * 2 * r, s = 1 + rand() * 0.7, name = `Pine ${label} ${i + 1}`;
        names.push(name);
        h.add({ name, shape: 'tree', model: 'pine', kind: 'environment', position: r3([x, g(x, z) - 0.05, z]), scale: r3([s, s * 1.6, s]), color: '#2f5d3a', ...(first ? { notes: 'Tall dark-green subalpine firs and pines' } : { lookFrom: 'Pine West shore 1' }) });
        first = false;
      }
      h.op({ op: 'group', ids: names, name: `Pines · ${label}` });
    }
    await h.flush();

    // The hiker: the imported mannequin on its Walk clip, keyed along the trail at walking pace.
    const [x0, z0] = along(TRAIL, S0);
    await h.mannequin('Hiker', { colour: 'sand', position: [x0, g(x0, z0), z0] });
    h.op({ op: 'update_entity', id: 'Hiker', patch: { notes: 'An adult hiker in a teal waterproof shell jacket, charcoal trekking trousers, a rust-red daypack and brown leather boots; short dark hair, steady easy stride', styleNotes: 'Plain outdoor clothing without logos or lettering' } });
    await h.animate([{ object: 'Hiker', mode: 'replace', keys: walkKeys(TRAIL, { t0: 0, t1: 20, speed: SPEED, s0: S0, ground: g }) }]);
    await h.perform({ object: 'Hiker', clip: 'Walk', offset: 0, speed: 1 });
    const p = await h.project(), hiker = t => focusAt(p, 'Hiker', t);
    const lookStyle = (lens, filter = ['golden hour light', NO_BRANDS_TAG]) => ({ movement: [], cuts: ['continuous take, no cuts'], lens, filter });

    // 1 · Aerial reveal: low behind the moraine, rising forward over it to find the hiker in the open valley.
    const reveal = cameraKeys(5, 40, t => {
      const u = smooth(t / 5), x = 72 - 22 * u, z = 52 + 6 * u;
      return { p: [x, g(x, z) + 2.6 + 13 * u ** 1.25, z], look: lerp(hiker(t), [-30, 3, -30], 0.3 * u), mm: 32 };
    });
    // 2 · FPV dive: from high on the south slope, down the fall line, levelling off behind the hiker.
    const dive = cameraKeys(5, 50, t => {
      const u = 1 - (1 - t / 5) ** 2.2, end = hiker(5 + 5), [ex, ez] = [end[0] - 1.5, end[2] + 6.2];
      const x = -4 + (ex + 4) * u, z = 140 + (ez - 140) * u, alt = Math.max(1.6, 7 * (1 - u) + 2.2 * u - 2.4 * Math.sin(Math.PI * u));
      return { p: [x, g(x, z) + alt, z], look: hiker(5 + t), mm: 20 };
    });
    // 3 · Low tracking shot: level with the hiker's knees on their right, a little ahead, moving with them.
    const track = cameraKeys(5, 25, t => {
      const f = hiker(10 + t), [, , heading] = along(TRAIL, S0 + (10 + t) * SPEED), d = [Math.sin(heading), Math.cos(heading)], right = [-d[1], d[0]];
      const x = f[0] + right[0] * 4.2 + d[0] * 0.8, z = f[2] + right[1] * 4.2 + d[1] * 0.8;
      return { p: [x, g(x, z) + 0.6, z], look: [f[0], f[1] - 0.25, f[2]], mm: 28 };
    });
    // 4 · Locked-off wide from a bench on the south slope: the whole valley, the hiker small on the trail.
    const wideP = [-9, g(-9, 92) + 5, 92], wideLook = [-2, 1, -10];
    const shots = [
      { title: 'Ridge reveal', start: 0, description: '@hiker walks the trail across the open meadow toward the lake and the cabin, small in the wide valley; morning light rakes across the moraine boulders.', camera: { move: 'custom', target: 'Hiker', keys: reveal, timing: 'linear', mm: 32 }, style: { ...lookStyle(['35mm natural']), movement: ['drone flyover', 'crane up'] }, cast: { include: ['Hiker'], exclude: [] } },
      { title: 'Slope dive', start: 5, description: '@hiker strides along the trail at an easy pace at the foot of a steep grassy slope scattered with stones.', camera: { move: 'custom', target: 'Hiker', keys: dive, timing: 'linear', mm: 20 }, style: { ...lookStyle(['24mm wide']), movement: ['FPV drone chase'] }, cast: { include: ['Hiker'], exclude: [] } },
      { title: 'Trail track', start: 10, description: '@hiker walks steadily along the packed-dirt trail, boots scuffing a little dust, the daypack swaying with each step; the lake and the pines lie beyond.', camera: { move: 'custom', target: 'Hiker', keys: track, timing: 'linear', mm: 28 }, style: { ...lookStyle(['24mm wide', 'deep focus']), movement: ['tracking shot'] } },
      { title: 'Valley wide', start: 15, description: '@hiker crosses the meadow on the trail toward the cabin; the lake lies still and the peaks stand clear beyond.', camera: { move: 'custom', target: 'Hiker', keys: [{ t: 0, p: r3(wideP), look: wideLook, mm: 24 }, { t: 1, p: r3(wideP), look: wideLook, mm: 24 }], mm: 24 }, style: { ...lookStyle(['24mm wide', 'deep focus']), movement: ['static locked-off shot'] }, cast: { include: ['Hiker'], exclude: [] } },
    ];
    shots.forEach((s, i) => h.op(i === 0 ? { op: 'update_shot', id: 1, patch: { ...s, duration: 5 } } : { op: 'add_shot', shot: { ...s, duration: 5 } }));
    await h.flush();
    // add_shot takes title, description, duration, start and camera; style and cast are set on the shot after.
    shots.forEach((s, i) => h.op({ op: 'update_shot', id: i + 1, patch: { style: s.style, ...(s.cast ? { cast: s.cast } : {}) } }));
    await h.flush();
  },
};
