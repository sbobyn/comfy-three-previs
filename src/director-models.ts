import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { blockoutModel, projectMesh, isDecalMaterial, DECAL_POLYGON_OFFSET } from '../shared/blockout-models.mjs';
import { applyBlockoutPose } from '../shared/blockout-pose.mjs';
import type { Pose } from '../shared/blockout-pose.mjs';
import { RigRuntime } from './director-rig';
import { SHAPES } from '../shared/director.mjs';
import type { Entity } from '../shared/director.mjs';

const loader = new GLTFLoader();
const loaded = new Map<string, THREE.Group>();
const pending = new Map<string, Promise<void>>();

/** Finish loading before any capture. A missing/corrupt model fails explicitly, never records its proxy. */
export async function loadBlockoutModels(entities: Entity[]) {
  await Promise.all([...new Set(entities.map(blockoutModel).filter((x): x is string => !!x))].map(id => {
    if (loaded.has(id)) return;
    if (!pending.has(id)) pending.set(id, loader.loadAsync(projectMesh(id) || `${import.meta.env.BASE_URL}models/blockouts/${id}.glb`).then(gltf => {
      // glTF node indices survive cloning in userData: imported rigs name their joints by node (shared/rig.mjs).
      gltf.scene.traverse(o => { const n = gltf.parser.associations.get(o)?.nodes; if (n !== undefined) o.userData.gltfNode = n; });
      gltf.scene.animations = gltf.animations;
      loaded.set(id, gltf.scene);
    }).catch(() => { throw Error(`Could not load blockout model “${id}”. ${projectMesh(id) ? 'Re-import the Blender mesh or restore this project’s mesh file.' : 'Reload after restoring public/models/blockouts.'}`); }).finally(() => { pending.delete(id); }));
    return pending.get(id);
  }));
}

export function modelReady(e: Entity) { const id = blockoutModel(e); return !id || loaded.has(id); }

/** Independent geometry/materials let scene disposal and entity tint edits leave the cached source intact. */
export function buildBlockoutModel(e: Entity): THREE.Group | null {
  const id = blockoutModel(e), source = id && loaded.get(id);
  if (!source) return null;
  let skinned = false; source.traverse(o => { skinned ||= !!(o as THREE.SkinnedMesh).isSkinnedMesh; });
  const group = (skinned ? cloneSkinned(source) : source.clone(true)) as THREE.Group;
  group.animations = source.animations;
  if (projectMesh(id)) group.scale.fromArray(SHAPES[e.shape].size);
  group.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    // Imported models (docs/import.md) keep their own materials and textures; skinned limbs leave their bind bounds.
    if (e.source) {
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(m => m.clone()) : mesh.material.clone();
      mesh.castShadow = mesh.receiveShadow = true;
      if ((mesh as THREE.SkinnedMesh).isSkinnedMesh) mesh.frustumCulled = false;
      return;
    }
    mesh.geometry = mesh.geometry.clone();
    const tint = (m: THREE.Material) => {
      const copy = m.clone() as THREE.MeshStandardMaterial;
      if (m.name === 'entity-color') copy.color.set(e.color);
      // Thin wings/markings are intentional low-poly surfaces.
      copy.side = THREE.DoubleSide;
      copy.shadowSide = THREE.BackSide; // closed meshes must not shadow their own front faces
      // Decals sit a few millimetres off the surface below (docs/blockout-modeling-rules.md); polygonOffset keeps them
      // in front at any distance, where that gap is smaller than one depth-buffer step.
      if (isDecalMaterial(m.name)) Object.assign(copy, { polygonOffset: true, polygonOffsetFactor: DECAL_POLYGON_OFFSET.factor, polygonOffsetUnits: DECAL_POLYGON_OFFSET.units });
      return copy;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(tint) : tint(mesh.material);
    // A decal's shadow is a texel-sized smudge around it: only solid parts cast.
    const decal = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).every(m => isDecalMaterial(m.name));
    const glass = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).every(m => m.transparent && m.opacity < 0.5);
    mesh.castShadow = e.shape !== 'terrain' && !decal && !glass; mesh.receiveShadow = true;
    if (e.shape === 'terrain') mesh.userData.terrain = true;
  });
  // Scene placement overwrites the root scale; keep the proxy base dimensions on its child.
  if (projectMesh(id)) { const root = new THREE.Group(); root.add(group); if (e.source) root.userData.rig = new RigRuntime(group, e); return root; }
  return group;
}

/** Pose a placed model for scene time t: an imported rig (clip, pose, stand-in) or a bundled model's joints. */
export function poseModel(root: THREE.Object3D, e: Entity, t: number, pose: Pose | undefined, opts: { neutral?: boolean } = {}) {
  const rig = root.userData.rig as RigRuntime | undefined;
  if (rig) rig.apply(root, e, t, pose, opts); else applyBlockoutPose(root, pose);
}
