// Imported models in the viewport and every capture (docs/import.md): clip playback at an absolute scene time, rig
// poses in the character's frame (shared/rig.mjs), and the neutral stand-in image and video models can be sent.
// Every call starts from the file's rest pose, so seeking, scrubbing and out-of-order capture give the same frame.
import * as THREE from 'three';
import { LIMBS, RIG_JOINTS, RIG_POSES, jointRotation, performanceAt } from '../shared/rig.mjs';
import type { Entity } from '../shared/director.mjs';
import type { Pose } from '../shared/blockout-pose.mjs';

const STAND_IN = new THREE.MeshStandardMaterial({ name: 'stand-in', color: 0x9aa0a8, roughness: 0.85, metalness: 0 });
const quat = (a: number[]) => new THREE.Quaternion(a[0], a[1], a[2], a[3]);

export class RigRuntime {
  private joints = new Map<string, THREE.Object3D>();
  private rest = new Map<THREE.Object3D, [THREE.Vector3, THREE.Quaternion, THREE.Vector3]>();
  private mixer: THREE.AnimationMixer;
  private actions = new Map<string, THREE.AnimationAction>();
  private current: THREE.AnimationAction | null = null;
  private materials = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
  private neutral = false;
  private model: THREE.Object3D;

  constructor(model: THREE.Object3D, entity: Entity) {
    this.model = model;
    const byNode = new Map<number, THREE.Object3D>();
    model.traverse(o => {
      if (Number.isInteger(o.userData.gltfNode)) byNode.set(o.userData.gltfNode, o);
      if ((o as THREE.Bone).isBone || Number.isInteger(o.userData.gltfNode)) this.rest.set(o, [o.position.clone(), o.quaternion.clone(), o.scale.clone()]);
      if ((o as THREE.Mesh).isMesh) this.materials.set(o as THREE.Mesh, (o as THREE.Mesh).material);
    });
    for (const [j, i] of Object.entries(entity.source?.rig?.joints || {})) { const o = byNode.get(i); if (o) this.joints.set(j, o); }
    this.mixer = new THREE.AnimationMixer(model);
  }

  private clip(name: string) {
    if (!this.actions.has(name)) {
      const clip = this.model.animations.find(c => c.name === name);
      if (!clip) return null;
      const action = this.mixer.clipAction(clip); action.setLoop(THREE.LoopRepeat, Infinity); this.actions.set(name, action);
    }
    return this.actions.get(name)!;
  }

  private setNeutral(on: boolean) {
    if (on === this.neutral) return;
    this.neutral = on;
    for (const [mesh, material] of this.materials) mesh.material = on ? STAND_IN : material;
  }

  /** Pose the model for scene time t. root is the object's placed group (its rotation is the character frame). */
  apply(root: THREE.Object3D, entity: Entity, t: number, pose: Pose | undefined, { neutral = false } = {}) {
    this.setNeutral(neutral);
    if (!this.joints.size && !this.model.animations.length) return; // a static model or a card: nothing moves
    for (const [o, [p, q, s]] of this.rest) { o.position.copy(p); o.quaternion.copy(q); o.scale.copy(s); }
    const perf = neutral ? null : performanceAt(entity, t);
    const action = perf ? this.clip(perf.clip) : null;
    if (this.current && this.current !== action) { this.current.stop(); this.current = null; }
    if (action && perf) {
      const d = action.getClip().duration || 1;
      action.play(); action.enabled = true; action.setEffectiveWeight(1);
      action.time = perf.loop ? ((perf.time % d) + d) % d : Math.max(0, Math.min(d - 1e-4, perf.time));
      this.mixer.update(0); this.current = action;
      // In place: the clip may bob and sway the hips, but the object's own path moves it across the set.
      const hips = this.joints.get('body'), r = hips && this.rest.get(hips);
      if (perf.inPlace && hips && r) { hips.position.x = r[0].x; hips.position.z = r[0].z; }
    }
    root.updateMatrixWorld(true);
    if (!this.joints.size) return;
    const angles: Pose = neutral ? RIG_POSES.stand : pose || {};
    if (action && !Object.keys(angles).length) return;
    const F = root.getWorldQuaternion(new THREE.Quaternion()), Fi = F.clone().invert();
    const base = new Map<string, THREE.Quaternion>(), at = new Map<string, THREE.Vector3>();
    for (const [j, o] of this.joints) { base.set(j, Fi.clone().multiply(o.getWorldQuaternion(new THREE.Quaternion()))); at.set(j, o.getWorldPosition(new THREE.Vector3()).applyQuaternion(Fi)); }
    const parents = entity.source?.rig?.parents || {};
    const align = new Map<string, THREE.Quaternion>(), acc = new Map<string, THREE.Quaternion>();
    for (const j of RIG_JOINTS) {
      if (!this.joints.has(j)) continue;
      const p = parents[j] || null, pa = (p && align.get(p)) || new THREE.Quaternion();
      const limb = (LIMBS as Record<string, [string, number[]]>)[j];
      // Without a clip, limbs start from the canonical T-pose, whatever the file's own rest pose (A-pose, T-pose).
      if (!action && limb && at.has(limb[0])) {
        const dir = at.get(limb[0])!.clone().sub(at.get(j)!).normalize().applyQuaternion(pa);
        align.set(j, new THREE.Quaternion().setFromUnitVectors(dir, new THREE.Vector3(...limb[1])).multiply(pa));
      } else align.set(j, pa.clone());
      acc.set(j, ((p && acc.get(p)) || new THREE.Quaternion()).clone().multiply(quat(jointRotation(j, angles[j]))));
    }
    const footY = () => Math.min(...['footL', 'footR'].filter(j => this.joints.has(j)).map(j => this.joints.get(j)!.getWorldPosition(new THREE.Vector3()).applyQuaternion(Fi).y));
    const parentQ = new THREE.Quaternion();
    for (const j of RIG_JOINTS) {
      const o = this.joints.get(j); if (!o) continue;
      const target = F.clone().multiply(acc.get(j)!).multiply(align.get(j)!).multiply(base.get(j)!);
      if (o.parent) o.parent.getWorldQuaternion(parentQ); else parentQ.identity();
      o.quaternion.copy(parentQ.invert().multiply(target));
      o.updateMatrixWorld(true);
    }
    // Bent legs lower the hips so the lowest foot stays where a straight-legged stance puts it (sitting, crouching).
    const hips = this.joints.get('body');
    if (!action && hips?.parent && this.joints.has('footL') && this.joints.has('thighL') && this.joints.has('shinL')) {
      const legs = ['L', 'R'].filter(s => this.joints.has(`foot${s}`)).map(s => at.get(`thigh${s}`)!.y - at.get(`thigh${s}`)!.distanceTo(at.get(`shin${s}`)!) - at.get(`shin${s}`)!.distanceTo(at.get(`foot${s}`)!));
      const drop = footY() - Math.min(...legs);
      if (drop > 1e-4) {
        const w = hips.getWorldPosition(new THREE.Vector3()).sub(new THREE.Vector3(0, drop, 0).applyQuaternion(F));
        hips.position.copy(hips.parent.worldToLocal(w)); hips.updateMatrixWorld(true);
      }
    }
  }

  dispose() { this.mixer.stopAllAction(); this.mixer.uncacheRoot(this.model); this.setNeutral(false); }
}
