// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
export function browserDelivery(input = {}) {
  const { width = 640, height = 360, fps = 24 } = input;
  if (![[640, 360], [1280, 720]].some(([w, h]) => w === width && h === height) || fps !== 24) throw Error('Choose 640×360 or 1280×720, 16:9 at 24 fps. Other delivery settings are not supported.');
  return { width, height, fps, aspect: '16:9' };
}

export function browserVideoPlan(frames, input) {
  const delivery = browserDelivery(input);
  if (!Array.isArray(frames) || !frames.length) throw Error('Record a short camera move or choose a three-second preset, then save the shot.');
  const recordedDuration = frames.at(-1).t;
  if (!Number.isFinite(recordedDuration) || recordedDuration < 0) throw Error('Saved motion timing is invalid.');
  // Include every point on the delivery grid, including an exact final endpoint.
  const frameCount = Math.floor(recordedDuration * delivery.fps + 1e-8) + 1;
  if (frameCount > 120) throw Error(`This motion needs ${frameCount} frames at 24 fps; export supports at most 120 (5 seconds). Choose a three-second preset or record a shorter take. The recording has not been shortened.`);
  return { ...delivery, frameCount, duration: frameCount / delivery.fps, recordedDuration, sampledEndTime: (frameCount - 1) / delivery.fps };
}
