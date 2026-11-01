import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { blockoutModel, projectMesh } from '../shared/blockout-models.mjs';
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
  const group = source.clone(true);
  if (projectMesh(id)) group.scale.fromArray(SHAPES[e.shape].size);
  group.traverse(o => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry = mesh.geometry.clone();
    const tint = (m: THREE.Material) => {
      const copy = m.clone() as THREE.MeshStandardMaterial;
      if (m.name === 'entity-color') copy.color.set(e.color);
      // Thin wings/markings are intentional low-poly surfaces.
      copy.side = THREE.DoubleSide;
      copy.shadowSide = THREE.BackSide; // closed meshes must not shadow their own front faces
      return copy;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(tint) : tint(mesh.material);
    mesh.castShadow = e.shape !== 'terrain'; mesh.receiveShadow = true;
    if (e.shape === 'terrain') mesh.userData.terrain = true;
  });
  // Scene placement overwrites the root scale; keep the proxy base dimensions on its child.
  if (projectMesh(id)) { const root = new THREE.Group(); root.add(group); return root; }
  return group;
}
