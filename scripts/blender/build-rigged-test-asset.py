# Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
# Test fixture for docs/import.md: a small rigged humanoid (Mixamo-style bone names, an A-pose, one skinned mesh and a
# "Wave" action) exported as FBX, USDZ and OBJ. Run headless; nothing is saved to a .blend:
#   blender -b --factory-startup --python scripts/blender/build-rigged-test-asset.py -- --out /abs/folder
import math
import sys
import bpy

out = sys.argv[sys.argv.index('--') + 1:][1] if '--out' in sys.argv else None
if not out:
    raise SystemExit('usage: … -- --out /abs/folder')

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = 24

# Blender is Z-up: x = the figure's left side, z = up, -y = its front.
A = math.sqrt(0.5)
BONES = [
    ('Hips', None, (0, 0, 1.0), (0, 0, 1.12)), ('Spine', 'Hips', (0, 0, 1.12), (0, 0, 1.5)), ('Neck', 'Spine', (0, 0, 1.5), (0, 0, 1.6)), ('Head', 'Neck', (0, 0, 1.6), (0, 0, 1.8)),
    ('LeftArm', 'Spine', (0.18, 0, 1.45), (0.18 + 0.28 * A, 0, 1.45 - 0.28 * A)), ('LeftForeArm', 'LeftArm', (0.18 + 0.28 * A, 0, 1.45 - 0.28 * A), (0.18 + 0.54 * A, 0, 1.45 - 0.54 * A)), ('LeftHand', 'LeftForeArm', (0.18 + 0.54 * A, 0, 1.45 - 0.54 * A), (0.18 + 0.62 * A, 0, 1.45 - 0.62 * A)),
    ('RightArm', 'Spine', (-0.18, 0, 1.45), (-0.18 - 0.28 * A, 0, 1.45 - 0.28 * A)), ('RightForeArm', 'RightArm', (-0.18 - 0.28 * A, 0, 1.45 - 0.28 * A), (-0.18 - 0.54 * A, 0, 1.45 - 0.54 * A)), ('RightHand', 'RightForeArm', (-0.18 - 0.54 * A, 0, 1.45 - 0.54 * A), (-0.18 - 0.62 * A, 0, 1.45 - 0.62 * A)),
    ('LeftUpLeg', 'Hips', (0.1, 0, 0.95), (0.1, 0, 0.52)), ('LeftLeg', 'LeftUpLeg', (0.1, 0, 0.52), (0.1, 0, 0.08)), ('LeftFoot', 'LeftLeg', (0.1, 0, 0.08), (0.1, -0.12, 0.02)),
    ('RightUpLeg', 'Hips', (-0.1, 0, 0.95), (-0.1, 0, 0.52)), ('RightLeg', 'RightUpLeg', (-0.1, 0, 0.52), (-0.1, 0, 0.08)), ('RightFoot', 'RightLeg', (-0.1, 0, 0.08), (-0.1, -0.12, 0.02)),
]
arm_data = bpy.data.armatures.new('Armature')
rig = bpy.data.objects.new('Armature', arm_data)
scene.collection.objects.link(rig)
bpy.context.view_layer.objects.active = rig
bpy.ops.object.mode_set(mode='EDIT')
for name, parent, head, tail in BONES:
    b = arm_data.edit_bones.new(f'mixamorig:{name}')
    b.head, b.tail = head, tail
    if parent:
        b.parent = arm_data.edit_bones[f'mixamorig:{parent}']
bpy.ops.object.mode_set(mode='OBJECT')

# One box per bone, rigidly weighted to it.
verts, faces, groups = [], [], []
for name, _, head, tail in BONES:
    hx, hy, hz = head
    tx, ty, tz = tail
    base = len(verts)
    for (x, y, z) in [(hx, hy, hz), (tx, ty, tz)]:
        for dx, dy in [(-0.04, -0.04), (0.04, -0.04), (0.04, 0.04), (-0.04, 0.04)]:
            verts.append((x + dx, y + dy, z))
    faces += [(base + a, base + b, base + c, base + d) for a, b, c, d in [(0, 1, 2, 3), (4, 7, 6, 5), (0, 4, 5, 1), (1, 5, 6, 2), (2, 6, 7, 3), (3, 7, 4, 0)]]
    groups.append((f'mixamorig:{name}', list(range(base, base + 8))))
mesh = bpy.data.meshes.new('Figure')
mesh.from_pydata(verts, [], faces)
body = bpy.data.objects.new('Figure', mesh)
scene.collection.objects.link(body)
for name, idx in groups:
    body.vertex_groups.new(name=name).add(idx, 1.0, 'REPLACE')
body.parent = rig
body.modifiers.new('Armature', 'ARMATURE').object = rig
mat = bpy.data.materials.new('Skin')
mat.diffuse_color = (0.8, 0.5, 0.3, 1)
mesh.materials.append(mat)

# A one-second wave of the right forearm.
rig.animation_data_create()
rig.animation_data.action = bpy.data.actions.new('Wave')
pb = rig.pose.bones['mixamorig:RightForeArm']
pb.rotation_mode = 'XYZ'
for frame, angle in [(1, 0), (13, -60), (25, 0)]:
    pb.rotation_euler = (0, math.radians(angle), 0)
    pb.keyframe_insert('rotation_euler', frame=frame)
scene.frame_start, scene.frame_end = 1, 25

bpy.ops.object.select_all(action='SELECT')
bpy.ops.export_scene.fbx(filepath=f'{out}/figure.fbx', add_leaf_bones=False, bake_anim=True, bake_anim_use_all_actions=False, bake_anim_use_nla_strips=False)
bpy.ops.wm.usd_export(filepath=f'{out}/figure.usdz')
bpy.ops.wm.obj_export(filepath=f'{out}/figure.obj')
print('PREVIS_FIXTURE_OK')
