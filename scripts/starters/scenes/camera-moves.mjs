// Lighthouse · Camera Moves: a lighthouse on a rocky headland, its keeper and a fishing boat. Every MOVES preset on
// the same four seconds (the keeper stands still, so only the camera differs), custom-key showcases, and shot pairs that
// craft transitions in the blockout (whip to whip, match cut, cut on action, foreground wipe) for the Cut's hard cuts.
import { NO_BRANDS, NO_BRANDS_TAG, walkKeys, cameraKeys, focusAt, lerp, smooth, r3 } from '../kit.mjs';

const TOP = 3.1;                       // the headland's grass
const K0 = [-6, TOP, 6];               // the keeper's lookout at the cliff edge
const DOOR = [0, TOP, 1.6];            // in front of the lighthouse door
const HINGE = [-0.55, TOP, 0.12];
const rad = d => d * Math.PI / 180;
const yawLook = (p, yaw, pitch = -4, dist = 20) => [p[0] + dist * Math.sin(rad(yaw)) * Math.cos(rad(pitch)), p[1] + dist * Math.sin(rad(pitch)), p[2] + dist * Math.cos(rad(yaw)) * Math.cos(rad(pitch))];
const yawTo = (p, q) => Math.atan2(q[0] - p[0], q[2] - p[2]) * 180 / Math.PI;
// The wipe: a 9 m truck left past the wipe rock, its midpoint at WIPE_MID, facing the pier (WIPE_F) — shots A and B are its halves.
const WIPE_MID = [4, TOP + 1.5, 5.6], WIPE_F = [0.357, 0.934], WIPE_LEFT = [0.934, -0.357];
const BOAT = [[0, -40, 48], [4, -32, 47], [8, -24, 45], [12, -16, 42], [16, -8, 38], [20, 0, 34], [24, 6, 30], [28, 10, 25.5], [32, 10.2, 21.5], [35, 8.4, 19], [39, 8.4, 18.6]];

export default {
  slug: 'camera-moves',
  title: 'Lighthouse · Camera Moves',
  leaveFrame: ['Whip pan A · out', 'Whip pan B · in'],
  async build(h) {
    h.op({ op: 'set_scene', patch: { name: 'Lighthouse point', environment: { preset: 'stage', description: 'A rocky headland in a sheltered bay on a bright breezy morning: a white lighthouse with a red cap, a small stone cottage, a high stone pier, a rock arch in the sea and green hills around the bay', style: `Photoreal coastal film. Clear morning sun, deep blue water with gentle swell, crisp natural colour. ${NO_BRANDS}` } } });
    h.add({ name: 'Bay hills', shape: 'terrain', model: 'terrain', kind: 'environment', position: [0, -2, 0], scale: [1.3, 0.35, 1.3], color: '#6f8f4e', notes: 'Green hills and pale cliffs ringing the bay' });
    const sea = [];
    for (const x of [-100, -50, 0, 50, 100]) for (const z of [-100, -50, 0, 50, 100]) { const n = `Sea ${sea.length + 1}`; sea.push(n); h.add({ name: n, shape: 'box', kind: 'environment', position: [x, -0.1, z], scale: [50, 0.1, 50], color: '#2e6a86', ...(sea.length === 1 ? { notes: 'Calm deep blue-green sea with a gentle swell' } : { lookFrom: 'Sea 1' }) }); }
    h.op({ op: 'group', ids: sea, name: 'Sea' });
    // The headland, its grass, the cliff rocks, the arch and the pier.
    h.add({ name: 'Headland', shape: 'box', kind: 'environment', position: [0, 0, 0], scale: [26, 3, 18], color: '#857d70', notes: 'A blunt granite headland with weathered grey cliffs' });
    h.add({ name: 'Headland grass', shape: 'box', kind: 'environment', position: [0, 3, 0], scale: [25.6, 0.1, 17.6], color: '#6f9a4e', notes: 'Short wind-flattened grass on the clifftop' });
    h.add({ name: 'Path', shape: 'box', kind: 'environment', position: [-4.5, TOP + 0.002, 2.6], rotation: 115, scale: [1.2, 0.04, 9.5], color: '#a89f8c', notes: 'A worn gravel footpath' });
    const rocks = [[-14, 6, 3.2, 3, 3], [-13, -5, 2.8, 2.6, 3.4], [12, -7, 3, 2.8, 3], [14, 3, 2.6, 2.4, 2.8], [-5, 10.5, 3.4, 1.6, 2.4], [9, 10, 2, 1.4, 2]];
    rocks.forEach(([x, z, sx, sy, sz], i) => h.add({ name: `Cliff rock ${i + 1}`, shape: 'rock', kind: 'environment', position: [x, -0.6, z], rotation: i * 47 % 360, scale: [sx, sy, sz], color: '#7a7368', ...(i ? { lookFrom: 'Cliff rock 1' } : { notes: 'Dark wet granite boulders at the waterline' }) }));
    for (const [n, x] of [['Arch pillar west', -9.5], ['Arch pillar east', -2.5]]) h.add({ name: n, shape: 'rock', kind: 'environment', position: [x, -0.5, 22], scale: [2, 6.3, 2.2], color: '#7a7368', lookFrom: 'Cliff rock 1' });
    h.add({ name: 'Arch top', shape: 'rock', kind: 'environment', position: [-6, 5.6, 22], scale: [6.6, 1.5, 2.2], color: '#7a7368', notes: 'A natural sea arch of dark granite' });
    h.op({ op: 'group', ids: ['Arch pillar west', 'Arch pillar east', 'Arch top'], name: 'Sea arch' });
    h.add({ name: 'Pier', shape: 'box', kind: 'environment', position: [6, 2.7, 16], scale: [2, 0.4, 14], color: '#8f877a', notes: 'A narrow high stone pier' });
    // The wipe rock: one continuous truck passes behind it; shot A ends covered by it and shot B starts there.
    h.add({ name: 'Wipe rock', shape: 'rock', kind: 'environment', position: r3([WIPE_MID[0] + WIPE_F[0] * 1.5, TOP, WIPE_MID[2] + WIPE_F[1] * 1.5]), rotation: 20, scale: [2.4, 2.6, 2.2], color: '#7a7368', lookFrom: 'Cliff rock 1' });
    h.op({ op: 'group', ids: ['Headland', 'Headland grass', 'Path', 'Pier', 'Wipe rock', ...rocks.map((_, i) => `Cliff rock ${i + 1}`)], name: 'Headland set' });
    // Lighthouse (centre 0, -2), its door, and the keeper's cottage.
    h.add({ name: 'Lighthouse', shape: 'cylinder', kind: 'environment', position: [0, TOP, -2], scale: [5, 10, 5], color: '#eceae4', notes: 'A tall white-painted round stone lighthouse tower' });
    h.add({ name: 'Gallery', shape: 'cylinder', kind: 'environment', position: [0, TOP + 12, -2], scale: [7, 0.2, 7], color: '#2f3336', notes: 'A black iron gallery with a railing' });
    h.add({ name: 'Lantern', shape: 'cylinder', kind: 'prop', position: [0, TOP + 12.24, -2], scale: [4, 1.8, 4], color: '#3c4a50', notes: 'The round glass lantern room of the lighthouse, a bright lamp glowing behind the panes' });
    h.add({ name: 'Lighthouse cap', shape: 'cylinder', kind: 'environment', position: [0, TOP + 14.4, -2], scale: [4.6, 0.5, 4.6], color: '#b5322c', notes: 'A red domed lighthouse cap' });
    h.add({ name: 'Doorway', shape: 'box', kind: 'environment', position: [0, TOP, 0.004], scale: [1.1, 2.1, 0.06], color: '#141414' });
    h.add({ name: 'Lighthouse door', shape: 'box', kind: 'prop', position: [0, TOP, 0.12], scale: [1.1, 2.1, 0.08], color: '#2d5a7a', notes: 'A heavy painted blue wooden door with iron hinges' });
    h.op({ op: 'group', ids: ['Lighthouse', 'Gallery', 'Lantern', 'Lighthouse cap', 'Doorway', 'Lighthouse door'], name: 'Lighthouse set' });
    h.add({ name: 'Cottage', shape: 'box', kind: 'environment', position: [-8.5, TOP, -3.5], scale: [6, 2.8, 4.5], color: '#d8d2c4', notes: 'A small whitewashed stone cottage with a slate roof' });
    for (const [s, n] of [[1, 'south'], [-1, 'north']]) h.add({ name: `Cottage roof ${n}`, shape: 'box', kind: 'environment', position: [-8.5, TOP + 2.85, -3.5 + s * 1.2], pitch: -s * 30, scale: [6.6, 0.16, 2.9], color: '#4a5058' });
    h.op({ op: 'group', ids: ['Cottage', 'Cottage roof south', 'Cottage roof north'], name: 'Cottage set' });
    // The boat (hull, wheelhouse and mast keyed together) and the buoy.
    h.add({ name: 'Fishing boat', shape: 'box', kind: 'vehicle', position: [-40, -0.35, 48], scale: [2.6, 1.1, 7], color: '#b8432a', notes: 'A small wooden fishing boat with a red hull, a white wheelhouse and a short mast; no name, numbers or lettering' });
    h.add({ name: 'Wheelhouse', shape: 'box', kind: 'vehicle', position: [-40, 0.75, 48], scale: [1.8, 1.4, 2], color: '#efeee8' });
    h.add({ name: 'Mast', shape: 'cylinder', kind: 'vehicle', position: [-40, 2.15, 48], scale: [0.19, 2.6, 0.19], color: '#5a4630' });
    h.op({ op: 'group', ids: ['Fishing boat', 'Wheelhouse', 'Mast'], name: 'Boat' });
    h.add({ name: 'Buoy', shape: 'sphere', kind: 'prop', position: [-1, -0.3, 29], scale: [1.4, 1.4, 1.4], color: '#c8352c', notes: 'A round red-and-white mooring buoy' });
    await h.flush();
    await h.animate(['Fishing boat', 'Wheelhouse', 'Mast'].map((object, i) => ({ object, mode: 'replace', keys: BOAT.map(([t, x, z]) => ({ t, position: [x, [-0.35, 0.75, 2.15][i], z] })) })));
    // The door swings open outward about its hinge, 26.2–27.6 s.
    await h.animate([{ object: 'Lighthouse door', mode: 'replace', keys: [0, 25, 50, 75, 100].map((a, i) => ({ t: 26.2 + i * 0.35, rotation: -a, position: r3([HINGE[0] + 0.55 * Math.cos(rad(a)), TOP, HINGE[2] + 0.55 * Math.sin(rad(a))]), ease: 'smoothstep' })) }]);

    // The keeper: stands at the lookout (Idle), waves to the boat, walks to the door, opens it and goes in.
    await h.mannequin('Keeper', { colour: 'slate', position: K0, rotation: 0 });
    h.op({ op: 'update_entity', id: 'Keeper', patch: { notes: 'A lighthouse keeper in a navy wool sweater, dark oilskin trousers, black rubber boots and a grey knit cap; weathered face, short grey beard', styleNotes: 'Plain workwear without logos or lettering' } });
    const walk = walkKeys([[K0[0], K0[2]], [-2.5, 4.5], [DOOR[0], DOOR[2]]], { t0: 20.7, t1: 26, ground: () => TOP, step: 0.53 });
    const inside = walkKeys([[DOOR[0], DOOR[2]], [0, -1.5]], { t0: 27.8, t1: 30.2, ground: () => TOP, step: 0.6 });
    await h.animate([{ object: 'Keeper', mode: 'replace', keys: [{ t: 0, position: K0, rotation: 0 }, { t: 4.5, position: K0, rotation: 0 }, { t: 7, position: K0, rotation: -20 }, { t: 20.7, position: K0, rotation: -20 },
      ...walk.map(k => ({ ...k, rotation: Math.round(Math.atan2(DOOR[0] - K0[0], DOOR[2] - K0[2]) * 180 / Math.PI) })), { t: 27.8, position: DOOR, rotation: 180 }, ...inside.slice(1).map(k => ({ ...k, rotation: 180 }))] }]);
    await h.perform({ object: 'Keeper', clip: 'Idle' });
    await h.perform({ object: 'Keeper', clip: 'Wave', at: 4.5, offset: 0 });
    await h.perform({ object: 'Keeper', clip: 'Idle', at: 7.6 });
    await h.perform({ object: 'Keeper', clip: 'Walk', at: 20.7 });
    await h.perform({ object: 'Keeper', clip: 'Idle', at: 26 });
    await h.perform({ object: 'Keeper', clip: 'Walk', at: 27.8 });
    const p = await h.project(), at = (n, t) => focusAt(p, n, t), keeper = at('Keeper', 0);

    const still = '@keeper stands at the cliff edge in the breeze, watching the sea, then glances along the coast; the white lighthouse stands behind.';
    const preset = (title, move, camera, movement) => ({ title, start: 0, description: still, camera: { move, target: 'Keeper', mm: 35, ...camera }, movement });
    const dirFromTower = [-0.6, 0.8];
    const shots = [
      preset('Locked-off', 'static', { distance: 7, height: 4.4, angle: -10 }, ['static locked-off shot']),
      preset('Dolly in', 'dolly-in', { distance: 8, height: 4.5, angle: -20 }, ['slow push-in']),
      preset('Dolly out', 'dolly-out', { distance: 8, height: 4.5, angle: -45 }, ['slow pull-out']),
      preset('Truck left', 'truck-left', { distance: 7, height: 4.5, angle: -30 }, ['tracking shot']),
      preset('Truck right', 'truck-right', { distance: 7, height: 4.5, angle: -30 }, ['tracking shot']),
      preset('Pan left', 'pan-left', { distance: 7, height: 4.5, angle: 0 }, ['slow pan']),
      preset('Pan right', 'pan-right', { distance: 7, height: 4.5, angle: -60 }, ['slow pan']),
      preset('Orbit left', 'orbit-left', { distance: 7, height: 4.6, angle: 0 }, ['orbit around the subject']),
      preset('Orbit right', 'orbit-right', { distance: 7, height: 4.6, angle: -60 }, ['orbit around the subject']),
      preset('Crane up', 'crane-up', { distance: 8, height: 4.2, angle: -20 }, ['crane up']),
      preset('Crane down', 'crane-down', { distance: 8, height: 4.2, angle: -20 }, ['crane down']),
      preset('Tilt up', 'tilt-up', { distance: 12, height: 3.6, angle: 0, mm: 24 }, ['tilt up']),
      // Dolly zoom: back from 5 m to 12 m while the lens goes 24 → 58 mm; the keeper holds size, the tower looms.
      { title: 'Dolly zoom (vertigo)', start: 0, description: still, movement: ['dolly zoom'], camera: { move: 'custom', target: 'Keeper', timing: 'linear', keys: cameraKeys(4, 32, t => { const u = smooth(t / 4), d = 5 + 7 * u; return { p: [keeper[0] + dirFromTower[0] * d, 4.6, keeper[2] + dirFromTower[1] * d], look: keeper, mm: 24 * d / 5 }; }) } },
      // FPV: low over the water, through the sea arch, up the cliff face to the keeper.
      { title: 'FPV fly-through', start: 0, description: still, movement: ['FPV drone chase'], camera: { move: 'custom', target: 'Keeper', timing: 'linear', keys: cameraKeys(4, 40, t => { const u = t / 4, z = 46 - 35 * u ** 1.15, y = z > 20 ? 1.6 + 0.04 * (46 - z) : 2.6 + 0.42 * (20 - z); return { p: [-6 + 0.6 * Math.sin(u * 5), y, z], look: lerp([-6, 2.5, 0], keeper, Math.min(1, u * 1.4)), mm: 20 }; }) } },
      // Handheld: a medium shot with a small, deterministic operator wobble (sums of sines, a few centimetres).
      { title: 'Handheld', start: 0, description: still, movement: ['handheld'], camera: { move: 'custom', target: 'Keeper', timing: 'linear', keys: cameraKeys(4, 63, t => { const n = (a, b, c) => 0.02 * Math.sin(t * a) + 0.012 * Math.sin(t * b + 1.3) + 0.006 * Math.sin(t * c + 0.4); const base = [keeper[0] + 1.2, 4.55, keeper[2] + 4.2]; return { p: [base[0] + n(3.1, 7.3, 13), base[1] + n(4.3, 9.1, 15), base[2] + n(2.7, 6.1, 11)], look: [keeper[0] + 2 * n(5.2, 8.7, 17), keeper[1] + 2 * n(3.7, 10.3, 19), keeper[2]], mm: 40 }; }) } },
      // Push-in with a lens change 35 → 50 mm (focus is not modelled in the blockout; rack focus stays a note).
      { title: 'Push-in + lens change', start: 0, description: still, movement: ['slow push-in'], lens: ['rack focus', 'shallow depth of field'], camera: { move: 'custom', target: 'Keeper', timing: 'linear', keys: cameraKeys(4, 16, t => { const u = smooth(t / 4), d = 8 - 3.5 * u; return { p: [keeper[0] + 0.5 * d, 4.5, keeper[2] + 0.87 * d], look: keeper, mm: 35 + 15 * u }; }) } },
    ];
    // Whip pan pair: A holds on the keeper waving, then whips right; B arrives mid-whip and settles on the boat.
    const W = [-1, TOP + 1.5, 12], kYaw = yawTo(W, at('Keeper', 4)), bYaw = t => yawTo(W, at('Fishing boat', t)), mid = kYaw + 55;
    shots.push({ title: 'Whip pan A · out', start: 4, description: '@keeper spots @fishing-boat out in the bay and waves an arm high in greeting.', movement: ['whip pan'], cuts: ['hard cut', 'whip pan to whip pan'], camera: { move: 'custom', target: 'Keeper', timing: 'linear', keys: cameraKeys(4, 40, t => { const f = at('Keeper', 4 + t); if (t <= 3) return { p: W, look: f, mm: 35 }; const u = ((t - 3) / 1) ** 2; return { p: W, look: yawLook(W, yawTo(W, f) + 55 * u, -4 + 2 * u, Math.hypot(f[0] - W[0], f[2] - W[2])), mm: 35 }; }) } });
    shots.push({ title: 'Whip pan B · in', start: 8, description: '@fishing-boat motors slowly across the bay toward the headland, a low wake curling behind it.', movement: ['whip pan'], cuts: ['hard cut', 'whip pan to whip pan'], camera: { move: 'custom', target: 'Fishing boat', timing: 'linear', keys: cameraKeys(4, 40, t => { const f = at('Fishing boat', 8 + t); if (t >= 0.6) return { p: W, look: f, mm: 35 }; const u = 1 - (1 - t / 0.6) ** 2; return { p: W, look: yawLook(W, mid + (bYaw(8.6) - mid) * u, -2 - 2 * u, 30), mm: 35 }; }) } });
    // Match cut pair: A ends on the round lantern centred; B starts on the round buoy at the same place and size.
    const lantern = at('Lantern', 12), buoy = at('Buoy', 16);
    shots.push({ title: 'Match cut A · lantern', start: 12, description: '@lantern glows behind its panes at the top of the tower; gulls wheel past the gallery.', cuts: ['match cut'], movement: ['slow push-in'], camera: { move: 'custom', target: 'Lantern', timing: 'linear', keys: cameraKeys(4, 16, t => { const u = smooth(t / 4); return { p: lerp([9, 12, 22], [4.4, 15.4, 11.2], u), look: lantern, mm: 50 }; }) } });
    shots.push({ title: 'Match cut B · buoy', start: 16, description: '@buoy rides the swell while @fishing-boat passes beyond it, heading in toward the headland.', cuts: ['match cut'], movement: ['slow pull-out'], camera: { move: 'custom', target: 'Buoy', timing: 'linear', keys: cameraKeys(4, 16, t => { const u = smooth(t / 4); const dir = [0.39, -0.92], d = 8.4 + 6 * u; return { p: [buoy[0] + dir[0] * d, buoy[1] + 1.1 + 0.15 * d * u, buoy[2] + dir[1] * d], look: lerp(buoy, [buoy[0] - 1.2, buoy[1] + 0.3, buoy[2] + 3], u), mm: 50 - 15 * u }; }) } });
    // Cut on action: A (wide) cuts as the door swings; B (closer, from the side) picks the swing up and follows the keeper in.
    shots.push({ title: 'Cut on action A · wide', start: 23, description: '@keeper walks up the gravel path to the lighthouse and hauls open @lighthouse-door.', cuts: ['cut on action'], movement: [], camera: { move: 'custom', target: 'Keeper', timing: 'linear', keys: cameraKeys(4, 8, t => ({ p: [-9.6 + 0.3 * t / 4, 5.4, 10.6], look: lerp(at('Keeper', 23 + t), [0, 4.4, 1], 0.35), mm: 35 })) } });
    shots.push({ title: 'Cut on action B · close', start: 26.8, description: '@lighthouse-door swings wide and @keeper steps through the dark doorway into the tower.', cuts: ['cut on action'], movement: [], camera: { move: 'custom', target: 'Keeper', timing: 'linear', keys: cameraKeys(4, 8, t => ({ p: [4.2 - 0.3 * t / 4, TOP + 1.5, 4.4], look: lerp([0, TOP + 1.2, 0.8], at('Keeper', 26.8 + t), 0.5), mm: 40 })) } });
    // Foreground wipe: one constant-speed truck left, 9 m over 8 s. A is its first half and ends covered by the wipe rock;
    // B is its second half, so it starts covered and the rock clears to the right.
    const wipe = half => cameraKeys(4, 24, t => { const u = (half * 4 + t) / 8 - 0.5, b = at('Fishing boat', 31 + half * 4 + t); return { p: [WIPE_MID[0] + WIPE_LEFT[0] * 9 * u, WIPE_MID[1], WIPE_MID[2] + WIPE_LEFT[1] * 9 * u], look: b, mm: 35 }; });
    shots.push({ title: 'Wipe A · foreground rock', start: 31, description: '@fishing-boat glides in toward the stone pier, slowing as it nears the cliff.', cuts: ['hard cut', 'in-camera foreground wipe'], movement: ['tracking shot'], camera: { move: 'custom', target: 'Fishing boat', timing: 'linear', keys: wipe(0) } });
    shots.push({ title: 'Wipe B · reveal', start: 35, description: '@fishing-boat comes to rest alongside the stone pier below the lighthouse, rocking gently.', cuts: ['hard cut', 'in-camera foreground wipe'], movement: ['tracking shot'], camera: { move: 'custom', target: 'Fishing boat', timing: 'linear', keys: wipe(1) } });

    shots.forEach((s, i) => { const { movement, cuts, lens, ...shot } = s; h.op(i === 0 ? { op: 'update_shot', id: 1, patch: { ...shot, duration: 4 } } : { op: 'add_shot', shot: { ...shot, duration: 4 } }); });
    await h.flush();
    shots.forEach((s, i) => h.op({ op: 'update_shot', id: i + 1, patch: { style: { movement: s.movement || [], cuts: s.cuts || ['continuous take, no cuts'], lens: [`${Math.round(s.camera.keys?.[0].mm ?? s.camera.mm)}mm`, ...(s.lens || [])], filter: ['deep focus', NO_BRANDS_TAG] }, cast: { include: [...new Set([s.camera.target])], exclude: [] } } }));
    await h.flush();
  },
};
