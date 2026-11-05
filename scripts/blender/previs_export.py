# Copyright (c) 2026 Steven Bobyn. SPDX-License-Identifier: MIT
"""previs_export.py: export one Blender shot for video-lab (the "thin import").

Writes <out>/blender-previs.json (the sidecar, format "comfy-previs-blender-handoff" version 1) and
<out>/frames/frame-000000.png ... (one 24 fps PNG per frame, rendered through the shot camera).
video-lab reads that folder with `previs_director_import_blender`, POST /api/director/import-blender, or a zip of it
dropped on the home screen. See docs/blender-import.md.

Run it headless:
  blender -b scene.blend -P scripts/blender/previs_export.py -- --out /abs/shot1 \
      [--camera ShotCam] [--start 1 --end 96] [--fps24] [--size 1280x720|640x360] [--engine keep|workbench|eevee|cycles]
or from a running Blender (Blender MCP execute_blender_code, the Text Editor, the Python console):
  PREVIS_EXPORT = {'out': '/abs/shot1', 'camera': 'ShotCam', 'fps24': True}
  exec(open('/path/to/previs_export.py').read())

Tagging (all optional): name an object "cast:Comfy Car" (or set custom property previs_cast = 1) to make it cast;
custom properties previs_name, previs_shape (person, car, box, ...), previs_kind (character, vehicle, prop,
environment), previs_color ("#rrggbb"), previs_ignore = 1 (leave it out). Untagged meshes come in as set pieces.
The .blend file is never saved; render settings, the frame and the scene camera are restored afterwards.
"""
import bpy, json, math, os, re, sys, struct
from mathutils import Matrix
from mathutils import Vector
from bpy_extras.object_utils import world_to_camera_view

VERSION = 1
SHAPES = {'person', 'car', 'bird', 'box', 'table', 'chair', 'sphere', 'cylinder', 'lamp', 'building', 'wall', 'tree', 'rock'}
KINDS = {'character', 'vehicle', 'prop', 'environment'}
SHAPE_WORDS = [('car', 'car'), ('truck', 'car'), ('van', 'car'), ('person', 'person'), ('character', 'person'), ('man', 'person'), ('woman', 'person'), ('tree', 'tree'), ('rock', 'rock'), ('wall', 'wall'), ('building', 'building'), ('house', 'building'), ('table', 'table'), ('chair', 'chair'), ('lamp', 'lamp'), ('bird', 'bird'), ('sphere', 'sphere'), ('ball', 'sphere'), ('cylinder', 'cylinder')]
MAX_OBJECTS = 150


class ExportError(Exception):
    """A reason the shot cannot be exported. Raised, never SystemExit, so a running Blender (Blender MCP) stays open."""


def options():
    """argv after '--', else the PREVIS_EXPORT dict a caller set, else defaults."""
    o = {'out': None, 'camera': None, 'start': None, 'end': None, 'fps24': False, 'size': '1280x720', 'engine': 'keep', 'meshes': False, 'selected': False, 'triangles': 20000}
    given = globals().get('PREVIS_EXPORT')
    if isinstance(given, dict): o.update({k.replace('-', ''): v for k, v in given.items()})
    elif '--' in sys.argv:
        args = sys.argv[sys.argv.index('--') + 1:]
        i = 0
        while i < len(args):
            key = args[i].lstrip('-').replace('-', '')
            if key in ('fps24', 'meshes', 'selected'): o[key] = True; i += 1; continue
            if i + 1 >= len(args): raise ExportError(f'previs_export: {args[i]} needs a value')
            o[key] = args[i + 1]; i += 2
    if not o['out']: raise ExportError('previs_export: pass --out /absolute/folder (or PREVIS_EXPORT = {"out": ...})')
    if o['size'] not in ('1280x720', '640x360'): raise ExportError('previs_export: --size must be 1280x720 or 640x360 (the sizes video-lab plays)')
    for k in ('start', 'end'): o[k] = int(o[k]) if o[k] not in (None, '') else None
    o['triangles'] = int(o['triangles'])
    if not 4 <= o['triangles'] <= 20000: raise ExportError('previs_export: --triangles must be 4–20000')
    return o


def linear_to_srgb(c):
    c = max(0.0, min(1.0, c))
    return c * 12.92 if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def hex_of(ob):
    """previs_color, else the first material's base colour, else None (the importer uses the shape default)."""
    given = ob.get('previs_color')
    if isinstance(given, str) and re.fullmatch(r'#[0-9a-fA-F]{6}', given): return given.lower()
    for slot in ob.material_slots:
        m = slot.material
        if not m: continue
        rgba = m.diffuse_color
        if m.use_nodes and m.node_tree:
            bsdf = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            if bsdf: rgba = bsdf.inputs['Base Color'].default_value
        return '#' + ''.join('%02x' % round(linear_to_srgb(rgba[i]) * 255) for i in range(3))
    return None


def name_of(ob):
    name = str(ob.get('previs_name') or ob.name)
    return name.split(':', 1)[1].strip() or ob.name if name.lower().startswith('cast:') else name


def is_cast(ob): return ob.name.lower().startswith('cast:') or bool(ob.get('previs_cast'))


def shape_of(ob):
    given = ob.get('previs_shape')
    if isinstance(given, str) and given in SHAPES: return given
    words = re.findall(r'[a-z]+', name_of(ob).lower())
    return next((shape for word, shape in SHAPE_WORDS if word in words), 'box')


def yaw_of(m):
    """Degrees about +Z of the object's front (-Y, Blender's front view); falls back to +X when -Y is vertical."""
    r = m.to_3x3()
    front, side = -(r @ Vector((0, 1, 0))), r @ Vector((1, 0, 0))
    if math.hypot(front.x, front.y) >= math.hypot(side.x, side.y): return math.degrees(math.atan2(front.x, -front.y)) % 360
    return math.degrees(math.atan2(side.y, side.x)) % 360


def bounds_of(ob, dg):
    """Evaluated bounds in the object's yaw frame: bottom-centre position (world, Z-up), yaw and [w, h, d]."""
    ev = ob.evaluated_get(dg)
    m = ev.matrix_world
    yaw = yaw_of(m)
    a = math.radians(yaw)
    x_axis, y_axis = Vector((math.cos(a), math.sin(a), 0)), Vector((-math.sin(a), math.cos(a), 0))
    pts = [m @ Vector(c) for c in ev.bound_box]
    xs, ys, zs = [p.dot(x_axis) for p in pts], [p.dot(y_axis) for p in pts], [p.z for p in pts]
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    centre = x_axis * cx + y_axis * cy
    return {'position': [round(centre.x, 4), round(centre.y, 4), round(min(zs), 4)], 'yaw': round(yaw, 3), 'size': [round(max(xs) - min(xs), 4), round(max(zs) - min(zs), 4), round(max(ys) - min(ys), 4)]}


def coplanar_warnings(objects, dg, limit=6):
    """Pairs of objects with surfaces on one plane (same facing, within 1 mm, overlapping by 1 mm2 or more) and different
    colours: they z-fight in video-lab. The same check as shared/blockout-lint.mjs (rules: docs/blockout-modeling-rules.md).
    Two downward faces that are both the bottom of their objects (standing on one floor) are not reported."""
    tol, min_area = 0.001, 1e-6
    buckets, found = {}, {}
    def clip(subject, by):
        out = subject
        for i in range(len(by)):
            a, b = by[i], by[(i + 1) % len(by)]
            inside = lambda p: (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]) >= 0
            src, out = out, []
            for j in range(len(src)):
                p, q = src[j], src[(j + 1) % len(src)]
                if inside(p): out.append(p)
                if inside(p) != inside(q):
                    dx, dy, ex, ey = q[0] - p[0], q[1] - p[1], b[0] - a[0], b[1] - a[1]
                    den = ex * dy - ey * dx
                    t = (ey * (p[0] - a[0]) - ex * (p[1] - a[1])) / den if den else 0
                    out.append((p[0] + t * dx, p[1] + t * dy))
            if not out: break
        return out
    def area(poly): return abs(sum(poly[i][0] * poly[(i + 1) % len(poly)][1] - poly[(i + 1) % len(poly)][0] * poly[i][1] for i in range(len(poly)))) / 2
    for ob in objects:
        ev = ob.evaluated_get(dg)
        try: mesh = ev.to_mesh()
        except RuntimeError: continue
        try:
            m, look = ev.matrix_world, hex_of(ob) or '#808080'
            verts = [m @ v.co for v in mesh.vertices]
            if not verts: continue
            floor = min(v.z for v in verts)
            mesh.calc_loop_triangles()
            for tri in mesh.loop_triangles:
                vs = [verts[i] for i in tri.vertices]
                n = (vs[1] - vs[0]).cross(vs[2] - vs[0])
                if n.length < 2 * min_area / 100: continue
                n.normalize()
                u = n.orthogonal().normalized(); w = n.cross(u)
                p2 = [(v.dot(u), v.dot(w)) for v in vs]
                if (p2[1][0] - p2[0][0]) * (p2[2][1] - p2[0][1]) - (p2[2][0] - p2[0][0]) * (p2[1][1] - p2[0][1]) < 0: p2.reverse()
                d = n.dot(vs[0])
                base = n.z < -0.9999 and all(v.z <= floor + tol for v in vs)
                key = (round(n.x, 2), round(n.y, 2), round(n.z, 2))
                rec = (ob.name, look, n, d, vs, base)
                for k in (round(d / tol) - 1, round(d / tol), round(d / tol) + 1):
                    for other in buckets.get(key + (k,), ()):
                        if other[0] == ob.name or other[1] == look or (base and other[5]) or n.dot(other[2]) < 0.99996: continue
                        if any(abs(other[2].dot(v) - other[3]) > tol for v in vs): continue
                        q2 = [(v.dot(u), v.dot(w)) for v in other[4]]
                        if (q2[1][0] - q2[0][0]) * (q2[2][1] - q2[0][1]) - (q2[2][0] - q2[0][0]) * (q2[1][1] - q2[0][1]) < 0: q2.reverse()
                        a = area(clip(p2, q2))
                        if a >= min_area:
                            pair = tuple(sorted((ob.name, other[0])))
                            found[pair] = found.get(pair, 0) + a
                buckets.setdefault(key + (round(d / tol),), []).append(rec)
        finally: ev.to_mesh_clear()
    worst = sorted(found.items(), key=lambda x: -x[1])[:limit]
    return [f'"{name_of(bpy.data.objects[a])}" and "{name_of(bpy.data.objects[b])}" share a surface ({x:.2f} m2 on one plane): they will z-fight in video-lab. Never put two surfaces on the same plane: lift the decal or line 2 mm along its normal, or cut the overlap (video-lab lifts a thin static one 2 mm on import)' for (a, b), x in worst]


def camera_key(cam, f):
    cam = cam.evaluated_get(bpy.context.evaluated_depsgraph_get())  # constraints (Track To) and drivers applied
    m = cam.matrix_world
    r = m.to_3x3().normalized()
    fwd, up = -(r @ Vector((0, 0, 1))), r @ Vector((0, 1, 0))
    return {'frame': f, 'p': [round(v, 5) for v in m.translation], 'fwd': [round(v, 6) for v in fwd.normalized()], 'up': [round(v, 6) for v in up.normalized()], 'lens': round(cam.data.lens, 4)}


def roll_of(key):
    """Degrees the camera's up leans away from the world-up look-at video-lab uses."""
    fwd, up = Vector(key['fwd']), Vector(key['up'])
    right = fwd.cross(Vector((0, 0, 1)))
    if right.length < 1e-6: return 0.0
    level_up = right.normalized().cross(fwd).normalized()
    return math.degrees(math.atan2(up.dot(right.normalized()), up.dot(level_up)))


def checks(scene, cam, f, recs, width, height):
    """Landmarks Blender projects at frame f: up to two object centres in view plus one camera-relative point."""
    key = camera_key(cam, f)
    fwd, up = Vector(key['fwd']), Vector(key['up'])
    synthetic = Vector(key['p']) + fwd * 10 + fwd.cross(up).normalized() * 2.5 + up * 1.2
    def seen(point):
        v = world_to_camera_view(scene, cam, point)
        ok = v.z > 0.1 and 0.02 < v.x < 0.98 and 0.02 < v.y < 0.98
        return ok and {'frame': f, 'point': [round(c, 4) for c in point], 'px': [round(v.x * width, 2), round((1 - v.y) * height, 2)]}
    objects = [c for c in (seen(Vector(r['position']) + Vector((0, 0, r['size'][1] / 2))) for r in recs) if c]
    return objects[:2] + [c for c in [seen(synthetic)] if c]


def pick_engine(want):
    items = {i.identifier for i in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items}
    names = {'workbench': ['BLENDER_WORKBENCH'], 'eevee': ['BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'], 'cycles': ['CYCLES']}.get(str(want).lower(), [])
    return next((n for n in names if n in items), None)


def prepare_out(out):
    if not os.path.isabs(out): raise ExportError('previs_export: --out must be an absolute path')
    frames = os.path.join(out, 'frames')
    if os.path.isdir(out):
        # Re-exporting into an earlier export folder replaces it; anything else in the folder is refused.
        extra = [n for n in os.listdir(out) if n not in ('blender-previs.json', 'frames', 'meshes')]
        old = os.listdir(frames) if os.path.isdir(frames) else []
        if extra or any(not re.fullmatch(r'frame-\d{6}\.png', n) for n in old): raise ExportError(f'previs_export: {out} holds other files; choose an empty or new folder')
        mesh_dir = os.path.join(out, 'meshes')
        meshes = os.listdir(mesh_dir) if os.path.isdir(mesh_dir) else []
        if os.path.islink(out) or os.path.islink(frames) or os.path.islink(mesh_dir) or any(not re.fullmatch(r'object-\d{3}\.glb', n) for n in meshes): raise ExportError('previs_export: output must be a real export folder without links or other files')
        for n in meshes: os.remove(os.path.join(mesh_dir, n))
        for n in old: os.remove(os.path.join(frames, n))
        if os.path.exists(os.path.join(out, 'blender-previs.json')): os.remove(os.path.join(out, 'blender-previs.json'))
    os.makedirs(frames, exist_ok=True)
    return frames



def export_mesh(ob, dg, bounds, path, triangle_cap):
    """Bake evaluated first-frame geometry, decimate a temporary copy, write a bounded GLB without dependencies.

    Coordinates are unit yaw-aligned bounds, bottom-centred, Y-up. video-lab scales by its proxy base size then the
    entity scale. Baking world transforms first preserves parents, negative scale, pitch, roll and modifiers.
    """
    mesh = bpy.data.meshes.new_from_object(ob.evaluated_get(dg), depsgraph=dg)
    temp = bpy.data.objects.new('video-lab export temporary', mesh)
    bpy.context.scene.collection.objects.link(temp)
    try:
        mesh.transform(ob.evaluated_get(dg).matrix_world)
        # Remove the yaw and bottom-centre translation; leave pitch/roll baked into the actual vertices.
        yaw = Matrix.Rotation(-math.radians(bounds['yaw']), 4, 'Z')
        mesh.transform(yaw @ Matrix.Translation(-Vector(bounds['position'])))
        mesh.calc_loop_triangles()
        count = len(mesh.loop_triangles)
        if count > triangle_cap:
            decimate = temp.modifiers.new('video-lab triangle cap', 'DECIMATE')
            decimate.ratio = max(0.00001, triangle_cap / count * 0.95)
            decimate.use_collapse_triangulate = True
        ev = temp.evaluated_get(bpy.context.evaluated_depsgraph_get())
        final = ev.to_mesh()
        try:
            final.calc_loop_triangles()
            if len(final.loop_triangles) > triangle_cap: raise ExportError(f'{ob.name}: cannot decimate under {triangle_cap} triangles')
            w, h, d = [max(v, 0.0001) for v in bounds['size']]
            points, normals = [], []
            for tri in final.loop_triangles:
                vs = [Vector((final.vertices[i].co.x / w, final.vertices[i].co.z / h, -final.vertices[i].co.y / d)) for i in tri.vertices]
                normal = (vs[1] - vs[0]).cross(vs[2] - vs[0]).normalized()
                points.extend(vs); normals.extend([normal] * 3)
            if not points: raise ExportError(f'{ob.name}: mesh has no triangles')
            payload = b''.join(struct.pack('<3f', *v) for v in points + normals)
            # One plain colour keeps files small: textures, custom properties, scripts and animation never cross.
            rgba = (0.5, 0.5, 0.5, 1)
            for slot in ob.material_slots:
                if slot.material:
                    rgba = tuple(slot.material.diffuse_color)
                    if slot.material.use_nodes and slot.material.node_tree:
                        bsdf = next((n for n in slot.material.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
                        if bsdf: rgba = tuple(bsdf.inputs['Base Color'].default_value)
                    break
            size = len(points) * 12
            g = {'asset': {'version': '2.0', 'generator': 'video-lab'}, 'scene': 0,
                 'scenes': [{'nodes': [0]}], 'nodes': [{'mesh': 0}],
                 'meshes': [{'primitives': [{'attributes': {'POSITION': 0, 'NORMAL': 1}, 'material': 0, 'mode': 4}]}],
                 'materials': [{'pbrMetallicRoughness': {'baseColorFactor': [max(0, min(1, v)) for v in rgba], 'metallicFactor': 0, 'roughnessFactor': 0.8}, 'doubleSided': True}],
                 'buffers': [{'byteLength': len(payload)}],
                 'bufferViews': [{'buffer': 0, 'byteOffset': 0, 'byteLength': size}, {'buffer': 0, 'byteOffset': size, 'byteLength': size}],
                 'accessors': [{'bufferView': 0, 'componentType': 5126, 'count': len(points), 'type': 'VEC3', 'min': [min(v[i] for v in points) for i in range(3)], 'max': [max(v[i] for v in points) for i in range(3)]},
                               {'bufferView': 1, 'componentType': 5126, 'count': len(points), 'type': 'VEC3'}]}
            raw = json.dumps(g, separators=(',', ':')).encode()
            raw += b' ' * (-len(raw) % 4)
            data = struct.pack('<III', 0x46546c67, 2, 28 + len(raw) + len(payload)) + struct.pack('<II', len(raw), 0x4e4f534a) + raw + struct.pack('<II', len(payload), 0x004e4942) + payload
            if len(data) > 2 * 1024 ** 2: raise ExportError(f'{ob.name}: mesh exceeds 2 MB')
            with open(path, 'wb') as fh: fh.write(data)
            return len(points) // 3, len(data)
        finally: ev.to_mesh_clear()
    finally:
        bpy.data.objects.remove(temp, do_unlink=True)
        bpy.data.meshes.remove(mesh)


def main():
    o = options()
    scene = bpy.context.scene
    cam = scene.objects.get(o['camera']) if o['camera'] else scene.camera
    if cam is None or cam.type != 'CAMERA' or cam.data.type != 'PERSP': raise ExportError('previs_export: pick a perspective camera (--camera NAME or the scene camera)')
    r = scene.render
    fps0 = (r.fps, r.fps_base)
    if o['fps24']: r.fps, r.fps_base = 24, 1
    if abs(r.fps / r.fps_base - 24) > 1e-9: raise ExportError('previs_export: set the scene to 24 fps (or pass --fps24)')
    start, end = o['start'] or scene.frame_start, o['end'] or scene.frame_end
    n = end - start + 1
    if not 12 <= n <= 120: raise ExportError(f'previs_export: {n} frames; video-lab shots are 12-120 frames (0.5-5 s at 24 fps)')
    width, height = map(int, o['size'].split('x'))
    frames_dir = prepare_out(o['out'])
    out = os.path.realpath(o['out'])  # the path video-lab accepts (no symlinks, e.g. /private/tmp rather than /tmp)
    warnings = []
    if abs(scene.unit_settings.scale_length - 1) > 1e-6: warnings.append(f'Unit scale is {scene.unit_settings.scale_length}, not 1 m; sizes are read as metres')
    if abs(cam.data.shift_x) > 1e-4 or abs(cam.data.shift_y) > 1e-4: warnings.append('The camera uses lens shift; video-lab camera words and boxes ignore it')
    view_layer = bpy.context.view_layer
    objects = [ob for ob in scene.objects if ob.type == 'MESH' and not ob.hide_render and ob.name in view_layer.objects and not ob.get('previs_ignore') and (not o['selected'] or ob.select_get())]
    if len(objects) > MAX_OBJECTS:
        vol = lambda ob: math.prod(ob.dimensions) or sum(ob.dimensions)
        objects = sorted(objects, key=vol, reverse=True)[:MAX_OBJECTS]
        warnings.append(f'More than {MAX_OBJECTS} meshes; kept the {MAX_OBJECTS} largest')
    saved = {k: getattr(r, k) for k in ('filepath', 'resolution_x', 'resolution_y', 'resolution_percentage', 'pixel_aspect_x', 'pixel_aspect_y', 'use_border', 'use_crop_to_border', 'film_transparent', 'use_file_extension', 'engine')}
    saved_img = {k: getattr(r.image_settings, k) for k in ('media_type', 'file_format', 'color_mode', 'color_depth', 'compression') if hasattr(r.image_settings, k)}
    frame0, camera0 = scene.frame_current, scene.camera
    keys, recs, landmarks = [], {ob.name: [] for ob in objects}, []
    check_frames = {start, start + (n - 1) // 2, end}
    try:
        r.resolution_x, r.resolution_y, r.resolution_percentage = width, height, 100
        r.pixel_aspect_x = r.pixel_aspect_y = 1
        r.use_border = r.use_crop_to_border = r.film_transparent = False
        r.use_file_extension = True
        engine = pick_engine(o['engine'])
        if engine: r.engine = engine
        if 'media_type' in saved_img: r.image_settings.media_type = 'IMAGE'
        r.image_settings.file_format, r.image_settings.color_mode, r.image_settings.color_depth = 'PNG', 'RGB', '8'
        r.image_settings.compression = 90  # lossless; smaller handoffs and zips
        scene.camera = cam
        for i, f in enumerate(range(start, end + 1)):
            scene.frame_set(f)
            dg = bpy.context.evaluated_depsgraph_get()
            keys.append(camera_key(cam, f))
            now = {ob.name: bounds_of(ob, dg) for ob in objects}
            for name, b in now.items(): recs[name].append({'frame': f, **b})
            if f in check_frames: landmarks += checks(scene, cam, f, [b for b in now.values() if b['size'][1] >= 0.01], width, height)
            r.filepath = os.path.join(frames_dir, 'frame-%06d.png' % i)
            if 'FINISHED' not in bpy.ops.render.render(write_still=True): raise RuntimeError(f'Blender did not finish rendering frame {f}')
    finally:
        for k, v in saved.items(): setattr(r, k, v)
        for k, v in saved_img.items(): setattr(r.image_settings, k, v)
        r.fps, r.fps_base = fps0
        scene.camera = camera0
        scene.frame_set(frame0)
    flat, records = [], []
    for ob in objects:
        rows = recs[ob.name]
        if max(x['size'][1] for x in rows) < 0.01: flat.append(ob.name); continue
        a = rows[0]
        static = all(math.dist(x['position'], a['position']) <= 0.01 and abs((x['yaw'] - a['yaw'] + 180) % 360 - 180) <= 1 and all(abs(s - t) <= 0.01 * max(t, 0.01) for s, t in zip(x['size'], a['size'])) for x in rows)
        kind = ob.get('previs_kind')
        records.append({'name': name_of(ob), 'blenderName': ob.name, 'cast': is_cast(ob), 'shape': shape_of(ob), **({'kind': kind} if kind in KINDS else {}), **({'color': hex_of(ob)} if hex_of(ob) else {}), 'frames': [a] if static else rows})
    if flat: warnings.append(f'Left out {len(flat)} flat object(s) under 1 cm tall (ground planes): {", ".join(flat[:6])}')
    try:
        scene.frame_set(start)
        warnings += coplanar_warnings([scene.objects[x['blenderName']] for x in records], bpy.context.evaluated_depsgraph_get())
    finally: scene.frame_set(frame0)
    if o['meshes']:
        os.makedirs(os.path.join(out, 'meshes'), exist_ok=True)
        total_triangles, total_bytes = 0, 0
        try:
            scene.frame_set(start)
            for i, record in enumerate(records):
                path = 'meshes/object-%03d.glb' % i
                triangles, size = export_mesh(scene.objects[record['blenderName']], bpy.context.evaluated_depsgraph_get(), record['frames'][0], os.path.join(out, path), o['triangles'])
                total_triangles += triangles; total_bytes += size
                if total_triangles > 100000 or total_bytes > 32 * 1024 ** 2: raise ExportError('previs_export: meshes exceed 100000 triangles or 32 MB total; use --selected or lower --triangles')
                record['mesh'] = path
        finally: scene.frame_set(frame0)
        warnings.append('Viewport meshes are static first-frame shapes with one material; deformation stays in the Blender clip')
    rolls = [abs(roll_of(k)) for k in keys]
    if max(rolls) > 2: warnings.append(f'The camera rolls up to {max(rolls):.1f}°; the clip keeps it, video-lab camera words and boxes assume a level camera')
    if len({k['lens'] for k in keys}) > 1: warnings.append('The lens is animated; video-lab follows it per frame')
    sidecar = {
        'format': 'comfy-previs-blender-handoff', 'version': VERSION,
        'exporter': {'name': 'previs_export.py', 'version': VERSION, 'blender': bpy.app.version_string},
        'source': {'file': os.path.basename(bpy.data.filepath) or None, 'scene': scene.name, 'camera': cam.name, 'frameStart': start, 'frameEnd': end},
        'fps': 24, 'frameCount': n, 'width': width, 'height': height, 'axes': 'blender-z-up',
        'camera': {'sensorWidth': cam.data.sensor_width, 'sensorHeight': cam.data.sensor_height, 'sensorFit': cam.data.sensor_fit, 'keys': keys, 'checks': landmarks},
        'objects': records, 'warnings': warnings,
    }
    with open(os.path.join(out, 'blender-previs.json'), 'w') as fh: json.dump(sidecar, fh, indent=1)
    print(f'previs_export: wrote {n} frames and {len(records)} objects to {out}')
    for w in warnings: print('previs_export: warning:', w)
    return out


if isinstance(globals().get('PREVIS_EXPORT'), dict):
    main()  # inside Blender (MCP, Text Editor): an ExportError reaches the caller with its message
elif __name__ == '__main__':
    try: main()
    except ExportError as error:
        print(error, file=sys.stderr)
        sys.exit(1)  # blender -b -P: exit code 1 with the reason
