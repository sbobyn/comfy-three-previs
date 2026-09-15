import * as THREE from "three";

const canvas = document.querySelector<HTMLCanvasElement>("#scene");
if (!canvas) throw new Error("missing #scene canvas");

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e0e12);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
camera.position.set(2.6, 2, 3.4);
camera.lookAt(0, 0, 0);

scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x20202a, 1.6));
const keyLight = new THREE.DirectionalLight(0xffffff, 2.4);
keyLight.position.set(3, 5, 2);
scene.add(keyLight);

const cube = new THREE.Mesh(
  new THREE.BoxGeometry(1, 1, 1),
  new THREE.MeshStandardMaterial({ color: 0x4f8cff, roughness: 0.35, metalness: 0.1 }),
);
scene.add(cube);

const grid = new THREE.GridHelper(10, 10, 0x3a3a4a, 0x24242e);
grid.position.y = -1;
scene.add(grid);

function resize(): void {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

window.addEventListener("resize", resize);
resize();

const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  const delta = clock.getDelta();
  cube.rotation.x += delta * 0.6;
  cube.rotation.y += delta * 0.9;
  renderer.render(scene, camera);
});
