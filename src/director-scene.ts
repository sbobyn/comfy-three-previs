import * as THREE from 'three';
import { buildBlockoutModel, loadBlockoutModels, modelReady, poseModel } from './director-models';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { computeModal, computeModalNumeric, modalKey as feedModalKey, modalHud, rigidApply, gridStep, unitsPerPixel, snapActive, snapDelta, framingDistance, isDrag, marqueeRect, inRect, RIGHT_CLICK_SLOP } from '../shared/editor-controls.mjs';
import type { XForm, ModalMode, ModalState } from '../shared/editor-controls.mjs';
import { KIND_COLORS } from '../shared/prompt.mjs';
import { terrainHeight } from '../shared/terrain.mjs';
import { withDescendants, SHAPES, cameraKeys, cameraAt, focusPoint, entitySize, entityAt, entitiesAt, shotCameraAt } from '../shared/director.mjs';
import type { DirectorProject, Shot, Entity, CameraKey, Vec3 } from '../shared/director.mjs';

const HELPERS = 1; // Layer hidden from the shot camera.
const rad = (d: number) => (d * Math.PI) / 180;
const ENV: Record<string, { sky: number; ground: number; fog: [number, number] }> = {
  stage: { sky: 0x1a1e25, ground: 0x2b3038, fog: [70, 220] },
  street: { sky: 0x0e131b, ground: 0x24272c, fog: [55, 190] },
  interior: { sky: 0x17130f, ground: 0x3a322c, fog: [40, 150] },
};
// Scenes with terrain are outdoors whatever their preset: a daylight sky that follows the camera, haze on distant
// slopes (shot camera only), and enough sky fill that slopes facing away from the sun still read.
const OUTDOOR = { zenith: '#4f86c6', upper: '#8fb6dc', horizon: '#d3dfe8', below: '#a3ab96', hemi: [0xd4e4f5, 0x7a735f, 2.2] as const, sun: [0xfff1dc, 3.0] as const, sunAt: [-14, 12, 5] as const, fog: [30, 620] as const };
const STUDIO = { hemi: [0xc4ccd8, 0x2a2420, 1.1] as const, sun: [0xffffff, 1.7] as const, sunAt: [9, 16, 11] as const };
let skyTexture: THREE.Texture | null = null;
function outdoorSky() {
  if (skyTexture) return skyTexture;
  const c = document.createElement('canvas'); c.width = 4; c.height = 256;
  const g = c.getContext('2d')!, grad = g.createLinearGradient(0, 0, 0, 256);
  grad.addColorStop(0, OUTDOOR.zenith); grad.addColorStop(0.36, OUTDOOR.upper); grad.addColorStop(0.5, OUTDOOR.horizon); grad.addColorStop(0.53, OUTDOOR.below); grad.addColorStop(1, OUTDOOR.below);
  g.fillStyle = grad; g.fillRect(0, 0, 4, 256);
  skyTexture = new THREE.CanvasTexture(c); skyTexture.mapping = THREE.EquirectangularReflectionMapping; skyTexture.colorSpace = THREE.SRGBColorSpace;
  return skyTexture;
}
export const isOutdoor = (entities: Pick<Entity, 'shape'>[]) => entities.some(e => e.shape === 'terrain');

function disposeShape(group: THREE.Object3D) {
  group.traverse(o => {
    const mesh = o as THREE.Mesh;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    materials.forEach(m => m.dispose());
  });
}

function material(color: string) { return new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0.02 }); }
function part(geometry: THREE.BufferGeometry, mat: THREE.Material, x = 0, y = 0, z = 0) {
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true;
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry, 30), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.16 }));
  mesh.add(edges);
  return mesh;
}

// Guide-only parts: hidden everywhere except still-guide captures (capture(..., { guide: true })), where they show
// image models which way things face. Never cast or picked.
function guidePart(geometry: THREE.BufferGeometry, color: string, x: number, y: number, z: number, glow = 0) {
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color, roughness: 0.6, ...(glow ? { emissive: color, emissiveIntensity: glow } : {}) }));
  mesh.position.set(x, y, z); mesh.castShadow = false; mesh.visible = false; mesh.userData.guide = true;
  return mesh;
}
/** A flat wedge on the ground pointing forward (+z) from z0, length len. */
function guideWedge(z0: number, len: number, half: number) {
  const tri = new THREE.Shape([new THREE.Vector2(-half, z0), new THREE.Vector2(half, z0), new THREE.Vector2(0, z0 + len)]);
  const geo = new THREE.ShapeGeometry(tri).rotateX(Math.PI / 2); // shape y → world +z
  const mesh = guidePart(geo, '#e8ecf2', 0, 0.12, 0); // above thin set floors and the guide grid (mesh.material as THREE.Material).side = THREE.DoubleSide;
  return mesh;
}

// Base-size geometry for each blockout shape. Forward is +z (rotation 0 faces the default camera).
function buildShape(shape: string, color: string): THREE.Group {
  const g = new THREE.Group(), m = material(color);
  const [w, h, d] = SHAPES[shape]?.size || [1, 1, 1];
  switch (shape) {
    case 'bird': {
      // A spread-wing silhouette, with the head/beak toward +z like the other directed shapes.
      g.add(part(new THREE.SphereGeometry(1, 12, 8).scale(0.16, 0.2, 0.35), m, 0, 0.25, 0));
      for (const side of [-1, 1]) {
        const wing = new THREE.Shape([new THREE.Vector2(side * 0.1, 0.2), new THREE.Vector2(side * 1.2, 0.05), new THREE.Vector2(side * 1.05, -0.32), new THREE.Vector2(side * 0.15, -0.2)]);
        const geo = new THREE.ExtrudeGeometry(wing, { depth: 0.045, bevelEnabled: false }).rotateX(Math.PI / 2);
        g.add(part(geo, m, 0, 0.3, 0));
      }
      const white = material('#eee9da');
      g.add(part(new THREE.SphereGeometry(0.12, 12, 8), white, 0, 0.32, 0.35));
      g.add(part(new THREE.ConeGeometry(0.07, 0.18, 6).rotateX(Math.PI / 2), material('#e5b447'), 0, 0.3, 0.46));
      g.add(part(new THREE.BoxGeometry(0.24, 0.045, 0.24), white, 0, 0.22, -0.43));
      break;
    }
    case 'person': {
      g.add(part(new THREE.CapsuleGeometry(0.21, 0.95, 4, 12), m, 0, 0.21 + 0.48 + 0.1, 0));
      g.add(part(new THREE.SphereGeometry(0.15, 16, 12), m, 0, 1.62, 0));
      g.add(part(new THREE.BoxGeometry(0.1, 0.06, 0.14), material('#f2f2f2'), 0, 1.62, 0.13));
      // Guide: a pale face, shoes pointing forward and a ground wedge, so front and back read even from behind.
      g.add(guidePart(new THREE.SphereGeometry(0.13, 16, 12).scale(0.9, 1.1, 0.55), '#d9dde2', 0, 1.61, 0.105)); // pale oval face
      for (const x of [-0.1, 0.1]) g.add(guidePart(new THREE.BoxGeometry(0.11, 0.09, 0.3), '#202226', x, 0.045, 0.09));
      g.add(guideWedge(0.3, 0.55, 0.16));
      break;
    }
    case 'car': {
      g.add(part(new THREE.BoxGeometry(w, 0.65, d), m, 0, 0.6, 0));
      g.add(part(new THREE.BoxGeometry(w * 0.86, 0.5, d * 0.5), m, 0, 1.17, -0.15));
      const wheel = new THREE.CylinderGeometry(0.34, 0.34, 0.24, 16).rotateZ(Math.PI / 2), tyre = material('#18191c');
      for (const [x, z] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) g.add(part(wheel, tyre, x * (w / 2 - 0.08), 0.34, z * (d / 2 - 0.8)));
      const light = new THREE.MeshStandardMaterial({ color: '#fff3c4', emissive: '#fff3c4', emissiveIntensity: 1.2 });
      for (const x of [-1, 1]) g.add(part(new THREE.BoxGeometry(0.34, 0.14, 0.04), light, x * (w / 2 - 0.3), 0.72, d / 2 + 0.01));
      // Guide: bright headlights on a pale nose, a pale windscreen on the cabin front, red tail lights and a ground wedge.
      g.add(guidePart(new THREE.BoxGeometry(w * 0.94, 0.34, 0.04), '#dfe3e8', 0, 0.55, d / 2 + 0.03));
      for (const x of [-1, 1]) g.add(guidePart(new THREE.BoxGeometry(0.42, 0.18, 0.05), '#fff6cf', x * (w / 2 - 0.3), 0.72, d / 2 + 0.06, 3));
      g.add(guidePart(new THREE.BoxGeometry(w * 0.8, 0.42, 0.04), '#c6d6e6', 0, 1.17, -0.15 + d * 0.25 + 0.03));
      for (const x of [-1, 1]) g.add(guidePart(new THREE.BoxGeometry(0.5, 0.24, 0.05), '#ff3b2f', x * (w / 2 - 0.32), 0.74, -d / 2 - 0.03, 2.5));
      g.add(guideWedge(d / 2 + 0.4, 1.4, 0.45));
      break;
    }
    case 'table': {
      g.add(part(new THREE.BoxGeometry(w, 0.06, d), m, 0, h - 0.03, 0));
      for (const [x, z] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) g.add(part(new THREE.BoxGeometry(0.06, h - 0.06, 0.06), m, x * (w / 2 - 0.08), (h - 0.06) / 2, z * (d / 2 - 0.08)));
      break;
    }
    case 'chair': {
      g.add(part(new THREE.BoxGeometry(w, 0.06, d), m, 0, 0.45, 0));
      g.add(part(new THREE.BoxGeometry(w, 0.45, 0.05), m, 0, 0.7, -d / 2 + 0.03));
      for (const [x, z] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) g.add(part(new THREE.BoxGeometry(0.04, 0.42, 0.04), m, x * (w / 2 - 0.04), 0.21, z * (d / 2 - 0.04)));
      break;
    }
    case 'sphere': g.add(part(new THREE.SphereGeometry(w / 2, 24, 16), m, 0, h / 2, 0)); break;
    case 'cylinder': g.add(part(new THREE.CylinderGeometry(w / 2, w / 2, h, 24), m, 0, h / 2, 0)); break;
    case 'lamp': {
      g.add(part(new THREE.CylinderGeometry(0.06, 0.08, h, 10), m, 0, h / 2, 0));
      g.add(part(new THREE.BoxGeometry(0.5, 0.12, 0.25), new THREE.MeshStandardMaterial({ color: '#ffe0a0', emissive: '#ffcf7a', emissiveIntensity: 1.5 }), 0, h, 0.15));
      break;
    }
    case 'terrain': { // heightfield in local space (entity position/scale are applied by the group)
      const N = 192, geo = new THREE.PlaneGeometry(w, d, N, N).rotateX(-Math.PI / 2);
      const pos = geo.attributes.position as THREE.BufferAttribute, cols: number[] = [];
      const base = { position: [0, 0, 0], scale: [1, 1, 1] };
      for (let i = 0; i < pos.count; i++) pos.setY(i, terrainHeight(base, pos.getX(i), pos.getZ(i)));
      geo.computeVertexNormals();
      const nrm = geo.attributes.normal as THREE.BufferAttribute;
      const meadow = new THREE.Color('#7fa35a'), forest = new THREE.Color('#3f6236'), rock = new THREE.Color('#a39a8c'), snow = new THREE.Color('#f3f4f2'), c = new THREE.Color(), tmp = new THREE.Color();
      const ramp = (v: number, a0: number, a1: number) => Math.min(1, Math.max(0, (v - a0) / (a1 - a0)));
      for (let i = 0; i < pos.count; i++) {
        const y = pos.getY(i), steep = 1 - nrm.getY(i), x = pos.getX(i), z = pos.getZ(i);
        const jitter = (Math.sin(x * 0.37 + z * 0.21) * Math.sin(z * 0.29 - x * 0.13)) * 0.5; // soft patchiness
        c.copy(meadow).lerp(forest, ramp(y + jitter * 4, 3, 22));
        // Forest climbs the lower slopes to a ragged tree line; granite above and on cliffs; snowfields near the summits.
        c.lerp(rock, Math.max(ramp(y + jitter * 14, 70, 125), ramp(steep, 0.34, 0.58) * ramp(y, 12, 45)));
        c.lerp(snow, ramp(y + jitter * 14, 140, 175) * (1 - ramp(steep, 0.5, 0.7)));
        c.lerp(tmp.setRGB(c.r * 1.06, c.g * 1.04, c.b * 0.98), jitter + 0.5); // slight hue variation
        cols.push(c.r, c.g, c.b);
      }
      geo.setAttribute('color', new THREE.Float32BufferAttribute(cols, 3));
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
      mesh.receiveShadow = true; mesh.userData.terrain = true; g.add(mesh); break;
    }
    case 'tree': {
      g.add(part(new THREE.CylinderGeometry(0.14, 0.2, h * 0.35, 8), material('#6b4c33'), 0, h * 0.175, 0));
      g.add(part(new THREE.ConeGeometry(w / 2, h * 0.7, 10), m, 0, h * 0.35 + h * 0.35, 0));
      break;
    }
    case 'rock': g.add(part(new THREE.DodecahedronGeometry(0.75, 0).scale(w / 1.5, h / 1.5, d / 1.5), m, 0, h * 0.45, 0)); break;
    case 'group': { // an empty: a small editor-only marker at the pivot, never in the shot
      const mk = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.OctahedronGeometry(0.28)), new THREE.LineBasicMaterial({ color: '#C8401F' }));
      mk.position.y = 0.3; mk.layers.set(HELPERS); g.add(mk); break;
    }
    default: g.add(part(new THREE.BoxGeometry(w, h, d), m, 0, h / 2, 0));
  }
  return g;
}

// Ground, road, lights and fog shared by the workspace and still renders.
export function createStage() {
  const scene = new THREE.Scene();
  scene.fog = null; // fog off for now: it hid distant set pieces in previs shots
  const hemi = new THREE.HemisphereLight(...STUDIO.hemi);
  const sun = new THREE.DirectionalLight(...STUDIO.sun);
  sun.position.set(...STUDIO.sunAt); sun.castShadow = true;
  fitSunShadow(sun, new THREE.Box3()); // the default box until objects arrive; sync() fits it to the scene
  scene.add(hemi, sun, sun.target);
  // Flat ground layers all sit at y = 0. Depth can't separate coplanar surfaces (especially far away),
  // so they never depth-test: they paint in a fixed order — ground, road, lane markings, grid — before
  // any object. The ground alone writes depth, so cars and people standing on it hide the layers above
  // it normally and anything below y = 0 stays hidden.
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(8000, 8000), new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 1, depthTest: false, depthWrite: true }));
  ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; ground.renderOrder = -10; scene.add(ground);
  const road = new THREE.Group();
  const lane = new THREE.Mesh(new THREE.PlaneGeometry(9, 8000), new THREE.MeshStandardMaterial({ color: 0x17181b, roughness: 0.6, depthTest: false, depthWrite: false }));
  lane.renderOrder = -9; road.add(lane);
  const dashMat = new THREE.MeshBasicMaterial({ color: 0xbfb27a, depthTest: false, depthWrite: false });
  for (let z = -1500; z < 1500; z += 6) { const dash = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 2.5), dashMat); dash.position.set(0, z, 0); dash.renderOrder = -8; road.add(dash); }
  road.rotation.x = -Math.PI / 2; road.children.forEach(c => (c as THREE.Mesh).receiveShadow = true); scene.add(road);
  // Opaque (pre-blended) grid so it stays in the ordered pass instead of the transparent one.
  const grid = new THREE.GridHelper(80, 80, 0x3d434d, 0x30353d);
  Object.assign(grid.material as THREE.Material, { transparent: false, depthTest: false, depthWrite: false }); grid.renderOrder = -7; scene.add(grid);
  // Still guides only: a light ground grid just above flat set surfaces (track, floor, grass) for perspective and depth.
  const guideGrid = new THREE.GridHelper(400, 200, 0xa3abb5, 0x8a929c);
  Object.assign(guideGrid.material as THREE.Material, { transparent: true, opacity: 0.4, depthWrite: false });
  guideGrid.position.y = 0.1; guideGrid.visible = false; scene.add(guideGrid);
  return { scene, ground, road, grid, hemi, sun, guideGrid };
}

// ---------- Shadows and depth precision (docs/blockout-modeling-rules.md) ----------
type Placed = { group: THREE.Object3D; entity: Entity };
const DEFAULT_SET = new THREE.Box3(new THREE.Vector3(-25, 0, -25), new THREE.Vector3(25, 4, 25));
/** World bounds of every shadow caster (each object but terrain and group pivots), over its whole animation path. */
export function casterBounds(items: Iterable<Placed>) {
  const out = new THREE.Box3(), part = new THREE.Box3(), shift = new THREE.Vector3();
  for (const { group, entity } of items) {
    if (entity.shape === 'group' || entity.shape === 'terrain') continue;
    group.updateWorldMatrix(true, true); part.setFromObject(group);
    if (part.isEmpty()) continue;
    out.union(part);
    for (const k of entity.path || []) { const p = entityAt(entity, k.t).position; shift.set(p[0], p[1], p[2]).sub(group.position); out.union(part.clone().translate(shift)); }
  }
  return out;
}
/** Shadow map size for a set: 2048² up to 60 m across, 4096² beyond. Fixed per scene, so refits never reallocate it. */
export const shadowMapSize = (casters: THREE.Box3) => (casters.isEmpty() || casters.getSize(new THREE.Vector3()).length() <= 60 ? 2048 : 4096);
/**
 * Where a camera's shadows matter: the box around its frustum out to 4× the distance to what it looks at (40–160 m).
 * Pass several poses (a whole shot) for one box that every frame of the shot shares, so shadows never shimmer.
 */
export function shadowFocus(poses: ScenePose[], aspect = 16 / 9) {
  const box = new THREE.Box3(), cam = new THREE.PerspectiveCamera(40, aspect, 0.1, 10), m = new THREE.Matrix4(), v = new THREE.Vector3();
  for (const pose of poses) {
    cam.position.set(...pose.p); cam.quaternion.setFromRotationMatrix(m.lookAt(cam.position, v.set(...pose.look), new THREE.Vector3(0, 1, 0)));
    cam.setFocalLength(pose.mm); cam.updateMatrixWorld();
    const reach = Math.min(160, Math.max(40, 4 * cam.position.distanceTo(v.set(...pose.look))));
    // The frustum is widened to a square on its longer side, so portrait and landscape frames get the same box.
    const t = Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * Math.max(aspect, 1 / aspect, 1) * reach;
    box.expandByPoint(cam.position);
    for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box.expandByPoint(v.set(x * t, y * t, -reach).applyMatrix4(cam.matrixWorld));
  }
  return box;
}
/**
 * Fit the sun's orthographic shadow camera tightly, keeping the sun's direction: across the light it covers the
 * casters (every object but terrain, over its whole animation path) where they meet `focus` (what the camera sees);
 * along the light it spans every caster and the focus box, so nothing that shadows the view or receives it is cut.
 * Biases are set in world terms from the texel size (half a texel of normal bias, at least 5 mm, and a quarter texel
 * of depth bias): enough against acne, since only back faces cast, and small enough that shadows stay attached and do
 * not leak into narrow gaps between parts. Viewport, monitor, card stills, captures and the headless renderer all fit
 * with the same inputs, so their shadows match.
 */
export function fitSunShadow(sun: THREE.DirectionalLight, casters: THREE.Box3, focus: THREE.Box3 | null = null) {
  const box = casters.isEmpty() ? DEFAULT_SET : casters, cam = sun.shadow.camera;
  const centre = box.getCenter(new THREE.Vector3()), radius = box.getBoundingSphere(new THREE.Sphere()).radius + (focus ? focus.getBoundingSphere(new THREE.Sphere()).radius + focus.distanceToPoint(centre) : 0);
  const dir = sun.position.clone().sub(sun.target.position).normalize();
  if (!Number.isFinite(dir.x) || dir.lengthSq() < 0.5) dir.set(...STUDIO.sunAt).normalize();
  sun.target.position.copy(centre); sun.position.copy(centre).addScaledVector(dir, radius + 10);
  sun.target.updateMatrixWorld(); sun.updateMatrixWorld();
  cam.position.copy(sun.position); cam.lookAt(centre); cam.updateMatrixWorld(); // as DirectionalLightShadow does
  const extent = (b: THREE.Box3) => {
    const lo = new THREE.Vector3(Infinity, Infinity, Infinity), hi = new THREE.Vector3(-Infinity, -Infinity, -Infinity), v = new THREE.Vector3();
    for (let i = 0; i < 8; i++) { v.set(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z).applyMatrix4(cam.matrixWorldInverse); lo.min(v); hi.max(v); }
    return { lo, hi };
  };
  const all = extent(box), across = { lo: all.lo.clone(), hi: all.hi.clone() };
  if (focus && !focus.isEmpty()) {
    const f = extent(focus);
    across.lo.max(f.lo); across.hi.min(f.hi);
    all.lo.z = Math.min(all.lo.z, f.lo.z); all.hi.z = Math.max(all.hi.z, f.hi.z);
    if (across.lo.x > across.hi.x || across.lo.y > across.hi.y) { across.lo.copy(f.lo); across.hi.copy(f.hi); } // nothing casts into view
  }
  const map = shadowMapSize(casters), pad = 0.5, size = Math.max(across.hi.x - across.lo.x, across.hi.y - across.lo.y) + 2 * pad, texel = size / map;
  // Centre snapped to whole texels: a box that moves keeps its texel grid, so edges do not crawl.
  const cx = Math.round((across.lo.x + across.hi.x) / 2 / texel) * texel, cy = Math.round((across.lo.y + across.hi.y) / 2 / texel) * texel;
  Object.assign(cam, { left: cx - size / 2, right: cx + size / 2, bottom: cy - size / 2, top: cy + size / 2, near: Math.max(0.1, -all.hi.z - pad), far: -all.lo.z + pad });
  cam.updateProjectionMatrix();
  if (sun.shadow.mapSize.x !== map) { sun.shadow.mapSize.set(map, map); sun.shadow.map?.dispose(); sun.shadow.map = null; }
  sun.shadow.bias = -(texel * 0.25) / (cam.far - cam.near);
  sun.shadow.normalBias = Math.max(0.005, texel * 0.5);
}
/**
 * Depth range for a camera at `at`. Precision in a perspective depth buffer is set almost entirely by the near plane,
 * so near is half the clearance to the closest object (between 0.1 m, the old fixed value, and 2 m); nothing is
 * closer than that, so nothing is clipped. Far reaches the farthest object outdoors; studio sets keep the far
 * horizon of the flat ground.
 */
export function depthRange(at: THREE.Vector3, items: Iterable<Placed>, outdoor: boolean, helpers: THREE.Vector3[] = []): [number, number] {
  let clear = Infinity, reach = 0;
  for (const p of helpers) clear = Math.min(clear, Math.max(0, at.distanceTo(p) - 0.5)); // editor rigs and gizmos
  const box = new THREE.Box3();
  for (const { group, entity } of items) {
    if (entity.shape === 'group') continue;
    if (entity.shape === 'terrain') clear = Math.min(clear, Math.max(0, at.y - terrainHeight({ ...entity, position: group.position.toArray(), scale: group.scale.toArray() }, at.x, at.z)) * 0.5);
    group.updateWorldMatrix(true, true); box.setFromObject(group);
    if (box.isEmpty()) continue;
    if (entity.shape !== 'terrain') clear = Math.min(clear, box.distanceToPoint(at));
    reach = Math.max(reach, Math.hypot(Math.max(Math.abs(at.x - box.min.x), Math.abs(at.x - box.max.x)), Math.max(Math.abs(at.y - box.min.y), Math.abs(at.y - box.max.y)), Math.max(Math.abs(at.z - box.min.z), Math.abs(at.z - box.max.z))));
  }
  const near = Math.min(2, Math.max(0.1, clear * 0.5));
  return [near, outdoor ? Math.min(6000, Math.max(100, reach * 1.05 + 10)) : 6000];
}
/** Fit `cam`'s depth range to the scene for one render; returns the function that puts the camera's own range back. */
function fitDepthRange(cam: THREE.Camera, items: Iterable<Placed>, outdoor: boolean, helpers: THREE.Vector3[] = []) {
  const c = cam as THREE.PerspectiveCamera;
  if (!c.isPerspectiveCamera) return () => {};
  const was = [c.near, c.far];
  [c.near, c.far] = depthRange(c.position, items, outdoor, helpers); c.updateProjectionMatrix();
  return () => { [c.near, c.far] = was; c.updateProjectionMatrix(); };
}

// Light sky outdoors so the horizon reads; a dim ceiling tone for interiors.
const GUIDE_SKY: Record<string, number> = { stage: 0xbcc6d1, street: 0x9aa7b6, interior: 0x3b3f46 }, GUIDE_GROUND = 0x5d636b;

function applyEnv(stage: Pick<ReturnType<typeof createStage>, 'scene' | 'ground' | 'road' | 'hemi' | 'sun'>, presetName: string, outdoor = false) {
  const e = ENV[presetName] || ENV.stage, light = outdoor ? OUTDOOR : STUDIO;
  stage.scene.background = outdoor ? outdoorSky() : new THREE.Color(e.sky);
  stage.scene.fog = outdoor ? new THREE.Fog(OUTDOOR.horizon, ...OUTDOOR.fog) : null; // studio sets stay fog-free: fog hid distant set pieces
  stage.hemi.color.setHex(light.hemi[0]); stage.hemi.groundColor.setHex(light.hemi[1]); stage.hemi.intensity = light.hemi[2];
  stage.sun.color.setHex(light.sun[0]); stage.sun.intensity = light.sun[1]; stage.sun.position.set(light.sunAt[0], light.sunAt[1], light.sunAt[2]); stage.sun.target.position.set(0, 0, 0); // a lower, side-on sun models the slopes (direction only: fitSunShadow places it)
  (stage.ground.material as THREE.MeshStandardMaterial).color.setHex(e.ground); stage.road.visible = presetName === 'street';
}
/** Shot-camera renders of an outdoor scene: the terrain is the ground, so the flat y = 0 plane, road and grid (drawn
 * without depth test) would cover dips in the meadow and show through the sky. Returns a restore function. */
function hideFlatGround(stage: Pick<ReturnType<typeof createStage>, 'ground' | 'road' | 'grid'>, outdoor: boolean) {
  if (!outdoor) return () => {};
  const was = [stage.ground.visible, stage.road.visible, stage.grid.visible];
  stage.ground.visible = stage.road.visible = stage.grid.visible = false;
  return () => { [stage.ground.visible, stage.road.visible, stage.grid.visible] = was; };
}

// One shared offscreen renderer for card thumbnails: renders a shot camera frame.
let stillRenderer: THREE.WebGLRenderer | null = null;
export function renderStill(project: Pick<DirectorProject, 'scene'>, shot: Shot, width: number, height: number, t = 0, type = 'image/jpeg') {
  if (!stillRenderer) {
    stillRenderer = new THREE.WebGLRenderer({ canvas: document.createElement('canvas'), antialias: true, preserveDrawingBuffer: true });
    stillRenderer.shadowMap.enabled = true; stillRenderer.shadowMap.type = THREE.PCFShadowMap; stillRenderer.outputColorSpace = THREE.SRGBColorSpace;
  }
  const stage = createStage(), outdoor = isOutdoor(project.scene.entities), placed: Placed[] = [];
  applyEnv(stage, project.scene.environment.preset, outdoor); hideFlatGround(stage, outdoor);
  for (const e of entitiesAt(project.scene.entities, (shot.start || 0) + t)) {
    const g = buildBlockoutModel(e) || buildShape(e.shape, e.color);
    g.position.set(...e.position); g.rotation.set(rad(e.pitch || 0), rad(e.rotation), rad(e.roll || 0), 'YXZ'); g.scale.set(...e.scale);
    poseModel(g, e, (shot.start || 0) + t, e.pose);
    stage.scene.add(g); placed.push({ group: g, entity: project.scene.entities.find(x => x.id === e.id) || e });
  }
  fitSunShadow(stage.sun, casterBounds(placed), shadowFocus(shotPoses(shot, project.scene.entities)));
  const cam = new THREE.PerspectiveCamera(40, width / height, 0.1, 6000);
  const pose = shotCameraAt(shot, project.scene.entities, t);
  cam.position.set(...pose.p);
  cam.quaternion.setFromRotationMatrix(new THREE.Matrix4().lookAt(cam.position, new THREE.Vector3(...pose.look), new THREE.Vector3(0, 1, 0)));
  cam.setFocalLength(pose.mm); cam.updateProjectionMatrix();
  stillRenderer.setPixelRatio(1); stillRenderer.setSize(width, height, false);
  const depth = fitDepthRange(cam, placed, outdoor);
  stillRenderer.render(stage.scene, cam);
  depth();
  const url = stillRenderer.domElement.toDataURL(type, 0.86);
  stage.scene.traverse(o => { const m = o as THREE.Mesh; m.geometry?.dispose(); const mat = m.material as THREE.Material | THREE.Material[] | undefined; (Array.isArray(mat) ? mat : mat ? [mat] : []).forEach(x => x.dispose()); });
  return url;
}

export type ScenePose = { p: Vec3; look: Vec3; mm: number };
/** Nine poses across a shot: enough for one shadow box that covers the whole camera move. */
const shotPoses = (shot: Shot, entities: Entity[]) => Array.from({ length: 9 }, (_, i) => shotCameraAt(shot, entities, (shot.duration * i) / 8));
export type DirectorScene = ReturnType<typeof createDirectorScene>;
export type TransformChange = { id: string; before: XForm; after: XForm };
export type ClickMode = 'replace' | 'add' | 'toggle';
/** auto: characters, vehicles, the shot's target and props at least 24 px on screen (environment on hover/selection); all: every root object; none. */
export type LabelMode = 'auto' | 'all' | 'none';
type Item = {
  group: THREE.Group; entity: Entity; label: HTMLElement; key: string;
  /** Label content key (name|color|image|kind), its lead <img>/swatch, cached group-label height and the last written layout. */
  lkey: string; lead: HTMLElement | null; topOff: number | null; span: number | null; lw: number; lh: number; lx: number; ly: number; shown: boolean; crowded: boolean;
};
const LABEL_MIN_PX = 24, LABEL_GAP = 2, LABEL_PUSHES = 3;

type Events = {
  onRefImage(id: string): string | null;
  /** Click without drag. id is null on empty space. */
  onClickSelect(id: string | null, mode: ClickMode): void;
  /** Shift+drag marquee: ids whose bounds centre is inside the box. */
  onMarquee(ids: string[]): void;
  /** Right press released without dragging. */
  onContextMenu(clientX: number, clientY: number): void;
  /** A gizmo drag or modal transform finished with changes. One undo step. */
  onTransformCommit(changes: TransformChange[], label: string): void;
  /** HUD text while a modal transform runs; null when it ends. */
  onModal(hud: string | null): void;
};

export function createDirectorScene(canvas: HTMLCanvasElement, labelsEl: HTMLElement, monitorEl: HTMLElement, frameEl: HTMLElement, events: Events) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(2, devicePixelRatio));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const captureCanvas = document.createElement('canvas');
  const capturer = new THREE.WebGLRenderer({ canvas: captureCanvas, antialias: true, preserveDrawingBuffer: true });
  capturer.shadowMap.enabled = true; capturer.shadowMap.type = THREE.PCFShadowMap; capturer.outputColorSpace = THREE.SRGBColorSpace;
  const overlay = canvas.parentElement!;

  const { scene, ground, road, grid, hemi, sun, guideGrid } = createStage();
  const guideParts: THREE.Object3D[] = [];

  // Editor cameras: perspective by default, orthographic on Numpad 5.
  const persp = new THREE.PerspectiveCamera(45, 1, 0.1, 6000);
  persp.position.set(10, 9, 16); persp.layers.enableAll();
  const ortho = new THREE.OrthographicCamera(-10, 10, 10, -10, -6000, 6000); ortho.layers.enableAll();
  let world: THREE.PerspectiveCamera | THREE.OrthographicCamera = persp;
  const controls = new OrbitControls(persp, canvas);
  controls.target.set(0, 1, 0); controls.enableDamping = true; controls.dampingFactor = 0.12; controls.minDistance = 0.08; controls.maxDistance = 3000;
  // Wheel / pinch zoom (perspective): one symmetric, exponential zoom toward the point under the cursor.
  // Camera and pivot scale together about that point, so the point stays under the cursor, in and out mirror
  // each other exactly, orbit keeps pivoting where you zoomed, and it never stalls near the pivot.
  controls.zoomToCursor = true; controls.zoomSpeed = 1.2; // ortho view keeps OrbitControls' zoom
  const ZOOM_NEAR = 0.35;
  canvas.addEventListener('wheel', ev => {
    if (world !== persp) return;
    ev.preventDefault(); ev.stopImmediatePropagation();
    const px = ev.deltaMode === 1 ? ev.deltaY * 33 : ev.deltaMode === 2 ? ev.deltaY * 400 : ev.deltaY;
    const k = ev.ctrlKey ? 0.008 : 0.0012; // ~12% per mouse notch; pinch reports small deltas
    const factor = Math.exp(-Math.max(-250, Math.min(250, px)) * k); // >1 zooms in
    const r = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, persp);
    // Anchor: where the cursor ray meets the plane through the pivot, facing the camera.
    const fwd = persp.getWorldDirection(new THREE.Vector3());
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(fwd, controls.target);
    // Prefer the real surface under the cursor (objects or ground); never zoom through it.
    // Big backdrops (terrain, the ground) only count when they're near the pivot: a far mountain under the cursor
    // would drag the zoom (and the orbit pivot) off to the horizon and stall it there.
    const dist = persp.position.distanceTo(controls.target);
    const hitObj = ray.intersectObjects([ground, ...[...groups.values()].map(g => g.group)], true).find(h => (h.object as THREE.Mesh).isMesh && h.object.visible
      && (!(h.object === ground || h.object.userData.terrain) || h.distance < Math.max(3 * dist, 30)));
    const anchor = hitObj?.point.clone() ?? ray.ray.intersectPlane(plane, new THREE.Vector3()) ?? controls.target.clone();
    let next = dist / factor;
    if (next > controls.maxDistance) next = controls.maxDistance;
    // Stop short of a surface: keep at least ZOOM_NEAR between the camera and the point under the cursor.
    if (hitObj && factor > 1) { const toHit = persp.position.distanceTo(anchor); if (toHit * (next / dist) < ZOOM_NEAR) next = dist * Math.min(1, ZOOM_NEAR / Math.max(1e-6, toHit)); }
    if (!hitObj && factor > 1 && next < ZOOM_NEAR) {
      // Already close: fly camera and pivot forward together along the cursor ray instead of stopping.
      const step = ray.ray.direction.clone().multiplyScalar(Math.max(0.05, dist) * (factor - 1));
      persp.position.add(step); controls.target.add(step);
    } else {
      const s2 = next / dist;
      persp.position.sub(anchor).multiplyScalar(s2).add(anchor);
      controls.target.sub(anchor).multiplyScalar(s2).add(anchor);
    }
    controls.update(); markDirty();
  }, { capture: true, passive: false });
  const shotCam = new THREE.PerspectiveCamera(40, 16 / 9, 0.1, 6000); shotCam.layers.set(0);

  // Selection outline (main view only; the shot monitor and captures stay clean).
  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, world);
  const outline = new OutlinePass(new THREE.Vector2(1, 1), scene, world);
  Object.assign(outline, { edgeStrength: 5, edgeThickness: 1, edgeGlow: 0, pulsePeriod: 0 });
  outline.visibleEdgeColor.set(0xd6daff); outline.hiddenEdgeColor.set(0xbac0ff);
  composer.addPass(renderPass); composer.addPass(outline); composer.addPass(new OutputPass());

  // Camera rig shown in the set view.
  const rig = new THREE.Group(); rig.layers.set(HELPERS);
  const camBody = new THREE.Group();
  const amber = new THREE.MeshBasicMaterial({ color: 0xffb547 });
  camBody.add(new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.24, 0.42), amber));
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.18, 14).rotateX(Math.PI / 2), amber); lens.position.z = -0.29; camBody.add(lens);
  camBody.traverse(o => o.layers.set(HELPERS));
  const proxy = new THREE.PerspectiveCamera(40, 16 / 9, 0.3, 2.2);
  const frustum = new THREE.CameraHelper(proxy);
  frustum.setColors(new THREE.Color(0xffb547), new THREE.Color(0xffb547), new THREE.Color(0xffb547), new THREE.Color(0xffb547), new THREE.Color(0xffb547));
  frustum.layers.set(HELPERS);
  const pathGeom = new THREE.BufferGeometry();
  const path = new THREE.Line(pathGeom, new THREE.LineBasicMaterial({ color: 0xffb547, transparent: true, opacity: 0.85 })); path.layers.set(HELPERS);
  const lookGeom = new THREE.BufferGeometry();
  const lookLine = new THREE.LineSegments(lookGeom, new THREE.LineDashedMaterial({ color: 0xffb547, dashSize: 0.2, gapSize: 0.15, transparent: true, opacity: 0.5 })); lookLine.layers.set(HELPERS);
  const startDot = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff })); startDot.layers.set(HELPERS);
  const endDot = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), amber); endDot.layers.set(HELPERS);
  rig.add(camBody, path, lookLine, startDot, endDot);
  scene.add(rig, frustum);

  // Transform gizmo (Move / Rotate / Resize), world space.
  const gizmo = new TransformControls(persp, canvas);
  gizmo.size = 0.82; gizmo.setSpace('world');
  gizmo.setColors(0xD9603B, 0x5E9E6E, 0x5A7FC8, 0xF0B43C); // warm palette: X tally red, Y sage, Z slate blue, active amber
  const gizmoHelper = gizmo.getHelper(); scene.add(gizmoHelper);

  const marquee = document.createElement('div'); marquee.className = 'marquee'; marquee.hidden = true; overlay.append(marquee);

  const groups = new Map<string, Item>();
  const trails = new Map<string, THREE.Line>();
  let entities: Entity[] = [], shot: Shot | null = null, keys: CameraKey[] = [], playhead = 0, view: 'set' | 'camera' = 'set', dirty = true, env = 'stage';
  let selectedIds: string[] = [], primary: string | null = null;
  let hiddenIds = new Set<string>(); // client-only: hidden in the editor views, never in captures
  let live: ScenePose | null = null; // [operate] pose flown by the camera operator, overrides the shot camera while set.
  let aimOverride: { q: [number, number, number, number]; mm: number | null } | null = null; // [director-phone]
  let mode: ModalMode = 'translate', snapPref = false, ctrlHeld = false, step = 1;
  let labelMode: LabelMode = 'auto', pointerHover: string | null = null;
  // Drawing is on demand: controls (incl. damping), gizmo, edits, playhead, hover, view, live pose and resize mark the frame dirty.
  const markDirty = () => { dirty = true; };
  controls.addEventListener('change', markDirty);
  gizmo.addEventListener('change', markDirty);

  const xformOf = (g: THREE.Object3D): XForm => ({ position: g.position.toArray() as Vec3, rotation: ((THREE.MathUtils.radToDeg(g.rotation.y) % 360) + 360) % 360, scale: g.scale.toArray() as Vec3 });
  const applyX = (g: THREE.Object3D, x: XForm) => { g.position.set(...x.position); g.rotation.y = rad(x.rotation); g.scale.set(...x.scale); };
  const entityX = (e: Entity): XForm => ({ position: [...e.position] as Vec3, rotation: e.rotation, scale: [...e.scale] as Vec3 });
  const snapping = () => snapActive(snapPref, ctrlHeld);

  function placeGroup(group: THREE.Group, e: Entity) { applyX(group, entityX(e)); group.rotation.order = 'YXZ'; group.rotation.x = rad(e.pitch || 0); group.rotation.z = rad(e.roll || 0); poseModel(group, e, sceneTime(), e.pose); }
  function attachGizmo() {
    const g = primary ? groups.get(primary)?.group : null;
    if (g && view === 'set' && !modal) gizmo.attach(g); else gizmo.detach();
    gizmo.setMode(mode);
    const rotate = mode === 'rotate';
    Object.assign(gizmo, { showX: !rotate, showZ: !rotate, showY: true });
    gizmo.setTranslationSnap(snapping() ? step : null);
    markDirty();
  }
  /** What a transform moves: the selection plus everything inside it. */
  const moving = () => withDescendants(entities, selectedIds).filter(id => groups.has(id));
  let hoverId: string | null = null;
  function refreshOutline() {
    const ids = new Set(moving()); if (hoverId) for (const id of withDescendants(entities, [hoverId])) ids.add(id);
    outline.selectedObjects = [...ids].map(id => groups.get(id)?.group).filter(Boolean) as THREE.Object3D[];
    for (const [id, { label }] of groups) label.classList.toggle('sel', selectedIds.includes(id));
    // Motion trails only for the selection; showing every path turns the road into noise.
    for (const [id, line] of trails) line.visible = selectedIds.includes(id);
    markDirty();
  }

  function sync(project: DirectorProject, current: Shot) {
    entities = project.scene.entities; shot = current;
    if (entities.some(e => !modelReady(e))) void loadBlockoutModels(entities).then(() => {
      if (entities === project.scene.entities && shot) sync(project, shot);
    }).catch(e => console.error(e));
    const preset = (ENV[project.scene.environment.preset] ? project.scene.environment.preset : 'stage') + (isOutdoor(entities) ? ':outdoor' : '');
    if (preset !== env || !scene.background) { env = preset; applyEnv({ scene, ground, road, hemi, sun }, preset.split(':')[0], preset.endsWith(':outdoor')); }
    const seen = new Set<string>();
    for (const e of entities) {
      seen.add(e.id);
      const key = `${e.shape}|${e.color}|${e.model || ''}|${modelReady(e)}`;
      let item = groups.get(e.id);
      if (!item || item.key !== key) {
        if (item) { if (gizmo.object === item.group) gizmo.detach(); scene.remove(item.group); item.label.remove(); dropGuideParts(item.group); disposeShape(item.group); }
        const group = buildBlockoutModel(e) || buildShape(e.shape, e.color); group.userData.entityId = e.id;
        group.traverse(o => { o.userData.entityId = e.id; if (o.userData.guide) guideParts.push(o); });
        scene.add(group);
        const label = document.createElement('div'); label.className = 'label'; label.dataset.id = e.id; label.style.display = 'none'; labelsEl.append(label);
        item = { group, entity: e, label, key, lkey: '', lead: null, topOff: null, span: null, lw: 0, lh: 0, lx: NaN, ly: NaN, shown: false, crowded: false }; groups.set(e.id, item);
      }
      item.entity = e;
      // Never fight a live gizmo drag or modal preview.
      if (!(gizmoDrag?.starts.has(e.id)) && !(modal?.starts.has(e.id))) placeGroup(item.group, e);
      item.group.visible = !hiddenIds.has(e.id);
      const ref = events.onRefImage(e.id), lkey = `${e.name}|${e.color}|${ref || ''}|${e.kind}`;
      if (item.lkey !== lkey) { // rebuild only on change; the same image URL keeps its <img>
        let lead = item.lead;
        if (ref) { if (!(lead instanceof HTMLImageElement) || lead.getAttribute('src') !== ref) { lead = document.createElement('img'); lead.setAttribute('src', ref); (lead as HTMLImageElement).alt = ''; } }
        else { if (!lead || lead instanceof HTMLImageElement) { lead = document.createElement('span'); lead.className = 'sw'; } lead.style.background = e.color; }
        item.label.replaceChildren(lead, e.name);
        item.label.style.setProperty('--k', KIND_COLORS[e.kind] || '#9aa7b8');
        Object.assign(item, { lkey, lead, lw: 0 });
      }
      const tgt = e.id === current.camera.target;
      if (item.label.classList.contains('tgt') !== tgt) { item.label.classList.toggle('tgt', tgt); item.lw = 0; }
    }
    for (const [id, item] of groups) if (!seen.has(id)) { if (gizmo.object === item.group) gizmo.detach(); scene.remove(item.group); item.label.remove(); dropGuideParts(item.group); disposeShape(item.group); groups.delete(id); }
    // Motion trails for animated objects.
    for (const [id, line] of trails) if (!entities.some(e => e.id === id && e.path && e.path.length > 1)) { scene.remove(line); line.geometry.dispose(); trails.delete(id); }
    for (const e of entities) {
      if (!e.path || e.path.length < 2) continue;
      let line = trails.get(e.id);
      if (!line) { line = new THREE.Line(new THREE.BufferGeometry(), new THREE.LineDashedMaterial({ color: e.color, dashSize: 0.5, gapSize: 0.3, transparent: true, opacity: 0.8 })); line.layers.set(HELPERS); line.visible = selectedIds.includes(e.id); scene.add(line); trails.set(e.id, line); }
      (line.material as THREE.LineDashedMaterial).color.set(e.color);
      const t0 = e.path[0].t, t1 = e.path.at(-1)!.t, n = Math.min(400, Math.max(16, Math.ceil((t1 - t0) * 12)));
      line.geometry.setFromPoints(Array.from({ length: n + 1 }, (_, i) => { const q = entityAt(e, t0 + ((t1 - t0) * i) / n).position; return new THREE.Vector3(q[0], q[1] + 0.25, q[2]); }));
      line.computeLineDistances();
    }
    applyTime(sceneTime());
    casters = casterBounds(groups.values());
    // Group labels sit above their members: bounds once per sync, kept as an offset from the group's own height.
    for (const item of groups.values()) {
      if (item.entity.shape !== 'group') { item.topOff = item.span = null; continue; }
      const b = new THREE.Box3();
      for (const id of withDescendants(entities, [item.entity.id])) { const g2 = groups.get(id); if (g2 && g2.entity.shape !== 'group') b.expandByObject(g2.group); }
      item.topOff = b.isEmpty() ? null : b.max.y + 0.4 - item.group.position.y;
      item.span = b.isEmpty() ? null : Math.max(...b.getSize(new THREE.Vector3()).toArray());
    }
    keys = cameraKeys(current, entitiesAt(entities, current.start || 0));
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 64; i++) pts.push(new THREE.Vector3(...shotCameraAt(current, entities, (i / 64) * current.duration).p));
    pathGeom.setFromPoints(pts);
    startDot.position.copy(pts[0]); endDot.position.copy(pts.at(-1)!);
    refreshOutline(); attachGizmo();
  }

  // Shadow casters (every object over its whole path), refreshed on each sync; each render fits the sun to its view.
  let casters = new THREE.Box3();
  const up = new THREE.Vector3(0, 1, 0), m4 = new THREE.Matrix4();
  function poseCamera(cam: THREE.PerspectiveCamera, pose: ScenePose) {
    cam.position.set(...pose.p);
    m4.lookAt(cam.position, new THREE.Vector3(...pose.look), up);
    cam.quaternion.setFromRotationMatrix(m4);
    cam.setFocalLength(pose.mm); cam.updateProjectionMatrix(); cam.updateMatrixWorld();
  }
  function pose(t = playhead): ScenePose { return shot ? shotCameraAt(shot, entities, t) : { p: [0, 1.6, 6], look: [0, 1, 0], mm: 35 }; }
  const sceneTime = (t = playhead) => (shot?.start || 0) + t;
  /** Pose animated objects for scene time t (objects being edited keep their live pose). */
  function applyTime(t: number) {
    for (const [id, { group, entity }] of groups) {
      if (gizmoDrag?.starts.has(id) || modal?.starts.has(id)) continue;
      const neutral = standIns && entity.standIn === 'neutral';
      if (!entity.path?.length) { if (group.userData.rig) poseModel(group, entity, t, entity.pose, { neutral }); continue; }
      const a = entityAt(entity, t); group.position.set(...a.position); group.rotation.set(rad(a.pitch), rad(a.rotation), rad(a.roll), 'YXZ'); group.scale.set(...a.scale); poseModel(group, entity, t, a.pose, { neutral });
    }
    markDirty();
  }
  /** Image and video models get each object's stand-in (docs/import.md): true only while a capture renders. */
  let standIns = false;
  /** Render without editor-only overlays (gizmo). */
  /** The shadow region of a shot (its whole camera move), plus a live pose flown over it. */
  const shotFocus = (s: Shot | null, extra: ScenePose | null = null) => shadowFocus([...(s ? shotPoses(s, entities) : []), ...(extra ? [extra] : [])]);
  /** The editor camera's shadow box (what it looks at) and depth range (kept clear of the camera rig); returns the restore. */
  function fitEditorView() {
    fitSunShadow(sun, casters, shadowFocus([{ p: world.position.toArray() as Vec3, look: controls.target.toArray() as Vec3, mm: persp.getFocalLength() }]));
    return fitDepthRange(world, groups.values(), env.endsWith(':outdoor'), [camBody.position, startDot.position, endDot.position, controls.target]);
  }
  /** Shadow box and depth range for one shot-camera render; returns the depth-range restore. */
  function fitView(cam: THREE.Camera, focus: THREE.Box3 | null) { fitSunShadow(sun, casters, focus); return fitDepthRange(cam, groups.values(), env.endsWith(':outdoor')); }
  function cleanRender(r: THREE.WebGLRenderer, cam: THREE.Camera, all = false, focus: THREE.Box3 | null = null) {
    const v = gizmoHelper.visible; gizmoHelper.visible = false;
    const depth = fitView(cam, focus);
    const shown = all ? [...hiddenIds].map(id => groups.get(id)?.group).filter(Boolean) as THREE.Group[] : [];
    for (const g of shown) g.visible = true;
    const restore = hideFlatGround({ ground, road, grid }, env.endsWith(':outdoor'));
    r.render(scene, cam);
    restore(); depth();
    for (const g of shown) g.visible = false;
    gizmoHelper.visible = v;
  }

  function size() { return renderer.getSize(new THREE.Vector2()); }
  function updateOrtho() {
    const s = size(), dist = persp.position.distanceTo(controls.target), h = dist * Math.tan(THREE.MathUtils.degToRad(persp.fov / 2));
    const a = s.x / Math.max(1, s.y);
    Object.assign(ortho, { left: -h * a, right: h * a, top: h, bottom: -h }); ortho.updateProjectionMatrix();
  }
  // Resizing a WebGL canvas clears it. While panels are dragged, keep the drawing buffer and
  // crop it (centred) instead; grow only when needed and redraw in the same step, then settle once.
  let canvasW = 0, canvasH = 0, offsetX = 0, offsetY = 0, settleTimer = 0;
  function applySize(w: number, h: number) {
    canvasW = Math.max(1, Math.round(w)); canvasH = Math.max(1, Math.round(h));
    renderer.setSize(canvasW, canvasH, false);
    composer.setPixelRatio(renderer.getPixelRatio()); composer.setSize(canvasW, canvasH);
    canvas.style.width = `${canvasW}px`; canvas.style.height = `${canvasH}px`;
    persp.aspect = canvasW / canvasH; persp.updateProjectionMatrix(); updateOrtho();
  }
  function placeCanvas(vw: number, vh: number) {
    offsetX = Math.round((vw - canvasW) / 2); offsetY = Math.round((vh - canvasH) / 2);
    canvas.style.left = `${offsetX}px`; canvas.style.top = `${offsetY}px`;
  }
  // Labels are measured once per content change; a resize (font size follows the viewport width) re-measures them.
  let clip = '';
  const remeasure = () => { for (const it of groups.values()) it.lw = 0; markDirty(); };
  new ResizeObserver(markDirty).observe(monitorEl); // the monitor folds and animates its width on its own
  document.fonts?.ready.then(remeasure);
  function resize() {
    for (const it of groups.values()) it.lw = 0;
    const r = overlay.getBoundingClientRect(), vw = Math.max(1, r.width), vh = Math.max(1, r.height);
    const settle = () => { if (Math.round(vw) !== canvasW || Math.round(vh) !== canvasH) { applySize(vw, vh); placeCanvas(vw, vh); draw(); dirty = false; } };
    if (!canvasW) { applySize(vw, vh); placeCanvas(vw, vh); draw(); dirty = false; return; }
    if (vw > canvasW || vh > canvasH) { applySize(Math.max(vw, canvasW), Math.max(vh, canvasH)); placeCanvas(vw, vh); draw(); dirty = false; }
    else { placeCanvas(vw, vh); markDirty(); }
    clearTimeout(settleTimer); settleTimer = window.setTimeout(settle, 150);
  }
  new ResizeObserver(resize).observe(overlay);

  function viewUnitsPerPixel(at: THREE.Vector3) {
    const h = Math.max(1, size().y);
    if (world === ortho) return (ortho.top - ortho.bottom) / ortho.zoom / h;
    return unitsPerPixel(Math.max(0.1, persp.position.distanceTo(at)), persp.fov, h);
  }
  function updateGrid() {
    const next = Math.min(100, Math.max(0.01, gridStep(viewUnitsPerPixel(controls.target))));
    if (next !== step) { step = next; gizmo.setTranslationSnap(snapping() ? step : null); }
    grid.scale.setScalar(Math.max(0.1, step));
    grid.position.set(Math.round(controls.target.x / (step * 10)) * step * 10, 0, Math.round(controls.target.z / (step * 10)) * step * 10);
  }

  function draw() {
    if (anim) stepAnim();
    controls.update();
    updateGrid();
    const s = size();
    const p = live ?? pose(); poseCamera(shotCam, p);
    // [director-phone] live aim preview (phone etc.): replaces only the orientation (and lens), never saved.
    let lookAt = new THREE.Vector3(...p.look);
    if (aimOverride) {
      shotCam.quaternion.set(...aimOverride.q).normalize();
      if (aimOverride.mm) { shotCam.setFocalLength(aimOverride.mm); shotCam.updateProjectionMatrix(); }
      shotCam.updateMatrixWorld();
      lookAt = new THREE.Vector3(0, 0, -1).applyQuaternion(shotCam.quaternion).multiplyScalar(shotCam.position.distanceTo(lookAt)).add(shotCam.position);
    }
    camBody.position.copy(shotCam.position); camBody.quaternion.copy(shotCam.quaternion);
    proxy.position.copy(shotCam.position); proxy.quaternion.copy(shotCam.quaternion); proxy.fov = shotCam.fov; proxy.updateProjectionMatrix(); proxy.updateMatrixWorld(); frustum.update();
    lookGeom.setFromPoints([shotCam.position.clone(), lookAt]); lookLine.computeLineDistances();
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, s.x, s.y);
    if (view === 'set') {
      // Fog is a look for the shot camera only; the editing view stays clear at any distance.
      const depth = fitEditorView();
      const fog = scene.fog; scene.fog = null;
      composer.render();
      scene.fog = fog; depth();
      const c = canvas.getBoundingClientRect(), m = monitorEl.getBoundingClientRect(), o = overlay.getBoundingClientRect(); // once per drawn frame
      if (m.width > 0) {
        const x = m.left - c.left, y = c.bottom - m.bottom;
        renderer.setScissorTest(true); renderer.setScissor(x, y, m.width, m.height); renderer.setViewport(x, y, m.width, m.height);
        cleanRender(renderer, shotCam, false, shotFocus(shot, live)); renderer.setScissorTest(false); renderer.setViewport(0, 0, s.x, s.y);
      }
      // Labels never cover the shot-camera monitor: cut a hole in the label layer where it sits.
      const nextClip = m.width > 0 ? `path(evenodd, 'M0 0 H${o.width} V${o.height} H0 Z M${m.left - o.left} ${m.top - o.top} h${m.width} v${m.height} h${-m.width} Z')` : '';
      if (nextClip !== clip) labelsEl.style.clipPath = clip = nextClip;
      layoutLabels(s);
      frameEl.hidden = true;
    } else {
      renderer.setClearColor(0x000000); renderer.clear();
      let w = s.x, hh = (s.x * 9) / 16; if (hh > s.y) { hh = s.y; w = (s.y * 16) / 9; }
      const x = (s.x - w) / 2, y = (s.y - hh) / 2;
      renderer.setScissorTest(true); renderer.setScissor(x, y, w, hh); renderer.setViewport(x, y, w, hh);
      cleanRender(renderer, shotCam, false, shotFocus(shot, live)); renderer.setScissorTest(false);
      for (const it of groups.values()) showLabel(it, false);
      frameEl.hidden = false; Object.assign(frameEl.style, { left: `${offsetX + x}px`, top: `${offsetY + (s.y - y - hh)}px`, width: `${w}px`, height: `${hh}px` });
    }
  }
  let frames = 0;
  function loop() { if (dirty) { dirty = false; frames++; draw(); } requestAnimationFrame(loop); }
  requestAnimationFrame(loop);
  // Damping needs no timer (controls.update() keeps firing 'change' until it settles); a slow heartbeat only while G/R/S runs.
  setInterval(() => { if (view === 'set' && modal) markDirty(); }, 500);

  function showLabel(it: Item, on: boolean, crowded = false) {
    if (it.shown !== on) { it.label.style.display = on ? '' : 'none'; it.shown = on; if (!on) it.lx = it.ly = NaN; }
    if (it.crowded !== crowded) { it.label.toggleAttribute('data-crowded', crowded); it.crowded = crowded; }
  }
  /** Which labels show, where, and a greedy de-overlap (push down, then give up and mark crowded). Writes only what changed. */
  function layoutLabels(s: THREE.Vector2) {
    const v = new THREE.Vector3(), cam = world.position, persp0 = world === persp;
    const upp = (d: number) => persp0 ? unitsPerPixel(Math.max(0.1, d), persp.fov, Math.max(1, s.y)) : (ortho.top - ortho.bottom) / ortho.zoom / Math.max(1, s.y);
    const want: { it: Item; x: number; y: number; prio: number }[] = [];
    for (const it of groups.values()) {
      const { group, entity } = it, id = entity.id;
      const sel = selectedIds.includes(id), hov = id === hoverId || id === pointerHover;
      let on = labelMode !== 'none' && !hiddenIds.has(id) && (!entity.parent || sel) && (labelMode === 'all' || sel || hov || entity.kind !== 'environment');
      if (on) {
        const [w, hgt, d] = entitySize(entity), ratio = group.scale.y / Math.max(0.001, entity.scale[1]);
        const top = it.topOff != null ? group.position.y + it.topOff : group.position.y + hgt * ratio + 0.25;
        v.set(group.position.x, top, group.position.z).project(world);
        on = v.z <= 1 && Math.abs(v.x) <= 1.1 && Math.abs(v.y) <= 1.1;
        // Tiny props drop out; characters, vehicles and the shot's target always keep a label (the collision pass still applies).
        const key = sel || hov || id === shot?.camera.target || entity.kind === 'character' || entity.kind === 'vehicle';
        if (on && labelMode === 'auto' && !key) on = (it.span ?? Math.max(w, hgt, d) * ratio) / upp(cam.distanceTo(group.position)) >= LABEL_MIN_PX;
        if (on) want.push({ it, x: offsetX + ((v.x + 1) / 2) * s.x, y: offsetY + ((1 - v.y) / 2) * s.y, prio: sel ? 0 : hov ? 1 : id === shot?.camera.target ? 2 : entity.kind === 'character' ? 3 : entity.kind === 'environment' ? 5 : 4 });
      }
      if (!on) showLabel(it, false);
    }
    // Measure labels whose content or size class changed (one layout read for all of them).
    const fresh = want.filter(w => !w.it.lw);
    for (const { it } of fresh) showLabel(it, true, it.crowded);
    for (const { it } of fresh) { it.lw = it.label.offsetWidth; it.lh = it.label.offsetHeight; }
    want.sort((a, b) => a.prio - b.prio || a.y - b.y);
    const placed: { l: number; r: number; t: number; b: number }[] = [];
    for (const w of want) {
      const { it } = w, half = it.lw / 2;
      let y = w.y, pushes = 0, hit: (typeof placed)[number] | undefined;
      while ((hit = placed.find(p => w.x - half < p.r && p.l < w.x + half && y - it.lh < p.b && p.t < y)) && pushes < LABEL_PUSHES) { y = hit.b + LABEL_GAP + it.lh; pushes++; }
      if (hit) { showLabel(it, false, true); continue; }
      placed.push({ l: w.x - half, r: w.x + half, t: y - it.lh, b: y });
      showLabel(it, true);
      if (!(Math.abs(w.x - it.lx) < 0.5)) { it.label.style.left = `${w.x}px`; it.lx = w.x; }
      if (!(Math.abs(y - it.ly) < 0.5)) { it.label.style.top = `${y}px`; it.ly = y; }
    }
  }

  // ---------- Picking ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function hit(clientX: number, clientY: number) {
    const r = canvas.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, view === 'set' ? world : shotCam);
    return ray;
  }
  function pick(clientX: number, clientY: number): string | null {
    const found = hit(clientX, clientY).intersectObjects([...groups.values()].map(g => g.group), true).find(i => i.object.userData.entityId && (i.object as THREE.Mesh).isMesh && i.object.visible && !hiddenIds.has(i.object.userData.entityId));
    return (found?.object.userData.entityId as string) ?? null;
  }

  // ---------- Gizmo drag: one rigid multi-object edit, one undo step ----------
  let gizmoDrag: { primaryStart: XForm; starts: Map<string, XForm> } | null = null;
  gizmo.addEventListener('dragging-changed', ev => { controls.enabled = !(ev as unknown as { value: boolean }).value; });
  gizmo.addEventListener('mouseDown', () => {
    if (!primary) return;
    const starts = new Map(moving().map(id => [id, xformOf(groups.get(id)!.group)] as const));
    gizmoDrag = { primaryStart: starts.get(primary)!, starts };
  });
  gizmo.addEventListener('objectChange', () => {
    if (!gizmoDrag || !primary) return;
    const now = xformOf(groups.get(primary)!.group);
    const others = [...gizmoDrag.starts.keys()].filter(id => id !== primary);
    rigidApply(gizmoDrag.primaryStart, now, others.map(id => gizmoDrag!.starts.get(id)!)).forEach((x, i) => applyX(groups.get(others[i])!.group, x));
    markDirty();
  });
  gizmo.addEventListener('mouseUp', () => {
    const d = gizmoDrag; gizmoDrag = null;
    if (!d) return;
    const changes = [...d.starts].map(([id, before]) => ({ id, before, after: xformOf(groups.get(id)!.group) })).filter(c => JSON.stringify(c.before) !== JSON.stringify(c.after));
    if (changes.length) events.onTransformCommit(changes, `${mode === 'translate' ? 'Move' : mode === 'rotate' ? 'Rotate' : 'Resize'} ${changes.length > 1 ? `${changes.length} objects` : groups.get(changes[0].id)!.entity.name}`);
  });

  // ---------- Modal transforms (G / R / S) ----------
  let modal: (ModalState & { starts: Map<string, XForm>; primaryStart: XForm; startPointer: { x: number; y: number }; pointer: { x: number; y: number } }) | null = null;
  let lastPointer = { x: 0, y: 0 }, pointerInside = false;
  overlay.addEventListener('pointermove', ev => { lastPointer = { x: ev.clientX, y: ev.clientY }; pointerInside = true; });
  overlay.addEventListener('pointerleave', () => { pointerInside = false; if (pointerHover) { pointerHover = null; markDirty(); } });
  function previewModal() {
    if (!modal || !primary) return;
    const cam = world; cam.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0).toArray() as Vec3;
    const upv = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1).toArray() as Vec3;
    const start = modal.primaryStart;
    const value = Number(modal.numeric);
    let now = modal.numeric && Number.isFinite(value) && modal.numeric !== '-' && modal.numeric !== '.'
      ? computeModalNumeric(modal.mode, modal.axis, start, value)
      : computeModal({ mode: modal.mode, axis: modal.axis, start, startPointer: modal.startPointer, pointer: modal.pointer, unitsPerPixel: viewUnitsPerPixel(new THREE.Vector3(...start.position)), cameraRight: right, cameraUp: upv });
    modal.snap = snapping(); modal.step = step;
    if (modal.mode === 'translate' && modal.snap && !modal.numeric) {
      const d = snapDelta(now.position.map((v, i) => v - start.position[i]), step);
      now = { ...now, position: start.position.map((v, i) => v + d[i]) as Vec3 };
    }
    applyX(groups.get(primary)!.group, now);
    const others = [...modal.starts.keys()].filter(id => id !== primary);
    rigidApply(start, now, others.map(id => modal!.starts.get(id)!)).forEach((x, i) => applyX(groups.get(others[i])!.group, x));
    events.onModal(modalHud(modal)); markDirty();
  }
  function beginModal(next: ModalMode) {
    if (view !== 'set' || !primary || !selectedIds.length) return false;
    if (modal) { // Switching G/R/S restarts from the original pose.
      for (const [id, x] of modal.starts) applyX(groups.get(id)!.group, x);
      Object.assign(modal, { mode: next, axis: null, numeric: '', startPointer: { ...modal.pointer } });
      previewModal(); return true;
    }
    const starts = new Map(moving().map(id => [id, xformOf(groups.get(id)!.group)] as const));
    const r = canvas.getBoundingClientRect();
    const p = pointerInside ? lastPointer : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    modal = { mode: next, axis: null, numeric: '', starts, primaryStart: starts.get(primary)!, startPointer: { ...p }, pointer: { ...p } };
    controls.enabled = false; gizmo.detach();
    previewModal(); return true;
  }
  function finishModal(commit: boolean) {
    const m = modal; if (!m) return;
    modal = null; controls.enabled = true; events.onModal(null);
    if (!commit) { for (const [id, x] of m.starts) applyX(groups.get(id)!.group, x); attachGizmo(); markDirty(); return; }
    const changes = [...m.starts].map(([id, before]) => ({ id, before, after: xformOf(groups.get(id)!.group) })).filter(c => JSON.stringify(c.before) !== JSON.stringify(c.after));
    attachGizmo();
    if (changes.length) events.onTransformCommit(changes, `${m.mode === 'translate' ? 'Move' : m.mode === 'rotate' ? 'Rotate' : 'Resize'} ${changes.length > 1 ? `${changes.length} objects` : groups.get(changes[0].id)!.entity.name}`);
  }
  function modalKey(key: string) {
    if (!modal) return false;
    const r = feedModalKey(modal, key);
    if (r.commit) finishModal(true); else if (r.cancel) finishModal(false); else if (r.handled) previewModal();
    return r.handled;
  }
  window.addEventListener('pointermove', ev => { if (modal) { modal.pointer = { x: ev.clientX, y: ev.clientY }; previewModal(); } });

  // ---------- Pointer: click / Shift-click / Ctrl-click / Shift-drag marquee / right-click menu ----------
  let down: { x: number; y: number; additive: boolean; toggle: boolean; dragged: boolean } | null = null;
  let rightDown: { x: number; y: number } | null = null;
  canvas.addEventListener('pointerdown', ev => {
    if (view !== 'set') return;
    if (modal) { ev.preventDefault(); ev.stopImmediatePropagation(); finishModal(ev.button === 0); return; }
    // macOS reports Ctrl+click as a right press: treat it as Ctrl+click (toggle), like Cmd+click.
    const macCtrlClick = ev.button === 2 && ev.ctrlKey && /Mac/i.test(navigator.platform);
    if (ev.button === 2 && !macCtrlClick) { rightDown = { x: ev.clientX, y: ev.clientY }; return; }
    if ((ev.button !== 0 && !macCtrlClick) || gizmo.axis !== null) return; // Gizmo handles win.
    const additive = ev.shiftKey, toggle = ev.ctrlKey || ev.metaKey;
    down = { x: ev.clientX, y: ev.clientY, additive, toggle, dragged: false };
    if (additive || toggle) { ev.stopImmediatePropagation(); ev.preventDefault(); canvas.setPointerCapture(ev.pointerId); }
  }, { capture: true });
  canvas.addEventListener('pointermove', ev => {
    if (down && !down.dragged && isDrag(down, { x: ev.clientX, y: ev.clientY })) down.dragged = true;
    if (down?.dragged && down.additive) {
      const o = overlay.getBoundingClientRect(), r = marqueeRect(down, { x: ev.clientX, y: ev.clientY });
      Object.assign(marquee.style, { left: `${Math.max(0, r.left - o.left)}px`, top: `${Math.max(0, r.top - o.top)}px`, width: `${Math.min(o.right, r.right) - Math.max(o.left, r.left)}px`, height: `${Math.min(o.bottom, r.bottom) - Math.max(o.top, r.top)}px` });
      marquee.hidden = false;
    }
    if (!down && !modal) {
      const id = view === 'set' ? pick(ev.clientX, ev.clientY) : null;
      canvas.style.cursor = id ? 'pointer' : '';
      if (id !== pointerHover) { pointerHover = id; markDirty(); } // environment labels show on hover
    }
  });
  canvas.addEventListener('pointerup', ev => {
    if (ev.button === 2 && rightDown) {
      const r = rightDown; rightDown = null;
      if (!isDrag(r, { x: ev.clientX, y: ev.clientY }, RIGHT_CLICK_SLOP)) events.onContextMenu(ev.clientX, ev.clientY);
      return;
    }
    const d = down; down = null;
    if (!d || (ev.button !== 0 && !d.toggle)) return;
    if (d.dragged && d.additive) {
      marquee.hidden = true;
      const r = marqueeRect(d, { x: ev.clientX, y: ev.clientY }), c = canvas.getBoundingClientRect(), box = new THREE.Box3(), centre = new THREE.Vector3();
      const ids: string[] = [];
      for (const [id, { group }] of groups) {
        box.setFromObject(group); box.getCenter(centre).project(world);
        if (centre.z < -1 || centre.z > 1) continue;
        if (inRect({ x: c.left + (centre.x + 1) * c.width / 2, y: c.top + (1 - centre.y) * c.height / 2 }, r)) ids.push(id);
      }
      events.onMarquee(ids);
      return;
    }
    if (d.dragged) return;
    events.onClickSelect(pick(ev.clientX, ev.clientY), d.toggle ? 'toggle' : d.additive ? 'add' : 'replace');
  });
  canvas.addEventListener('contextmenu', ev => ev.preventDefault());

  // ---------- View presets, projection, framing ----------
  let anim: { from: THREE.Vector3; to: THREE.Vector3; t0: number } | null = null;
  function stepAnim() {
    const a = anim!, u = Math.min(1, (performance.now() - a.t0) / 180), e = 1 - (1 - u) ** 3;
    world.position.lerpVectors(a.from, a.to, e); if (world === ortho) persp.position.copy(world.position);
    if (u >= 1) anim = null; else markDirty();
  }
  function snapView(axis: 'x' | 'y' | 'z', opposite: boolean) {
    const dist = world.position.distanceTo(controls.target);
    const dir = axis === 'x' ? new THREE.Vector3(1, 0, 0) : axis === 'y' ? new THREE.Vector3(0, Math.cos(1e-3), Math.sin(1e-3)) : new THREE.Vector3(0, 0, 1);
    if (opposite) dir.multiplyScalar(-1);
    anim = { from: world.position.clone(), to: controls.target.clone().addScaledVector(dir, Math.max(0.5, dist)), t0: performance.now() };
    markDirty();
  }
  function useCamera(next: THREE.PerspectiveCamera | THREE.OrthographicCamera) {
    next.position.copy(world.position); next.quaternion.copy(world.quaternion);
    world = next; (controls as unknown as { object: THREE.Camera }).object = next; (gizmo as unknown as { camera: THREE.Camera }).camera = next; renderPass.camera = next; outline.renderCamera = next;
    controls.update(); markDirty();
  }
  function toggleProjection() { if (world === persp) { updateOrtho(); ortho.zoom = 1; useCamera(ortho); } else useCamera(persp); return world === ortho ? 'orthographic' : 'perspective'; }
  function frame(ids: string[], minRadius = 0.3) {
    const box = new THREE.Box3();
    const want = withDescendants(entities, ids);
    for (const [id, { group, entity }] of groups) if ((!ids.length || want.includes(id)) && entity.shape !== 'group') box.expandByObject(group);
    if (box.isEmpty()) box.set(new THREE.Vector3(-3, 0, -3), new THREE.Vector3(3, 2, 3));
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const dir = world.position.clone().sub(controls.target).normalize();
    if (!Number.isFinite(dir.x) || dir.lengthSq() === 0) dir.set(0.5, 0.45, 0.75).normalize();
    const s = size(), dist = framingDistance(Math.max(minRadius, sphere.radius), persp.fov, s.x / Math.max(1, s.y));
    controls.target.copy(sphere.center); world.position.copy(sphere.center).addScaledVector(dir, dist);
    if (world === ortho) { persp.position.copy(world.position); updateOrtho(); }
    markDirty();
  }

  // ---------- Capture ----------
  function dropGuideParts(group: THREE.Object3D) { group.traverse(o => { const i = guideParts.indexOf(o); if (i >= 0) guideParts.splice(i, 1); }); }
  /**
   * Still-guide look for one render: front markers on, a light sky so the horizon reads, a lighter ground with a grid,
   * and the sun's shadow box moved to the shot so objects cast shadows wherever they are on the set.
   */
  function withGuide(look: Vec3, render: () => void) {
    const bg = scene.background, gm = ground.material as THREE.MeshStandardMaterial, gc = gm.color.getHex(), sp = sun.position.clone(), st = sun.target.position.clone();
    for (const o of guideParts) o.visible = true;
    guideGrid.visible = true; guideGrid.position.set(Math.round(look[0] / 2) * 2, 0.1, Math.round(look[2] / 2) * 2);
    scene.background = new THREE.Color(GUIDE_SKY[env] ?? GUIDE_SKY.stage); gm.color.setHex(GUIDE_GROUND);
    sun.target.position.set(look[0], 0, look[2]); sun.position.set(look[0] + 9, 16, look[2] + 11); sun.target.updateMatrixWorld();
    try { render(); } // cleanRender fits the shadow box with the guide's sun direction
    finally {
      for (const o of guideParts) o.visible = false;
      guideGrid.visible = false; scene.background = bg; gm.color.setHex(gc);
      sun.position.copy(sp); sun.target.position.copy(st); sun.target.updateMatrixWorld(); markDirty();
    }
  }
  /** The shot camera frame at t. guide: the still-guide look (front markers, grid, light sky, local shadows; never in the viewport). */
  function capture(t: number, width: number, height: number, type = 'image/png', quality?: number, opts: { guide?: boolean } = {}) {
    if (entities.some(e => !modelReady(e))) throw Error('Blockout models are still loading. Try again in a moment.');
    capturer.setPixelRatio(1); capturer.setSize(width, height, false);
    const cam = shotCam.clone(); cam.aspect = width / height; const at = pose(t); poseCamera(cam, at);
    standIns = true;
    try {
      applyTime(sceneTime(t));
      const focus = shotFocus(shot, at);
      if (opts.guide) withGuide(at.look, () => cleanRender(capturer, cam, true, focus)); else cleanRender(capturer, cam, true, focus);
    } finally { standIns = false; applyTime(sceneTime()); }
    return captureCanvas.toDataURL(type, quality);
  }
  const thumbs = new Map<string, HTMLCanvasElement>();
  /** Shot card still at mid-shot. With a signature (e.g. director.ts `signature(project, shot)`) the result is cached and reused. */
  function thumbnail(other: Shot, width = 176, height = 99, signature?: string) {
    const models = entities.map(e => e.model || '').join(',');
    const ck = signature ? `${signature}|${models}|${entities.every(modelReady)}|${width}x${height}` : '', cached = ck ? thumbs.get(ck) : undefined;
    if (cached) return cached;
    capturer.setPixelRatio(1); capturer.setSize(width, height, false);
    const cam = shotCam.clone(); cam.aspect = width / height;
    poseCamera(cam, shotCameraAt(other, entities, other.duration * 0.5));
    applyTime((other.start || 0) + other.duration * 0.5); cleanRender(capturer, cam, true, shotFocus(other)); applyTime(sceneTime());
    if (!ck) return captureCanvas;
    const copy = document.createElement('canvas'); copy.width = width; copy.height = height; copy.getContext('2d')!.drawImage(captureCanvas, 0, 0);
    thumbs.set(ck, copy); if (thumbs.size > 64) thumbs.delete(thumbs.keys().next().value!);
    return copy;
  }
  /**
   * Screen boxes (0–1, top-left origin) of every object the shot camera sees at time t, from the live scene:
   * mesh bounds on the render layer through a clone of the shot camera. Objects partly behind the camera are left out.
   */
  function boxesAt(other: Shot, t: number, aspect = 16 / 9) {
    const cam = shotCam.clone(); cam.aspect = aspect; poseCamera(cam, shotCameraAt(other, entities, t));
    applyTime((other.start || 0) + t);
    const out: { id: string; x0: number; y0: number; x1: number; y1: number }[] = [];
    const box = new THREE.Box3(), part = new THREE.Box3(), v = new THREE.Vector3();
    for (const [id, { group, entity }] of groups) {
      if (entity.shape === 'group') continue;
      group.updateWorldMatrix(true, true); box.makeEmpty();
      group.traverse(o => { const m = o as THREE.Mesh; if (!m.isMesh || !o.layers.isEnabled(0)) return; if (!m.geometry.boundingBox) m.geometry.computeBoundingBox(); part.copy(m.geometry.boundingBox!).applyMatrix4(o.matrixWorld); box.union(part); });
      if (box.isEmpty()) continue;
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, behind = false;
      for (let k = 0; k < 8 && !behind; k++) {
        v.set(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z).applyMatrix4(cam.matrixWorldInverse);
        if (v.z > -cam.near) { behind = true; break; }
        v.applyMatrix4(cam.projectionMatrix);
        x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); y0 = Math.min(y0, v.y); y1 = Math.max(y1, v.y);
      }
      if (behind || x1 < -1 || x0 > 1 || y1 < -1 || y0 > 1) continue;
      const c = (n: number) => Math.max(0, Math.min(1, n));
      out.push({ id, x0: c((x0 + 1) / 2), x1: c((x1 + 1) / 2), y0: c((1 - y1) / 2), y1: c((1 - y0) / 2) });
    }
    applyTime(sceneTime());
    return out;
  }
  function quaternionAt(t: number): [number, number, number, number] {
    const cam = shotCam.clone(); poseCamera(cam, pose(t));
    const q = cam.quaternion.normalize(); return [q.x, q.y, q.z, q.w];
  }

  const api = {
    sync, pick, pose, capture, thumbnail, boxesAt, quaternionAt, markDirty,
    async ready() { await loadBlockoutModels(entities); },
    /** Outline colour matches the object's colour in the prompt. */
    setOutlineColor(c: string | null) { outline.visibleEdgeColor.set(c || 0xd6daff); outline.hiddenEdgeColor.set(c || 0xbac0ff); labelsEl.style.setProperty('--sel', c || ''); markDirty(); },
    /** Temporarily outline an object (hovering its row in the panel). */
    setHover(id: string | null) { if (hoverId !== id) { hoverId = id; refreshOutline(); } },
    setSelection(ids: string[], main: string | null) { selectedIds = ids.filter(id => groups.has(id)); primary = main && groups.has(main) ? main : selectedIds.at(-1) ?? null; refreshOutline(); attachGizmo(); },
    setTransformMode(next: ModalMode) { mode = next; attachGizmo(); },
    transformMode: () => mode,
    setSnap(on: boolean) { snapPref = on; attachGizmo(); },
    setCtrl(on: boolean) { if (ctrlHeld !== on) { ctrlHeld = on; gizmo.setTranslationSnap(snapping() ? step : null); if (modal) previewModal(); } },
    setGridVisible(on: boolean) { grid.visible = on; markDirty(); },
    /** Hide objects in the editor views only (captures, thumbnails and renders still include them). */
    setHidden(ids: Iterable<string>) { hiddenIds = new Set(ids); for (const [id, item] of groups) item.group.visible = !hiddenIds.has(id); markDirty(); },
    gridStep: () => step,
    beginModal, modalKey, finishModal, modalActive: () => modal !== null,
    pointerInViewport: () => pointerInside, lastPointer: () => lastPointer,
    snapView, toggleProjection, frame,
    frameAll() { frame([]); },
    setPlayhead(t: number) { playhead = t; applyTime(sceneTime()); },
    sceneTime: () => sceneTime(),
    setLivePose(p: ScenePose | null) { live = p; markDirty(); }, // [operate]
    /** [director-phone] Live preview only: aim the shot camera from an external source; null restores the shot's own aim. */
    setAimOverride(q: [number, number, number, number] | null, mm: number | null = null) { aimOverride = q ? { q, mm } : null; markDirty(); },
    setView(v: 'set' | 'camera') { if (modal) finishModal(false); view = v; attachGizmo(); markDirty(); },
    view: () => view,
    worldView(): { p: Vec3; look: Vec3; mm: number } { return { p: world.position.toArray() as Vec3, look: controls.target.toArray() as Vec3, mm: Math.round(persp.getFocalLength()) }; },
    orbitTarget: () => controls.target.toArray() as Vec3,
    /** Where a screen point meets the ground (y = 0), or null above the horizon. */
    groundAt(clientX: number, clientY: number): Vec3 | null {
      const p = hit(clientX, clientY).ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
      return p && p.length() < 2000 ? [Math.round(p.x * 100) / 100, 0, Math.round(p.z * 100) / 100] : null;
    },
    lookThrough() { const p = pose(); world.position.set(...p.p); controls.target.set(...p.look); markDirty(); },
    setLabelMode(m: LabelMode) { if (labelMode !== m) { labelMode = m; markDirty(); } },
    labelMode: () => labelMode,
    /** Orbit and zoom around this object from now on without moving the view: the pivot moves to the object's depth on the
     *  view axis, so nothing on screen changes. aim = true puts the pivot on the object itself (the camera stays put but turns to it). */
    pivotOn(id: string, aim = false) {
      const it = groups.get(id); if (!it) return false;
      const f = new THREE.Vector3(...focusPoint({ ...it.entity, position: it.group.position.toArray() as Vec3 }));
      if (aim) controls.target.copy(f);
      else {
        world.updateMatrixWorld(); const fwd = world.getWorldDirection(new THREE.Vector3()), depth = f.sub(world.position).dot(fwd);
        if (depth < ZOOM_NEAR) return false; // behind or at the camera: keep the pivot
        controls.target.copy(world.position).addScaledVector(fwd, depth);
      }
      controls.update(); markDirty(); return true;
    },
    focusOn(entity: Entity) { const f = focusPoint(entity); const off = world.position.clone().sub(controls.target); controls.target.set(...f); world.position.copy(controls.target.clone().add(off)); markDirty(); },
  };
  // Test hook (dev builds or ?perf): drawn-frame counter plus the editor-camera pose for acceptance scripts.
  if (import.meta.env.DEV || /[?&]perf\b/.test(location.search)) (window as unknown as { __scene: unknown }).__scene = { frames: () => frames, worldView: api.worldView, pivotOn: api.pivotOn, setLabelMode: api.setLabelMode, setPlayhead: api.setPlayhead };
  return api;
}
