"""Rebuild bundled, texture-free GLBs: blender -b --python scripts/blender/generate-blockouts.py.
Geometry helpers use Previs metres (Y up, +Z forward, bottom-centre pivot).
Blender stores (x,-z,y); glTF's standard Y-up export restores the Previs axes.
Run from the repository root with Node 22+ on PATH (terrain samples share the app's heightfield).
"""
import bpy
import json
import os
import math
import subprocess
import struct
import sys
from pathlib import Path
from mathutils import Vector, Matrix

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / 'public/models/blockouts'
OUT.mkdir(parents=True, exist_ok=True)
materials = {}
colors = {}

def mat(name, color):
    colors[name] = color
    if name not in materials:
        m = bpy.data.materials.new(name)
        rgb = tuple(int(color[i:i+2], 16) / 255 for i in (1, 3, 5))
        # Blender node colours are linear; the palette is sRGB like Three.Color(hex).
        rgb = tuple(c / 12.92 if c <= .04045 else ((c + .055) / 1.055) ** 2.4 for c in rgb)
        m.diffuse_color = (*rgb, 1)
        m.use_nodes = True
        p = m.node_tree.nodes.get('Principled BSDF')
        p.inputs['Base Color'].default_value = (*rgb, 1)
        p.inputs['Roughness'].default_value = .85
        materials[name] = m
    return materials[name]

BODY = mat('entity-color', '#ffffff')  # tinted to the scene entity colour by the loader
DARK = mat('charcoal', '#202932')
WHITE = mat('ivory', '#e9e8dc')
GLASS = mat('glass-blue', '#52788e')
SKIN = mat('skin', '#b87851')
GOLD = mat('gold', '#f6c544')
WOOD = mat('bark', '#594334')
LEAF = mat('pine-shadow', '#244532')
ORANGE = mat('rim-orange', '#e57b2a')

# Never two surfaces on one plane (docs/blockout-modeling-rules.md). A decal, line or inset panel is lifted DECAL metres
# off the surface under it, measured at the smallest scale the starters show the model, so the gap survives
# non-uniform entity scales (a 5 cm court slab, a 6 cm backboard). Decal materials end in '-decal': the viewer gives
# them polygonOffset and no shadow casting. shared/blockout-lint.mjs checks every GLB and starter for overlaps.
DECAL = .003
def decal(material): return mat(material.name + '-decal', colors[material.name])
def starter_scales():
    out = {}
    for f in sorted((ROOT / 'examples/starters').glob('*/starter.json')):
        for e in json.loads(f.read_text())['scene']['entities']:
            if e.get('model'): out[e['model']] = [min(a, b) for a, b in zip(out.get(e['model'], [1e9] * 3), e['scale'])]
    return out
SCALES = starter_scales()
current = None
def gap(axis):
    # Model units for DECAL metres along Previs axis 0/1/2 of the model being built (never below DECAL itself).
    world = [s * (SIZES[BUILDERS[current][0]][i] if current in UNIT_CUBE else 1) for i, s in enumerate(SCALES.get(current, [1, 1, 1]))]
    return DECAL / min(1, world[axis])

def xyz(p): return (p[0], -p[2], p[1])
created = []  # mesh objects in creation order, for names that never depend on Blender's auto-numbering
def finish(o, material):
    o.data.materials.append(material)
    created.append(o)
    return o

def box(p, s, material=BODY, bevel=0):
    bpy.ops.mesh.primitive_cube_add(size=1, location=xyz(p))
    o = bpy.context.object
    o.scale = (s[0], s[2], s[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        m = o.modifiers.new('corner cuts', 'BEVEL'); m.width = bevel; m.segments = 1
        bpy.ops.object.modifier_apply(modifier=m.name)
    return finish(o, material)

def ellipsoid(p, s, material=BODY, segments=12, rings=6):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=rings, radius=1, location=xyz(p))
    o = bpy.context.object; o.scale = (s[0], s[2], s[1])
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    return finish(o, material)

def rod(a, b, r, material=BODY, r2=None, sides=8):
    av, bv = Vector(xyz(a)), Vector(xyz(b)); v = bv-av
    bpy.ops.mesh.primitive_cone_add(vertices=sides, radius1=r, radius2=r if r2 is None else r2, depth=v.length, location=(av+bv)/2)
    o = bpy.context.object; o.rotation_euler = v.to_track_quat('Z','Y').to_euler()
    return finish(o, material)

def mesh(verts, faces, material=BODY):
    data = bpy.data.meshes.new('faceted'); data.from_pydata([xyz(v) for v in verts], [], faces); data.update()
    o = bpy.data.objects.new('faceted', data); bpy.context.collection.objects.link(o)
    return finish(o, material)

def ring(p, radius, tube, material=WHITE, axis='y', segments=24):
    bpy.ops.mesh.primitive_torus_add(major_segments=segments, minor_segments=4, location=xyz(p), major_radius=radius, minor_radius=tube)
    o = bpy.context.object
    if axis == 'x': o.rotation_euler[1] = math.pi/2
    if axis == 'z': o.rotation_euler[0] = math.pi/2
    return finish(o, material)

def joint(name, pivot, objects, parent=None):
    node = bpy.data.objects.new('joint_' + name, None)
    bpy.context.collection.objects.link(node)
    node.location = xyz(pivot)
    bpy.context.view_layer.update()
    for obj in sorted(objects, key=lambda o:o.name):
        world = obj.matrix_world.copy()
        obj.parent = node
        obj.matrix_world = world
    if parent:
        world = node.matrix_world.copy()
        node.parent = parent
        node.matrix_world = world
    return node

def human(role):
    # Rigid limbs articulated at anatomical pivots; neutral bounds retain the original proxy.
    sports = role == 'player'
    body = joint('body', (0,.94,0), [])
    for side, label in [(-1,'L'),(1,'R')]:
        x = side*.105
        foot = box((x,.065,.035),(.14,.13,.28),DARK,.025)
        shin = rod((x,.15,0),(x,.59,-.025),.064,SKIN if sports else BODY,r2=.07)
        thigh = rod((x,.59,-.025),(x,.94,0),.07,BODY,r2=.085)
        upper = joint('thigh'+label,(x,.94,0),[thigh],body)
        parts = [foot,shin]
        if sports: parts.append(box((x,.24,.065),(.105,.16,.03),WHITE))
        joint('shin'+label,(x,.59,-.025),parts,upper)
    before=set(bpy.context.scene.objects)
    box((0,.93,0),(.33,.23,.23),BODY,.045)
    mesh([(-.16,1, -.11),(.16,1,-.11),(.20,1.43,-.09),(-.20,1.43,-.09),(-.16,1,.12),(.16,1,.12),(.20,1.43,.10),(-.20,1.43,.10)],[(0,3,2,1),(4,5,6,7),(0,1,5,4),(3,7,6,2),(0,4,7,3),(1,2,6,5)])
    rod((0,1.40,0),(0,1.53,0),.065,SKIN)
    if sports:
        box((0,1.12,.123),(.29,.045,.008),decal(GOLD))
        box((0,1.31,.117),(.065,.13,.008),decal(WHITE))
    if role == 'anchor':
        mesh([(-.10,1.43,.105),(.10,1.43,.105),(0,1.17,.13)],[(0,2,1)],WHITE)
        box((0,1.31,.137),(.035,.18,.012),GOLD)
    for obj in sorted(set(bpy.context.scene.objects)-before, key=lambda o:o.name):
        world=obj.matrix_world.copy(); obj.parent=body; obj.matrix_world=world
    before=set(bpy.context.scene.objects)
    ellipsoid((0,1.64,.005),(.12,.16,.125),SKIN)
    ellipsoid((0,1.735,-.015),(.12,.065,.105),DARK)
    box((0,1.63,.128),(.045,.055,.045),SKIN,.008)
    joint('head',(0,1.50,0),set(bpy.context.scene.objects)-before,body)
    for side,label in [(-1,'L'),(1,'R')]:
        shoulder=(side*.19,1.38,0); elbow=(side*.205,1.14,.02)
        hand=(side*.19,1.0,.10)
        if role == 'fan': elbow=(side*.20,1.32,.08); hand=(side*.16,1.50,.12)
        if role == 'operator': hand=(side*.17,1.18,.13)
        upper=joint('arm'+label,shoulder,[rod(shoulder,elbow,.048,SKIN if sports else BODY)],body)
        joint('forearm'+label,elbow,[rod(elbow,hand,.041,SKIN if sports else BODY),ellipsoid(hand,(.044,.055,.04),SKIN,8,4)],upper)
    if role == 'fan': box((0,1.51,.14),(.18,.10,.035),DARK,.01)

def car():
    box((0,.56,0),(1.77,.56,4.42),BODY,.14)
    box((0,.85,1.25),(1.65,.20,1.6),BODY,.07)
    # Sloping windscreen and roof, plus inset dark windows.
    mesh([(-.82,.77,-1.3),(.82,.77,-1.3),(.64,1.39,-.8),(-.64,1.39,-.8),(-.82,.77,1.0),(.82,.77,1.0),(.64,1.39,.45),(-.64,1.39,.45)],[(0,3,2,1),(4,5,6,7),(3,7,6,2),(0,4,7,3),(1,2,6,5)],GLASS)
    box((0,1.41,-.17),(1.32,.08,1.30),BODY,.04)
    for side in (-1,1):
        box((side*.79,1.07,-.22),(.06,.58,.10),BODY)
        for z in (-1.38,1.40):
            label = ('F' if z > 0 else 'R') + ('L' if side < 0 else 'R')
            tire = rod((side*.72,.36,z),(side*.95,.36,z),.36,DARK,sides=16)
            hub = rod((side*.951,.36,z),(side*.955,.36,z),.19,WHITE,sides=10)
            # A spoke makes rotation readable at 24 fps without a texture.
            spoke = box((side*.958,.36,z),(.004,.29,.035),GOLD)
            spin = joint('wheel'+label,(side*.84,.36,z),[tire,hub,spoke])
            if z > 0: joint('steer'+('L' if side < 0 else 'R'),(side*.84,.36,z),[spin])
        box((side*.55,.67,2.17),(.43,.15,.05),WHITE,.02)
        box((side*.55,.66,-2.19-gap(2)),(.44,.12,.04),ORANGE)  # proud of the tail, not flush with it
    box((0,.42,2.23),(1.62,.11,.04),DARK)
    box((0,.65,2.205),(.54,.12,.02),DARK)
    box((0,.94,1.33),(.24,.025,1.53),decal(GOLD))
    box((0,1.456,-.18),(.24,.012,1.18),decal(GOLD))
    for x in (-.55,.55): box((x,.97,-1.94),(.07,.27,.10),DARK)
    box((0,1.12,-1.96),(1.8,.08,.36),DARK,.015)

    joint('body',(0,.55,0),[o for o in bpy.context.scene.objects if o.type == 'MESH' and not o.parent])

def solid(verts, faces, material=BODY):
    # A closed faceted mesh with outward normals (wings and tail have thickness, so they shade like feathered surfaces).
    o = mesh(verts, faces, material)
    import bmesh
    bm = bmesh.new(); bm.from_mesh(o.data); bmesh.ops.recalc_face_normals(bm, faces=bm.faces); bm.to_mesh(o.data); bm.free(); o.data.update()
    return o

def strip(stations, material=BODY):
    # Lofted aerofoil: each station is (x, y, leading z, trailing z, thickness); a thick rounded leading edge, a thin trailing edge.
    v, f = [], []
    for x, y, zl, zt, t in stations:
        c = zl - zt
        v += [(x, y + t, zl - .10*c), (x, y - t*.45, zl - .04*c), (x, y + t*.55, zt + .45*c), (x, y - .004, zt)]
    n = len(stations)
    for i in range(n-1):
        a, b = 4*i, 4*i+4
        f += [(a, b, b+2, a+2), (a+2, b+2, b+3, a+3), (a+3, b+3, b+1, a+1), (a+1, b+1, b, a)]
    f += [(0, 2, 3, 1), (4*n-4, 4*n-3, 4*n-1, 4*n-2)]
    return solid(v, f, material)

def eagle():
    # Soaring glide at rest: broad arm wings set high on the body with a slight dihedral, a hand of six splayed, up-curled
    # primaries ("fingers"), a fanned white tail and talons tucked under it. Joints: wing at the shoulder, tip at the wrist,
    # tail at its base. The proxy is 2.4 x 0.5 x 1.1 m, so the curl and the tucked talons fill its height instead of a
    # vertical stretch (which would steepen every wing angle).
    ellipsoid((0,.20,0),(.12,.10,.34),BODY,16,8)
    ellipsoid((0,.232,.27),(.10,.092,.15),WHITE,12,6)
    ellipsoid((0,.262,.375),(.08,.08,.115),WHITE,12,6)
    rod((0,.262,.46),(0,.242,.56),.038,GOLD,r2=.012,sides=6)
    rod((0,.248,.553),(0,.222,.566),.013,GOLD,r2=.004,sides=6)
    for side in (-1,1):
        L = 'L' if side < 0 else 'R'
        ellipsoid((side*.058,.287,.415),(.013,.014,.012),DARK,8,4)
        ellipsoid((side*.06,.14,-.12),(.045,.045,.10),BODY,10,5)
        rod((side*.055,.112,-.17),(side*.05,.10,-.285),.02,GOLD,r2=.012,sides=6)
        before=set(bpy.context.scene.objects)
        dh = math.tan(math.radians(5))
        arm = [(.07,.17,-.23),(.20,.20,-.31),(.34,.20,-.35),(.48,.19,-.355),(.62,.17,-.33)]
        strip([(side*x, .27 + (x-.07)*dh, zl, zt, .03 - .013*(x-.07)/.55) for x, zl, zt in arm])
        wy = .27 + .55*dh
        feathers=set(bpy.context.scene.objects)
        hand = [(.62,.17,-.33),(.75,.145,-.32),(.86,.10,-.29)]
        strip([(side*x, wy + (x-.62)*.08, zl, zt, .017 - .007*(x-.62)/.24) for x, zl, zt in hand], DARK)
        hy = wy + .24*.08
        # Primaries fan from the leading (most outward, slightly forward) to the trailing one, each a little lower than the
        # one in front, and bend upward toward their tips as they carry the load.
        for i,(ang,length) in enumerate([(13,.20),(5,.26),(-3,.29),(-11,.29),(-20,.26),(-30,.21)]):
            a = math.radians(ang); root = (.83 - .006*i, hy - .006*i, .07 - .062*i)
            ux, uz = math.cos(a), math.sin(a); nx, nz = -uz, ux
            w = .036 - .001*i
            def at(u, half, lift):
                return (side*(root[0] + ux*u*length + nx*half), root[1] + lift, root[2] + uz*u*length + nz*half)
            curl = lambda u: length*(.10*u + .30*u*u)
            v = [at(0, w, 0), at(0, -w, 0), at(.55, -w*.85, curl(.55)), at(.9, -w*.45, curl(.9)), at(1, 0, curl(1)), at(.9, w*.45, curl(.9)), at(.55, w*.85, curl(.55))]
            v += [(x, y-.006, z) for x, y, z in v]
            f = [(0,1,2,3,4,5,6), (13,12,11,10,9,8,7)] + [(k, (k+1)%7, (k+1)%7+7, k+7) for k in range(7)]
            solid(v, f, DARK)
        tip=joint('tip'+L,(side*.62,wy,.0),set(bpy.context.scene.objects)-feathers)
        joint('wing'+L,(side*.08,.27,.0),[o for o in set(bpy.context.scene.objects)-before if not o.parent])
    # Rounded fan: twelve rectrices read as one white wedge, slightly spread for the glide.
    arc = [(math.sin(math.radians(a))*.30, -.24 - math.cos(math.radians(a))*.30) for a in range(-28, 29, 8)]
    top = [(-.06,.215,-.22),(.06,.215,-.22)] + [(x, .205 - .01*abs(x), z) for x, z in reversed(arc)]
    v = top + [(x, y-.016, z) for x, y, z in top]
    n = len(top)
    f = [tuple(range(n)), tuple(range(2*n-1, n-1, -1))] + [(k, (k+1)%n, (k+1)%n+n, k+n) for k in range(n)]
    joint('tail',(0,.21,-.22),[solid(v, f, WHITE)])

def elk():
    ellipsoid((0,.51,-.08),(.26,.24,.35))
    for x in (-.18,.18):
        for z in (-.30,.19):
            rod((x,.40,z),(x,.06,z+.035),.042,WOOD,r2=.026)
            box((x,.035,z+.05),(.075,.07,.10),DARK)
    before=set(bpy.context.scene.objects)
    rod((0,.55,.20),(0,.79,.31),.13,BODY,r2=.085)
    ellipsoid((0,.81,.35),(.10,.11,.15))
    ellipsoid((0,.78,.46),(.075,.06,.055),DARK)
    for s in (-1,1):
        ellipsoid((s*.12,.89,.31),(.10,.035,.055))
        rod((s*.045,.88,.30),(s*.18,1,.20),.018,WHITE,r2=.008)
        for j in range(3): rod((s*(.07+j*.04),.91+j*.025,.28-j*.025),(s*(.13+j*.04),.99,.29-j*.03),.01,WHITE,r2=.003)

    joint('head',(0,.55,.20),set(bpy.context.scene.objects)-before)

def pine():
    rod((0,0,0),(0,4.6,0),.16,WOOD,r2=.055)
    for i in range(5):
        y=1.0+i*.74; r=1.25-i*.21
        rod((0,y,0),(0,min(5,y+1.8),0),r,BODY if i%2 else LEAF,r2=0,sides=9)

def equipment(kind):
    if kind == 'camera':
        for x,z in [(-.34,.25),(.34,.25),(0,-.35)]: rod((x,.03,z),(0,.79,0),.025,DARK)
        rod((0,.1,0),(0,.85,0),.055,DARK)
        box((0,.97,-.06),(.42,.36,.38),BODY,.025)
        rod((0,1.0,.10),(0,1.0,.38),.12,DARK)
        rod((0,1.0,.38),(0,1.0,.4),.095,GLASS)
        box((0,1.17,-.10),(.20,.06,.2),DARK)
    else:
        rod((0,0,0),(0,3.65,0),.07,DARK,r2=.045)
        for x,z in [(-.14,.13),(.14,.13),(0,-.15)]: rod((x,0,z),(0,.5,0),.025,DARK)
        box((0,3.82,0),(.30,.36,.30),BODY,.025)
        box((0,3.82,.151),(.25,.27,.01),WHITE)

def surface(kind):
    top = .92
    box((0,top/2,0),(1,top,1),BODY)
    def layer(x, z, w, h, d, material, level=1):
        # Flat markings stacked on the slab: each level is its own plane, `gap` above the one below.
        y = top + level*gap(1) + (level-1)*.03
        box((x,y+h/2,z),(w,h,d),decal(material))
    if kind == 'court':
        # Markings on top: world dimensions 28 x 15 through the entity scale. Plank seams below the paint lines.
        for i in range(15): layer(-.46+i*.065,0,.001,.01,.94,WOOD)
        for x in (-.48,.48): layer(x,0,.003,.03,.95,WHITE,2)
        for z in (-.47,.47): layer(0,z,.96,.03,.005,WHITE,2)
        layer(0,0,.003,.03,.94,WHITE,2)
        arc = top + 2*gap(1) + .03 + .015
        for side in (-1,1):
            # Open three-point arc, sampled in the existing floor's normalised space.
            for i in range(24):
                a=-math.pi/2+i*math.pi/24; b=a+math.pi/24
                rod((side*(.43-.22*math.cos(a)),arc,.40*math.sin(a)),(side*(.43-.22*math.cos(b)),arc,.40*math.sin(b)),.002,decal(WHITE),sides=4)
    elif kind == 'paint':
        for z in (-.47,.47): layer(0,z,.96,.03,.015,WHITE)
        for x in (-.48,.48): layer(x,0,.015,.03,.96,WHITE)
    elif kind == 'track':
        for z in (-.46,.46): layer(0,z,1,.025,.012,WHITE)
        for x in (-.375,-.125,.125,.375): layer(x,0,.10,.025,.008,GOLD)
    elif kind == 'finish':
        for x in range(2):
            for z in range(20):
                if (x+z)%2: layer(-.25+x*.5,-.475+z*.05,.5,.03,.05,DARK)
    elif kind == 'studio-floor':
        for z in (-.42,.42): layer(0,z,.9,.025,.004,GLASS)
        for x in (-.42,.42): layer(x,0,.004,.025,.84,GLASS)
    elif kind == 'grass':
        for i in range(8): layer(-.4375+i*.125,0,.0625,.02,1,LEAF)
    elif kind == 'river':
        for x in (-.27,.12): layer(x,0,.012,.02,.85,GLASS)

def stands():
    for i in range(6):
        z=-.5+(i+.5)/6; h=(i+1)/6
        box((0,h/2,z),(1,h,1/6),BODY)
        box((0,h+.007,z-.015),(.96,.015,.065),DARK)
        for x in range(12): box((-.46+x*.083,h+.035,z+.04),(.052,.065,.015),GLASS)
    for x in (-.49,.49):
        rod((x,.14,-.48),(x,.99,.45),.008,WHITE)

def panels(kind):
    if kind in ('barrier', 'press-box'):
        # The dark cap sits on the body (it does not overlap it) and overhangs it by `gap` on every side.
        cap = .12 if kind == 'barrier' else .08
        box((0,(1-cap)/2,0),(1,1-cap,1),BODY,.025)
        box((0,1-cap/2,0),(1+2*gap(0),cap,1+2*gap(2)),DARK)
        if kind == 'barrier':
            for x in (-.375,-.125,.125,.375): box((x,.46,.5+gap(2)+.005),(.006,.72,.01),decal(GLASS))
        else:
            for x in range(10): box((-.45+x*.1,.55,.5+gap(2)+.005),(.085,.56,.01),decal(GLASS))
        return
    box((0,.5,0),(1,1,1),BODY,.025)
    # Screen: a dark frame proud of the body, glass panels proud of the frame, then the gold strip and the map.
    z = .5 + gap(2)
    box((0,.53,z+.0075),(.92,.83,.015),DARK); z += .015 + gap(2)
    for x in range(4): box((-.345+x*.23,.57,z+.004),(.22,.62,.008),decal(GLASS))
    box((0,.16,z+.005),(.86,.04,.01),decal(GOLD)); z += .01 + gap(2)
    if kind == 'video-wall':
        # Stylised world map made from broad facets, no text or textures.
        for x,y,w,h in [(-.25,.65,.17,.20),(-.17,.4,.06,.17),(.05,.64,.10,.12),(.08,.43,.07,.19),(.25,.64,.21,.16),(.32,.34,.08,.07)]:
            box((x,y,z+.005),(w,h,.01),decal(WHITE),.01)

def desk():
    box((0,.70,0),(1.6,.10,.9),BODY,.025)
    for x in (-.6,.6): box((x,.32,0),(.14,.64,.65),DARK,.03)
    box((0,.38,.24),(1.35,.48,.11),GLASS,.02)  # stops below the legs' tops
    box((0,.15,0),(1.45,.09,.7),DARK,.03)
    # Paper and tablet lie on the desk top, a `gap` above it.
    box((-.35,.75+gap(1)+.004,.08),(.33,.008,.25),decal(WHITE))
    box((.45,.75+gap(1)+.01,.03),(.25,.02,.20),DARK)

def basketball():
    ellipsoid((0,.5,0),(.49,.49,.49),BODY,20,12)
    for axis in ('x','y','z'): ring((0,.5,0),.49,.009,DARK,axis,32)

def rim():
    ring((0,.64,0),.36,.035,ORANGE,segments=32)
    # Net stays within the same short cylinder proxy; the rim is genuinely open.
    ring((0,.12,0),.27,.012,WHITE,segments=24)
    for i in range(12):
        a=i*math.tau/12; b=a+.22
        rod((.35*math.cos(a),.62,.35*math.sin(a)),(.27*math.cos(b),.08,.27*math.sin(b)),.009,WHITE,sides=4)

def circle():
    rod((0,0,0),(0,1,0),.4,BODY,sides=48)
    ring((0,1,0),.385,.008,WHITE,segments=48)

def lake():
    rod((0,0,0),(0,1.2,0),.4,BODY,sides=64)
    # Shoreline ring and ripples float `gap` above the water: the lake is only 6 cm tall in Wingspan.
    ring((0,1.2+gap(1),0),.397,.002,decal(GLASS),segments=64)
    for x,z,s in [(-.2,-.1,.12),(.1,.12,.18),(-.05,-.25,.10)]: box((x,1.2+gap(1)+.0025,z),(s,.005,.002),decal(GLASS))

def support():
    box((0,.09,0),(1,.18,1),DARK,.04)
    box((0,.47,0),(.42,.78,.42),BODY,.04)  # the post ends under the cap instead of sharing its top
    box((0,.93,0),(.90,.14,.90),DARK,.04)

def backboard():
    # Arena glass keeps the score readable from the fixed baseline camera behind the board.
    pane = mat('backboard-glass', '#b8d4df')
    pane.diffuse_color = (*pane.diffuse_color[:3], .12)
    pane.node_tree.nodes.get('Principled BSDF').inputs['Alpha'].default_value = .12
    pane.surface_render_method = 'DITHERED'
    box((0,.5,0),(.90,.94,.94),pane)
    for y in (.025,.975): box((0,y,0),(1,.05,1),DARK)
    for z in (-.475,.475): box((0,.5,z),(1,.90,.05),DARK)
    # The existing board is thin in X (6 cm in Posterized). Decoration must be on both X faces, each layer `gap` off.
    g = gap(0)
    for side in (-1,1):
        x = .5+g+.015+g+.0075
        for z in (-.19,.19): box((side*x,.42,z),(.015,.30,.025),decal(WHITE))
        for y in (.27,.57): box((side*x,y,0),(.015,.025,.40),decal(WHITE))

def tower():
    for x in (-.38,.38):
        for z in (-.38,.38): rod((x,0,z),(x,.8,z),.035,DARK,sides=6)
    for y in (.2,.4,.6):
        for z in (-.38,.38): rod((-.38,y-.18,z),(.38,y,z),.02,DARK,sides=6)
    box((0,.77,0),(1,.08,1),BODY)
    for x in (-.46,.46): rod((x,.8,-.46),(x,1,-.46),.018,WHITE)
    box((0,.96,-.44),(.94,.06,.04),WHITE)

# Shared height function is sampled without rewriting its deterministic noise in Python.
def terrain():
    code = "import {terrainHeight} from './shared/terrain.mjs'; const a=[]; for(let z=0;z<=48;z++)for(let x=0;x<=48;x++)a.push([x*10-240,terrainHeight({position:[0,0,0],scale:[1,1,1]},x*10-240,z*10-240),z*10-240]); console.log(JSON.stringify(a));"
    verts=json.loads(subprocess.check_output(['node','--input-type=module','-e',code],cwd=ROOT))
    faces=[]
    for z in range(48):
        for x in range(48):
            a=z*49+x; faces.extend([(a,a+49,a+1),(a+1,a+49,a+50)])
    o=mesh(verts,faces,mat('meadow','#7fa35a'))
    palette=[mat('forest','#476b3c'),mat('rock','#a39a8c'),mat('snow','#e4e9e6')]
    for m in palette:o.data.materials.append(m)
    for poly in o.data.polygons:
        h=sum(verts[i][1] for i in poly.vertices)/3
        poly.material_index=3 if h>160 else 2 if h>95 else 1 if h>18 else 0

BUILDERS = {
    'player': ('person',lambda:human('player')), 'anchor':('person',lambda:human('anchor')),
    'operator':('person',lambda:human('operator')), 'fan':('person',lambda:human('fan')),
    'race-car':('car',car), 'eagle':('bird',eagle), 'elk':('box',elk), 'pine':('tree',pine),
    'studio-camera':('cylinder',lambda:equipment('camera')), 'light':('lamp',lambda:equipment('light')),
    'court':('box',lambda:surface('court')), 'paint':('box',lambda:surface('paint')),
    'track':('box',lambda:surface('track')), 'finish':('box',lambda:surface('finish')),
    'studio-floor':('box',lambda:surface('studio-floor')), 'grass':('box',lambda:surface('grass')),
    'river':('box',lambda:surface('river')), 'stands':('box',stands),
    'barrier':('box',lambda:panels('barrier')), 'press-box':('box',lambda:panels('press-box')),
    'screen':('box',lambda:panels('screen')), 'video-wall':('wall',lambda:panels('video-wall')),
    'desk-panel':('box',lambda:panels('screen')), 'desk':('table',desk),
    'basketball':('sphere',basketball), 'rim':('cylinder',rim), 'circle':('cylinder',circle),
    'lake':('cylinder',lake), 'support':('box',support), 'backboard':('box',backboard),
    'flag-stand':('box',tower), 'terrain':('terrain',terrain),
}
UNIT_CUBE = {'video-wall'}  # authored in a unit cube, then stretched to its proxy size
SIZES={'person':(.5,1.8,.35),'car':(1.9,1.45,4.5),'bird':(2.4,.5,1.1),'box':(1,1,1),'tree':(2.5,5,2.5),'cylinder':(.8,1.2,.8),'lamp':(.3,4,.3),'wall':(8,3,.25),'table':(1.6,.75,.9),'sphere':(1,1,1)}
def canonical_indices(file):
    # Blender's parallel exporter can reorder triangles without changing geometry.
    # Rotate each triangle cyclically (preserve winding) and sort the index records.
    data = bytearray(file.read_bytes())
    json_size = struct.unpack_from('<I', data, 12)[0]
    doc = json.loads(data[20:20+json_size])
    binary = 28 + json_size
    canonical = {}
    aliases = {}
    # Canonicalise even unused duplicate accessors: the exporter can arbitrarily reuse any of them.
    for index, acc in enumerate(doc['accessors']):
        if acc['type'] != 'SCALAR' or acc['componentType'] not in (5123, 5125): continue
        view = doc['bufferViews'][acc['bufferView']]
        offset = binary + view.get('byteOffset', 0) + acc.get('byteOffset', 0)
        fmt = '<' + {5123: 'H', 5125: 'I'}[acc['componentType']] * acc['count']
        values = struct.unpack_from(fmt, data, offset)
        triangles = []
        for i in range(0, len(values), 3):
            tri = values[i:i+3]
            triangles.append(min(tri[n:]+tri[:n] for n in range(3)))
        ordered = tuple(i for tri in sorted(triangles) for i in tri)
        struct.pack_into(fmt, data, offset, *ordered)
        key = (acc['componentType'], ordered)
        canonical.setdefault(key, index)
        aliases[index] = canonical[key]
    for mesh_data in doc['meshes']:
        for primitive in mesh_data['primitives']:
            primitive['indices'] = aliases[primitive['indices']]
    # Keep only the accessors the meshes use, one buffer view each, packed in the order the meshes reference them, so
    # the bytes never depend on which duplicates the exporter happened to share.
    order = {}
    for mesh_data in doc['meshes']:
        for primitive in mesh_data['primitives']:
            for key in [*primitive['attributes'].values(), primitive['indices']]: order.setdefault(key, len(order))
    accessors, views, payload = [], [], bytearray()
    for old in order:
        acc = dict(doc['accessors'][old]); view = doc['bufferViews'][acc['bufferView']]
        start = binary + view.get('byteOffset', 0)
        views.append({k: v for k, v in {'buffer': 0, 'byteLength': view['byteLength'], 'byteOffset': len(payload), 'target': view.get('target')}.items() if v is not None})
        payload += data[start:start+view['byteLength']]; payload += b'\0' * (-len(payload) % 4)
        acc['bufferView'] = len(views) - 1; accessors.append(acc)
    for mesh_data in doc['meshes']:
        for primitive in mesh_data['primitives']:
            primitive['attributes'] = {k: order[v] for k, v in primitive['attributes'].items()}
            primitive['indices'] = order[primitive['indices']]
    doc['accessors'], doc['bufferViews'], doc['buffers'] = accessors, views, [{'byteLength': len(payload)}]
    encoded = json.dumps(doc, separators=(',', ':')).encode()
    encoded += b' ' * (-len(encoded) % 4)
    file.write_bytes(struct.pack('<III', 0x46546c67, 2, 28+len(encoded)+len(payload)) +
                    struct.pack('<II', len(encoded), 0x4e4f534a) + encoded +
                    struct.pack('<II', len(payload), 0x004e4942) + payload)

# Ids baked by the beret-parts library (scripts/blender/library-blockouts.mjs) are skipped here and keep their
# manifest entries. PREVIS_BLOCKOUTS_ALL=1 rebuilds every builder in Blender instead (the old path, kept as a fallback).
# `-- id ...` after the script rebuilds only those ids.
LIBRARY = set() if os.environ.get('PREVIS_BLOCKOUTS_ALL') == '1' else set(json.loads((ROOT / 'scripts/blender/library-blockouts.json').read_text()))
only=set(sys.argv[sys.argv.index('--')+1:]) if '--' in sys.argv else set()
old_manifest = json.loads((OUT / 'manifest.json').read_text()) if (OUT / 'manifest.json').exists() else {}
manifest={k: old_manifest[k] for k in BUILDERS if k in old_manifest}
for name,(shape,build) in BUILDERS.items():
    if name in LIBRARY or (only and name not in only): continue
    bpy.ops.object.select_all(action='SELECT'); bpy.ops.object.delete(use_global=False)
    current = name
    created.clear()
    build()
    objects=list(bpy.context.scene.objects)
    articulated = any(o.type == 'EMPTY' for o in objects)
    if articulated:
        # Fit once in the neutral pose. Pose changes never resize the body or its limbs.
        bpy.ops.object.select_all(action='DESELECT')
        for o in objects:
            if o.type == 'MESH': o.select_set(True); bpy.context.view_layer.objects.active=o
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        # Name each part after the asset: Blender's auto-numbered names would make bytes depend on which builders ran.
        assert len(created) == sum(o.type == 'MESH' for o in objects), (name, 'a mesh skipped finish()')
        for i, o in enumerate(created): o.name = o.data.name = f'{name}.{i:03d}'
        bpy.context.view_layer.update()
        coords=[o.matrix_world @ v.co for o in objects if o.type == 'MESH' for v in o.data.vertices]
        lo=[min(v[i] for v in coords) for i in range(3)]; hi=[max(v[i] for v in coords) for i in range(3)]
        w,h,d=SIZES[shape]; target=(w,d,h)
        root=bpy.data.objects.new(name, None); bpy.context.collection.objects.link(root)
        for o in objects:
            if not o.parent: o.parent=root
        root.scale=tuple(target[i]/(hi[i]-lo[i]) for i in range(3))
        root.location=tuple(-lo[i]*root.scale[i]-(0 if i==2 else target[i]/2) for i in range(3))
        triangles=0
        for o in objects:
            if o.type == 'MESH': o.data.calc_loop_triangles(); triangles+=len(o.data.loop_triangles)
        bpy.ops.object.select_all(action='SELECT')
    else:
        # Static models keep their canonical, joined geometry.
        bpy.ops.object.select_all(action='SELECT'); bpy.context.view_layer.objects.active=objects[0]
        bpy.ops.object.convert(target='MESH'); bpy.ops.object.join()
        # Name the mesh too: Blender's auto-numbered datablock names would make bytes depend on which builders ran.
        o=bpy.context.object; o.name=name; o.data.name=name
        bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
        if shape != 'terrain':
            coords=[v.co.copy() for v in o.data.vertices]
            lo=[min(v[i] for v in coords) for i in range(3)]; hi=[max(v[i] for v in coords) for i in range(3)]
            w,h,d=SIZES[shape]; target=(w,d,h)
            for v in o.data.vertices:
                for i in range(3): v.co[i]=((v.co[i]-lo[i])/(hi[i]-lo[i])-(0 if i==2 else .5))*target[i]
        o.data.update(); o.data.calc_loop_triangles()
        triangles=len(o.data.loop_triangles)
    assert triangles <= 5000,(name,triangles)
    file=OUT/(name+'.glb')
    bpy.ops.export_scene.gltf(filepath=str(file),export_format='GLB',use_selection=True,export_yup=True,export_animations=False,export_cameras=False,export_lights=False,export_texcoords=False,export_normals=True,export_materials='EXPORT')
    canonical_indices(file)
    manifest[name]={'shape':shape,'triangles':triangles,'bytes':file.stat().st_size}
(OUT/'manifest.json').write_text(json.dumps({k: manifest[k] for k in BUILDERS if k in manifest},indent=2)+'\n')
print('BLOCKOUTS',len(manifest),'assets',sum(x['bytes'] for x in manifest.values()),'bytes')
# The gate: no two surfaces on one plane in any GLB or starter (shared/blockout-lint.mjs). Fails the rebuild loudly.
lint = subprocess.run(['node', 'scripts/blender/lint-blockouts.mjs'], cwd=ROOT, capture_output=True, text=True)
print(lint.stdout + lint.stderr)
if lint.returncode: raise SystemExit('generate-blockouts: coplanar overlaps found; fix the builders above (see docs/blockout-modeling-rules.md)')
