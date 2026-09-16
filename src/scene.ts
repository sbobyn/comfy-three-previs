import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { Demo } from "./demos";

// Helpers live on their own layer so the world view can show the rig while the
// camera view stays clean — an operator must not see their own frustum.
const HELPER_LAYER = 1;

export type Studio = {
  pov: THREE.PerspectiveCamera;
  rawPov: THREE.PerspectiveCamera;
  setRawVisible: (visible: boolean) => void;
  setDemo: (demo: Demo) => void;
  /** 0..1 along the current demo's path; ignored when the demo has none. */
  setDollyProgress: (u: number) => void;
  /** Full-frame focal length in mm. */
  setFocalLength: (mm: number) => void;
  /** Target frame aspect, or null to fill the pane. */
  setFormat: (aspect: number | null) => void;
  render: () => void;
  dispose: () => void;
};

const PARKED = new THREE.Vector3(0, 1.7, 0);

/**
 * Full-frame sensor width. Three derives film height by dividing this by the
 * aspect, so horizontal field of view depends only on focal length — a 50mm
 * stays a 50mm when the window is resized, which a fixed vertical FOV would not.
 */
const FILM_GAUGE = 36;

export function horizontalFov(mm: number): number {
  return THREE.MathUtils.radToDeg(2 * Math.atan(FILM_GAUGE / 2 / mm));
}

/** A small body so the rig reads as a camera in the world view, not just lines. */
function cameraBody(color: number): THREE.Object3D {
  const group = new THREE.Group();
  const material = new THREE.MeshBasicMaterial({ color });
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.36, 0.7), material);
  const lens = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.17, 0.36, 16), material);
  lens.rotation.x = -Math.PI / 2;
  lens.position.z = -0.5;
  group.add(box, lens);
  group.traverse((object) => object.layers.set(HELPER_LAYER));
  return group;
}

function buildSet(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x20202a, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(6, 12, 4);
  scene.add(key);

  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(200, 200),
    new THREE.MeshStandardMaterial({ color: 0x15151c, roughness: 1 }),
  );
  ground.rotation.x = -Math.PI / 2;
  scene.add(ground);
  scene.add(new THREE.GridHelper(80, 80, 0x2e2e3e, 0x1e1e28));

  // Landmarks at varied distance and height: framing can only be judged against
  // things worth framing, and parallax needs depth to read.
  // The rig sits at the origin, so the set is staged outward from it — a camera
  // buried inside its own scenery gives both views a wall of clutter.
  const subject = new THREE.Mesh(
    new THREE.TorusKnotGeometry(1.1, 0.34, 180, 28),
    new THREE.MeshStandardMaterial({ color: 0x4f8cff, roughness: 0.3, metalness: 0.2 }),
  );
  subject.position.set(0, 2.2, -11);
  scene.add(subject);

  const palette = [0xff7a45, 0x5ad1a0, 0xd98cff, 0xffd166, 0x6ea8ff];
  for (let i = 0; i < 16; i += 1) {
    const angle = (i / 16) * Math.PI * 2 + 0.2;
    const radius = 14 + ((i * 4.3) % 13);
    const height = 2 + ((i * 2.7) % 7);
    const pillar = new THREE.Mesh(
      new THREE.BoxGeometry(1.2, height, 1.2),
      new THREE.MeshStandardMaterial({ color: palette[i % palette.length], roughness: 0.7 }),
    );
    pillar.position.set(Math.cos(angle) * radius, height / 2, Math.sin(angle) * radius);
    pillar.rotation.y = angle;
    scene.add(pillar);
  }

  // Distant slabs give the horizon something to sweep past during a pan.
  for (let i = 0; i < 7; i += 1) {
    const angle = (i / 7) * Math.PI * 2 + 0.4;
    const height = 12 + i * 3;
    const slab = new THREE.Mesh(
      new THREE.BoxGeometry(9, height, 9),
      new THREE.MeshStandardMaterial({ color: 0x23232f, roughness: 0.9 }),
    );
    slab.position.set(Math.cos(angle) * 58, height / 2, Math.sin(angle) * 58);
    scene.add(slab);
  }
}

export function createStudio(canvas: HTMLCanvasElement, worldPane: HTMLElement): Studio {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setScissorTest(true);
  renderer.setClearColor(0x07070a);

  let focalLength = 35;
  let format: number | null = 16 / 9;

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e0e12);
  scene.fog = new THREE.Fog(0x0e0e12, 45, 170);
  buildSet(scene);

  const pov = new THREE.PerspectiveCamera(40, 1, 0.5, 300);
  pov.filmGauge = FILM_GAUGE;
  pov.position.copy(PARKED);
  // Added to the scene so the body mesh below travels with it; the body sits on
  // the helper layer, so the camera never renders its own housing.
  scene.add(pov);
  pov.add(cameraBody(0x4f8cff));

  const rawPov = new THREE.PerspectiveCamera(40, 1, 0.5, 300);
  rawPov.filmGauge = FILM_GAUGE;
  rawPov.position.copy(pov.position);
  scene.add(rawPov);

  const povHelper = new THREE.CameraHelper(pov);
  povHelper.layers.set(HELPER_LAYER);
  povHelper.setColors(
    new THREE.Color(0x4f8cff),
    new THREE.Color(0x4f8cff),
    new THREE.Color(0x8fb4ff),
    new THREE.Color(0x4f8cff),
    new THREE.Color(0x4f8cff),
  );
  scene.add(povHelper);

  const rawHelper = new THREE.CameraHelper(rawPov);
  rawHelper.layers.set(HELPER_LAYER);
  const orange = new THREE.Color(0xff7a45);
  rawHelper.setColors(orange, orange, orange, orange, orange);
  scene.add(rawHelper);

  const world = new THREE.PerspectiveCamera(50, 1, 0.1, 600);
  world.position.set(13, 9, 19);
  world.layers.enable(HELPER_LAYER);

  const controls = new OrbitControls(world, worldPane);
  controls.target.set(0, 2, -4);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.update();

  let path: THREE.Curve<THREE.Vector3> | null = null;
  let pathLine: THREE.Line | null = null;

  const setDollyProgress = (u: number): void => {
    if (path) path.getPointAt(Math.min(1, Math.max(0, u)), pov.position);
    else pov.position.copy(PARKED);
    rawPov.position.copy(pov.position);
  };

  const setDemo = (demo: Demo): void => {
    if (pathLine) {
      scene.remove(pathLine);
      pathLine.geometry.dispose();
      (pathLine.material as THREE.Material).dispose();
      pathLine = null;
    }
    path = demo.path;
    if (path) {
      pathLine = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(path.getPoints(240)),
        new THREE.LineBasicMaterial({ color: 0x5ad1a0 }),
      );
      pathLine.layers.set(HELPER_LAYER);
      scene.add(pathLine);
    }
    setDollyProgress(0);
  };

  const resize = (): void => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  };
  window.addEventListener("resize", resize);
  resize();

  const render = (): void => {
    controls.update();

    const width = window.innerWidth;
    const height = window.innerHeight;
    const split = Math.round(width / 2);

    // Letterbox the camera view to the delivery format: composition judged at
    // the wrong aspect is composition judged for a different shot.
    const paneWidth = width - split;
    const frameHeight = format === null ? height : Math.min(height, paneWidth / format);
    const frameWidth = format === null ? paneWidth : frameHeight * format;
    const frameX = split + (paneWidth - frameWidth) / 2;
    const frameY = (height - frameHeight) / 2;

    world.aspect = split / height;
    world.updateProjectionMatrix();
    pov.aspect = frameWidth / frameHeight;
    pov.setFocalLength(focalLength);
    rawPov.aspect = pov.aspect;
    rawPov.setFocalLength(focalLength);

    // Helpers read the camera matrices, so refresh those before updating them.
    pov.updateMatrixWorld(true);
    rawPov.updateMatrixWorld(true);
    povHelper.update();
    rawHelper.update();

    renderer.setViewport(0, 0, split, height);
    renderer.setScissor(0, 0, split, height);
    renderer.render(scene, world);

    renderer.setViewport(split, 0, paneWidth, height);
    renderer.setScissor(split, 0, paneWidth, height);
    renderer.clear();

    renderer.setViewport(frameX, frameY, frameWidth, frameHeight);
    renderer.setScissor(frameX, frameY, frameWidth, frameHeight);
    renderer.render(scene, pov);
  };

  return {
    pov,
    rawPov,
    setRawVisible: (visible: boolean) => {
      rawHelper.visible = visible;
    },
    setDemo,
    setDollyProgress,
    setFocalLength: (mm: number) => {
      focalLength = mm;
    },
    setFormat: (aspect: number | null) => {
      format = aspect;
    },
    render,
    dispose: () => {
      window.removeEventListener("resize", resize);
      controls.dispose();
      renderer.dispose();
    },
  };
}

export type SoloStage = {
  target: THREE.Object3D;
  render: () => void;
};

/** Minimal single-object stage for the phone-only sensor check. */
export function createSoloStage(canvas: HTMLCanvasElement): SoloStage {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e0e12);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 1.4, 4);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x20202a, 1.6));
  const key = new THREE.DirectionalLight(0xffffff, 2.4);
  key.position.set(3, 5, 2);
  scene.add(key);

  const target = new THREE.Group();
  target.add(
    new THREE.Mesh(
      new THREE.BoxGeometry(1, 1.8, 0.2),
      new THREE.MeshStandardMaterial({ color: 0x4f8cff, roughness: 0.35, metalness: 0.1 }),
    ),
  );
  target.add(new THREE.AxesHelper(1.6));
  scene.add(target);

  const grid = new THREE.GridHelper(10, 10, 0x3a3a4a, 0x24242e);
  grid.position.y = -1.6;
  scene.add(grid);

  const resize = (): void => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", resize);
  resize();

  return { target, render: () => renderer.render(scene, camera) };
}
