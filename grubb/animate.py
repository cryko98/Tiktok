"""Blender side of the pipeline: timeline JSON -> keyframed scene -> PNG frames.

Run with either
    blender -b -P grubb/animate.py -- timeline.json out_dir [--engine EEVEE|CYCLES] [--scale 1.0]
or, with the `bpy` pip module,
    python grubb/animate.py timeline.json out_dir ...
"""
import argparse
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import bpy  # noqa: E402

from grubb.character import Grubb  # noqa: E402
from grubb import stage  # noqa: E402

# pupil offset (x, z), pupil size, lid (0 open .. 1 closed), mouth width, mouth rest openness
EXPRESSIONS = {
    "neutral":   dict(look=(0.0, 0.0),   pupil=1.0,  lid=0.0,  mouth_w=0.7, mouth=0.12),
    "happy":     dict(look=(0.0, -0.03), pupil=1.0,  lid=0.0,  mouth_w=1.0, mouth=0.55),
    "side":      dict(look=(0.09, 0.0),  pupil=1.0,  lid=0.5,  mouth_w=0.45, mouth=0.1),
    "stillhere": dict(look=(0.0, 0.02),  pupil=1.0,  lid=0.4,  mouth_w=0.65, mouth=0.18),
    "shock":     dict(look=(0.0, 0.0),   pupil=0.65, lid=0.0,  mouth_w=0.45, mouth=0.85),
    "sad":       dict(look=(0.0, -0.06), pupil=1.1,  lid=0.3,  mouth_w=0.5, mouth=0.12),
}
BLEND_FRAMES = 4


def lerp(a, b, t):
    return a + (b - a) * t


def smoothstep(t):
    t = max(0.0, min(1.0, t))
    return t * t * (3 - 2 * t)


def beat_at(beats, f):
    current = beats[0]
    for b in beats:
        if b["start"] <= f:
            current = b
    return current


def expression_at(beats, f):
    """Expression params at frame f, blended over BLEND_FRAMES after each change."""
    prev = EXPRESSIONS[beats[0]["expr"]]
    for i, b in enumerate(beats):
        if b["start"] > f:
            break
        cur = EXPRESSIONS[b["expr"]]
        t = smoothstep((f - b["start"]) / BLEND_FRAMES)
        mixed = {k: (tuple(lerp(p, c, t) for p, c in zip(prev[k], cur[k])) if isinstance(cur[k], tuple)
                     else lerp(prev[k], cur[k], t)) for k in cur}
        prev = mixed
    return prev


def blink_at(f, fps, blocked):
    """Blink roughly every 3.3 s, closing for ~4 frames."""
    if blocked:
        return 0.0
    period = int(fps * 3.3)
    phase = (f + 17) % period
    return {0: 0.5, 1: 1.0, 2: 1.0, 3: 0.5}.get(phase, 0.0)


def arm_angles(action, t_in_beat, f, fps):
    """Returns (left, right) arm rotation around Y. 0 = arms hanging."""
    sway = 0.05 * math.sin(f / fps * 2.2)
    if action == "wave":
        ramp = smoothstep(t_in_beat * fps / 6)
        return 0.15 + sway, -lerp(0.0, 2.0 + 0.35 * math.sin(f / fps * 14), ramp)
    if action == "arms_up":
        ramp = smoothstep(t_in_beat * fps / 5)
        return lerp(0, 2.2, ramp) + sway, -lerp(0, 2.2, ramp) - sway
    if action == "shrug":
        ramp = smoothstep(t_in_beat * fps / 5)
        return lerp(0, 0.9, ramp), -lerp(0, 0.9, ramp)
    return 0.15 + sway, -0.15 - sway


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("timeline")
    ap.add_argument("out_dir")
    ap.add_argument("--engine", default="EEVEE")
    ap.add_argument("--scale", type=float, default=1.0, help="resolution scale, 0.5 = 540x960")
    ap.add_argument("--samples", type=int, default=16)
    ap.add_argument("--frames", default=None, help="only render a range, e.g. 1-24")
    args = ap.parse_args(argv)

    tl = json.load(open(args.timeline))
    fps, total = tl["fps"], tl["frames"]
    beats, amp = tl["beats"], tl["amp"]

    bpy.ops.wm.read_factory_settings(use_empty=True)
    stage.build_island()
    g = Grubb()
    cam = stage.setup(args.engine, int(1080 * args.scale), int(1920 * args.scale), fps, args.samples)
    sc = bpy.context.scene
    sc.frame_start, sc.frame_end = 1, total

    cam_start, cam_end = cam.location.y, cam.location.y + 1.2
    for f in range(1, total + 1):
        b = beat_at(beats, f)
        t_in_beat = (f - b["start"]) / fps
        ex = expression_at(beats, f)

        # body: idle breathing, plus a little hop when a beat asks for it
        breathe = 0.02 * math.sin(f / fps * 2 * math.pi * 0.6)
        hop = 0.0
        if b.get("action") == "hop" and t_in_beat < 0.6:
            hop = math.sin(t_in_beat / 0.6 * math.pi) * 0.5
        talk = amp[f - 1] if b.get("text") else 0.0
        g.upper.scale = (1 - breathe / 2 - talk * 0.015, 1, 1 + breathe + talk * 0.03)
        g.root.location = (0, 0, hop)
        g.root.keyframe_insert("location", frame=f)
        g.upper.keyframe_insert("scale", frame=f)

        left, right = arm_angles(b.get("action", "idle"), t_in_beat, f, fps)
        g.arms[0].rotation_euler = (0, left, 0)
        g.arms[1].rotation_euler = (0, right, 0)
        for a in g.arms:
            a.keyframe_insert("rotation_euler", frame=f)

        lid = max(ex["lid"], blink_at(f, fps, blocked=ex["lid"] > 0.6))
        for i in range(2):
            x, z, r = g.eye_r[i]
            k = r / 0.3  # smaller eye, smaller pupil travel
            g.looks[i].location = (x + ex["look"][0] * k, -0.6, z + ex["look"][1] * k)
            g.looks[i].keyframe_insert("location", frame=f)
            g.pupils[i].scale = (r * 0.42 * ex["pupil"], r * 0.17, r * 0.42 * ex["pupil"])
            g.pupils[i].keyframe_insert("scale", frame=f)
            g.set_lid(i, lid)
            g.lids[i].keyframe_insert("rotation_euler", frame=f)

        open_ = min(1.0, ex["mouth"] + talk * 0.75)
        g.mouth.scale = (ex["mouth_w"] * (1 - talk * 0.15), 1, max(0.08, open_))
        g.mouth.keyframe_insert("scale", frame=f)

        cam.location.y = lerp(cam_start, cam_end, smoothstep(f / total))
        cam.keyframe_insert("location", frame=f)

    if args.frames:
        a, b = map(int, args.frames.split("-"))
        sc.frame_start, sc.frame_end = a, b
    os.makedirs(args.out_dir, exist_ok=True)
    sc.render.filepath = os.path.join(os.path.abspath(args.out_dir), "f_")
    sc.render.image_settings.file_format = "PNG"
    bpy.ops.render.render(animation=True)


if __name__ == "__main__":
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else sys.argv[1:]
    main(argv)
