"""Grubb, built from primitives so the character is 100% our own IP.

Every animatable part hangs off an empty, so the animator only has to move
a handful of controls (see `Grubb`).
"""
import math

import bpy

GRUBB_COLOR = (0.02, 0.42, 0.32, 1)  # signature teal
BANDAGE_COLOR = (0.85, 0.55, 0.32, 1)

# (x, z, radius) in body space; the left eye is bigger on purpose
EYES = [(-0.33, 2.25, 0.30), (0.36, 2.22, 0.24)]
EYE_Y = -0.6
MOUTH_POS = (0.0, -0.58, 1.72)
SHOULDERS = [(-0.8, 0.0, 1.75), (0.8, 0.0, 1.75)]


def _mat(name, color, rough=0.55, sss=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = color
    b.inputs["Roughness"].default_value = rough
    if sss:
        b.inputs["Subsurface Weight"].default_value = sss
        b.inputs["Subsurface Radius"].default_value = (0.3, 0.15, 0.1)
        b.inputs["Subsurface Scale"].default_value = 0.1
    return m


def _finish(o, m):
    for p in o.data.polygons:
        p.use_smooth = True
    o.data.materials.append(m)
    return o


def _sphere(loc, scale, m, segments=48):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=segments, ring_count=segments // 2, location=loc)
    o = bpy.context.object
    o.scale = scale
    return _finish(o, m)


def _rcube(loc, scale, bevel, m, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(location=loc, rotation=rot)
    o = bpy.context.object
    o.scale = scale
    bpy.ops.object.transform_apply(scale=True)
    bv = o.modifiers.new("bevel", "BEVEL")
    bv.width = bevel
    bv.segments = 6
    sub = o.modifiers.new("subsurf", "SUBSURF")
    sub.levels = sub.render_levels = 2
    return _finish(o, m)


def _capsule(a, b, r, m):
    dx, dy, dz = (b[i] - a[i] for i in range(3))
    length = math.sqrt(dx * dx + dy * dy + dz * dz)
    mid = tuple((a[i] + b[i]) / 2 for i in range(3))
    bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=r, depth=length, location=mid)
    o = bpy.context.object
    o.rotation_euler = (0, math.acos(dz / length), math.atan2(dy, dx))
    parts = [_finish(o, m), _sphere(a, (r, r, r), m, 32), _sphere(b, (r, r, r), m, 32)]
    return parts


def _dome(radius, m):
    """Upper half of a sphere, centred on the origin."""
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=24, radius=radius)
    o = bpy.context.object
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="DESELECT")
    bpy.ops.object.mode_set(mode="OBJECT")
    for v in o.data.vertices:
        v.select = v.co.z < -1e-4
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.delete(type="VERT")
    bpy.ops.object.mode_set(mode="OBJECT")
    o.data.materials.append(m)
    for p in o.data.polygons:
        p.use_smooth = True
    sol = o.modifiers.new("solidify", "SOLIDIFY")
    sol.thickness = radius * 0.08
    return o


def _empty(name, loc):
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=loc)
    e = bpy.context.object
    e.name = name
    e.empty_display_size = 0.2
    return e


def _parent(children, parent):
    bpy.context.view_layer.update()
    inv = parent.matrix_world.inverted()
    for c in children:
        c.parent = parent
        c.matrix_parent_inverse = inv


class Grubb:
    """Controls:
    root        location (hops, walking), rotation
    upper       scale for squash & stretch (pivot at the hips)
    arms[i]     rotation_euler.y raises the arm (left arm positive, right negative)
    looks[i]    location offset moves the pupils
    pupils[i]   scale for pupil size
    lids[i]     driven via set_lid()
    mouth       scale.x = width, scale.z = openness
    """

    def __init__(self, location=(0, 0, 0)):
        body = _mat("grubb_body", GRUBB_COLOR, 0.6, sss=0.15)
        white = _mat("grubb_white", (0.95, 0.95, 0.95, 1), 0.25)
        black = _mat("grubb_black", (0.01, 0.01, 0.01, 1), 0.15)
        mouth_m = _mat("grubb_mouth", (0.12, 0.02, 0.03, 1), 0.6)
        tongue_m = _mat("grubb_tongue", (0.85, 0.3, 0.35, 1), 0.5)
        band_m = _mat("grubb_bandage", BANDAGE_COLOR, 0.7)

        self.root = _empty("grubb_root", (0, 0, 0))
        self.upper = _empty("grubb_upper", (0, 0, 0.75))
        _parent([self.upper], self.root)

        lower = []
        for x in (-0.38, 0.38):
            lower += _capsule((x, 0, 0.75), (x, 0, 0.25), 0.16, body)
            lower.append(_sphere((x, -0.08, 0.14), (0.26, 0.32, 0.14), body))
        _parent(lower, self.root)

        upper = [_rcube((0, 0, 1.75), (0.85, 0.62, 1.05), 0.45, body)]
        for a in (0.6, -0.6):
            upper.append(_rcube((0.42, -0.5, 2.62), (0.22, 0.03, 0.06), 0.02, band_m, rot=(0.35, a, 0.0)))

        self.arms = []
        for sx, sy, sz in SHOULDERS:
            s = 1 if sx > 0 else -1
            pivot = _empty(f"grubb_arm_{'r' if s > 0 else 'l'}", (sx, sy, sz))
            parts = _capsule((sx, sy, sz), (s * 1.1, -0.05, 1.2), 0.12, body)
            parts.append(_sphere((s * 1.13, -0.05, 1.1), (0.2, 0.16, 0.2), body, 32))
            _parent(parts, pivot)
            upper.append(pivot)
            self.arms.append(pivot)

        self.looks, self.pupils, self.lids, self.eye_r = [], [], [], []
        for i, (x, z, r) in enumerate(EYES):
            upper.append(_sphere((x, EYE_Y, z), (r, r * 0.7, r), white))
            look = _empty(f"grubb_look_{i}", (x, EYE_Y, z))
            pupil = _sphere((x, EYE_Y - r * 0.62, z), (r * 0.42, r * 0.17, r * 0.42), black, 32)
            _parent([pupil], look)
            # eyelid: a dome that rotates over the eye, inside an eye-shaped (squashed) pivot
            lid_pivot = _empty(f"grubb_lid_{i}", (x, EYE_Y, z))
            lid_pivot.scale = (1, 0.88, 1)
            lid = _dome(r * 1.06, body)
            lid.parent = lid_pivot
            upper.append(look)
            upper.append(lid_pivot)
            self.looks.append(look)
            self.pupils.append(pupil)
            self.lids.append(lid)
            self.eye_r.append((x, z, r))

        self.mouth = _empty("grubb_mouth", MOUTH_POS)
        mx, my, mz = MOUTH_POS
        mouth_parts = [_sphere(MOUTH_POS, (0.42, 0.12, 0.26), mouth_m),
                       _sphere((mx, my - 0.08, mz - 0.12), (0.22, 0.06, 0.1), tongue_m, 32)]
        for i in range(5):
            mouth_parts.append(_rcube((mx - 0.24 + i * 0.12, my - 0.085, mz + 0.15),
                                      (0.05, 0.03, 0.06), 0.02, white))
        _parent(mouth_parts, self.mouth)
        upper.append(self.mouth)

        _parent(upper, self.upper)
        self.root.location = location

    def set_lid(self, i, amount):
        """amount: 0 = eye fully open, 0.5 = half closed, 1 = closed."""
        amount = max(0.0, min(1.0, amount))
        self.lids[i].rotation_euler = (math.radians(-95 + 185 * amount), 0, 0)
