const print = expression => `print("PREVIS_JSON:" + json.dumps(${expression}))`;
export const inspectCode = `import bpy, json
${print(`{"file": bpy.data.filepath, "scenes": [{"name": s.name, "fps": s.render.fps / s.render.fps_base, "start": s.frame_start, "end": s.frame_end, "frame": s.frame_current, "cameras": [o.name for o in s.objects if o.type == 'CAMERA']} for s in bpy.data.scenes]}`)}
`;
export function renderCode(binding) {
  return `import bpy, json, tempfile, os, base64
binding = json.loads(${JSON.stringify(JSON.stringify(binding))})
if bpy.data.filepath != binding['file']: raise RuntimeError('Blender file changed; refresh and rebind the shot')
s = bpy.data.scenes.get(binding['scene'])
if s is None: raise RuntimeError('Scene missing; refresh and rebind')
camera = s.objects.get(binding['camera'])
if camera is None or camera.type != 'CAMERA': raise RuntimeError('Camera missing; refresh and rebind')
if abs(s.render.fps / s.render.fps_base - binding['fps']) > 0.00001: raise RuntimeError('Scene FPS changed; refresh and rebind')
if binding['start'] < s.frame_start or binding['end'] > s.frame_end or binding['frame'] < s.frame_start or binding['frame'] > s.frame_end: raise RuntimeError('Frame range changed; refresh and rebind')
r = s.render
old = (s.camera, s.frame_current, s.frame_subframe, r.filepath, r.resolution_x, r.resolution_y, r.resolution_percentage, r.image_settings.file_format, r.image_settings.color_mode, r.use_file_extension, r.use_compositing, r.use_sequencer, r.use_border, r.use_crop_to_border, r.pixel_aspect_x, r.pixel_aspect_y)
fd, path = tempfile.mkstemp(suffix='.png')
os.close(fd)
try:
    s.camera = camera
    s.frame_set(binding['frame'])
    r.filepath = path
    r.resolution_x = 640
    r.resolution_y = 360
    r.resolution_percentage = 100
    r.image_settings.file_format = 'PNG'
    r.image_settings.color_mode = 'RGBA'
    r.use_file_extension = True
    r.use_compositing = False
    r.use_sequencer = False
    r.use_border = False
    r.use_crop_to_border = False
    r.pixel_aspect_x = 1
    r.pixel_aspect_y = 1
    bpy.ops.render.render(write_still=True, scene=s.name)
    with open(path, 'rb') as f: image = base64.b64encode(f.read()).decode('ascii')
    ${print(`{"png": image, "width": 640, "height": 360, "binding": binding}`)}
finally:
    s.camera, frame, subframe, r.filepath, r.resolution_x, r.resolution_y, r.resolution_percentage, r.image_settings.file_format, r.image_settings.color_mode, r.use_file_extension, r.use_compositing, r.use_sequencer, r.use_border, r.use_crop_to_border, r.pixel_aspect_x, r.pixel_aspect_y = old
    s.frame_set(frame, subframe=subframe)
    if os.path.exists(path): os.unlink(path)
`;
}
