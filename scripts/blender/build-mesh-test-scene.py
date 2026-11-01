# Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
"""Free local geometry acceptance scene. blender -b --python this.py -- --out /absolute/folder"""
import bpy, math, os, sys
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
out = args[args.index('--out') + 1]
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 24
scene.frame_start, scene.frame_end = 1, 12
scene.render.engine = 'BLENDER_WORKBENCH'
scene.display.shading.color_type = 'MATERIAL'
scene.display.shading.light = 'STUDIO'
scene.display.shading.show_shadows = True
scene.world = bpy.data.worlds.new('World')

def finish(name, color):
    ob = bpy.context.object
    ob.name = 'cast:' + name
    ob['previs_shape'] = 'box'
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    ob.data.materials.append(mat)
    return ob

bpy.ops.mesh.primitive_monkey_add(location=(-2.0, 0, 1.25))
monkey = finish('Suzanne', (0.12, 0.45, 0.8))
monkey['previs_shape'] = 'person'
monkey.rotation_euler = (0.12, -0.18, 0.3)
monkey.scale = (1.1, 0.8, 1.15)
modifier = monkey.modifiers.new('Smooth source', 'SUBSURF'); modifier.levels = 3
bpy.ops.mesh.primitive_torus_add(major_segments=96, minor_segments=32, location=(1.5, 0, 1.3), rotation=(math.pi / 2, 0.12, 0.3))
torus = finish('Copper Ring', (0.9, 0.3, 0.06))
torus.keyframe_insert('location', frame=1)
torus.location.x += 0.35; torus.keyframe_insert('location', frame=12)
bpy.ops.mesh.primitive_cone_add(vertices=32, radius1=0.8, radius2=0.1, depth=2.3, location=(0, 2, 1.15))
finish('Gold Spire', (0.85, 0.65, 0.1))['previs_shape'] = 'cylinder'
bpy.ops.mesh.primitive_cube_add(size=1, location=(0, 0.6, -0.15), scale=(8, 5, 0.3))
stage = finish('Stage', (0.2, 0.23, 0.28)); stage.name = 'Stage'
cam_data = bpy.data.cameras.new('Mesh Camera'); cam_data.lens = 40
cam = bpy.data.objects.new('Mesh Camera', cam_data); scene.collection.objects.link(cam); scene.camera = cam
cam.location = (5, -12, 6)
cam.rotation_euler = (Vector((0, 0.6, 1)) - cam.location).to_track_quat('-Z', 'Y').to_euler()
scene.frame_set(1)
selected = '--selected' in args
if selected:
    for ob in scene.objects: ob.select_set(ob == monkey)
helper = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'previs_export.py')
exec(compile(open(helper).read(), helper, 'exec'), {'__name__': 'previs_export', 'PREVIS_EXPORT': {'out': out, 'size': '640x360', 'meshes': True, 'triangles': 2500, 'selected': selected}})

assert not any(ob.name.startswith('Previs export temporary') for ob in scene.objects)
assert scene.frame_current == 1
assert monkey.modifiers['Smooth source'].levels == 3
