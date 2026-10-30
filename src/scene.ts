import * as THREE from "three";
import { FILM_GAUGE } from "./lens";

// The camera-study set the phone viewfinder (phone.html) draws.
const PARKED = new THREE.Vector3(0, 1.7, 0);


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
  subject.name = "previs-subject";
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

export type Viewfinder = {
  setSubjectPosition: (position: number[]) => void;
  camera: THREE.PerspectiveCamera;
  setPosition: (x: number, y: number, z: number) => void;
  setFocalLength: (mm: number) => void;
  setFormat: (aspect: number | null) => void;
  render: () => void;
};

/** Same camera-study set, synchronized from the desktop camera and subject. */
export function createViewfinder(canvas: HTMLCanvasElement): Viewfinder {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setScissorTest(true);
  renderer.setClearColor(0x000000);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e0e12);
  scene.fog = new THREE.Fog(0x0e0e12, 45, 170);
  buildSet(scene);

  const camera = new THREE.PerspectiveCamera(40, 1, 0.5, 300);
  camera.filmGauge = FILM_GAUGE;
  camera.position.copy(PARKED);

  let focalLength = 35;
  let format: number | null = 16 / 9;

  const resize = (): void => {
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  };
  window.addEventListener("resize", resize);
  window.addEventListener("orientationchange", resize);
  resize();

  return {
    camera,
    setSubjectPosition: (position: number[]) => { scene.getObjectByName("previs-subject")!.position.fromArray(position); },
    setPosition: (x: number, y: number, z: number) => {
      camera.position.set(x, y, z);
    },
    setFocalLength: (mm: number) => {
      focalLength = mm;
    },
    setFormat: (aspect: number | null) => {
      format = aspect;
    },
    render: () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const frameHeight = format === null ? height : Math.min(height, width / format);
      const frameWidth = format === null ? width : frameHeight * format;
      const x = (width - frameWidth) / 2;
      const y = (height - frameHeight) / 2;

      camera.aspect = frameWidth / frameHeight;
      camera.setFocalLength(focalLength);

      renderer.setViewport(0, 0, width, height);
      renderer.setScissor(0, 0, width, height);
      renderer.clear();

      renderer.setViewport(x, y, frameWidth, frameHeight);
      renderer.setScissor(x, y, frameWidth, frameHeight);
      renderer.render(scene, camera);
    },
  };
}
