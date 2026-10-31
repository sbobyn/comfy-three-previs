# Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
"""Build the Blender import test scene from nothing and export it with previs_export.py.

  blender -b --factory-startup -P scripts/blender/build-test-scene.py -- --out /abs/folder \
      [--frames 12] [--size 640x360] [--fit AUTO|VERTICAL] [--lens 35] [--sensor 36] [--save /abs/scene.blend]

The scene: a flat ground plane (left out by the exporter), a crate, a rotated grandstand, a cast car driving across
the frame, a cast runner, and a camera on a Track To constraint that dollies and cranes down. Rendered with
Workbench so a 12-frame export takes seconds. tests/fixtures/blender-handoff/ was made with this script.
"""
import bpy, math, os, sys

args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
opt = {'out': None, 'frames': '12', 'size': '640x360', 'fit': 'AUTO', 'lens': '35', 'sensor': '36', 'save': None}
for i in range(0, len(args) - 1, 2): opt[args[i].lstrip('-')] = args[i + 1]
if not opt['out']: raise SystemExit('build-test-scene: pass --out /absolute/folder')
n = int(opt['frames'])

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps, scene.render.fps_base = 24, 1
scene.frame_start, scene.frame_end = 1, n
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.color_type = 'MATERIAL'
scene.display.render_aa = 'OFF'  # flat edges and no dither keep the committed fixture PNGs small
scene.render.dither_intensity = 0
world = bpy.data.worlds.new('World'); world.color = (0.55, 0.62, 0.72); scene.world = world


def material(name, rgb):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*rgb, 1)  # Workbench colour
    m.use_nodes = True
    bsdf = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if bsdf: bsdf.inputs['Base Color'].default_value = (*rgb, 1)  # what the exporter reads (EEVEE/Cycles colour)
    return m


def box(name, size, location, yaw=0.0, rgb=(0.6, 0.6, 0.6), **props):
    """A box whose bottom sits at location.z; size = (x, y, z) extents in metres before rotation."""
    bpy.ops.mesh.primitive_cube_add(size=1, location=(location[0], location[1], location[2] + size[2] / 2))
    ob = bpy.context.active_object
    ob.name = name
    ob.scale = size
    ob.rotation_euler = (0, 0, math.radians(yaw))
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    ob.data.materials.append(material(name + ' mat', rgb))
    for k, v in props.items(): ob[k] = v
    return ob


bpy.ops.mesh.primitive_plane_add(size=60, location=(0, 0, 0)); bpy.context.active_object.name = 'Ground'
box('Crate', (1, 1, 1), (3, 2, 0), rgb=(0.8, 0.2, 0.15))
box('Grandstand', (10, 2.5, 3), (-4, 10, 0), yaw=20, rgb=(0.35, 0.37, 0.43), previs_shape='building')
# The car's nose is Blender -Y (its front view); it drives along +X+Y, so its yaw is atan2(dx, -dy).
car = box('cast:Comfy Car', (1.9, 4.5, 1.45), (-6, -2, 0), yaw=math.degrees(math.atan2(10, -6)), rgb=(0.11, 0.3, 0.85))
car.keyframe_insert('location', frame=1)
car.location = (4, 4, car.location.z); car.keyframe_insert('location', frame=n)
for fc in (car.animation_data.action.fcurves if hasattr(car.animation_data.action, 'fcurves') else []):
    for k in fc.keyframe_points: k.interpolation = 'LINEAR'
box('cast:Runner', (0.5, 0.35, 1.8), (1.5, -1, 0), yaw=200, rgb=(0.9, 0.7, 0.3), previs_shape='person')

target = bpy.data.objects.new('Aim', None); scene.collection.objects.link(target); target.location = (0, 1, 0.8)
cam_data = bpy.data.cameras.new('ShotCam')
cam_data.lens, cam_data.sensor_width, cam_data.sensor_fit = float(opt['lens']), float(opt['sensor']), opt['fit']
cam_data.sensor_height = 24
cam = bpy.data.objects.new('ShotCam', cam_data); scene.collection.objects.link(cam); scene.camera = cam
cam.location = (-10, -16, 5); cam.keyframe_insert('location', frame=1)
cam.location = (-6, -12, 2.5); cam.keyframe_insert('location', frame=n)
track = cam.constraints.new('TRACK_TO'); track.target = target; track.track_axis = 'TRACK_NEGATIVE_Z'; track.up_axis = 'UP_Y'

if opt['save']: bpy.ops.wm.save_as_mainfile(filepath=opt['save'])
helper = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'previs_export.py')
try: exec(compile(open(helper).read(), helper, 'exec'), {'__name__': 'previs_export', 'PREVIS_EXPORT': {'out': opt['out'], 'size': opt['size']}})
except Exception as error:  # previs_export's ExportError: report it and fail the run
    print(error, file=sys.stderr)
    sys.exit(1)
