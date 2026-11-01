// Display meshes: bundled names or strictly scoped project assets (never arbitrary URLs).
// Imported GLBs have unit bounds; the viewport fits them to the entity’s proxy dimensions.
export const BLOCKOUT_MODELS = Object.freeze({
  player: 'person', anchor: 'person', operator: 'person', fan: 'person',
  'race-car': 'car', eagle: 'bird', elk: 'box', pine: 'tree',
  'studio-camera': 'cylinder', light: 'lamp', court: 'box', paint: 'box',
  track: 'box', finish: 'box', 'studio-floor': 'box', grass: 'box', river: 'box',
  stands: 'box', barrier: 'box', 'press-box': 'box', screen: 'box',
  'video-wall': 'wall', 'desk-panel': 'box', desk: 'table', basketball: 'sphere',
  rim: 'cylinder', circle: 'cylinder', lake: 'cylinder', support: 'box',
  backboard: 'box', 'flag-stand': 'box', terrain: 'terrain',
});
export const projectMesh = model => typeof model === 'string' && /^\/director-refs\/[a-f0-9-]{36}\/[a-f0-9-]{36}\.glb$/.test(model) ? model : null;
export const blockoutModel = e => typeof e.model === 'string' && Object.hasOwn(BLOCKOUT_MODELS, e.model) && BLOCKOUT_MODELS[e.model] === e.shape ? e.model : projectMesh(e.model);
