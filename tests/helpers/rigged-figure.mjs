// A small rigged figure for tests (no third-party assets): Mixamo-style bone names, an A-pose (arms 45° down), one
// skinned mesh of boxes, and two clips: Wave (right forearm) and Walk (hips travel forward 1 m with leg swing).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { exportGlb } from '../../server/previs/asset-convert.mjs';

const A = Math.SQRT1_2;
// name, parent, world position (metres)
const BONES = [
  ['Hips', null, [0, 1.0, 0]], ['Spine', 'Hips', [0, 1.12, 0]], ['Spine1', 'Spine', [0, 1.3, 0]], ['Neck', 'Spine1', [0, 1.5, 0]], ['Head', 'Neck', [0, 1.6, 0]], ['HeadTop_End', 'Head', [0, 1.8, 0]],
  ['LeftShoulder', 'Spine1', [0.06, 1.45, 0]], ['LeftArm', 'LeftShoulder', [0.18, 1.45, 0]], ['LeftForeArm', 'LeftArm', [0.18 + 0.28 * A, 1.45 - 0.28 * A, 0]], ['LeftHand', 'LeftForeArm', [0.18 + 0.54 * A, 1.45 - 0.54 * A, 0]], ['LeftHandIndex1', 'LeftHand', [0.18 + 0.62 * A, 1.45 - 0.62 * A, 0]],
  ['RightShoulder', 'Spine1', [-0.06, 1.45, 0]], ['RightArm', 'RightShoulder', [-0.18, 1.45, 0]], ['RightForeArm', 'RightArm', [-0.18 - 0.28 * A, 1.45 - 0.28 * A, 0]], ['RightHand', 'RightForeArm', [-0.18 - 0.54 * A, 1.45 - 0.54 * A, 0]], ['RightHandIndex1', 'RightHand', [-0.18 - 0.62 * A, 1.45 - 0.62 * A, 0]],
  ['LeftUpLeg', 'Hips', [0.1, 0.95, 0]], ['LeftLeg', 'LeftUpLeg', [0.1, 0.52, 0]], ['LeftFoot', 'LeftLeg', [0.1, 0.08, 0]], ['LeftToeBase', 'LeftFoot', [0.1, 0.02, 0.12]],
  ['RightUpLeg', 'Hips', [-0.1, 0.95, 0]], ['RightLeg', 'RightUpLeg', [-0.1, 0.52, 0]], ['RightFoot', 'RightLeg', [-0.1, 0.08, 0]], ['RightToeBase', 'RightFoot', [-0.1, 0.02, 0.12]],
];

/** { root, animations } of the figure; prefix is prepended to every bone name (e.g. 'mixamorig:'). */
export function riggedFigure({ prefix = 'mixamorig:' } = {}) {
  const bones = new Map(), at = new Map(BONES.map(([n, , p]) => [n, new THREE.Vector3(...p)]));
  for (const [name, parent] of BONES) {
    const b = new THREE.Bone(); b.name = prefix + name;
    b.position.copy(at.get(name)).sub(parent ? at.get(parent) : new THREE.Vector3());
    bones.set(name, b); if (parent) bones.get(parent).add(b);
  }
  const list = [...bones.values()], parts = [];
  for (const [name, parent] of BONES) {
    if (!parent) continue;
    const a = at.get(parent), b = at.get(name), len = a.distanceTo(b), g = new THREE.BoxGeometry(0.08, len, 0.08);
    g.translate(0, len / 2, 0); g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), b.clone().sub(a).normalize())); g.translate(a.x, a.y, a.z);
    const n = g.getAttribute('position').count, index = list.indexOf(bones.get(parent));
    g.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Array(n * 4).fill(0).map((_, i) => (i % 4 === 0 ? index : 0)), 4));
    g.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Array(n * 4).fill(0).map((_, i) => (i % 4 === 0 ? 1 : 0)), 4));
    parts.push(g);
  }
  const mesh = new THREE.SkinnedMesh(mergeGeometries(parts), new THREE.MeshStandardMaterial({ color: 0xd08040 }));
  mesh.name = 'Figure';
  const root = new THREE.Group(); root.name = 'Armature'; root.add(bones.get('Hips')); root.add(mesh);
  root.updateMatrixWorld(true); mesh.bind(new THREE.Skeleton(list));
  const q = (axis, deg) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...axis), deg * Math.PI / 180).toArray();
  const wave = new THREE.AnimationClip('Wave', 1, [new THREE.QuaternionKeyframeTrack(`${prefix.replace(/[:.]/g, '')}RightForeArm.quaternion`, [0, 0.5, 1], [...q([0, 0, 1], 0), ...q([0, 0, 1], -60), ...q([0, 0, 1], 0)])]);
  const walk = new THREE.AnimationClip('Walk', 1, [
    new THREE.VectorKeyframeTrack(`${prefix.replace(/[:.]/g, '')}Hips.position`, [0, 1], [0, 1, 0, 0, 1.02, 1]),
    new THREE.QuaternionKeyframeTrack(`${prefix.replace(/[:.]/g, '')}LeftUpLeg.quaternion`, [0, 0.5, 1], [...q([1, 0, 0], -25), ...q([1, 0, 0], 25), ...q([1, 0, 0], -25)]),
  ]);
  return { root, animations: [wave, walk] };
}

/** The figure as GLB bytes. Track names use the sanitized bone names three.js gives the nodes. */
export async function riggedFigureGlb(opts) {
  const { root, animations } = riggedFigure(opts);
  for (const b of root.getObjectByName('Figure').skeleton.bones) b.name = b.name.replace(/[:.]/g, '');
  return exportGlb(root, animations);
}
