import { createHash } from 'node:crypto';
const print = expression => `print("PREVIS_JSON:" + json.dumps(${expression}))`;
export const inspectCode = `import bpy, json
${print(`{"file": bpy.data.filepath, "activeScene": bpy.context.scene.name, "scenes": [{"name": s.name, "fps": s.render.fps / s.render.fps_base, "start": s.frame_start, "end": s.frame_end, "frame": s.frame_current, "activeCamera": s.camera.name if s.camera else None, "cameras": [o.name for o in s.objects if o.type == 'CAMERA'], "cameraDetails": {o.name: {"type": o.data.type, "mm": o.data.lens if o.data.type == 'PERSP' else None, "sensorWidth": o.data.sensor_width, "frame": s.frame_current, "mayAnimate": bool(o.data.animation_data)} for o in s.objects if o.type == 'CAMERA'}} for s in bpy.data.scenes]}`)}
`;
export function catalogToken(catalog) {
  // Ignore playhead/active camera; only the binding identity and timing matter.
  return createHash('sha256').update(JSON.stringify({ file: catalog.file, scenes: catalog.scenes.map(({ name, fps, start, end, cameras }) => ({ name, fps, start, end, cameras })) })).digest('hex');
}
export function renderCode(binding) {
  return `import bpy, json, tempfile, os, base64
binding = json.loads(${JSON.stringify(JSON.stringify(binding))})
def previs_render():
    if bpy.data.filepath != binding['file']: return {'ok': False, 'error': 'Blender file changed; refresh and rebind the shot'}
    s = bpy.data.scenes.get(binding['scene'])
    if s is None: return {'ok': False, 'error': 'Scene missing; refresh and rebind'}
    camera = s.objects.get(binding['camera'])
    if camera is None or camera.type != 'CAMERA': return {'ok': False, 'error': 'Camera missing or renamed; refresh and rebind'}
    if abs(s.render.fps / s.render.fps_base - binding['fps']) > 0.00001: return {'ok': False, 'error': 'Scene FPS changed; refresh and rebind'}
    if binding['start'] < s.frame_start or binding['end'] > s.frame_end or not binding['start'] <= binding['frame'] <= binding['end']: return {'ok': False, 'error': 'Frame range changed; refresh and rebind'}
    r = s.render
    old = (s.camera, s.frame_current, s.frame_subframe, r.filepath, r.resolution_x, r.resolution_y, r.resolution_percentage, r.image_settings.file_format, r.image_settings.color_mode, r.use_file_extension, r.use_compositing, r.use_sequencer, r.use_border, r.use_crop_to_border, r.pixel_aspect_x, r.pixel_aspect_y)
    markers = [(m, m.camera) for m in s.timeline_markers if m.camera]
    window = bpy.context.window
    original_scene, original_view_layer = window.scene, window.view_layer
    fd, path = tempfile.mkstemp(suffix='.png')
    os.close(fd)
    try:
        # Blender copies the context frame when rendering an explicitly named
        # non-active scene. Establish the target context before setting its frame.
        window.scene = s
        for marker, original_camera in markers: marker.camera = None
        s.frame_set(binding['frame'])
        s.camera = camera
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
        try:
            status = bpy.ops.render.render(write_still=True, scene=s.name)
            if 'FINISHED' not in status: raise RuntimeError('Blender did not finish the render')
            with open(path, 'rb') as f: image_bytes = f.read()
            if len(image_bytes) < 24 or not image_bytes.startswith(bytes([137,80,78,71,13,10,26,10])): raise RuntimeError('Blender did not produce a PNG')
            image = base64.b64encode(image_bytes).decode('ascii')
            result = {'ok': True, 'png': image, 'width': 640, 'height': 360, 'binding': binding}
        except Exception as error:
            result = {'ok': False, 'error': 'Render failed: ' + str(error)[:400]}
    finally:
        original_camera, frame, subframe, r.filepath, r.resolution_x, r.resolution_y, r.resolution_percentage, r.image_settings.file_format, r.image_settings.color_mode, r.use_file_extension, r.use_compositing, r.use_sequencer, r.use_border, r.use_crop_to_border, r.pixel_aspect_x, r.pixel_aspect_y = old
        s.frame_set(frame, subframe=subframe)
        for marker, marker_camera in markers: marker.camera = marker_camera
        s.camera = original_camera
        window.scene = original_scene
        window.view_layer = original_view_layer
        if os.path.exists(path): os.unlink(path)
    return result
${print('previs_render()')}
`;
}
