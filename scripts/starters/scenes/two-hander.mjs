// Two-Hander: dialogue coverage at a café table. Two seated mannequins (sit pose, keyed gestures, an IK reach for a
// cup), a barista behind the counter sent to models as the neutral stand-in, and coverage with lens changes:
// a master, two over-the-shoulders on the 180° line, an insert and a zooming close-up.
import { RIG_POSES } from '../../../shared/rig.mjs';
import { NO_BRANDS, NO_BRANDS_TAG, cameraKeys, lerp, smooth, r3 } from '../kit.mjs';

const SIT = RIG_POSES.sit;
const pose = extra => ({ ...SIT, ...extra });
const ADA = [-0.67, 0, 0], BEN = [0.67, 0, 0];           // feet; each faces the table (+x for Ada, -x for Ben)
const CUP = [-0.27, 0.75, 0.12];

export default {
  slug: 'two-hander',
  title: 'Two-Hander',
  async build(h) {
    h.op({ op: 'set_scene', patch: { name: 'Corner café', environment: { preset: 'interior', description: 'A small neighbourhood café in the late afternoon: warm wood floor, a sage-green back wall with a tall window, a counter with a coffee machine, a pendant lamp over a round table', style: `Photoreal intimate drama. Soft window light from the left, warm practical lamp, shallow depth, natural skin tones. ${NO_BRANDS}` } } });
    h.add({ name: 'Floor', shape: 'box', kind: 'environment', position: [0, -0.05, 0], scale: [9, 0.05, 7], color: '#8a6446', notes: 'Warm oak floorboards' });
    h.add({ name: 'Back wall', shape: 'wall', kind: 'environment', position: [0, 0, -2.6], scale: [1.12, 1.1, 1], color: '#8fa38a', notes: 'A sage-green painted plaster wall' });
    h.add({ name: 'Side wall', shape: 'wall', kind: 'environment', position: [-4.4, 0, 0.6], rotation: 90, scale: [0.8, 1.1, 1], color: '#8fa38a', lookFrom: 'Back wall' });
    h.add({ name: 'Window', shape: 'box', kind: 'environment', position: [-4.26, 0.9, -0.3], rotation: 90, scale: [1.6, 1.8, 0.04], color: '#d8e6ee', notes: 'A tall multi-pane window with soft daylight; nothing written on the glass' });
    h.add({ name: 'Counter', shape: 'box', kind: 'environment', position: [2.4, 0, -1.9], scale: [3.2, 1.05, 0.7], color: '#5b4636', notes: 'A dark wood café counter with a plain steel coffee machine; no brand names' });
    h.add({ name: 'Coffee machine', shape: 'box', kind: 'environment', position: [2.9, 1.05, -2.0], scale: [0.7, 0.5, 0.45], color: '#b8bcc0', lookFrom: 'Counter' });
    h.add({ name: 'Café table', shape: 'table', kind: 'prop', position: [0, 0, 0], scale: [0.6, 1, 0.9], color: '#a07a55', notes: 'A small round wooden café table' });
    for (const [n, x, rot] of [['Ada’s chair', -1.1, 90], ['Ben’s chair', 1.1, 270]]) h.add({ name: n, shape: 'chair', kind: 'prop', position: [x, 0, 0], rotation: rot, color: '#6b4f38', ...(x < 0 ? { notes: 'Bentwood café chairs in dark wood' } : { lookFrom: 'Ada’s chair' }) });
    h.add({ name: 'Ada’s cup', shape: 'cylinder', kind: 'prop', position: CUP, scale: [0.11, 0.09, 0.11], color: '#f2efe8', notes: 'A plain white ceramic coffee cup on a saucer' });
    h.add({ name: 'Ben’s cup', shape: 'cylinder', kind: 'prop', position: [0.27, 0.75, -0.12], scale: [0.11, 0.09, 0.11], color: '#f2efe8', lookFrom: 'Ada’s cup' });
    h.add({ name: 'Pendant lamp', shape: 'cylinder', kind: 'environment', position: [0, 1.75, 0], scale: [0.5, 0.2, 0.5], color: '#d9a441', notes: 'A brass pendant lamp glowing warmly over the table' });
    h.add({ name: 'Plant', shape: 'tree', kind: 'environment', position: [-3.6, 0, -2], scale: [0.45, 0.4, 0.45], color: '#4f7f4a', notes: 'A potted fig in a terracotta pot' });
    h.op({ op: 'group', ids: ['Floor', 'Back wall', 'Side wall', 'Window', 'Counter', 'Coffee machine', 'Pendant lamp', 'Plant'], name: 'Café set' });
    h.op({ op: 'group', ids: ['Café table', 'Ada’s chair', 'Ben’s chair', 'Ada’s cup', 'Ben’s cup'], name: 'Table' });
    await h.flush();

    // The pair: imported mannequins in the sit pose; gestures and the reach are pose keys (IK for the hand).
    await h.mannequin('Ada', { colour: 'sand', position: ADA, rotation: 90 });
    await h.mannequin('Ben', { colour: 'slate', position: BEN, rotation: 270 });
    await h.mannequin('Barista', { colour: 'sand', position: [2.3, 0, -2.75], rotation: 0 });
    h.op({ op: 'update_entity', id: 'Ada', patch: { notes: 'A woman in her forties with a short dark bob and round tortoiseshell glasses, a mustard cardigan over a cream blouse', styleNotes: 'Plain clothing without logos or lettering' } });
    h.op({ op: 'update_entity', id: 'Ben', patch: { notes: 'A man in his late twenties with close-cropped curly black hair and light stubble, a forest-green bomber jacket over a grey T-shirt', styleNotes: 'Plain clothing without logos or lettering' } });
    h.op({ op: 'update_entity', id: 'Barista', patch: { notes: 'A café worker in a plain dark apron over a white shirt, wiping the counter', styleNotes: 'Plain clothing without logos or lettering' } });
    // Positions are keyed (still) so performances key at moments rather than replacing the default pose.
    await h.animate(['Ada', 'Ben'].map(object => ({ object, mode: 'replace', keys: [{ t: 0, position: object === 'Ada' ? ADA : BEN, rotation: object === 'Ada' ? 90 : 270 }, { t: 20, position: object === 'Ada' ? ADA : BEN, rotation: object === 'Ada' ? 90 : 270 }] })));
    await h.perform({ object: 'Ada', clip: null, pose: 'sit' });
    await h.perform({ object: 'Ben', clip: null, pose: 'sit' });
    await h.perform({ object: 'Barista', clip: 'Idle', standIn: 'neutral' });
    const key = (object, at, extra) => h.perform({ object, at, pose: pose(extra) });
    // Ada talks: an open right hand rises and settles (0–9 s); Ben nods; Ben answers with his left hand (10–14 s).
    for (const [t, extra] of [[0, {}], [1.2, { armR: [-40, 0, -70], forearmR: [0, 70, 0], head: [0, -8, 0] }], [2.6, { armR: [-30, 0, -72], forearmR: [0, 50, 0], head: [0, 6, 0] }], [4, {}], [5.5, { armR: [-45, 0, -66], forearmR: [0, 80, 0] }], [7, { armR: [-38, 0, -70], forearmR: [0, 60, 0], head: [-6, 0, 0] }], [9, {}], [15.2, {}]]) await key('Ada', t, extra);
    for (const [t, extra] of [[0, {}], [3.2, { head: [12, 0, 0] }], [3.8, { head: [-2, 0, 0] }], [4.4, { head: [10, 0, 0] }], [5, {}], [10.4, {}], [11.2, { armL: [-42, 0, -68], forearmL: [0, -75, 0], head: [0, 8, 0] }], [12.8, { armL: [-30, 0, -72], forearmL: [0, -55, 0], head: [-6, -6, 0] }], [14.2, {}], [16.5, { head: [6, 8, 0] }]]) await key('Ben', t, extra);
    // The reach: IK puts Ada's right hand on her cup (her frame: x her left, z her front, origin at her feet).
    const local = [-(CUP[2] - ADA[2]), CUP[1] + 0.05, CUP[0] - ADA[0]];
    await h.perform({ object: 'Ada', at: 16.6, pose: pose({}), ik: { handR: r3(local) } });
    await h.perform({ object: 'Ada', at: 18.4, pose: pose({}), ik: { handR: r3([local[0], local[1] + 0.02, local[2]]) } });
    // Seated, the head is over the chair (behind the feet, which are the object's origin), about 1.2 m up.
    const face = n => (n === 'Ada' ? [-1.06, 1.2, 0] : [1.06, 1.2, 0]);
    const shots = [
      { title: 'Master', start: 0, duration: 5, description: '@ada leans in and explains something with an open hand; @ben listens and nods slowly.', camera: { move: 'custom', target: 'Ada', timing: 'linear', keys: cameraKeys(5, 10, t => ({ p: [0.1, 1.25, 2.9 - 0.25 * smooth(t / 5)], look: [0, 0.92, 0], mm: 32 })) }, lens: ['32mm'] },
      { title: 'Over Ben · on Ada', start: 5, duration: 5, description: '@ada keeps talking, her hand rising and settling as she makes her point, eyes on @ben.', camera: { move: 'custom', target: 'Ada', timing: 'linear', keys: cameraKeys(5, 10, t => ({ p: [1.95, 1.32, 0.55 + 0.05 * t / 5], look: lerp(face('Ada'), [0, 1.1, 0], 0.12), mm: 50 })) }, lens: ['50mm', 'shallow depth of field'] },
      { title: 'Over Ada · on Ben', start: 10, duration: 5, description: '@ben answers with a small shrug and an open left hand, half smiling at @ada.', camera: { move: 'custom', target: 'Ben', timing: 'linear', keys: cameraKeys(5, 10, t => ({ p: [-1.95, 1.32, 0.55 + 0.05 * t / 5], look: lerp(face('Ben'), [0, 1.1, 0], 0.12), mm: 50 })) }, lens: ['50mm', 'shallow depth of field'] },
      { title: 'Insert · cup', start: 15, duration: 4, description: '@ada’s hand comes to rest around @ada-s-cup on its saucer and her fingers settle on the handle.', camera: { move: 'custom', target: 'Ada’s cup', timing: 'linear', keys: cameraKeys(4, 8, t => ({ p: [0.25, 1.02, 1.05], look: [CUP[0] - 0.05, 0.82, CUP[2]], mm: 70 })) }, lens: ['70mm', 'macro'] },
      { title: 'Close-up · zoom on Ben', start: 16, duration: 4, description: '@ben watches @ada and gives a slow, thoughtful nod.', camera: { move: 'custom', target: 'Ben', timing: 'linear', keys: cameraKeys(4, 16, t => ({ p: [-1.2, 1.25, 1.6], look: lerp(face('Ben'), [0.67, 1.53, 0], 0.3), mm: 50 + 20 * smooth(t / 4) })) }, lens: ['70mm', 'shallow depth of field'] },
    ];
    shots.forEach((s, i) => { const { lens, ...shot } = s; h.op(i === 0 ? { op: 'update_shot', id: 1, patch: shot } : { op: 'add_shot', shot }); });
    await h.flush();
    shots.forEach((s, i) => h.op({ op: 'update_shot', id: i + 1, patch: { style: { movement: [], cuts: ['hard cut'], lens: s.lens, filter: [NO_BRANDS_TAG] } } }));
    await h.flush();
  },
};
