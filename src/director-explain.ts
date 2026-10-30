// Explainers: tiny looping 3D scenes that show how the viewport works (navigate, select, move/rotate/
// resize, groups, animate, fly the camera, the camera rig), plus inline SVG diagrams for keyboard,
// gamepad and phone camera controls, phone pairing and what a video model takes.
// Same pattern as director-camhelp: one shared, lazily created WebGL renderer draws every mounted
// explainer into its own 2D canvas; the loop runs only while one is on screen (IntersectionObserver,
// document.hidden) and the renderer is disposed after an idle. Reduced motion shows one still frame
// with its key badges; Play starts it on request. Dragging across a scene scrubs it.
import './director-explain.css';
import * as THREE from 'three';
import { KIND_COLORS } from '../shared/prompt.mjs';
import { LAYOUTS } from '../shared/camera-operate.mjs';
import { h } from './director-common';

type Vec3 = [number, number, number];
type Pose = { p: Vec3; look: Vec3; mm: number };
type Obj = 'person' | 'crate' | 'car' | 'tree';
type Anchor = Obj | [number, number] | [Obj, number, number];
type Pointer = { from: Anchor; to: Anchor; k: number; btn?: 'left' | 'right' | 'wheel'; click?: number };
type Frame = {
  view: Pose;
  objs?: Partial<Record<Obj, { p?: Vec3; yaw?: number; s?: number }>>;
  sel?: Obj[]; group?: Obj[];
  pointer?: Pointer;
  keys: string[]; say: string;
  hud?: string; axis?: 'x' | 'y' | 'z';
  box?: [Anchor, Anchor];
  path?: Vec3[];
  timeline?: { keys: number[]; head: number };
  cam?: Pose; sees?: boolean; rec?: boolean;
  sliders?: [string, number, string, boolean][];
};
type Spec = { id: string; title: string; group: string; label: string; dur: number; still: number; frame(u: number): Frame };

// ---------- Maths ----------
const rad = (d: number) => (d * Math.PI) / 180;
const clamp = (v: number, a = 0, b = 1) => Math.max(a, Math.min(b, v));
const ease = (u: number) => u * u * (3 - 2 * u);
const sm = (a: number, b: number, u: number) => ease(clamp((u - a) / (b - a)));
const lerp = (a: number, b: number, u: number) => a + (b - a) * u;
const mix3 = (a: Vec3, b: Vec3, u: number): Vec3 => [lerp(a[0], b[0], u), lerp(a[1], b[1], u), lerp(a[2], b[2], u)];
const add3 = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const orbit = (target: Vec3, az: number, el: number, dist: number): Vec3 => [target[0] + dist * Math.cos(rad(el)) * Math.sin(rad(az)), target[1] + dist * Math.sin(rad(el)), target[2] + dist * Math.cos(rad(el)) * Math.cos(rad(az))];
/** Index of the phase that u is in; phases are [start, label] pairs in order. */
const phase = <T>(u: number, steps: [number, T][]): T => { let v = steps[0][1]; for (const [at, x] of steps) if (u >= at) v = x; return v; };

// ---------- The set ----------
const HOME: Record<Obj, Vec3> = { person: [-1.1, 0, 0.5], crate: [0.9, 0, 0.3], car: [0.6, 0, -2.4], tree: [-2.7, 0, -2.2] };
const TARGET: Vec3 = [-0.2, 0.6, -0.5];
const VIEW: Pose = { p: orbit(TARGET, 32, 30, 8.6), look: TARGET, mm: 30 };
const FOCUS: Vec3 = [HOME.person[0], 1.45, HOME.person[2]];

// ---------- Explainers ----------
const SPECS: Spec[] = [
  {
    id: 'navigate', title: 'Look around', group: 'Navigate', dur: 7.5, still: 0.2,
    label: 'Animated example: left-drag orbits the view around the scene, right-drag pans it, scrolling zooms in.',
    frame: u => {
      const az = 32 + 38 * sm(0.04, 0.3, u), pan: Vec3 = mix3([0, 0, 0], [1.1, 0, 0.4], sm(0.37, 0.62, u)), dist = 8.6 - 3 * sm(0.7, 0.95, u);
      const target = add3(TARGET, pan);
      const step = phase(u, [[0, 0], [0.34, 1], [0.66, 2]] as [number, number][]);
      const pointer: Pointer = step === 0 ? { from: [0.38, 0.6], to: [0.66, 0.58], k: sm(0.04, 0.3, u), btn: 'left' }
        : step === 1 ? { from: [0.62, 0.45], to: [0.4, 0.5], k: sm(0.37, 0.62, u), btn: 'right' }
        : { from: [0.5, 0.48], to: [0.5, 0.48], k: 1, btn: 'wheel' };
      return { view: { p: orbit(target, az, 30, dist), look: target, mm: 30 }, pointer, keys: [['Left-drag'], ['Right-drag'], ['Scroll']][step], say: ['Orbit around the scene', 'Pan sideways', 'Zoom in and out'][step] };
    },
  },
  {
    id: 'select', title: 'Select objects', group: 'Select', dur: 8, still: 0.47,
    label: 'Animated example: click an object to select it, Shift-click adds another, clicking empty space clears the selection, Shift-drag draws a box that selects everything inside.',
    frame: u => {
      const step = phase(u, [[0, 0], [0.24, 1], [0.5, 2], [0.64, 3]] as [number, number][]);
      const sel: Obj[] = u < 0.2 ? [] : u < 0.43 ? ['person'] : u < 0.58 ? ['person', 'crate'] : u < 0.88 ? [] : ['car', 'tree'];
      const pointer: Pointer = step === 0 ? { from: [0.85, 0.85], to: 'person', k: sm(0.02, 0.17, u), click: clamp((u - 0.19) / 0.06) }
        : step === 1 ? { from: 'person', to: 'crate', k: sm(0.26, 0.4, u), click: clamp((u - 0.42) / 0.06) }
        : step === 2 ? { from: 'crate', to: [0.86, 0.86], k: sm(0.5, 0.56, u), click: clamp((u - 0.57) / 0.06) }
        : { from: [0.1, 0.04], to: ['car', 0.13, 0.07], k: sm(0.68, 0.86, u), btn: 'left' };
      const box: Frame['box'] = step === 3 && u > 0.68 && u < 0.89 ? [[0.1, 0.04], ['car', 0.13, 0.07]] : undefined;
      return { view: { ...VIEW, p: orbit(TARGET, 28, 50, 9) }, sel, pointer, box, keys: [['Click'], ['Shift', 'Click'], ['Click empty space'], ['Shift', 'Drag']][step], say: ['Select an object', 'Add to the selection', 'Clear the selection', 'Box-select everything inside'][step] };
    },
  },
  {
    id: 'transform', title: 'Move, rotate, resize', group: 'Transform', dur: 9, still: 0.24,
    label: 'Animated example: with an object selected press G to move it, X to lock to the X axis and type 2 for two metres; R and 45 rotates it; S and 1.5 resizes it. Enter confirms.',
    frame: u => {
      const mv = sm(0.16, 0.24, u), rot = sm(0.44, 0.52, u), sc = sm(0.74, 0.82, u);
      const free = u > 0.03 && u < 0.11 ? Math.sin(((u - 0.03) / 0.08) * Math.PI) * 0.5 : 0;
      const crate = { p: add3(HOME.crate, [lerp(0, 2, mv) + free * 0.6, 0, free * -0.4]), yaw: 45 * rot, s: lerp(1, 1.5, sc) };
      const step = phase(u, [[0, 0], [0.34, 1], [0.64, 2]] as [number, number][]);
      const keys = step === 0 ? phase(u, [[0, ['G']], [0.11, ['G', 'X']], [0.16, ['G', 'X', '2']], [0.27, ['G', 'X', '2', 'Enter']]] as [number, string[]][])
        : step === 1 ? phase(u, [[0, ['R']], [0.42, ['R', '45']], [0.56, ['R', '45', 'Enter']]] as [number, string[]][])
        : phase(u, [[0, ['S']], [0.72, ['S', '1.5']], [0.86, ['S', '1.5', 'Enter']]] as [number, string[]][]);
      const hud = step === 0 ? (u < 0.11 ? 'Move' : `Move · X ${(2 * mv).toFixed(1)} m`) : step === 1 ? `Rotate · ${Math.round(45 * rot)}°` : `Resize · ×${lerp(1, 1.5, sc).toFixed(2)}`;
      const live = (u > 0.02 && u < 0.27) || (u > 0.36 && u < 0.56) || (u > 0.66 && u < 0.86);
      return { view: { ...VIEW, look: [0.6, 0.5, -0.3], p: orbit([0.6, 0.5, -0.3], 24, 26, 8.4) }, objs: { crate }, sel: ['crate'], axis: step === 0 && u > 0.11 && u < 0.27 ? 'x' : undefined, hud: live ? hud : undefined, keys, say: ['Move: G, lock an axis, type metres', 'Rotate: R, type degrees', 'Resize: S, type a multiplier'][step] };
    },
  },
  {
    id: 'groups', title: 'Groups', group: 'Edit', dur: 8, still: 0.33,
    label: 'Animated example: select two objects, press Ctrl or Cmd plus G to group them, move the group as one, then click again inside the group to edit just one object.',
    frame: u => {
      const step = phase(u, [[0, 0], [0.2, 1], [0.34, 2], [0.6, 3]] as [number, number][]);
      const grouped = u >= 0.24;
      const shift = sm(0.4, 0.55, u) * 1.4, solo = sm(0.76, 0.88, u) * 0.9;
      const objs = { person: { p: add3(HOME.person, [shift, 0, 0]) }, crate: { p: add3(HOME.crate, [shift, 0, solo]) } };
      const sel: Obj[] = u < 0.08 ? [] : u < 0.16 ? ['person'] : u < 0.66 ? ['person', 'crate'] : ['crate'];
      const pointer: Pointer = step === 0 ? { from: [0.8, 0.86], to: 'person', k: sm(0, 0.07, u), click: clamp((u - 0.08) / 0.05) }
        : step === 1 ? { from: 'person', to: 'crate', k: sm(0.0, 0.14, u - 0.02), click: clamp((u - 0.15) / 0.05) }
        : step === 2 ? { from: 'crate', to: ['crate', 0.16, 0], k: sm(0.4, 0.55, u) }
        : { from: ['crate', 0.16, 0], to: 'crate', k: sm(0.6, 0.64, u), click: clamp((u - 0.65) / 0.05) };
      const keys = [['Shift', 'Click'], ['Ctrl/⌘', 'G'], ['G'], u < 0.72 ? ['Click again'] : ['G']][step];
      return { view: VIEW, objs, sel, group: grouped ? ['person', 'crate'] : undefined, pointer, keys, say: ['Select the pieces', 'Group them', 'The group moves as one', 'Click again to edit one piece'][step] };
    },
  },
  {
    id: 'animate', title: 'Animate an object', group: 'Animate', dur: 9, still: 0.82,
    label: 'Animated example: with the car selected press I to set a key at the playhead, move the playhead later, move the car and press I again; scrubbing plays the move along its path.',
    frame: u => {
      const a = HOME.car, b: Vec3 = add3(HOME.car, [2.6, 0, 1.8]);
      const head = u < 0.14 ? 0 : u < 0.32 ? lerp(0, 0.8, sm(0.15, 0.3, u)) : u < 0.62 ? 0.8 : u < 0.68 ? lerp(0.8, 0, sm(0.62, 0.68, u)) : lerp(0, 0.8, sm(0.7, 0.95, u));
      const keyed = u >= 0.52;
      const moved = sm(0.36, 0.48, u);
      const p = !keyed ? mix3(a, b, u < 0.34 ? 0 : moved) : mix3(a, b, ease(head / 0.8));
      const keys = phase(u, [[0, ['I']], [0.14, ['Drag the playhead']], [0.34, ['G']], [0.5, ['I']], [0.66, ['Space']]] as [number, string[]][]);
      const say = phase(u, [[0, 'Set a key at the playhead'], [0.14, 'Move to a later time'], [0.34, 'Move the object'], [0.5, 'Set another key'], [0.66, 'Play: it follows the path']] as [number, string][]);
      return { view: { p: orbit([1.2, 0.4, -1.2], 14, 40, 10.5), look: [1.2, 0.4, -1.2], mm: 30 }, objs: { car: { p, yaw: 90 + 30 * ease(keyed ? head / 0.8 : moved) } }, sel: ['car'], path: keyed ? Array.from({ length: 13 }, (_, i) => add3(mix3(a, b, ease(i / 12)), [0, 0.05, 0])) : undefined, timeline: { keys: u >= 0.04 ? (keyed ? [0, 0.8] : [0]) : [], head }, keys, say };
    },
  },
  {
    id: 'fly', title: 'Fly the shot camera', group: 'Shoot', dur: 8, still: 0.4,
    label: 'Animated example: the shot camera flies through the set from the keyboard: W forward, A and D sideways, Q and E turn, Space rises; R records the take. An inset shows what the camera sees.',
    frame: u => {
      const fwd = sm(0.06, 0.32, u), side = sm(0.36, 0.52, u), turn = sm(0.38, 0.56, u), up = sm(0.6, 0.78, u);
      const p: Vec3 = [lerp(3.6, 2.4, fwd) - 1.2 * side, lerp(1.4, 1.4, 0) + 1.4 * up, lerp(5.2, 2.6, fwd)];
      const yaw = lerp(-28, -2, turn), pitch = -6 - 12 * up;
      const look: Vec3 = [p[0] + Math.sin(rad(yaw)) * 4, p[1] + Math.tan(rad(pitch)) * 4, p[2] - Math.cos(rad(yaw)) * 4];
      const keys = phase(u, [[0, ['R']], [0.06, ['W']], [0.36, ['A', 'E']], [0.6, ['Space']], [0.82, ['R']]] as [number, string[]][]);
      const say = phase(u, [[0, 'Record a take'], [0.06, 'Forward'], [0.36, 'Slide and turn'], [0.6, 'Rise'], [0.82, 'Stop recording']] as [number, string][]);
      return { view: { p: orbit([1.2, 0.8, 1.2], 62, 42, 14), look: [1.2, 0.8, 1.2], mm: 30 }, cam: { p, look, mm: 28 }, sees: true, rec: u > 0.03 && u < 0.84, keys, say };
    },
  },
  {
    id: 'camera-rig', title: 'Camera distance, height, angle, lens', group: 'Shoot', dur: 9, still: 0.3,
    label: 'Animated example: the shot camera aims at the subject while distance, height, angle around it and lens length change one at a time; an inset shows the framing.',
    frame: u => {
      const d = lerp(5.5, 3.2, sm(0.04, 0.2, u) - sm(0.86, 0.96, u)), ht = lerp(1.6, 3.4, sm(0.28, 0.42, u) - sm(0.86, 0.96, u));
      const ang = lerp(20, 70, sm(0.5, 0.64, u) - sm(0.86, 0.96, u)), mm = lerp(35, 85, sm(0.7, 0.82, u) - sm(0.86, 0.96, u));
      const p = add3(FOCUS, [d * Math.sin(rad(ang)), ht - FOCUS[1], d * Math.cos(rad(ang))]);
      const on = phase(u, [[0, 0], [0.26, 1], [0.48, 2], [0.68, 3], [0.86, -1]] as [number, number][]);
      return {
        view: { p: orbit([-0.4, 0.8, 0.6], 70, 36, 11), look: [-0.4, 0.8, 0.6], mm: 30 }, cam: { p, look: FOCUS, mm }, sees: true, sel: ['person'],
        sliders: [['Distance', (d - 2) / 5, `${d.toFixed(1)} m`, on === 0], ['Height', ht / 4, `${ht.toFixed(1)} m`, on === 1], ['Angle', (ang + 10) / 100, `${Math.round(ang)}°`, on === 2], ['Lens', (mm - 14) / 121, `${Math.round(mm)} mm`, on === 3]],
        keys: on < 0 ? [] : [['Distance'], ['Height'], ['Angle'], ['Lens']][on], say: on < 0 ? 'Back to the start' : ['Closer or farther', 'Higher or lower', 'Around the subject', 'Wider or tighter lens'][on],
      };
    },
  },
];
const BY_ID = new Map(SPECS.map(s => [s.id, s]));

/** Every explainer; `group` matches the Controls card section title it belongs to. */
export const EXPLAINERS: { id: string; title: string; group: string }[] = SPECS.map(({ id, title, group }) => ({ id, title, group }));

// ---------- Shared renderer + scene (lazy, disposed after idle) ----------
const BG = '#F1EDE5', ACCENT = '#C8401F', INK = '#15130F';
const AXIS_COLORS = { x: '#C83A3A', y: '#3E8E3A', z: '#2F63C9' };
type Rig = ReturnType<typeof buildRig>;
let rig: Rig | null = null;
let glFailed = false;
let disposeTimer = 0;

function buildRig() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'low-power' });
  renderer.setPixelRatio(1);
  renderer.setClearColor(BG, 1);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(BG);
  const owned: { dispose(): void }[] = [];
  const mat = (color: string, extra: THREE.MeshStandardMaterialParameters = {}) => { const m = new THREE.MeshStandardMaterial({ color, roughness: 0.8, metalness: 0, ...extra }); owned.push(m); return m; };
  const geo = <T extends THREE.BufferGeometry>(g: T) => { owned.push(g); return g; };
  scene.add(new THREE.HemisphereLight(0xfffaf0, 0xb3a893, 1.9));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6); sun.position.set(5, 10, 7); scene.add(sun);
  const ground = new THREE.Mesh(geo(new THREE.PlaneGeometry(60, 60)), mat('#E4DDD0')); ground.rotation.x = -Math.PI / 2; scene.add(ground);
  const grid = new THREE.GridHelper(30, 30, 0xc4baa9, 0xd3cbbd); grid.position.y = 0.005; owned.push(grid.geometry, grid.material as THREE.Material); scene.add(grid);

  const objs = {} as Record<Obj, THREE.Group>;
  const mats = {} as Record<Obj, THREE.MeshStandardMaterial[]>;
  const make = (k: Obj, parts: THREE.Mesh[]) => { const g = new THREE.Group(); g.add(...parts); objs[k] = g; mats[k] = parts.map(p => p.material as THREE.MeshStandardMaterial); scene.add(g); return g; };
  const body = new THREE.Mesh(geo(new THREE.CapsuleGeometry(0.24, 0.95, 6, 14)), mat(KIND_COLORS.character)); body.position.y = 0.72;
  const head = new THREE.Mesh(geo(new THREE.SphereGeometry(0.16, 16, 12)), mat('#E8C9A8')); head.position.y = 1.62;
  const visor = new THREE.Mesh(geo(new THREE.BoxGeometry(0.2, 0.06, 0.08)), mat('#2B2622')); visor.position.set(0, 1.65, 0.14);
  make('person', [body, head, visor]);
  const crate = new THREE.Mesh(geo(new THREE.BoxGeometry(0.8, 0.8, 0.8)), mat(KIND_COLORS.prop)); crate.position.y = 0.4;
  const lid = new THREE.Mesh(geo(new THREE.BoxGeometry(0.82, 0.06, 0.82)), mat('#8E5E16')); lid.position.y = 0.8;
  make('crate', [crate, lid]);
  const carBody = new THREE.Mesh(geo(new THREE.BoxGeometry(1.8, 0.6, 4)), mat(KIND_COLORS.vehicle, { roughness: 0.45 })); carBody.position.y = 0.6;
  const cabin = new THREE.Mesh(geo(new THREE.BoxGeometry(1.55, 0.52, 2)), mat('#2B3442', { roughness: 0.3 })); cabin.position.set(0, 1.15, -0.2);
  const wheels = [[0.92, 1.25], [-0.92, 1.25], [0.92, -1.25], [-0.92, -1.25]].map(([x, z]) => { const w = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.33, 0.33, 0.26, 18)), mat('#1E1C1A')); w.rotation.z = Math.PI / 2; w.position.set(x, 0.33, z); return w; });
  make('car', [carBody, cabin, ...wheels]);
  const trunk = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.14, 0.18, 1.2, 8)), mat('#7D6650')); trunk.position.y = 0.6;
  const crown = new THREE.Mesh(geo(new THREE.ConeGeometry(1, 2.6, 10)), mat(KIND_COLORS.environment)); crown.position.y = 2.3;
  make('tree', [trunk, crown]);

  // Camera gizmo: body + lens + frustum lines, built along +z (Object3D.lookAt aims +z at the target).
  const gizmo = new THREE.Group();
  const gBody = new THREE.Mesh(geo(new THREE.BoxGeometry(0.34, 0.26, 0.42)), new THREE.MeshBasicMaterial({ color: INK })); owned.push(gBody.material as THREE.Material); gBody.position.z = -0.12;
  const gLens = new THREE.Mesh(geo(new THREE.CylinderGeometry(0.09, 0.11, 0.16, 14)), new THREE.MeshBasicMaterial({ color: ACCENT })); owned.push(gLens.material as THREE.Material); gLens.rotation.x = Math.PI / 2; gLens.position.z = 0.15;
  const frGeo = geo(new THREE.BufferGeometry()); frGeo.setAttribute('position', new THREE.Float32BufferAttribute(new Float32Array(16 * 3), 3));
  const frMat = new THREE.LineBasicMaterial({ color: ACCENT }); owned.push(frMat);
  gizmo.add(gBody, gLens, new THREE.LineSegments(frGeo, frMat));
  const setFov = (mm: number) => {
    const len = 1.5, hw = len * (18 / mm), hh = hw / (16 / 9), c = [[hw, hh], [-hw, hh], [-hw, -hh], [hw, -hh]], a = frGeo.attributes.position as THREE.BufferAttribute;
    let i = 0; for (let k = 0; k < 4; k++) { const [x, y] = c[k], [nx, ny] = c[(k + 1) % 4]; a.setXYZ(i++, 0, 0, 0.2); a.setXYZ(i++, x, y, len); a.setXYZ(i++, x, y, len); a.setXYZ(i++, nx, ny, len); }
    a.needsUpdate = true; frGeo.computeBoundingSphere();
  };
  scene.add(gizmo);
  const view = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 200); view.filmGauge = 36;
  const eye = new THREE.PerspectiveCamera(40, 16 / 9, 0.05, 200); eye.filmGauge = 36;
  return { renderer, scene, objs, mats, gizmo, setFov, view, eye, owned, size: [0, 0] as [number, number] };
}

function getRig(): Rig | null {
  if (glFailed) return null;
  clearTimeout(disposeTimer);
  if (rig) return rig;
  try { rig = buildRig(); } catch { glFailed = true; rig = null; }
  return rig;
}
function scheduleDispose() {
  clearTimeout(disposeTimer);
  disposeTimer = window.setTimeout(() => {
    if (!rig || (!document.hidden && [...live].some(i => i.playing && i.visible))) return;
    for (const o of rig.owned) o.dispose();
    rig.renderer.dispose(); rig.renderer.forceContextLoss();
    rig = null;
  }, 8000);
}

// ---------- Drawing ----------
function setPose(cam: THREE.PerspectiveCamera, pose: Pose, aspect: number) {
  cam.aspect = aspect; cam.position.set(...pose.p); cam.up.set(0, 1, 0); cam.lookAt(...pose.look);
  cam.setFocalLength(pose.mm); cam.updateProjectionMatrix(); cam.updateMatrixWorld();
}
function applyObjects(r: Rig, f: Frame) {
  for (const k of Object.keys(r.objs) as Obj[]) {
    const o = f.objs?.[k], g = r.objs[k];
    g.position.set(...(o?.p || HOME[k])); g.rotation.y = rad(o?.yaw ?? (k === 'car' ? 90 : k === 'person' ? 20 : 0)); g.scale.setScalar(o?.s ?? 1);
    const on = f.sel?.includes(k);
    for (const m of r.mats[k]) { m.emissive.set(on ? ACCENT : '#000000'); m.emissiveIntensity = on ? 0.08 : 0; }
  }
}

type Inst = {
  spec: Spec; fig: HTMLElement; canvas: HTMLCanvasElement; keysEl: HTMLElement; sayEl: HTMLElement; play: HTMLButtonElement;
  t0: number; u: number; playing: boolean; visible: boolean; drawn: boolean; sig: string; io?: IntersectionObserver;
};
const live = new Set<Inst>();
let raf = 0;
const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Screen position (device px) of a world point, or null behind the camera. */
function project(cam: THREE.PerspectiveCamera, p: THREE.Vector3, w: number, ht: number): [number, number] | null {
  const v = p.clone().project(cam);
  return v.z > 1 ? null : [((v.x + 1) / 2) * w, ((1 - v.y) / 2) * ht];
}
function screenBox(r: Rig, objs: Obj[], w: number, ht: number) {
  const box = new THREE.Box3(); for (const k of objs) box.expandByObject(r.objs[k]);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < 8; i++) {
    const s = project(r.view, new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z), w, ht);
    if (!s) continue; x0 = Math.min(x0, s[0]); y0 = Math.min(y0, s[1]); x1 = Math.max(x1, s[0]); y1 = Math.max(y1, s[1]);
  }
  return { x0, y0, x1, y1 };
}
function anchorAt(r: Rig, a: Anchor, w: number, ht: number): [number, number] {
  if (typeof a === 'string' || typeof a[0] === 'string') {
    const [k, dx, dy] = typeof a === 'string' ? [a, 0, 0] : a as [Obj, number, number];
    const b = screenBox(r, [k], w, ht);
    return [(b.x0 + b.x1) / 2 + dx * w, (b.y0 + b.y1) / 2 + dy * ht];
  }
  return [(a as [number, number])[0] * w, (a as [number, number])[1] * ht];
}
function pill(c: CanvasRenderingContext2D, text: string, x: number, y: number, s: number, dark = true, align: 'l' | 'r' = 'l') {
  c.save(); c.font = `600 ${10.5 * s}px ui-monospace, 'SF Mono', Menlo, monospace`;
  const tw = c.measureText(text).width, pad = 6 * s, bh = 18 * s, x0 = align === 'l' ? x : x - tw - pad * 2;
  c.fillStyle = dark ? 'rgba(21,19,15,.78)' : 'rgba(255,253,249,.9)'; c.beginPath(); c.roundRect(x0, y, tw + pad * 2, bh, 5 * s); c.fill();
  c.fillStyle = dark ? '#F6F3EE' : INK; c.textBaseline = 'middle'; c.fillText(text, x0 + pad, y + bh / 2 + 0.5 * s); c.restore();
}
function brackets(c: CanvasRenderingContext2D, b: { x0: number; y0: number; x1: number; y1: number }, s: number, color: string) {
  const pad = 5 * s, x0 = b.x0 - pad, y0 = b.y0 - pad, x1 = b.x1 + pad, y1 = b.y1 + pad, k = Math.min(10 * s, (x1 - x0) / 3, (y1 - y0) / 3);
  c.save(); c.strokeStyle = color; c.lineWidth = 2 * s; c.lineCap = 'round'; c.beginPath();
  for (const [x, y, dx, dy] of [[x0, y0, 1, 1], [x1, y0, -1, 1], [x0, y1, 1, -1], [x1, y1, -1, -1]]) { c.moveTo(x + dx * k, y); c.lineTo(x, y); c.lineTo(x, y + dy * k); }
  c.stroke(); c.restore();
}
function cursor(c: CanvasRenderingContext2D, x: number, y: number, s: number, p: Pointer) {
  if (p.click !== undefined && p.click > 0 && p.click < 1) {
    c.save(); c.globalAlpha = 1 - p.click; c.strokeStyle = ACCENT; c.lineWidth = 2 * s; c.beginPath(); c.arc(x, y, (6 + 16 * p.click) * s, 0, Math.PI * 2); c.stroke(); c.restore();
  }
  if (p.btn) { // mouse glyph under the pointer, the active button filled
    const mx = x + 12 * s, my = y + 14 * s, mw = 14 * s, mh = 20 * s;
    c.save(); c.fillStyle = '#FFFDF9'; c.strokeStyle = INK; c.lineWidth = 1.3 * s; c.beginPath(); c.roundRect(mx, my, mw, mh, 7 * s); c.fill(); c.stroke();
    c.fillStyle = ACCENT;
    if (p.btn === 'left') { c.beginPath(); c.roundRect(mx + 1.2 * s, my + 1.2 * s, mw / 2 - 1.8 * s, mh * 0.42, [6 * s, 0, 0, 0]); c.fill(); }
    if (p.btn === 'right') { c.beginPath(); c.roundRect(mx + mw / 2 + 0.6 * s, my + 1.2 * s, mw / 2 - 1.8 * s, mh * 0.42, [0, 6 * s, 0, 0]); c.fill(); }
    c.beginPath(); c.moveTo(mx + mw / 2, my); c.lineTo(mx + mw / 2, my + mh * 0.45); c.moveTo(mx, my + mh * 0.45); c.lineTo(mx + mw, my + mh * 0.45); c.stroke();
    if (p.btn === 'wheel') { c.beginPath(); c.roundRect(mx + mw / 2 - 2 * s, my + 3 * s, 4 * s, 6 * s, 2 * s); c.fill(); }
    c.restore();
  }
  c.save(); c.translate(x, y); c.scale(s, s);
  c.beginPath(); c.moveTo(0, 0); c.lineTo(0, 15); c.lineTo(4, 11.5); c.lineTo(7, 17.5); c.lineTo(9.6, 16.3); c.lineTo(6.7, 10.5); c.lineTo(11.5, 10.5); c.closePath();
  c.fillStyle = INK; c.strokeStyle = '#FFFDF9'; c.lineWidth = 1.4; c.lineJoin = 'round'; c.fill(); c.stroke(); c.restore();
}

function drawInst(r: Rig, inst: Inst) {
  const cw = Math.max(1, inst.canvas.clientWidth || 288), ch = Math.max(1, inst.canvas.clientHeight || 162);
  const dpr = Math.min(2, window.devicePixelRatio || 1), w = Math.round(cw * dpr), ht = Math.round(ch * dpr), s = dpr;
  if (inst.canvas.width !== w || inst.canvas.height !== ht) { inst.canvas.width = w; inst.canvas.height = ht; }
  if (r.size[0] < w || r.size[1] < ht) { r.size = [Math.max(r.size[0], w), Math.max(r.size[1], ht)]; r.renderer.setSize(r.size[0], r.size[1], false); }
  const f = inst.spec.frame(inst.u), c = inst.canvas.getContext('2d')!, src = r.renderer.domElement, sy = r.size[1] - ht;
  applyObjects(r, f);
  // Main view (with the camera gizmo when there is one).
  setPose(r.view, f.view, w / ht);
  r.gizmo.visible = !!f.cam;
  if (f.cam) { r.gizmo.position.set(...f.cam.p); r.gizmo.up.set(0, 1, 0); r.gizmo.lookAt(...f.cam.look); r.gizmo.scale.setScalar(1.1); r.setFov(f.cam.mm); }
  r.renderer.setViewport(0, 0, w, ht); r.renderer.setScissor(0, 0, w, ht); r.renderer.setScissorTest(true);
  r.renderer.render(r.scene, r.view);
  c.drawImage(src, 0, sy, w, ht, 0, 0, w, ht);
  // Overlays.
  if (f.path) {
    const pts = f.path.map(p => project(r.view, new THREE.Vector3(...p), w, ht)).filter(Boolean) as [number, number][];
    c.save(); c.strokeStyle = ACCENT; c.lineWidth = 2 * s; c.setLineDash([5 * s, 4 * s]); c.beginPath(); pts.forEach(([x, y], i) => (i ? c.lineTo(x, y) : c.moveTo(x, y))); c.stroke(); c.setLineDash([]);
    for (const [x, y] of [pts[0], pts[pts.length - 1]]) { c.fillStyle = ACCENT; c.beginPath(); c.moveTo(x, y - 5 * s); c.lineTo(x + 5 * s, y); c.lineTo(x, y + 5 * s); c.lineTo(x - 5 * s, y); c.closePath(); c.fill(); }
    c.restore();
  }
  if (f.axis && f.sel?.[0]) {
    const o = r.objs[f.sel[0]].position, d = new THREE.Vector3(f.axis === 'x' ? 1 : 0, f.axis === 'y' ? 1 : 0, f.axis === 'z' ? 1 : 0);
    const a = project(r.view, o.clone().addScaledVector(d, -12).setY(o.y + 0.02), w, ht), b = project(r.view, o.clone().addScaledVector(d, 12).setY(o.y + 0.02), w, ht);
    if (a && b) { c.save(); c.strokeStyle = AXIS_COLORS[f.axis]; c.globalAlpha = 0.85; c.lineWidth = 1.6 * s; c.beginPath(); c.moveTo(...a); c.lineTo(...b); c.stroke(); c.restore(); }
  }
  if (f.group) {
    const b = screenBox(r, f.group, w, ht), pad = 12 * s;
    c.save(); c.strokeStyle = INK; c.globalAlpha = 0.7; c.lineWidth = 1.3 * s; c.setLineDash([4 * s, 3 * s]); c.strokeRect(b.x0 - pad, b.y0 - pad, b.x1 - b.x0 + pad * 2, b.y1 - b.y0 + pad * 2); c.restore();
    pill(c, 'Group', b.x0 - pad, b.y0 - pad - 20 * s, s * 0.9, false);
  }
  for (const k of f.sel || []) brackets(c, screenBox(r, [k], w, ht), s, ACCENT);
  if (f.box) {
    const [x0, y0] = anchorAt(r, f.box[0], w, ht), [x1, y1] = anchorAt(r, f.box[1], w, ht);
    c.save(); c.fillStyle = 'rgba(200,64,31,.08)'; c.strokeStyle = ACCENT; c.lineWidth = 1.2 * s; c.setLineDash([4 * s, 3 * s]); c.fillRect(x0, y0, x1 - x0, y1 - y0); c.strokeRect(x0, y0, x1 - x0, y1 - y0); c.restore();
  }
  if (f.timeline) {
    const x0 = w * 0.1, x1 = w * 0.9, y = ht - 46 * s;
    c.save(); c.fillStyle = 'rgba(255,253,249,.88)'; c.beginPath(); c.roundRect(x0 - 10 * s, y - 10 * s, x1 - x0 + 20 * s, 20 * s, 6 * s); c.fill();
    c.strokeStyle = '#B8AF9F'; c.lineWidth = 2 * s; c.beginPath(); c.moveTo(x0, y); c.lineTo(x1, y); c.stroke();
    for (const k of f.timeline.keys) { const x = lerp(x0, x1, k); c.fillStyle = INK; c.beginPath(); c.moveTo(x, y - 5 * s); c.lineTo(x + 5 * s, y); c.lineTo(x, y + 5 * s); c.lineTo(x - 5 * s, y); c.closePath(); c.fill(); }
    const hx = lerp(x0, x1, f.timeline.head); c.strokeStyle = ACCENT; c.lineWidth = 2 * s; c.beginPath(); c.moveTo(hx, y - 9 * s); c.lineTo(hx, y + 9 * s); c.stroke(); c.restore();
  }
  if (f.sliders) {
    const x = 8 * s, rw = Math.min(118 * s, w * 0.34); let y = 8 * s;
    c.save(); c.fillStyle = 'rgba(255,253,249,.9)'; c.beginPath(); c.roundRect(x - 4 * s, y - 4 * s, rw + 8 * s, f.sliders.length * 22 * s + 6 * s, 6 * s); c.fill();
    c.font = `600 ${9 * s}px ui-sans-serif, system-ui, sans-serif`; c.textBaseline = 'top';
    for (const [label, v, text, on] of f.sliders) {
      c.fillStyle = on ? ACCENT : '#5E584F'; c.fillText(label, x, y); c.textAlign = 'right'; c.fillText(text, x + rw, y); c.textAlign = 'left';
      c.fillStyle = '#D9D1C3'; c.fillRect(x, y + 12 * s, rw, 3 * s); c.fillStyle = on ? ACCENT : '#8E877B'; c.fillRect(x, y + 12 * s, rw * clamp(v), 3 * s);
      c.beginPath(); c.arc(x + rw * clamp(v), y + 13.5 * s, 3.5 * s, 0, Math.PI * 2); c.fill();
      y += 22 * s;
    }
    c.restore();
  }
  if (f.hud) pill(c, f.hud, 8 * s, 8 * s, s);
  if (f.rec) { pill(c, '   REC', 8 * s, 8 * s, s * 0.9); c.save(); c.fillStyle = ACCENT; c.beginPath(); c.arc(17 * s, 16 * s, 3.5 * s, 0, Math.PI * 2); c.fill(); c.restore(); }
  // What the shot camera sees, inset bottom-right (gizmo hidden).
  if (f.cam && f.sees) {
    const iw = Math.round(Math.min(w * 0.38, 150 * s)), ih = Math.round(iw * 9 / 16), m = 7 * s, ix = w - iw - m, iy = ht - ih - m;
    r.gizmo.visible = false; setPose(r.eye, f.cam, 16 / 9);
    r.renderer.setViewport(0, 0, iw, ih); r.renderer.setScissor(0, 0, iw, ih);
    r.renderer.render(r.scene, r.eye);
    c.save(); c.shadowColor = 'rgba(21,19,15,.35)'; c.shadowBlur = 10 * s; c.fillStyle = '#FFFDF9'; c.fillRect(ix - 2 * s, iy - 2 * s, iw + 4 * s, ih + 4 * s); c.restore();
    c.drawImage(src, 0, r.size[1] - ih, iw, ih, ix, iy, iw, ih);
    pill(c, 'Camera sees', ix + 4 * s, iy + 4 * s, s * 0.8);
  }
  r.renderer.setScissorTest(false);
  if (f.pointer) {
    const a = anchorAt(r, f.pointer.from, w, ht), b = anchorAt(r, f.pointer.to, w, ht), k = ease(clamp(f.pointer.k));
    cursor(c, lerp(a[0], b[0], k), lerp(a[1], b[1], k), s, f.pointer);
  }
  // Key badges and caption (DOM; only when they change).
  const sig = f.keys.join('|') + '§' + f.say;
  if (sig !== inst.sig) {
    inst.sig = sig;
    inst.keysEl.replaceChildren(...f.keys.flatMap((k, i) => [i ? h('span', { class: 'ex-plus' }, k === 'Enter' || /^[\d.]+$/.test(k) ? '·' : '+') : null, h('kbd', {}, k)].filter(Boolean) as Node[]));
    inst.sayEl.textContent = f.say;
  }
  inst.drawn = true;
}

function tick(now: number) {
  raf = 0;
  if (document.hidden || ![...live].some(i => i.visible && i.fig.isConnected)) { scheduleDispose(); return; }
  const r = getRig();
  if (!r) { for (const i of live) noGl(i); return; }
  let again = false;
  for (const inst of live) {
    if (!inst.fig.isConnected) { disposeInst(inst); continue; }
    if (!inst.visible) continue;
    if (inst.playing) {
      const dur = inst.spec.dur + 0.8, t = (now - inst.t0) / 1000;
      inst.u = clamp(((t % dur) - 0.2) / inst.spec.dur);
      again = true;
    } else if (inst.drawn) continue;
    drawInst(r, inst);
  }
  if (again && !document.hidden) raf = requestAnimationFrame(tick);
  else scheduleDispose();
}
function wake() { if (!raf && typeof requestAnimationFrame === 'function') raf = requestAnimationFrame(tick); }
function noGl(inst: Inst) { inst.fig.classList.add('ex-nogl'); inst.sayEl.textContent = inst.spec.label.replace(/^Animated example: /, ''); inst.play.hidden = true; }
function disposeInst(inst: Inst) { inst.io?.disconnect(); live.delete(inst); if (!live.size) scheduleDispose(); }
if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); else { cancelAnimationFrame(raf); raf = 0; scheduleDispose(); } });

function setPlaying(inst: Inst, on: boolean) {
  inst.playing = on;
  if (on) inst.t0 = performance.now() - (inst.u * inst.spec.dur + 0.2) * 1000;
  inst.drawn = false;
  inst.play.textContent = on ? '❚❚' : '▶';
  inst.play.setAttribute('aria-label', on ? `Pause “${inst.spec.title}”` : `Play “${inst.spec.title}”`);
  inst.play.setAttribute('aria-pressed', String(on));
  wake();
}

/**
 * Mounts an explainer into host (fills its width; 16:9 unless the host sets a height).
 * Plays while visible unless autoplay is false or the user prefers reduced motion.
 */
export function mountExplainer(host: HTMLElement, id: string, opts: { autoplay?: boolean } = {}): { dispose(): void } {
  const spec = BY_ID.get(id);
  if (!spec) return { dispose() {} };
  const canvas = h('canvas', { class: 'ex-canvas', role: 'img', 'aria-label': spec.label });
  const keysEl = h('div', { class: 'ex-keys', 'aria-hidden': 'true' }), sayEl = h('span', { class: 'ex-say', 'aria-hidden': 'true' });
  const play = h('button', { class: 'ex-play', type: 'button' });
  const fig = h('figure', { class: 'ex', 'data-explainer': id }, h('div', { class: 'ex-stage' }, canvas, keysEl, play), h('figcaption', {}, h('b', {}, spec.title), sayEl));
  const inst: Inst = { spec, fig, canvas, keysEl, sayEl, play, t0: 0, u: spec.still, playing: false, visible: typeof IntersectionObserver !== 'function', drawn: false, sig: '' };
  play.onclick = () => setPlaying(inst, !inst.playing);
  // Drag across the scene to scrub it.
  let dragging = false;
  const scrub = (ev: PointerEvent) => { const b = canvas.getBoundingClientRect(); inst.u = clamp((ev.clientX - b.left) / Math.max(1, b.width)); inst.drawn = false; wake(); };
  canvas.addEventListener('pointerdown', ev => { dragging = true; canvas.setPointerCapture?.(ev.pointerId); if (inst.playing) setPlaying(inst, false); scrub(ev); });
  canvas.addEventListener('pointermove', ev => { if (dragging) scrub(ev); });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('pointercancel', () => { dragging = false; });
  host.append(fig);
  live.add(inst);
  if (typeof IntersectionObserver === 'function') {
    inst.io = new IntersectionObserver(entries => { for (const e of entries) inst.visible = e.isIntersecting; if (inst.visible) { inst.drawn = false; wake(); } });
    inst.io.observe(fig);
  }
  setPlaying(inst, opts.autoplay !== false && !reduced());
  return { dispose() { fig.remove(); disposeInst(inst); } };
}

/** A small tab strip that swaps explainers in one stage (one mounted at a time). */
export function explainerTabs(ids: string[], opts: { label: string; autoplay?: boolean }) {
  ids = ids.filter(id => BY_ID.has(id));
  const stage = h('div', { class: 'ex-tabstage', role: 'tabpanel', 'aria-label': opts.label });
  let current: { dispose(): void } | null = null;
  const tabs = ids.filter(id => BY_ID.has(id)).map((id, i) => {
    const b = h('button', { type: 'button', role: 'tab', class: 'ex-tab', 'aria-selected': String(i === 0), tabindex: i === 0 ? 0 : -1 }, BY_ID.get(id)!.title);
    b.onclick = () => show(i, true);
    return b;
  });
  const list = h('div', { class: 'ex-tabs', role: 'tablist', 'aria-label': opts.label }, ...tabs);
  list.onkeydown = ev => {
    const i = tabs.findIndex(t => t.getAttribute('aria-selected') === 'true');
    const n = ev.key === 'ArrowRight' ? i + 1 : ev.key === 'ArrowLeft' ? i - 1 : ev.key === 'Home' ? 0 : ev.key === 'End' ? tabs.length - 1 : null;
    if (n === null) return;
    ev.preventDefault(); ev.stopPropagation(); show((n + tabs.length) % tabs.length, true);
  };
  function show(i: number, focus: boolean) {
    tabs.forEach((t, j) => { t.setAttribute('aria-selected', String(i === j)); t.tabIndex = i === j ? 0 : -1; });
    current?.dispose(); current = mountExplainer(stage, ids[i], { autoplay: opts.autoplay });
    if (focus) tabs[i].focus();
  }
  const el = h('div', { class: 'ex-tabbed' }, list, stage);
  if (tabs.length) show(0, false);
  return { el, dispose() { current?.dispose(); current = null; } };
}

// ---------- SVG diagrams (inline, themed by CSS variables) ----------
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
function svgFigure(cls: string, label: string, svg: string, caption?: string) {
  const art = h('div', { class: 'ex-svg', role: 'img', 'aria-label': label }); art.innerHTML = svg;
  return h('figure', { class: `ex-diagram ${cls}` }, art, caption ? h('figcaption', {}, caption) : null);
}
const key = (x: number, y: number, w: number, label: string, hot = false) => `<g class="k${hot ? ' hot' : ''}"><rect x="${x}" y="${y}" width="${w}" height="26" rx="5"/><text x="${x + w / 2}" y="${y + 17}">${esc(label)}</text></g>`;
const note = (x: number, y: number, text: string, anchor: 'start' | 'middle' | 'end' = 'start') => `<text class="n" x="${x}" y="${y}" text-anchor="${anchor}">${esc(text)}</text>`;

/** Keyboard flight keys for the Fly camera. */
export function keyboardDiagram() {
  const rows: [string, string][] = [['W  S', 'forward · back'], ['A  D', 'slide left · right'], ['Q  E', 'turn'], ['Space  Shift', 'up · down'], ['Arrows', 'aim · Alt slows'], ['R  Esc', 'record · release']];
  const svg = `<svg viewBox="0 0 360 124" xmlns="http://www.w3.org/2000/svg">
    ${key(0, 0, 34, 'Esc')}
    ${key(12, 32, 28, 'Q', true)}${key(44, 32, 28, 'W', true)}${key(76, 32, 28, 'E', true)}${key(108, 32, 28, 'R', true)}
    ${key(20, 62, 28, 'A', true)}${key(52, 62, 28, 'S', true)}${key(84, 62, 28, 'D', true)}
    ${key(0, 92, 44, 'Shift')}${key(48, 92, 100, 'Space')}
    ${rows.map(([k, v], i) => `<text class="n" x="178" y="${14 + i * 20}" text-anchor="start"><tspan class="kn">${esc(k)}</tspan>  ${esc(v)}</text>`).join('')}
  </svg>`;
  return svgFigure('ex-keyboard', 'Keyboard: W and S fly forward and back, A and D slide sideways, Q and E turn, Space rises, Shift lowers, arrow keys aim, Alt slows down, R records, Esc releases the camera.', svg, 'Keyboard');
}

/** Gamepad (standard mapping) for one stick layout from LAYOUTS. */
export function gamepadDiagram(layout: keyof typeof LAYOUTS = 'game') {
  const drone = layout === 'drone';
  const ls = drone ? 'turn · climb' : 'fly · slide', rs = drone ? 'fly · slide' : 'turn · aim';
  const svg = `<svg viewBox="0 0 360 170" xmlns="http://www.w3.org/2000/svg">
    <path class="pad" d="M92 40 Q180 26 268 40 Q312 46 326 96 Q338 146 300 150 Q276 152 256 120 L104 120 Q84 152 60 150 Q22 146 34 96 Q48 46 92 40 Z"/>
    <rect class="sh" x="70" y="22" width="56" height="14" rx="6"/><rect class="sh" x="234" y="22" width="56" height="14" rx="6"/>
    <text class="b" x="98" y="33">LB</text><text class="b" x="262" y="33">RB</text>
    <circle class="stick" cx="112" cy="76" r="17"/><circle class="stick" cx="216" cy="104" r="17"/>
    <path class="dp" d="M136 96h12v-12h10v12h12v10h-12v12h-10v-12h-12z"/>
    <circle class="btn" cx="262" cy="92" r="9"/><text class="b" x="262" y="96">A</text>
    <circle class="btn" cx="280" cy="74" r="9"/><text class="b" x="280" y="78">B</text>
    <circle class="btn" cx="244" cy="74" r="9"/><text class="b" x="244" y="78">X</text>
    ${note(4, 14, drone ? 'LT / RT  —' : 'LT / RT  down · up')}${note(356, 14, 'LB slow · RB fast', 'end')}
    ${note(112, 108, `left stick: ${ls}`, 'middle')}${note(216, 140, `right stick: ${rs}`, 'middle')}
    ${drone ? note(153, 136, 'D-pad ↑↓ tilt', 'middle') : ''}
    ${note(356, 62, 'B release', 'end')}${note(356, 112, 'A arm · record', 'end')}${note(198, 62, 'X re-zero', 'end')}
  </svg>`;
  return svgFigure('ex-gamepad', `Gamepad, ${LAYOUTS[layout]} layout: left stick ${ls}, right stick ${rs}, ${drone ? 'D-pad up and down tilts the camera' : 'triggers lower and raise'}, LB slows, RB speeds up, A arms and records, B releases, X re-zeroes.`, svg, `Gamepad · ${LAYOUTS[layout]}`);
}

/** Phone used as the camera: hold it like a camera; buttons on screen. */
export function phoneDiagram() {
  const svg = `<svg viewBox="0 0 360 150" xmlns="http://www.w3.org/2000/svg">
    <rect class="phone" x="70" y="22" width="220" height="108" rx="16"/><rect class="screen" x="82" y="32" width="196" height="88" rx="8"/>
    <path class="frame" d="M98 44h14M98 44v10M262 44h-14M262 44v10M98 108h14M98 108v-10M262 108h-14M262 108v-10"/>
    <g class="k"><rect x="94" y="94" width="44" height="18" rx="5"/><text x="116" y="107">Re-zero</text></g>
    <rect class="track" x="146" y="101" width="70" height="4" rx="2"/><circle class="btn" cx="170" cy="103" r="6"/>
    <circle class="rec" cx="258" cy="103" r="9"/>
    <path class="arc" d="M40 76 q-14 -30 14 -52" /><path class="arc" d="M320 76 q14 -30 -14 -52"/>
    ${note(180, 14, 'Tilt and turn the phone to aim the shot camera', 'middle')}
    ${note(116, 146, 'level the aim', 'middle')}${note(181, 146, 'lens', 'middle')}${note(258, 146, 'arm · record', 'middle')}
  </svg>`;
  return svgFigure('ex-phone', 'Phone: hold it like a camera and tilt or turn it to aim the shot camera. Re-zero levels the aim, the slider sets the lens, the red button arms and records.', svg, 'Phone');
}

/** Pairing a phone: scan, trust the certificate, open the link. */
export function phonePairDiagram() {
  const step = (x: number, n: number, title: string, art: string) => `<g transform="translate(${x} 0)"><circle class="num" cx="16" cy="16" r="11"/><text class="b inv" x="16" y="20">${n}</text>${art}${note(56, 128, title, 'middle')}</g>`;
  const qr = Array.from({ length: 25 }, (_, i) => ((i * 7) % 3 ? `<rect x="${30 + (i % 5) * 10}" y="${42 + Math.floor(i / 5) * 10}" width="9" height="9"/>` : '')).join('');
  const svg = `<svg viewBox="0 0 360 140" xmlns="http://www.w3.org/2000/svg">
    ${step(0, 1, 'Scan the QR code', `<rect class="screen" x="24" y="36" width="64" height="64" rx="6"/><g class="qr">${qr}</g>`)}
    ${step(122, 2, 'Trust ca.crt once', `<path class="shield" d="M56 34 l26 10 v22 q0 22 -26 34 q-26 -12 -26 -34 v-22 z"/><path class="tick" d="M44 66 l9 9 l17 -19"/>`)}
    ${step(244, 3, 'Open the link', `<rect class="phone" x="34" y="30" width="44" height="80" rx="9"/><rect class="screen" x="39" y="40" width="34" height="58" rx="3"/><circle class="rec" cx="56" cy="88" r="5"/>`)}
    <path class="arr" d="M104 70h18M226 70h18"/>
  </svg>`;
  return svgFigure('ex-pair', 'Pairing a phone in three steps: scan the QR code, trust the ca.crt certificate once, then open the link on the phone.', svg);
}

/** What a video model takes, by task (J11): the grey clip, start/end stills, or the prompt only. */
export function modelInputsDiagram(task: string, opts: { twoFrames?: boolean; castImages?: number } = {}) {
  const clip = task === 'transform-video' || task === 'control-video', stills = task === 'first-frame';
  const tile = (x: number, label: string, cls: string) => `<g transform="translate(${x} 30)"><rect class="${cls}" width="64" height="36" rx="4"/>${cls === 'clip' ? '<path class="film" d="M0 8h64M0 28h64"/>' : ''}${note(32, 50, label, 'middle')}</g>`;
  const ins = clip ? tile(8, 'blockout clip', 'clip') : stills ? tile(8, 'start still', 'still') + (opts.twoFrames ? tile(78, 'end still', 'still') : '') : `<g transform="translate(8 30)"><rect class="prompt" width="64" height="36" rx="4"/><path class="lines" d="M8 12h48M8 20h40M8 28h30"/>${note(32, 50, 'prompt', 'middle')}</g>`;
  const end = clip ? 92 : stills && opts.twoFrames ? 162 : 92;
  const refs = opts.castImages ? `<g transform="translate(${end - 80} 2)"><rect class="cast" width="18" height="18" rx="3"/><text class="b" x="9" y="13">${opts.castImages}</text></g>${note(end - 58, 15, 'cast images')}` : '';
  const svg = `<svg viewBox="0 0 ${end + 100} 90" xmlns="http://www.w3.org/2000/svg">${refs}${ins}<path class="arr" d="M${end - 14} 48h22"/><g transform="translate(${end + 14} 30)"><rect class="video" width="64" height="36" rx="4"/><path class="play" d="M27 11l12 7-12 7z"/>${note(32, 50, 'video', 'middle')}</g></svg>`;
  const what = clip ? 'the grey blockout clip, so it follows your camera move' : stills ? (opts.twoFrames ? 'a start and an end still and animates between them' : 'a start still and animates from it') : 'only the prompt';
  return svgFigure('ex-inputs', `This video model takes ${what}${opts.castImages ? `, plus ${opts.castImages} cast images` : ''}.`, svg);
}
