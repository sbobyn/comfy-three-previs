import * as THREE from "three";
import { element } from "./dom";
import { createStage } from "./scene";
import { onDeviceQuaternion, requestMotionPermission, YawZero } from "./orientation";

const canvas = element<HTMLCanvasElement>("scene");
const enableButton = element<HTMLButtonElement>("enable");
const zeroButton = element<HTMLButtonElement>("zero");
const status = element("status");

const stage = createStage(canvas);
const yawZero = new YawZero();
const euler = new THREE.Euler();

let samples = 0;
let pendingZero = false;

enableButton.addEventListener("click", async () => {
  enableButton.disabled = true;
  status.textContent = "Requesting permission…";

  if (!(await requestMotionPermission())) {
    status.textContent = "Motion permission denied";
    enableButton.disabled = false;
    return;
  }

  onDeviceQuaternion((q) => {
    if (pendingZero) {
      yawZero.capture(q);
      pendingZero = false;
    }
    yawZero.apply(q);
    stage.target.quaternion.copy(q);
    samples += 1;
    if (samples % 15 === 0) {
      euler.setFromQuaternion(q, "YXZ");
      const deg = (r: number): string => THREE.MathUtils.radToDeg(r).toFixed(0).padStart(4);
      status.textContent = `yaw ${deg(euler.y)}°  pitch ${deg(euler.x)}°  roll ${deg(euler.z)}°`;
    }
  });

  zeroButton.disabled = false;
  status.textContent = "Waiting for sensor…";
});

zeroButton.addEventListener("click", () => {
  pendingZero = true;
});

const animate = (): void => {
  stage.render();
  requestAnimationFrame(animate);
};
animate();
