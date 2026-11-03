// Small rigid-part rigs in the bundled GLBs. Angles are local XYZ degrees, never URLs or node paths.
// Imported humanoids use the same names in the character's frame (shared/rig.mjs); spine…footR exist only there.
export const POSE_JOINTS = Object.freeze(['body', 'head', 'armL', 'armR', 'forearmL', 'forearmR', 'thighL', 'thighR', 'shinL', 'shinR', 'wingL', 'wingR', 'tipL', 'tipR', 'tail', 'steerL', 'steerR', 'wheelFL', 'wheelFR', 'wheelRL', 'wheelRR', 'spine', 'neck', 'handL', 'handR', 'footL', 'footR']);
export function normalizePose(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return Object.fromEntries(POSE_JOINTS.filter(k => Array.isArray(value[k]) && value[k].length === 3 && value[k].every(Number.isFinite)).map(k => [k, value[k].map(v => Math.max(-36000, Math.min(36000, v)))]));
}
export const keyEase = (key, u) => key?.ease === 'smoothstep' ? u * u * (3 - 2 * u) : u;
export function blendPose(a = {}, b = {}, u) {
  return Object.fromEntries([...new Set([...Object.keys(a), ...Object.keys(b)])].map(k => [k, [0, 1, 2].map(i => (a[k]?.[i] || 0) * (1 - u) + (b[k]?.[i] || 0) * u)]));
}
/** Absolute evaluation: seeking backwards and capturing out of order cannot accumulate rotations. */
export function applyBlockoutPose(root, pose = {}) {
  root.traverse(node => {
    if (!node.name.startsWith('joint_')) return;
    const key = node.name.slice(6);
    if (!POSE_JOINTS.includes(key)) return;
    node.userData.restRotation ||= [node.rotation.x, node.rotation.y, node.rotation.z];
    const rest = node.userData.restRotation, angles = pose[key] || [0, 0, 0];
    node.rotation.set(...rest.map((v, i) => v + angles[i] * Math.PI / 180));
  });
}
