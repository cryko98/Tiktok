"""Episode JSON -> finished 1080x1920 TikTok MP4.

    python make_episode.py episodes/ep000_hello.json
    python make_episode.py episodes/ep000_hello.json --engine CYCLES --scale 0.5   # no GPU

Steps: TTS per line (Piper) -> timeline with lip-sync amplitudes ->
Blender renders frames -> ffmpeg adds voice + captions.
"""
import argparse
import json
import os
import shutil
import subprocess
import sys
import wave

import numpy as np

ROOT = os.path.dirname(os.path.abspath(__file__))
VOICE_MODEL = os.path.join(ROOT, "voices", "en-us-libritts-high.onnx")
FONT = os.path.join(ROOT, "assets", "fonts", "Inter-ExtraBold.otf")
SAMPLE_RATE = 44100


def run(cmd, **kw):
    print("+", " ".join(cmd) if isinstance(cmd, list) else cmd, flush=True)
    subprocess.run(cmd, check=True, **kw)


def tts(text, speaker, pitch, out_wav, tmp):
    raw = os.path.join(tmp, "raw.wav")
    run([sys.executable, "-m", "piper", "-m", VOICE_MODEL, "-s", str(speaker), "-f", raw],
        input=text.encode())
    # pitch the voice up for a small cartoon character, keep the pace natural
    run(["ffmpeg", "-y", "-loglevel", "error", "-i", raw, "-af",
         f"asetrate=22050*{pitch},aresample={SAMPLE_RATE},atempo={1.08 / pitch:.4f}",
         "-ac", "1", out_wav])


def read_wav(path):
    with wave.open(path) as w:
        data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16).astype(np.float32) / 32768
        return data, w.getframerate()


def envelope(samples, sr, fps):
    """Per-video-frame mouth openness 0..1 from the audio loudness."""
    hop = sr / fps
    n = int(np.ceil(len(samples) / hop))
    rms = np.array([np.sqrt(np.mean(samples[int(i * hop):int((i + 1) * hop)] ** 2) + 1e-9) for i in range(n)])
    ref = np.percentile(rms, 90) or 1.0
    env = np.clip(rms / ref, 0, 1)
    env[env < 0.15] = 0
    return np.convolve(env, [0.25, 0.5, 0.25], mode="same")


def build_timeline(ep, tmp):
    fps = ep.get("fps", 24)
    voice = ep.get("voice", {})
    t = ep.get("lead_in", 0.4)
    beats, clips = [], []
    for i, b in enumerate(ep["beats"]):
        start = t
        if b.get("text"):
            wav = os.path.join(tmp, f"line_{i:02d}.wav")
            tts(b["text"], voice.get("speaker", 0), voice.get("pitch", 1.3), wav, tmp)
            samples, sr = read_wav(wav)
            clips.append((start, wav))
            t += len(samples) / sr
        t += b.get("hold", 0.0) + b.get("pause_after", 0.35)
        beats.append({**b, "start": int(round(start * fps)) + 1, "start_s": start, "end_s": t})
    duration = t + ep.get("tail", 0.6)
    frames = int(np.ceil(duration * fps))

    # one voice track, and a per-frame loudness curve for lip-sync
    track = np.zeros(int(duration * SAMPLE_RATE) + SAMPLE_RATE, dtype=np.float32)
    for start, wav in clips:
        s, _ = read_wav(wav)
        i = int(start * SAMPLE_RATE)
        track[i:i + len(s)] += s
    amp = envelope(track, SAMPLE_RATE, fps)[:frames]
    amp = np.pad(amp, (0, max(0, frames - len(amp))))
    voice_wav = os.path.join(tmp, "voice.wav")
    with wave.open(voice_wav, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes((np.clip(track, -1, 1) * 32767).astype(np.int16).tobytes())
    return {"fps": fps, "frames": frames, "duration": duration, "beats": beats,
            "amp": [round(float(a), 3) for a in amp]}, voice_wav


def blender_cmd(script, args):
    """Prefer a real Blender install; fall back to the `bpy` pip module."""
    blender = os.environ.get("BLENDER") or shutil.which("blender")
    if blender:
        return [blender, "-b", "-P", script, "--"] + args
    return [sys.executable, script] + args


def captions_filter(timeline, tmp):
    parts = []
    for i, b in enumerate(timeline["beats"]):
        if not b.get("text"):
            continue
        txt = os.path.join(tmp, f"cap_{i:02d}.txt")
        with open(txt, "w") as f:
            f.write(b.get("caption", b["text"]).upper())
        parts.append(
            f"drawtext=fontfile='{FONT}':textfile='{txt}':fontsize=78:fontcolor=white"
            f":borderw=7:bordercolor=black:x=(w-text_w)/2:y=h*0.70"
            f":enable='between(t,{b['start_s']:.2f},{b['end_s']:.2f})'")
    return ",".join(parts) or "null"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("episode")
    ap.add_argument("--engine", default="EEVEE", help="EEVEE (GPU, fast) or CYCLES (CPU)")
    ap.add_argument("--scale", type=float, default=1.0, help="render resolution scale")
    ap.add_argument("--samples", type=int, default=16)
    ap.add_argument("--out", default=os.path.join(ROOT, "output"))
    args = ap.parse_args()

    ep = json.load(open(args.episode))
    name = os.path.splitext(os.path.basename(args.episode))[0]
    tmp = os.path.join(args.out, name + "_work")
    os.makedirs(tmp, exist_ok=True)

    timeline, voice_wav = build_timeline(ep, tmp)
    tl_path = os.path.join(tmp, "timeline.json")
    json.dump(timeline, open(tl_path, "w"), indent=1)
    print(f"timeline: {timeline['frames']} frames, {timeline['duration']:.1f}s", flush=True)

    frames_dir = os.path.join(tmp, "frames")
    run(blender_cmd(os.path.join(ROOT, "grubb", "animate.py"),
                    [tl_path, frames_dir, "--engine", args.engine, "--scale", str(args.scale),
                     "--samples", str(args.samples)]))

    out_mp4 = os.path.join(args.out, name + ".mp4")
    vf = "scale=1080:1920:flags=lanczos," + captions_filter(timeline, tmp)
    run(["ffmpeg", "-y", "-loglevel", "error", "-framerate", str(timeline["fps"]),
         "-i", os.path.join(frames_dir, "f_%04d.png"), "-i", voice_wav,
         "-vf", vf, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "18",
         "-c:a", "aac", "-b:a", "192k", "-shortest", out_mp4])
    print("done:", out_mp4)


if __name__ == "__main__":
    main()
