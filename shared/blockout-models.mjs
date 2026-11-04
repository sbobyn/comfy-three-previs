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
/** Decals, lines and inset panels: lifted off the surface below in the GLB, drawn with polygonOffset, never shadow casters. */
export const isDecalMaterial = name => typeof name === 'string' && name.endsWith('-decal');
/**
 * polygonOffset for decal materials: pulled toward the camera by a constant number of depth steps, so they win at any
 * distance. No slope factor: it would pull a decal's thin, nearly edge-on side faces far forward, through whatever
 * sits in front of them (they showed as dotted lines through the video wall's map).
 */
export const DECAL_POLYGON_OFFSET = Object.freeze({ factor: 0, units: -4 });
export const blockoutModel = e => typeof e.model === 'string' && Object.hasOwn(BLOCKOUT_MODELS, e.model) && BLOCKOUT_MODELS[e.model] === e.shape ? e.model : projectMesh(e.model);
