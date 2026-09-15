import * as THREE from "three";

export type Stage = {
  target: THREE.Object3D;
  ghost: THREE.Object3D;
  render: () => void;
  dispose: () => void;
};

/** Cube plus axes, so orientation is readable rather than just "a box moved". */
export function createStage(canvas: HTMLCanvasElement): Stage {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0e0e12);

  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 1.4, 4);
  camera.lookAt(0, 0, 0);

  scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x20202a, 1.6));
  const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
  keyLight.position.set(3, 5, 2);
  scene.add(keyLight);

  const target = new THREE.Group();
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(1, 1.8, 0.2),
    new THREE.MeshStandardMaterial({ color: 0x4f8cff, roughness: 0.35, metalness: 0.1 }),
  );
  target.add(body);
  target.add(new THREE.AxesHelper(1.6));
  scene.add(target);

  // Unsmoothed reference drawn in the same place, so the lag and tremor that
  // smoothing removes are visible directly rather than inferred.
  const ghost = new THREE.Mesh(
    new THREE.BoxGeometry(1.06, 1.86, 0.26),
    new THREE.MeshBasicMaterial({ color: 0xff7a45, wireframe: true, transparent: true, opacity: 0.55 }),
  );
  scene.add(ghost);

  const grid = new THREE.GridHelper(10, 10, 0x3a3a4a, 0x24242e);
  grid.position.y = -1.6;
  scene.add(grid);

  const resize = (): void => {
    const { innerWidth: width, innerHeight: height } = window;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", resize);
  resize();

  return {
    target,
    ghost,
    render: () => renderer.render(scene, camera),
    dispose: () => {
      window.removeEventListener("resize", resize);
      renderer.dispose();
    },
  };
}
