// Original demo blockout. Metres, four seconds, one scene/shot. No services or jobs run here.
export function afterHoursSpec(id = () => crypto.randomUUID()) {
  const entities = [];
  const add = (name, shape, position, scale, color, extra = {}) => {
    const e = { id: id(), name, shape, position, scale, color, ...extra }; entities.push(e); return e;
  };
  const car = add('Plum hover coupe', 'car', [0, .65, 0], [1.15, .8, 1.08], '#49378B', {
    rotation: 335, notes: 'Hero vehicle: original retro-futurist plum coupe, satin violet body, warm-white lamps, Comfy-yellow trim, dark glass. Four wheels stay visible. Hover gently, no flames, no driving away.',
    path: [{ t: 0, p: [0, .65, 0], r: 335 }, { t: 2, p: [0, .65, 0], r: 335 }, { t: 4, p: [0, 1.4, 0], r: 335 }],
  });
  const lead = add('Creator · Ink Comfy shirt', 'person', [-2.7, 0, 3.7], [1.1, 1.1, 1.1], '#211927', {
    rotation: 195, notes: 'Adult creator, warm brown skin, short curly dark hair. Oversized charcoal T-shirt with the supplied Comfy wordmark centered large across the upper back, plum cargo trousers, off-white sneakers. Back toward the opening camera; watches the car. Keep identity and wardrobe throughout.',
  });
  const friend = add('Creator · Yellow Comfy shirt', 'person', [3.2, 0, 1.8], [1.05, 1.05, 1.05], '#F2FF59', {
    rotation: 230, notes: 'Adult creator, East Asian appearance, shoulder-length dark hair. Comfy-yellow T-shirt with the supplied wordmark on an Ink chest patch, charcoal trousers, off-white sneakers. Stands beside the car, watches its lift. Natural restrained reaction, no walking or dialogue.',
  });
  add('River channel · concrete apron', 'box', [0, -.24, -8], [42, .22, 70], '#C2BFB9', { kind: 'environment', notes: 'Dry pale concrete LA River channel, subtle tire marks. No rain, no water covering the set.' });
  add('Channel water · narrow reflection', 'box', [13, -.02, -14], [1.5, .05, 60], '#847B9A', { kind: 'environment', notes: 'One narrow strip of still water, outside the action area.' });
  for (const x of [-17, 17]) add(`Channel bank ${x < 0 ? 'west' : 'east'}`, 'box', [x, .6, -13], [6, .6, 65], '#AFA59C', { kind: 'environment', roll: x < 0 ? -12 : 12 });
  add('Bridge · raised deck', 'box', [0, 5.8, -19], [39, .55, 7], '#B4B0A8', { kind: 'environment' });
  // Two segmented arch ribs: simple editable boxes, not a claimed architectural scan.
  for (const z of [-16, -22]) {
    for (const x of [-11, 11]) add(`Bridge pier ${x} / ${z}`, 'box', [x, 0, z], [.9, 6.2, .9], '#B6B0A5', { kind: 'environment' });
    const points = Array.from({ length: 13 }, (_, i) => { const t = i / 12; return [-11 + 22 * t, 6.1 + 7.5 * Math.sin(Math.PI * t)]; });
    for (let i = 0; i < points.length - 1; i++) {
      const [a, b] = [points[i], points[i + 1]], dx = b[0] - a[0], dy = b[1] - a[1];
      add(`Bridge arch ${z} · rib ${i + 1}`, 'box', [a[0], a[1], z], [.46, Math.hypot(dx, dy) + .06, .6], '#F0EFED', { kind: 'environment', roll: -Math.atan2(dx, dy) * 180 / Math.PI });
    }
    for (const x of [-7, -3, 3, 7]) {
      const y = 7.5 * Math.sin(Math.PI * (x + 11) / 22);
      add(`Bridge hanger ${x} / ${z}`, 'box', [x, 6.2, z], [.10, y, .10], '#C2BFB9', { kind: 'environment' });
    }
  }
  for (const [i, x, z, height] of [[1,-17,-57,18],[2,-10,-64,24],[3,-4,-66,32],[4,3,-70,27],[5,10,-62,20],[6,18,-59,16]]) {
    add(`Downtown silhouette ${i}`, 'building', [x, 0, z], [.6, height / 12, .65], i % 2 ? '#7B7589' : '#8D8194', { notes: 'Distant downtown LA skyline in golden-hour haze.' });
  }
  for (const [x,z] of [[-9,-6],[10,-9]]) add(`Channel work light ${x}`, 'lamp', [x,0,z], [1,1.5,1], '#49378B');
  const prompt = `Use Video 1 as the source of the exact camera move, duration, scene blocking and hover-car lift. Re-render that same continuous shot as a premium live-action film. Los Angeles River channel beneath an original interpretation of the Sixth Street Bridge at late golden hour; warm side light, soft lavender downtown haze, pale dry concrete. Preserve the sideways camera reveal, foreground occlusion and parallax, subject positions, silhouettes and scale from Video 1. The plum retro-futurist coupe holds still horizontally, then rises gently during the final two seconds, exactly as in Video 1. Two adult creators wear the Comfy shirts shown in the reference images; keep the supplied wordmark legible and consistent, without extra text. Ink shirt creator is foreground left, Yellow shirt creator stands beyond the car on the right. They watch the lift with restrained natural movement. No cuts, no camera shake, no extra people or vehicles, no driving away, no explosions. Cinematic believable materials and skin, subtle warm reflections. Reference images define appearance; Video 1 defines motion and composition. Four seconds, 16:9. Judge motion and branding rather than promising exact preservation.`;
  return {
    title: 'Comfy After Hours · Sixth Street Lift-Off',
    scene: { name: 'LA River · Sixth Street Lift-Off', environment: { preset: 'stage', description: 'Los Angeles River beneath the Sixth Street Bridge, late golden hour, dry pale concrete, plum and yellow hero accents, hazy downtown skyline.', style: 'Premium live-action automotive short. Restrained sci-fi, warm sunlight and lavender haze. Comfy wardrobe follows the supplied artwork; no implication of official endorsement.' } },
    entities, leads: { car: car.id, ink: lead.id, yellow: friend.id },
    shot: { title: '01 · The lift-off reveal', description: prompt, duration: 4, start: 0,
      camera: { move: 'custom', target: car.id, distance: 7, height: 1.5, angle: 0, mm: 24, timing: 'linear', keys: [
        { t: 0, p: [-2.55, 1.65, 5.6], look: [-.15, 1.25, .15], mm: 24 },
        { t: .25, p: [-1.1, 1.7, 5.9], look: [-.1, 1.3, 0], mm: 24 },
        { t: .75, p: [2.7, 2.1, 7.8], look: [0, 1.9, -.7], mm: 24 },
        { t: 1, p: [4.8, 2.5, 9], look: [0, 2.6, -3], mm: 24 },
      ] }, cast: { include: [car.id, lead.id, friend.id], exclude: [] } },
    prompt,
  };
}
