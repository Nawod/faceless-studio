"""bkit — Blender kit for bespoke 3D films (the 3D twin of engines/kit/film.js).

The director writes <workspace>/blender/scene.py:

    import bkit as K
    K.setup(look='studio')                 # resets Blender, reads the voice timings, sets 1080x1920 / fps / EEVEE / colour
    hero = K.sphere(0.6, (0, 0, 0.6), K.mat('hero', '#E8582C', rough=0.35))
    K.pop_in(hero, K.at(0))                # scene 0 starts → hero pops in
    cam = K.camera(lens=40)
    K.shot(cam, K.at(0), (0, -8, 3), (0, 0, 0.6))
    K.shot(cam, K.at(2), (2, -5, 1.6), (0, 0, 0.6), ease='EXPO')
    K.save()

Every frame is a pure function of the keys, so any frame renders on its own (stills for review, chunks for the film).
Frames are numbered 1..K.FRAMES; frame f shows film time (f - 1) / FPS — the same clock as the 2D layer on top.
Captions, labels, arrows, chips and the logo are drawn by the 2D film layer (film/film.js), not here.
"""
import json
import math
import os
import random
import sys
import urllib.request

import bpy

HERE = os.path.dirname(os.path.abspath(__file__))
ASSETS = os.path.join(HERE, 'assets')
SPEC = {}
FPS = 30
FRAMES = 1
W, H = 1080, 1920
_rng = random.Random(7)


# ---------------------------------------------------------------- time
def sec(t):
    """Film seconds → Blender frame (frame 1 = t 0)."""
    return int(round(t * FPS)) + 1


def at(i, off=0.0):
    """Frame when scene i starts (+ offset seconds). Scene 0 may start before 0 → clamped to frame 1."""
    s = SPEC['scenes'][min(i, len(SPEC['scenes']) - 1)]
    return max(1, sec(max(0.0, s['start']) + off))


def end(i):
    return sec(SPEC['scenes'][min(i, len(SPEC['scenes']) - 1)]['end'])


def word(i, text, fallback=0.4):
    """Frame when `text` is spoken in scene i (sync hits to the voice)."""
    s = SPEC['scenes'][i]
    norm = lambda w: ''.join(c for c in w.lower() if c.isalnum())
    for w in SPEC.get('words', []):
        if s['start'] - 0.05 <= w['start'] < s['end'] and norm(w['word']) == norm(text):
            return sec(w['start'])
    return at(i, fallback)


# ---------------------------------------------------------------- colour + materials
def hexlin(h, a=1.0):
    h = h.lstrip('#')
    rgb = [int(h[k:k + 2], 16) / 255 for k in (0, 2, 4)]
    return tuple(((c + 0.055) / 1.055) ** 2.4 if c > 0.04045 else c / 12.92 for c in rgb) + (a,)


def _bsdf(m):
    return next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')


def mat(name, hex_color, rough=0.45, metal=0.0, emit=None, strength=0.0, coat=0.0, alpha=1.0, transmission=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    p = _bsdf(m)
    p.inputs['Base Color'].default_value = hexlin(hex_color)
    p.inputs['Roughness'].default_value = rough
    p.inputs['Metallic'].default_value = metal
    p.inputs['Coat Weight'].default_value = coat
    if transmission:
        p.inputs['Transmission Weight'].default_value = transmission
    if emit:
        p.inputs['Emission Color'].default_value = hexlin(emit)
        p.inputs['Emission Strength'].default_value = strength
    if alpha < 1:
        p.inputs['Alpha'].default_value = alpha
        _blend(m)
    return m


def _blend(m):
    for attr, val in (('surface_render_method', 'BLENDED'), ('blend_method', 'BLEND')):
        try:
            setattr(m, attr, val)
            break
        except (AttributeError, TypeError):
            continue


def emission(name, hex_color, strength=4.0):
    """Pure glowing surface (screens, neon, sparks, sun). Pair with bloom()."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    e = nt.nodes.new('ShaderNodeEmission')
    e.inputs['Color'].default_value = hexlin(hex_color)
    e.inputs['Strength'].default_value = strength
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(e.outputs[0], out.inputs[0])
    return m


def toon(name, hex_color, shade_hex=None, steps=2):
    """Flat cel shading with hard colour breaks (the clean 'cutaway' explainer look). EEVEE only."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    d = nt.nodes.new('ShaderNodeBsdfDiffuse')
    s2r = nt.nodes.new('ShaderNodeShaderToRGB')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.interpolation = 'CONSTANT'
    lit, dark = hexlin(hex_color), hexlin(shade_hex) if shade_hex else tuple(c * 0.45 for c in hexlin(hex_color)[:3]) + (1,)
    ramp.color_ramp.elements[0].color = dark
    ramp.color_ramp.elements[1].position = 0.35
    ramp.color_ramp.elements[1].color = lit
    if steps > 2:
        e = ramp.color_ramp.elements.new(0.12)
        e.color = tuple((a + b) / 2 for a, b in zip(dark[:3], lit[:3])) + (1,)
    em = nt.nodes.new('ShaderNodeEmission')
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(d.outputs[0], s2r.inputs[0])
    nt.links.new(s2r.outputs['Color'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], em.inputs['Color'])
    nt.links.new(em.outputs[0], out.inputs[0])
    return m


def xray(name, hex_color='#59C3FF', strength=3.0, core=0.04):
    """Glowing see-through hologram / X-ray: bright rim (fresnel), almost clear core."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    lw = nt.nodes.new('ShaderNodeLayerWeight')
    lw.inputs['Blend'].default_value = 0.35
    pw = nt.nodes.new('ShaderNodeMath'); pw.operation = 'POWER'; pw.inputs[1].default_value = 1.6
    mx = nt.nodes.new('ShaderNodeMath'); mx.operation = 'MAXIMUM'; mx.inputs[1].default_value = core
    em = nt.nodes.new('ShaderNodeEmission')
    em.inputs['Color'].default_value = hexlin(hex_color)
    em.inputs['Strength'].default_value = strength
    tr = nt.nodes.new('ShaderNodeBsdfTransparent')
    mix = nt.nodes.new('ShaderNodeMixShader')
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(lw.outputs['Facing'], pw.inputs[0])
    nt.links.new(pw.outputs[0], mx.inputs[0])
    nt.links.new(mx.outputs[0], mix.inputs['Fac'])
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs[0])
    _blend(m)
    return m


def grid_mat(name='HoloGrid', line_hex='#3FA9FF', base_hex='#05070C', cell=1.0, width=0.03, strength=2.5):
    """Dark floor with glowing grid lines (the holographic 'explainer lab' floor)."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    tc = nt.nodes.new('ShaderNodeTexCoord')
    sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    nt.links.new(tc.outputs['Object'], sep.inputs[0])

    def line(axis):
        d = nt.nodes.new('ShaderNodeMath'); d.operation = 'DIVIDE'; d.inputs[1].default_value = cell
        fr = nt.nodes.new('ShaderNodeMath'); fr.operation = 'PINGPONG'; fr.inputs[1].default_value = 0.5
        lt = nt.nodes.new('ShaderNodeMath'); lt.operation = 'LESS_THAN'; lt.inputs[1].default_value = width
        nt.links.new(sep.outputs[axis], d.inputs[0]); nt.links.new(d.outputs[0], fr.inputs[0]); nt.links.new(fr.outputs[0], lt.inputs[0])
        return lt
    a, b = line('X'), line('Y')
    mx = nt.nodes.new('ShaderNodeMath'); mx.operation = 'MAXIMUM'
    nt.links.new(a.outputs[0], mx.inputs[0]); nt.links.new(b.outputs[0], mx.inputs[1])
    em = nt.nodes.new('ShaderNodeEmission'); em.inputs['Color'].default_value = hexlin(line_hex); em.inputs['Strength'].default_value = strength
    floor = nt.nodes.new('ShaderNodeBsdfPrincipled'); floor.inputs['Base Color'].default_value = hexlin(base_hex); floor.inputs['Roughness'].default_value = 0.25
    mix = nt.nodes.new('ShaderNodeMixShader')
    nt.links.new(mx.outputs[0], mix.inputs['Fac']); nt.links.new(floor.outputs[0], mix.inputs[1]); nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs[0])
    return m


def glass(name, hex_color='#FFFFFF', rough=0.05):
    return mat(name, hex_color, rough=rough, transmission=1.0)


# ---------------------------------------------------------------- objects
def _done(o, material=None, smooth=True, name=None):
    if name:
        o.name = name
    if material:
        o.data.materials.append(material)
    if smooth and o.type == 'MESH':
        for p in o.data.polygons:
            p.use_smooth = True
    return o


def box(size=(1, 1, 1), loc=(0, 0, 0), material=None, bevel=0.04, name=None, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(location=loc, rotation=rot)
    o = bpy.context.active_object
    o.scale = (size[0] / 2, size[1] / 2, size[2] / 2)
    bpy.ops.object.transform_apply(scale=True)
    if bevel:
        b = o.modifiers.new('Bevel', 'BEVEL'); b.width, b.segments = bevel, 3
    return _done(o, material, smooth=bool(bevel), name=name)


def sphere(r=0.5, loc=(0, 0, 0), material=None, name=None, seg=48):
    bpy.ops.mesh.primitive_uv_sphere_add(radius=r, location=loc, segments=seg, ring_count=seg // 2)
    return _done(bpy.context.active_object, material, name=name)


def cylinder(r=0.5, depth=1.0, loc=(0, 0, 0), material=None, name=None, rot=(0, 0, 0), verts=48, bevel=0.0):
    bpy.ops.mesh.primitive_cylinder_add(radius=r, depth=depth, location=loc, rotation=rot, vertices=verts)
    o = bpy.context.active_object
    if bevel:
        b = o.modifiers.new('Bevel', 'BEVEL'); b.width, b.segments = bevel, 3
        o.modifiers.new('WN', 'WEIGHTED_NORMAL')
    return _done(o, material, smooth=bool(bevel), name=name)


def cone(r1=0.5, r2=0.0, depth=1.0, loc=(0, 0, 0), material=None, name=None, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cone_add(radius1=r1, radius2=r2, depth=depth, location=loc, rotation=rot, vertices=48)
    return _done(bpy.context.active_object, material, smooth=False, name=name)


def torus(r=1.0, thick=0.08, loc=(0, 0, 0), material=None, name=None, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_torus_add(major_radius=r, minor_radius=thick, location=loc, rotation=rot, major_segments=96, minor_segments=16)
    return _done(bpy.context.active_object, material, name=name)


def plane(size=10, loc=(0, 0, 0), material=None, name=None, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_plane_add(size=size, location=loc, rotation=rot)
    return _done(bpy.context.active_object, material, smooth=False, name=name)


def text3d(text, size=0.6, loc=(0, 0, 0), material=None, extrude=0.05, rot=(math.radians(90), 0, 0), align='CENTER', name=None):
    """Real 3D lettering in the scene (signage, numbers on objects). Screen captions belong to the 2D layer."""
    bpy.ops.object.text_add(location=loc, rotation=rot)
    o = bpy.context.active_object
    o.data.body = text
    o.data.size = size
    o.data.extrude = extrude
    o.data.bevel_depth = extrude * 0.25
    o.data.align_x = align
    o.data.align_y = 'CENTER'
    return _done(o, material, smooth=False, name=name)


def arrow3d(length=1.5, loc=(0, 0, 0), rot=(0, 0, 0), material=None, name='Arrow'):
    shaft = cylinder(0.05, length * 0.75, (0, 0, length * 0.375), material)
    head = cone(0.14, 0, length * 0.25, (0, 0, length * 0.875), material)
    root = empty(loc, name=name)
    root.rotation_euler = rot
    for o in (shaft, head):
        parent(o, root)
    return root


def empty(loc=(0, 0, 0), name='Empty'):
    bpy.ops.object.empty_add(location=loc)
    o = bpy.context.active_object
    o.name = name
    return o


def parent(child, par):
    """Parent while keeping the child's world position (view_layer.update() first, or it jumps to the origin)."""
    bpy.context.view_layer.update()
    child.parent = par
    child.matrix_parent_inverse = par.matrix_world.inverted()
    return child


def join(objs, name=None):
    bpy.ops.object.select_all(action='DESELECT')
    for o in objs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    o = bpy.context.active_object
    if name:
        o.name = name
    return o


def instances(obj, positions, name='inst'):
    """Linked copies (cheap): rows of seats, a field of rocks, a ring of particles."""
    out = []
    for k, p in enumerate(positions):
        c = obj.copy()
        c.location = p
        c.name = f'{name}_{k}'
        bpy.context.collection.objects.link(c)
        out.append(c)
    return out


# ---------------------------------------------------------------- animation
EASES = {'LINEAR': ('LINEAR', None), 'SMOOTH': ('BEZIER', None), 'SINE': ('SINE', 'EASE_IN_OUT'), 'QUAD': ('QUAD', 'EASE_IN_OUT'),
         'CUBIC': ('CUBIC', 'EASE_IN_OUT'), 'EXPO': ('EXPO', 'EASE_IN_OUT'), 'OUT': ('CUBIC', 'EASE_OUT'), 'IN': ('CUBIC', 'EASE_IN'),
         'BACK': ('BACK', 'EASE_OUT'), 'BOUNCE': ('BOUNCE', 'EASE_OUT'), 'ELASTIC': ('ELASTIC', 'EASE_OUT'), 'STEP': ('CONSTANT', None)}


def key(obj, path, frame, value=None, ease='SMOOTH', index=-1):
    """Key obj.<path> at frame (set value first if given). The ease applies to the segment that STARTS at this key."""
    if value is not None:
        cur = obj.path_resolve(path)
        if hasattr(cur, '__len__') and not isinstance(value, (int, float)):
            for k, v in enumerate(value):
                cur[k] = v
        else:
            setattr(obj, path, value) if '.' not in path else exec(f'obj.{path} = value')
    obj.keyframe_insert(data_path=path, frame=frame, index=index)
    ad = obj.animation_data if hasattr(obj, 'animation_data') else None
    action = ad.action if ad else None
    if action:
        interp, easing = EASES.get(ease, EASES['SMOOTH'])
        for fc in _fcurves(action):
            if fc.data_path == path:
                for kp in fc.keyframe_points:
                    if abs(kp.co.x - frame) < 0.5:
                        kp.interpolation = interp
                        if easing:
                            kp.easing = easing
                        if interp == 'BEZIER':
                            kp.handle_left_type = kp.handle_right_type = 'AUTO_CLAMPED'
    return obj


def _fcurves(action):
    try:
        return list(action.fcurves)
    except AttributeError:   # Blender 5 layered actions
        out = []
        for layer in action.layers:
            for strip in layer.strips:
                for bag in strip.channelbags:
                    out.extend(bag.fcurves)
        return out


def move(obj, f0, f1, a, b, ease='CUBIC', path='location'):
    key(obj, path, f0, a, ease)
    key(obj, path, f1, b, ease)


def pop_in(obj, frame, dur=10, scale=None, ease='BACK'):
    """Scale from 0 with overshoot (things arrive with energy)."""
    s = tuple(scale or obj.scale)
    key(obj, 'scale', max(1, frame - 1), (0, 0, 0), 'STEP') if frame > 1 else None
    key(obj, 'scale', frame, (0.001, 0.001, 0.001), ease)
    key(obj, 'scale', frame + dur, s, 'SMOOTH')


def pop_out(obj, frame, dur=8):
    s = tuple(obj.scale)
    key(obj, 'scale', frame, s, 'IN')
    key(obj, 'scale', frame + dur, (0.001, 0.001, 0.001), 'STEP')


def spin(obj, f0, f1, turns=1.0, axis=2, ease='LINEAR'):
    r = list(obj.rotation_euler)
    key(obj, 'rotation_euler', f0, r, ease)
    r[axis] += turns * 2 * math.pi
    key(obj, 'rotation_euler', f1, r, ease)


def hop(obj, f0, f1, a, b, height=1.0, squash=True):
    """A jump with anticipation, arc and landing squash, keyed per frame."""
    sx, sy, sz = obj.scale
    for f in range(f0 - 4, f1 + 8):
        if f < f0:
            k = (f - (f0 - 4)) / 4; pos, s = a, 1 - 0.2 * k
        elif f <= f1:
            t = (f - f0) / max(1, f1 - f0); e = t * t * (3 - 2 * t)
            pos = tuple(a[i] + (b[i] - a[i]) * e for i in range(3))
            pos = (pos[0], pos[1], pos[2] + height * 4 * t * (1 - t)); s = 1.15 - 0.15 * abs(2 * t - 1)
        else:
            k = (f - f1) / 8; pos, s = b, 0.8 + 0.2 * k + 0.05 * math.sin(k * math.pi)
        obj.location = pos
        obj.keyframe_insert('location', frame=f)
        if squash:
            v = 1 / math.sqrt(max(0.3, s)); obj.scale = (sx * v, sy * v, sz * s)
            obj.keyframe_insert('scale', frame=f)
    obj.scale = (sx, sy, sz)


def wobble(obj, f0, f1, amp=0.03, freq=1.5, path='location', seed=1):
    """Gentle idle float (nothing is ever fully still)."""
    base = list(obj.path_resolve(path))
    r = random.Random(seed)
    ph = [r.random() * 6.28 for _ in range(3)]
    for f in range(f0, f1 + 1, 3):
        t = f / FPS
        v = [base[k] + amp * math.sin(t * freq * 2 * math.pi + ph[k]) for k in range(3)]
        key(obj, path, f, v)


# ---------------------------------------------------------------- camera
def camera(lens=40, fstop=None, name='Cam'):
    """Camera that always looks at a target empty (move both with shot())."""
    bpy.ops.object.camera_add()
    cam = bpy.context.active_object
    cam.name = name
    cam.data.lens = lens
    cam.data.clip_end = 2000
    tgt = empty((0, 0, 0), name=f'{name}Target')
    c = cam.constraints.new('TRACK_TO'); c.target = tgt; c.track_axis, c.up_axis = 'TRACK_NEGATIVE_Z', 'UP_Y'
    if fstop:
        cam.data.dof.use_dof = True; cam.data.dof.focus_object = tgt; cam.data.dof.aperture_fstop = fstop
    bpy.context.scene.camera = cam
    cam['target'] = tgt.name
    return cam


def shot(cam, frame, loc, look_at, lens=None, ease='CUBIC'):
    """Camera position + aim (+ lens) at a frame. Consecutive shots ease between each other; ease='STEP' = hard cut."""
    tgt = bpy.data.objects[cam['target']]
    key(cam, 'location', frame, loc, ease)
    key(tgt, 'location', frame, look_at, ease)
    if lens:
        key(cam.data, 'lens', frame, lens, ease)


def cut(cam, frame, loc, look_at, lens=None):
    """Hard cut to a new angle at `frame` (hold the previous shot until then)."""
    tgt = bpy.data.objects[cam['target']]
    for o, path in ((cam, 'location'), (tgt, 'location')):
        o.keyframe_insert(path, frame=frame - 1)
    shot(cam, frame, loc, look_at, lens, ease='STEP')
    for o in (cam, tgt):
        for fc in _fcurves(o.animation_data.action):
            for kp in fc.keyframe_points:
                if abs(kp.co.x - (frame - 1)) < 0.5:
                    kp.interpolation = 'CONSTANT'


def shake(cam, f0, f1, amp=0.06, freq=14, seed=3):
    """Decaying camera shake (impacts, launches). Keys every frame on delta_location."""
    r = random.Random(seed)
    ph = [r.random() * 100 for _ in range(3)]
    for f in range(f0, f1 + 1):
        k = (1 - (f - f0) / max(1, f1 - f0)) ** 2
        t = f / FPS
        cam.delta_location = tuple(amp * k * math.sin(t * freq + ph[i]) * math.cos(t * freq * 0.63 + ph[i]) for i in range(3))
        cam.keyframe_insert('delta_location', frame=f)
    cam.delta_location = (0, 0, 0)
    cam.keyframe_insert('delta_location', frame=f1 + 1)


# ---------------------------------------------------------------- light + world
def world_color(hex_color='#101218', strength=1.0):
    w = bpy.context.scene.world
    bg = next(n for n in w.node_tree.nodes if n.type == 'BACKGROUND')
    bg.inputs['Color'].default_value = hexlin(hex_color)
    bg.inputs['Strength'].default_value = strength


def world_gradient(top_hex='#9FD3FF', bottom_hex='#FFE7C9', strength=1.0):
    """Soft vertical sky gradient (pastel daytime explainer backdrop)."""
    w = bpy.context.scene.world
    nt = w.node_tree
    bg = next(n for n in nt.nodes if n.type == 'BACKGROUND')
    tc = nt.nodes.new('ShaderNodeTexCoord'); sep = nt.nodes.new('ShaderNodeSeparateXYZ')
    ramp = nt.nodes.new('ShaderNodeValToRGB')
    ramp.color_ramp.elements[0].position = 0.45; ramp.color_ramp.elements[0].color = hexlin(bottom_hex)
    ramp.color_ramp.elements[1].position = 0.75; ramp.color_ramp.elements[1].color = hexlin(top_hex)
    mr = nt.nodes.new('ShaderNodeMapRange'); mr.inputs['From Min'].default_value = -1; mr.inputs['From Max'].default_value = 1
    nt.links.new(tc.outputs['Generated'] if False else tc.outputs['Window'], sep.inputs[0])
    nt.links.new(sep.outputs['Y'], ramp.inputs['Fac'])
    nt.links.new(ramp.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = strength


def stars(count=1500, radius=300, size=0.35, seed=11, hex_color='#FFFFFF'):
    """A real starfield (emissive specks on a far sphere) that parallaxes with the camera."""
    r = random.Random(seed)
    m = emission('Stars', hex_color, 6)
    base = sphere(size, (0, 0, 0), m, 'Star', seg=8)
    pts = []
    for _ in range(count):
        u, v = r.random(), r.random()
        th, ph = 2 * math.pi * u, math.acos(2 * v - 1)
        pts.append((radius * math.sin(ph) * math.cos(th), radius * math.sin(ph) * math.sin(th), radius * math.cos(ph)))
    instances(base, pts, 'Star')
    base.hide_render = True


def light(kind='AREA', loc=(3, -4, 6), energy=800, size=3, hex_color='#FFFFFF', aim=(0, 0, 0), glossy=False, name=None):
    bpy.ops.object.light_add(type=kind, location=loc)
    l = bpy.context.active_object
    if name:
        l.name = name
    l.data.energy = energy
    l.data.color = hexlin(hex_color)[:3]
    if kind == 'AREA':
        l.data.size = size
    if kind != 'POINT':
        d = [aim[i] - loc[i] for i in range(3)]
        l.rotation_euler = (math.atan2(math.hypot(d[0], d[1]), -d[2]), 0, math.atan2(d[1], d[0]) + math.pi / 2)
    l.visible_glossy = glossy   # lights out of reflections: no white blocks on glossy floors/screens
    return l


def studio(key_energy=900, warm='#FFF1E0', cool='#CFE3FF'):
    """Soft three-point studio light (clean product / explainer look)."""
    light('AREA', (-4, -5, 6), key_energy, 5, warm, name='Key')
    light('AREA', (5, -2, 3), key_energy * 0.35, 4, cool, name='Fill')
    light('AREA', (0, 6, 5), key_energy * 0.6, 4, '#FFFFFF', name='Rim')


def cyclorama(hex_color='#EDEFF3', size=60, rough=0.6):
    """Seamless curved backdrop (floor sweeping up into a wall) — the infinite-studio look."""
    bpy.ops.mesh.primitive_plane_add(size=size)
    o = bpy.context.active_object
    o.name = 'Cyclorama'
    bpy.ops.object.mode_set(mode='EDIT')
    bpy.ops.mesh.subdivide(number_cuts=24)
    bpy.ops.object.mode_set(mode='OBJECT')
    for v in o.data.vertices:
        if v.co.y > size * 0.1:
            k = (v.co.y - size * 0.1) / (size * 0.4)
            v.co.z = (k ** 2) * size * 0.4
    o.modifiers.new('S', 'SUBSURF').levels = 2
    return _done(o, mat('Cyc', hex_color, rough=rough))


def hdri(slug='kloofendal_48d_partly_cloudy_puresky', strength=1.0, res='1k', show=True):
    """Image-based lighting from Poly Haven (CC0), cached. show=False lights the scene but keeps the background colour."""
    path = polyhaven_file(slug, 'hdris', res, 'hdr')
    w = bpy.context.scene.world
    nt = w.node_tree
    bg = next(n for n in nt.nodes if n.type == 'BACKGROUND')
    env = nt.nodes.new('ShaderNodeTexEnvironment')
    env.image = bpy.data.images.load(path)
    nt.links.new(env.outputs['Color'], bg.inputs['Color'])
    bg.inputs['Strength'].default_value = strength
    if not show:
        lp = nt.nodes.new('ShaderNodeLightPath'); mix = nt.nodes.new('ShaderNodeMixShader'); flat = nt.nodes.new('ShaderNodeBackground')
        flat.inputs['Color'].default_value = (0.02, 0.02, 0.025, 1)
        out = next(n for n in nt.nodes if n.type == 'OUTPUT_WORLD')
        nt.links.new(lp.outputs['Is Camera Ray'], mix.inputs['Fac']); nt.links.new(bg.outputs[0], mix.inputs[1]); nt.links.new(flat.outputs[0], mix.inputs[2])
        nt.links.new(mix.outputs[0], out.inputs[0])


# ---------------------------------------------------------------- assets (CC0, cached)
def _download(url, path):
    if os.path.isfile(path) and os.path.getsize(path) > 0:
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    req = urllib.request.Request(url, headers={'User-Agent': 'faceless-studio/1.0'})
    with urllib.request.urlopen(req, timeout=60) as r, open(path, 'wb') as f:
        f.write(r.read())
    return path


def polyhaven_file(slug, kind, res='1k', fmt='hdr'):
    info = json.loads(urllib.request.urlopen(urllib.request.Request(f'https://api.polyhaven.com/files/{slug}', headers={'User-Agent': 'faceless-studio/1.0'}), timeout=30).read())
    key = 'hdri' if kind == 'hdris' else fmt
    entry = info[key][res][fmt] if kind == 'hdris' else info[key][res][fmt]
    return _download(entry['url'], os.path.join(ASSETS, kind, slug, os.path.basename(entry['url'])))


def polyhaven_model(slug, res='1k', loc=(0, 0, 0), height=None, name=None):
    """Import a Poly Haven model (CC0 props, furniture, plants, rocks). Search slugs at https://polyhaven.com/models."""
    info = json.loads(urllib.request.urlopen(urllib.request.Request(f'https://api.polyhaven.com/files/{slug}', headers={'User-Agent': 'faceless-studio/1.0'}), timeout=30).read())
    g = info['gltf'][res]['gltf']
    folder = os.path.join(ASSETS, 'models', slug)
    main = _download(g['url'], os.path.join(folder, os.path.basename(g['url'])))
    for rel, inc in (g.get('include') or {}).items():
        _download(inc['url'], os.path.join(folder, rel))
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=main)
    objs = [o for o in bpy.data.objects if o not in before]
    root = empty(loc, name=name or slug)
    for o in objs:
        if o.parent is None:
            parent(o, root)
    if height:
        fit_height(root, objs, height)
    return root


def fit_height(root, objs, height):
    bpy.context.view_layer.update()
    zs = [ (o.matrix_world @ v.co).z for o in objs if o.type == 'MESH' for v in o.data.vertices]
    if zs:
        k = height / max(1e-6, max(zs) - min(zs))
        root.scale = (k, k, k)


# ---------------------------------------------------------------- look + output
def bloom(threshold=0.8, size=6, mix=0.0):
    """Glow around bright/emissive things (neon, screens, sparks, the sun). Compositor glare; works in EEVEE and Cycles."""
    sc = bpy.context.scene
    try:
        sc.render.use_compositing = True
        if hasattr(sc, 'compositing_node_group'):          # Blender 5: compositor is a node group
            tree = bpy.data.node_groups.new('Comp', 'CompositorNodeTree')
            sc.compositing_node_group = tree
            gin = tree.nodes.new('NodeGroupInput') if False else None
            rl = tree.nodes.new('CompositorNodeRLayers')
            out = tree.nodes.new('NodeGroupOutput')
            tree.interface.new_socket('Image', in_out='OUTPUT', socket_type='NodeSocketColor')
        else:
            sc.use_nodes = True
            tree = sc.node_tree
            for n in list(tree.nodes):
                tree.nodes.remove(n)
            rl = tree.nodes.new('CompositorNodeRLayers')
            out = tree.nodes.new('CompositorNodeComposite')
        g = tree.nodes.new('CompositorNodeGlare')
        for attr, val in (('glare_type', 'FOG_GLOW'), ('quality', 'HIGH')):
            try:
                setattr(g, attr, val)
            except Exception:
                pass
        for name, val in (('Threshold', threshold), ('Size', size / 10 if size > 1 else size), ('Strength', 1.0)):
            if name in g.inputs:
                g.inputs[name].default_value = val
        if hasattr(g, 'threshold'):
            g.threshold = threshold
        if hasattr(g, 'size') and isinstance(getattr(g, 'size'), int):
            g.size = int(size)
        tree.links.new(rl.outputs['Image'], g.inputs['Image'])
        tree.links.new(g.outputs['Image'], out.inputs[0])
    except Exception as e:   # never let a look tweak break a film
        print('BKIT_WARN bloom unavailable:', e)


def setup(look='studio', samples=32, motion_blur=False, exposure=None, spec_path=None):
    """Reset Blender and configure the film from the voice timings. looks: studio | toon | holo | night | space | cinematic."""
    global SPEC, FPS, FRAMES, W, H
    bpy.ops.wm.read_factory_settings(use_empty=True)
    spec_path = spec_path or os.environ.get('BKIT_SPEC') or os.path.join(os.getcwd(), 'spec.json')
    SPEC = json.load(open(spec_path, encoding='utf-8'))
    FPS = int(SPEC.get('fps', 30))
    W, H = SPEC.get('W', 1080), SPEC.get('H', 1920)
    FRAMES = int(math.ceil(SPEC['duration'] * FPS)) + 1
    sc = bpy.context.scene
    sc.frame_start, sc.frame_end = 1, FRAMES
    sc.render.fps = FPS
    sc.render.resolution_x, sc.render.resolution_y = W, H
    ids = [i.identifier for i in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items]
    sc.render.engine = next(e for e in ids if 'EEVEE' in e)
    sc.eevee.taa_render_samples = samples
    for attr, val in (('use_raytracing', look in ('cinematic', 'holo', 'night')), ('use_shadows', True), ('use_gtao', True)):
        try:
            setattr(sc.eevee, attr, val)
        except Exception:
            pass
    sc.render.use_motion_blur = motion_blur
    sc.view_settings.view_transform = 'Standard' if look == 'toon' else 'AgX'
    try:
        sc.view_settings.look = 'AgX - Medium High Contrast' if look in ('cinematic', 'night') else 'None'
    except TypeError:
        pass
    sc.view_settings.exposure = exposure if exposure is not None else (-0.3 if look in ('studio', 'cinematic') else 0.0)
    w = bpy.data.worlds.new('World')
    sc.world = w
    w.use_nodes = True
    world_color({'studio': '#E9ECF1', 'toon': '#F3E3CC', 'holo': '#04060B', 'night': '#070A12', 'space': '#000000', 'cinematic': '#0B0D12'}.get(look, '#202024'),
                {'studio': 0.6, 'toon': 1.0, 'holo': 0.3, 'night': 0.2, 'space': 0.0, 'cinematic': 0.25}.get(look, 0.5))
    if look in ('holo', 'night', 'space', 'cinematic'):
        bloom(0.8 if look != 'cinematic' else 1.2, 6)
    return SPEC


def save():
    bpy.context.view_layer.update()
    out = os.environ.get('BKIT_OUT') or os.path.join(os.getcwd(), 'scene.blend')
    bpy.ops.wm.save_as_mainfile(filepath=out)
    print('BKIT_SAVED', out, 'frames', FRAMES)
