"""The island set, lights, camera and render settings."""
import math

import bpy


def _mat(name, color, rough=0.8):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = color
    b.inputs["Roughness"].default_value = rough
    return m


def _add(o, m):
    o.data.materials.append(m)
    for p in o.data.polygons:
        p.use_smooth = True
    return o


def _palm(x, y, h, m_trunk, m_leaf):
    bpy.ops.mesh.primitive_cylinder_add(vertices=12, radius=0.18, depth=h, location=(x, y, h / 2))
    _add(bpy.context.object, m_trunk).rotation_euler = (0, 0.12, 0)
    for i in range(6):
        a = i / 6 * 2 * math.pi
        bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=8,
                                             location=(x + 0.12 * h + math.cos(a) * 1.1, y + math.sin(a) * 1.1, h - 0.25))
        leaf = _add(bpy.context.object, m_leaf)
        leaf.scale = (1.4, 0.45, 0.12)
        leaf.rotation_euler = (0, 0.35, a)


def build_island():
    bpy.ops.mesh.primitive_plane_add(size=300, location=(0, 0, -0.08))
    _add(bpy.context.object, _mat("sea", (0.0, 0.45, 0.75, 1), 0.2))
    bpy.ops.mesh.primitive_uv_sphere_add(segments=96, ring_count=48, location=(0, 2, -0.55))
    island = bpy.context.object
    island.scale = (14, 14, 0.6)
    _add(island, _mat("sand", (0.8, 0.62, 0.38, 1), 0.9))
    rock = _mat("rock", (0.45, 0.42, 0.4, 1), 0.8)
    for loc, s in (((-3.4, 3.5, 0.0), 0.7), ((4.2, 6.0, 0.0), 1.0)):
        bpy.ops.mesh.primitive_ico_sphere_add(subdivisions=2, location=loc)
        r = bpy.context.object
        r.scale = (s, s * 0.8, s * 0.6)
        _add(r, rock)
    trunk = _mat("trunk", (0.45, 0.3, 0.18, 1), 0.9)
    leaf = _mat("leaf", (0.1, 0.55, 0.15, 1), 0.7)
    _palm(-4.5, 8, 4.5, trunk, leaf)
    _palm(5.5, 11, 5.5, trunk, leaf)


def setup(engine="EEVEE", width=1080, height=1920, fps=24, samples=16):
    sc = bpy.context.scene
    if engine.upper() == "CYCLES":
        sc.render.engine = "CYCLES"
        sc.cycles.device = "CPU"
        sc.cycles.samples = samples
        sc.cycles.use_denoising = True
        sc.render.use_persistent_data = True
        sc.cycles.max_bounces = 4
        sc.cycles.use_adaptive_sampling = True
    else:
        try:  # Blender 4.2-4.x calls it EEVEE_NEXT, 5.x is back to plain EEVEE
            sc.render.engine = "BLENDER_EEVEE_NEXT"
        except TypeError:
            sc.render.engine = "BLENDER_EEVEE"
    sc.render.resolution_x = width
    sc.render.resolution_y = height
    sc.render.fps = fps
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.exposure = -0.3

    w = bpy.data.worlds.new("sky")
    w.use_nodes = True
    bg = w.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.2, 0.55, 1.0, 1)
    bg.inputs[1].default_value = 0.9
    sc.world = w

    bpy.ops.object.light_add(type="SUN", rotation=(math.radians(50), 0, math.radians(-30)))
    bpy.context.object.data.energy = 2.5
    bpy.context.object.data.angle = math.radians(10)
    bpy.ops.object.light_add(type="AREA", location=(-3, -5, 4), rotation=(math.radians(55), 0, math.radians(-30)))
    bpy.context.object.data.energy = 250
    bpy.context.object.data.size = 5

    bpy.ops.object.camera_add(location=(0, -8.5, 1.8), rotation=(math.radians(87), 0, 0))
    cam = bpy.context.object
    cam.data.lens = 40
    sc.camera = cam
    return cam

