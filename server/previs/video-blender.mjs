// Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
import { assertFrameStage, videoOptions, VIDEO_LIMITS } from './video.mjs';

/** Fixed MCP script only. Parent persists its operation receipt before dispatch.
 * Each inclusive source frame becomes one PNG. Output FPS controls playback only;
 * binding.fps remains the source FPS for stale checks. Never saves the source file.
 */
export function animationCode(binding, options) {
  if (!binding || binding.source !== 'blender' || ['file', 'scene', 'camera'].some(key => typeof binding[key] !== 'string' || !binding[key]) || !Number.isFinite(binding.fps) || binding.fps <= 0 || !Number.isInteger(binding.start) || !Number.isInteger(binding.end) || Math.abs(binding.start) > 1048574 || Math.abs(binding.end) > 1048574 || !Number.isInteger(binding.frame) || binding.frame < binding.start || binding.frame > binding.end) throw Error('An exact saved Blender shot binding is required');
  const normalized = videoOptions({ ...options, frameCount: binding.end - binding.start + 1 });
  const stage = assertFrameStage(options.outputDir, { ...normalized, outputPath: options.outputPath });
  return `import bpy, json, os, struct
binding = json.loads(${JSON.stringify(JSON.stringify(binding))})
output = json.loads(${JSON.stringify(JSON.stringify({ ...normalized, outputDir: stage.directory, maxFrameBytes: VIDEO_LIMITS.maxFrameBytes }))})
def previs_animation():
    if bpy.data.filepath != binding['file']: return {'ok': False, 'error': 'Blender file changed; refresh and rebind the shot'}
    s = bpy.data.scenes.get(binding['scene'])
    if s is None: return {'ok': False, 'error': 'Scene missing; refresh and rebind'}
    camera = s.objects.get(binding['camera'])
    if camera is None or camera.type != 'CAMERA': return {'ok': False, 'error': 'Camera missing or renamed; refresh and rebind'}
    if abs(s.render.fps / s.render.fps_base - binding['fps']) > 0.000000001: return {'ok': False, 'error': 'Scene FPS changed; refresh and rebind'}
    if binding['start'] < s.frame_start or binding['end'] > s.frame_end: return {'ok': False, 'error': 'Frame range changed; refresh and rebind'}
    directory = output['outputDir']
    if not os.path.isdir(directory) or os.path.islink(directory) or os.path.realpath(directory) != directory or os.listdir(directory): return {'ok': False, 'error': 'Video stage must be an empty server-created local directory'}
    window = bpy.context.window
    if window is None: return {'ok': False, 'error': 'A Blender GUI window is required'}
    r = s.render
    settings = {'filepath': r.filepath, 'resolution_x': r.resolution_x, 'resolution_y': r.resolution_y, 'resolution_percentage': r.resolution_percentage, 'use_file_extension': r.use_file_extension, 'use_compositing': r.use_compositing, 'use_sequencer': r.use_sequencer, 'use_border': r.use_border, 'use_crop_to_border': r.use_crop_to_border, 'pixel_aspect_x': r.pixel_aspect_x, 'pixel_aspect_y': r.pixel_aspect_y, 'use_multiview': r.use_multiview, 'use_stamp': r.use_stamp, 'use_overwrite': r.use_overwrite, 'use_placeholder': r.use_placeholder}
    image_settings = {'file_format': r.image_settings.file_format, 'color_mode': r.image_settings.color_mode, 'color_depth': r.image_settings.color_depth, 'compression': r.image_settings.compression}
    original_camera, frame, subframe = s.camera, s.frame_current, s.frame_subframe
    original_scene, original_view_layer = window.scene, window.view_layer
    original_frame, original_subframe, original_active_camera = original_scene.frame_current, original_scene.frame_subframe, original_scene.camera
    markers = [(m, m.camera) for m in s.timeline_markers]
    try:
        # Establish target context BEFORE frame_set: rendering a named inactive
        # scene otherwise inherits the active scene's frame in Blender.
        window.scene = s
        for marker, marker_camera in markers: marker.camera = None
        r.resolution_x, r.resolution_y, r.resolution_percentage = output['width'], output['height'], 100
        r.image_settings.file_format, r.image_settings.color_mode = 'PNG', 'RGB'
        r.image_settings.color_depth, r.image_settings.compression = '8', 15
        r.use_file_extension = True
        r.use_compositing = r.use_sequencer = r.use_border = r.use_crop_to_border = False
        r.use_multiview = r.use_stamp = r.use_overwrite = r.use_placeholder = False
        r.pixel_aspect_x = r.pixel_aspect_y = 1
        camera_lenses = []
        for index, source_frame in enumerate(range(binding['start'], binding['end'] + 1)):
            path = os.path.join(directory, 'frame-%06d.png' % index)
            if os.path.lexists(path): raise RuntimeError('Frame output already exists')
            s.frame_set(source_frame, subframe=0.0)
            s.camera = camera
            camera_lenses.append({'frame': source_frame, 'type': camera.data.type, 'mm': camera.data.lens if camera.data.type == 'PERSP' else None, 'sensorWidth': camera.data.sensor_width, 'sensorHeight': camera.data.sensor_height, 'sensorFit': camera.data.sensor_fit, 'orthoScale': camera.data.ortho_scale})
            r.filepath = path
            status = bpy.ops.render.render(write_still=True, scene=s.name)
            if 'FINISHED' not in status: raise RuntimeError('Blender did not finish the render')
            if os.path.islink(path) or not os.path.isfile(path) or not 33 <= os.path.getsize(path) <= output['maxFrameBytes']: raise RuntimeError('Blender did not produce a bounded PNG frame')
            with open(path, 'rb') as f: header = f.read(24)
            if header[:8] != bytes([137,80,78,71,13,10,26,10]) or header[12:16] != b'IHDR' or struct.unpack('>II', header[16:24]) != (output['width'], output['height']): raise RuntimeError('Blender produced unexpected frame dimensions')
        result = {'ok': True, 'binding': binding, 'width': output['width'], 'height': output['height'], 'fps': output['fps'], 'fpsRational': output['fpsRational'], 'frameCount': output['frameCount'], 'duration': output['duration'], 'sourceFps': binding['fps'], 'sampling': 'one-output-frame-per-source-frame', 'fileSaved': False, 'cameraLenses': camera_lenses}
    except Exception as error:
        result = {'ok': False, 'error': 'Animation render failed: ' + str(error)[:400]}
    finally:
        # Attempt every restore even when one fails. A restore failure raises to
        # MCP so its durable operation must be treated as uncertain, not retried.
        restore_errors = []
        def restore(action):
            try: action()
            except Exception as error: restore_errors.append(str(error)[:200])
        for key, value in settings.items(): restore(lambda key=key, value=value: setattr(r, key, value))
        for key, value in image_settings.items(): restore(lambda key=key, value=value: setattr(r.image_settings, key, value))
        restore(lambda: s.frame_set(frame, subframe=subframe))
        for marker, marker_camera in markers: restore(lambda marker=marker, marker_camera=marker_camera: setattr(marker, 'camera', marker_camera))
        restore(lambda: setattr(s, 'camera', original_camera))
        restore(lambda: setattr(window, 'scene', original_scene))
        restore(lambda: setattr(window, 'view_layer', original_view_layer))
        if original_scene != s:
            restore(lambda: original_scene.frame_set(original_frame, subframe=original_subframe))
            restore(lambda: setattr(original_scene, 'camera', original_active_camera))
        if restore_errors: raise RuntimeError('Video state restoration failed; inspect Blender: ' + '; '.join(restore_errors))
    result['stateRestored'] = True
    return result
print('PREVIS_JSON:' + json.dumps(previs_animation()))
`;
}
