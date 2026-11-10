"""Frames + soundtrack -> TikTok-ready MP4 (1080x1920, 30 fps, H.264 High, AAC 48 kHz).

    python motion/encode.py output/weeks4000 [--fps 30]

Audio is loudness-normalized in two passes (linear gain, no pumping) to -14 LUFS / -1.5 dBTP,
the level TikTok plays at, so the platform won't squash it.
"""
import argparse
import json
import os
import re
import subprocess

ap = argparse.ArgumentParser()
ap.add_argument("workdir")
ap.add_argument("--fps", type=int, default=30)
ap.add_argument("--name")
args = ap.parse_args()

wd = os.path.abspath(args.workdir)
name = args.name or os.path.basename(wd)
wav = os.path.join(wd, "soundtrack.wav")
norm = os.path.join(wd, "soundtrack_norm.wav")
mp4 = os.path.join(wd, name + ".mp4")

target = "I=-14:TP=-1.5:LRA=11"
p = subprocess.run(["ffmpeg", "-hide_banner", "-nostats", "-i", wav, "-af", f"loudnorm={target}:print_format=json",
                    "-f", "null", "-"], capture_output=True, text=True)
m = json.loads(re.search(r"\{[^{}]*\"input_i\"[^{}]*\}", p.stderr).group(0))
af = (f"loudnorm={target}:linear=true:measured_I={m['input_i']}:measured_TP={m['input_tp']}"
      f":measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}")
subprocess.run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", wav, "-af", af, "-ar", "48000", norm], check=True)

subprocess.run([
    "ffmpeg", "-y", "-hide_banner", "-loglevel", "error",
    "-framerate", str(args.fps), "-i", os.path.join(wd, "frames", "f_%05d.png"),
    "-i", norm,
    "-c:v", "libx264", "-preset", "slow", "-crf", "17", "-maxrate", "11M", "-bufsize", "22M", "-tune", "film",
    "-pix_fmt", "yuv420p", "-profile:v", "high", "-level", "4.2",
    "-x264-params", f"keyint={args.fps * 2}:min-keyint={args.fps}",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    "-c:a", "aac", "-b:a", "256k", "-ar", "48000",
    "-movflags", "+faststart", "-shortest", mp4,
], check=True)
print("done:", mp4)
