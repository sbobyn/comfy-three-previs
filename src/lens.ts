import * as THREE from "three";

/**
 * Full-frame sensor width. Three derives film height by dividing this by the
 * aspect, so horizontal field of view depends only on focal length — a 50mm
 * stays a 50mm when the window is resized, which a fixed vertical FOV would not.
 */
export const FILM_GAUGE = 36;

export const MIN_MM = 10;
const MM_RANGE = 30;

export function horizontalFov(mm: number): number {
  return THREE.MathUtils.radToDeg(2 * Math.atan(FILM_GAUGE / 2 / mm));
}

/**
 * Focal length reads logarithmically, so sliders map that way — a linear one
 * spends most of its travel across telephoto lengths that look nearly identical
 * and compresses the wide end where every millimetre changes the shot.
 */
export function sliderToMm(t: number): number {
  return Math.round(MIN_MM * Math.pow(MM_RANGE, t));
}

export function mmToSlider(mm: number): number {
  return Math.log(mm / MIN_MM) / Math.log(MM_RANGE);
}
