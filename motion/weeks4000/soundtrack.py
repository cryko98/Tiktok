"""4,000 WEEKS — original soundtrack, synthesized from scratch and locked to the picture.

    node motion/weeks4000/timeline.js > output/weeks4000/cues.json
    python motion/weeks4000/soundtrack.py output/weeks4000/cues.json output/weeks4000/soundtrack.wav

D minor, 100 BPM, 14 bars. Everything is generated here (no samples): felt piano, supersaw pads,
a formant "choir", clock ticks, sub impacts, risers, fire crackle, sleep breathing, phone buzz,
glitches and a heartbeat. The grid assembling row by row is sonified as 80 rising plucks, the
burning weeks crackle exactly when each dot burns. The tail of the piece is wrapped around onto
its start, so the audio loops as seamlessly as the picture.
"""
import json
import sys
import wave

import numpy as np
from scipy import signal

SR = 48000
RNG = np.random.default_rng(4000)
cues = json.load(open(sys.argv[1]))
OUT = sys.argv[2]
T = cues["T"]
BEAT, BAR, DUR = cues["beat"], cues["bar"], cues["duration"]
TAIL = 6.0
N = int((DUR + TAIL) * SR)


def bus():
    return np.zeros((2, N))


music, drums, sfx, verb_send = bus(), bus(), bus(), bus()
# everything that starts at/after the hard cut (23.6 s) lives on its own buses, so the cut is real silence
POST = {id(music): bus(), id(drums): bus(), id(sfx): bus()}
verb_post = bus()


# ------------------------------------------------------------------ helpers
def mtof(m):
    return 440.0 * 2 ** ((m - 69) / 12)


def tt(n):
    return np.arange(n) / SR


def pan2(x, pan):
    a = (pan + 1) * np.pi / 4
    return np.stack([x * np.cos(a), x * np.sin(a)])


def place(b, t0, sig, gain=1.0, pan=0.0, send=0.0):
    vs = verb_send
    if t0 >= T["cut"] - 1e-6:
        b, vs = POST[id(b)], verb_post
    if sig.ndim == 1:
        sig = pan2(sig, pan)
    i = int(round(t0 * SR))
    if i < 0:
        sig = sig[:, -i:]
        i = 0
    j = min(N, i + sig.shape[1])
    if j <= i:
        return
    b[:, i:j] += sig[:, :j - i] * gain
    if send:
        vs[:, i:j] += sig[:, :j - i] * gain * send


def sos(kind, f, order=2):
    return signal.butter(order, f, btype=kind, fs=SR, output="sos")


def filt(x, kind, f, order=2):
    return signal.sosfilt(sos(kind, f, order), x, axis=-1)


def sweep_filter(x, kind, f_of_t, block=256, order=2):
    """time-varying Butterworth filter, f_of_t(time array) -> cutoff (Hz); works on mono or stereo"""
    stereo = x.ndim == 2
    xs = x if stereo else x[None]
    out = np.zeros_like(xs)
    zi = None
    for s in range(0, xs.shape[1], block):
        tc = (s + block / 2) / SR
        f = float(np.clip(f_of_t(tc), 20, SR * 0.45))
        if kind == "bandpass":
            bw = f * 0.6
            sv = signal.butter(order, [max(20, f - bw / 2), min(SR * 0.45, f + bw / 2)], btype="bandpass", fs=SR, output="sos")
        else:
            sv = signal.butter(order, f, btype=kind, fs=SR, output="sos")
        if zi is None:
            zi = np.zeros((xs.shape[0], sv.shape[0], 2))
        for c in range(xs.shape[0]):
            out[c, s:s + block], zi[c] = signal.sosfilt(sv, xs[c, s:s + block], zi=zi[c])
    return out if stereo else out[0]


def saw(freq, n, phase=0.0):
    """band-limited (polyBLEP) saw; freq may be an array"""
    f = np.broadcast_to(np.asarray(freq, float), (n,))
    dt = f / SR
    ph = (phase + np.cumsum(dt)) % 1.0
    s = 2 * ph - 1
    m = ph < dt
    x = ph[m] / dt[m]
    s[m] -= x + x - x * x - 1
    m = ph > 1 - dt
    x = (ph[m] - 1) / dt[m]
    s[m] -= x * x + x + x + 1
    return s


def sine(freq, n, phase=0.0):
    f = np.broadcast_to(np.asarray(freq, float), (n,))
    return np.sin(2 * np.pi * (phase + np.cumsum(f) / SR))


def noise(n):
    return RNG.standard_normal(n)


def env_ar(n, a, r, curve=1.0):
    t = tt(n)
    e = np.minimum(1, t / max(a, 1e-4)) * np.exp(-np.maximum(0, t - a) / max(r, 1e-4))
    return e ** curve


def env_pad(n, a, rel):
    e = np.ones(n)
    na, nr = int(a * SR), int(rel * SR)
    e[:na] = np.linspace(0, 1, na) ** 2
    if nr:
        e[-nr:] *= np.linspace(1, 0, nr) ** 1.5
    return e


# ------------------------------------------------------------------ instruments
def pad(notes, dur, bright=1800, a=0.9, rel=1.6, voices=3, detune=0.12):
    n = int((dur + rel) * SR)
    out = np.zeros((2, n))
    for m in notes:
        f0 = mtof(m)
        for v in range(voices):
            d = (v - (voices - 1) / 2) * detune
            f = f0 * 2 ** (d / 12)
            lfo = 1 + 0.002 * np.sin(2 * np.pi * (0.2 + 0.07 * v) * tt(n) + v)
            out += pan2(saw(f * lfo, n, RNG.random()), (v - (voices - 1) / 2) * 0.7)
    out = filt(out, "lowpass", bright, 2)
    out *= env_pad(n, a, rel) / (len(notes) * voices) ** 0.5
    return out


def choir(notes, dur, a=1.2, rel=1.8):
    n = int((dur + rel) * SR)
    src = np.zeros((2, n))
    for m in notes:
        for v in range(4):
            f = mtof(m) * 2 ** ((v - 1.5) * 0.08 / 12)
            vib = 1 + 0.004 * np.sin(2 * np.pi * (5.1 + 0.3 * v) * tt(n) + v)
            src += pan2(saw(f * vib, n, RNG.random()), (v - 1.5) * 0.5)
    out = np.zeros_like(src)
    for fc, g in ((730, 1.0), (1090, 0.6), (2440, 0.25)):   # vowel "ah"
        out += g * signal.sosfilt(signal.butter(2, [fc * 0.85, fc * 1.15], btype="bandpass", fs=SR, output="sos"), src, axis=-1)
    return out * env_pad(n, a, rel) / (len(notes) * 4) ** 0.5 * 2.2


def piano(m, vel=0.7, dur=4.5):
    n = int(dur * SR)
    t = tt(n)
    f0, B = mtof(m), 0.00035
    x = np.zeros(n)
    for k in range(1, 14):
        fk = f0 * k * np.sqrt(1 + B * k * k)
        if fk > 12000:
            break
        amp = (1 / k ** 1.15) * (vel ** (0.4 * k))
        dec = np.exp(-t * (0.55 + 0.42 * k)) * 0.8 + 0.2 * np.exp(-t * (0.2 + 0.1 * k))
        for det in (-0.0006, 0.0006):
            x += amp * dec * np.sin(2 * np.pi * fk * (1 + det) * t + RNG.random() * 6.28)
    ham = filt(noise(int(0.012 * SR)) * np.linspace(1, 0, int(0.012 * SR)) ** 2, "lowpass", 2500)
    x[:len(ham)] += 0.25 * ham * vel
    x *= np.minimum(1, t / 0.003)
    x = filt(x, "lowpass", 2200 + 3500 * vel)
    return x * vel * 0.22


def pluck(m, vel=1.0):
    n = int(0.9 * SR)
    t = tt(n)
    f = mtof(m)
    x = (np.sin(2 * np.pi * f * t) + 0.35 * np.sin(4 * np.pi * f * t) * np.exp(-t * 9)
         + 0.12 * np.sin(6 * np.pi * f * t) * np.exp(-t * 16))
    return x * np.exp(-t * 6.5) * np.minimum(1, t / 0.002) * vel


def bell(f, dur=3.0, index=3.0):
    n = int(dur * SR)
    t = tt(n)
    I = index * np.exp(-t * 2.5)
    x = np.sin(2 * np.pi * f * t + I * np.sin(2 * np.pi * f * 2.76 * t))
    x = x * np.exp(-t * 1.6) + 0.5 * np.sin(np.pi * f * t) * np.exp(-t * 0.9)
    return x * np.minimum(1, t / 0.002)


def kick(gain=1.0, decay=6.0, tone=45):
    n = int(0.7 * SR)
    t = tt(n)
    f = tone + 110 * np.exp(-t * 32)
    x = np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * decay)
    x += 0.3 * filt(noise(n), "highpass", 3000) * np.exp(-t * 180)
    return np.tanh(x * 1.6) * gain


def snare(gain=1.0):
    n = int(0.5 * SR)
    t = tt(n)
    nz = signal.sosfilt(signal.butter(2, [1200, 9000], btype="bandpass", fs=SR, output="sos"), noise(n))
    x = nz * np.exp(-t * 15) * 0.8 + np.sin(2 * np.pi * 190 * t) * np.exp(-t * 30) * 0.6
    for d in (0.0, 0.011, 0.023):  # clap layers
        i = int(d * SR)
        x[i:] += 0.35 * nz[:n - i] * np.exp(-tt(n - i) * 60)
    return x * gain


def tick(hi=True, gain=1.0):
    n = int(0.06 * SR)
    t = tt(n)
    f = 2900 if hi else 1900
    x = np.sin(2 * np.pi * f * t) * np.exp(-t * 260) + 0.5 * filt(noise(n), "highpass", 4000) * np.exp(-t * 500)
    return x * gain


def boom(gain=1.0, length=3.0, f0=95, f1=28):
    n = int(length * SR)
    t = tt(n)
    f = f1 + (f0 - f1) * np.exp(-t * 2.2)
    sub = np.tanh(1.8 * np.sin(2 * np.pi * np.cumsum(f) / SR)) * np.exp(-t * 1.5)
    crack = filt(noise(n), "highpass", 1800) * np.exp(-t * 22)
    rumble = filt(noise(n), "lowpass", 160, 4) * np.exp(-t * 1.2) * 2.5
    fb = 60 + 120 * np.exp(-t * 9)
    body = filt(np.tanh(3 * np.sin(2 * np.pi * np.cumsum(fb) / SR)), "lowpass", 900) * np.exp(-t * 5) * 0.45
    sub = sub + body
    l = sub + 0.45 * crack + rumble
    r = sub + 0.45 * filt(noise(n), "highpass", 1800) * np.exp(-t * 22) + filt(noise(n), "lowpass", 160, 4) * np.exp(-t * 1.2) * 2.5
    return np.stack([l, r]) * gain


def riser(dur, gain=1.0, f_lo=300, f_hi=9000, pitch=(50, 74)):
    n = int(dur * SR)
    t = tt(n)
    u = t / dur
    nz = np.stack([noise(n), noise(n)])
    x = sweep_filter(nz, "bandpass", lambda tc: f_lo * (f_hi / f_lo) ** (tc / dur)) * 0.9
    p = pitch[0] + (pitch[1] - pitch[0]) * u ** 1.6
    tone = sum(saw(mtof(p + d), n, RNG.random()) for d in (-0.15, 0, 0.15, 12)) / 4
    tone = sweep_filter(tone, "lowpass", lambda tc: 400 + 5000 * (tc / dur) ** 2)
    trem = 0.75 + 0.25 * np.sin(2 * np.pi * np.cumsum(4 + 22 * u ** 2) / SR)
    out = (x + pan2(tone, 0) * 0.6) * (u ** 2.4 * trem)
    return out * gain


def reverse_swell(dur, gain=1.0, hp=2500):
    n = int(dur * SR)
    t = tt(n)
    x = np.stack([filt(noise(n), "highpass", hp), filt(noise(n), "highpass", hp)]) * np.exp(-t * 3.0)
    return x[:, ::-1] * gain


def whoosh(dur, gain=1.0, f_peak=2500, pan_from=-0.6, pan_to=0.6):
    n = int(dur * SR)
    t = tt(n)
    u = t / dur
    bell_env = np.sin(np.pi * u) ** 2
    x = sweep_filter(noise(n), "bandpass", lambda tc: 300 + f_peak * np.sin(np.pi * tc / dur))
    pans = pan_from + (pan_to - pan_from) * u
    a = (pans + 1) * np.pi / 4
    return np.stack([x * np.cos(a), x * np.sin(a)]) * bell_env * gain


def heartbeat(gain=1.0):
    n = int(0.6 * SR)
    t = tt(n)
    out = np.zeros(n)
    for d, g, f in ((0.0, 1.0, 58), (0.24, 0.7, 50)):
        i = int(d * SR)
        tl = tt(n - i)
        ff = f + 30 * np.exp(-tl * 25)
        out[i:] += g * np.sin(2 * np.pi * np.cumsum(ff) / SR) * np.minimum(1, tl / 0.006) * np.exp(-tl * 13)
        thump = filt(noise(n - i), "lowpass", 700) * np.exp(-tl * 45) * 0.5
        out[i:] += g * thump
    # saturate for harmonics a phone speaker can actually play, then keep it soft
    return filt(np.tanh(out * 3.0), "lowpass", 1400) * gain * 0.8


def buzz(dur, gain=1.0):
    n = int(dur * SR)
    t = tt(n)
    x = saw(152 + 3 * np.sin(2 * np.pi * 37 * t), n)
    x = filt(x, "lowpass", 900) * (0.8 + 0.2 * np.sign(np.sin(2 * np.pi * 76 * t)))
    return x * env_pad(n, 0.015, 0.04) * gain


def chirp(f0, f1, dur=0.035, gain=1.0):
    n = int(dur * SR)
    f = np.linspace(f0, f1, n)
    return sine(f, n) * np.hanning(n) * gain


def crackle(gain=1.0):
    n = int(RNG.uniform(0.002, 0.007) * SR)
    fc = RNG.uniform(1200, 6500)
    x = signal.sosfilt(signal.butter(2, [fc * 0.7, fc * 1.3], btype="bandpass", fs=SR, output="sos"), noise(n))
    return x * np.exp(-tt(n) * 900) * gain


def breath(dur=2.4, gain=1.0):
    n = int(dur * SR)
    t = tt(n)
    e = np.where(t < 1.0, np.sin(np.pi / 2 * t / 1.0) ** 2, np.exp(-(t - 1.0) * 2.2))
    x = signal.sosfilt(signal.butter(2, [350, 2200], btype="bandpass", fs=SR, output="sos"), noise(n))
    return x * e * gain


def bitcrush(x, bits=6, hold=4):
    y = np.repeat(x[..., ::hold], hold, axis=-1)[..., :x.shape[-1]]
    q = 2 ** bits
    return np.round(y * q) / q


# ------------------------------------------------------------------ harmony
Dm9 = [50, 57, 60, 64, 65]
Bbmaj7 = [46, 53, 57, 62, 69]
F_A = [45, 53, 60, 64, 67]
Gm9 = [43, 50, 58, 65, 69]
Asus = [45, 52, 57, 62, 64]
A = [45, 52, 57, 61, 64]
Dm = [50, 57, 62, 65, 69]
C = [48, 55, 60, 64, 67]
Bb = [46, 53, 58, 62, 65, 70]
F = [41, 53, 57, 60, 65, 69]
Cbig = [48, 55, 60, 64, 67, 72]

chords = [
    (0.0, 4.8, Dm9, 1100, 0.32),
    (4.8, 2.4, Bbmaj7, 2400, 0.55),
    (7.2, 2.4, F_A, 2400, 0.5),
    (9.6, 2.4, Gm9, 2000, 0.5),
    (12.0, 1.2, Asus, 2200, 0.5),
    (13.2, 1.2, A, 2600, 0.55),
    (14.4, 2.4, Bbmaj7, 1400, 0.5),
    (16.8, 2.4, Gm9, 1400, 0.5),
    (19.2, 2.4, Dm, 2600, 0.42),
    (21.6, 2.0, C, 3000, 0.42),
    (26.4, 1.2, Bb, 3000, 0.62),
    (27.6, 1.2, F, 3600, 0.7),
    (28.8, 1.2, Cbig, 3600, 0.7),
    (30.0, 1.0, Dm, 2400, 0.45),
    (31.0, 2.6, Dm9, 1100, 0.32),
]
for t0, d, notes, br, g in chords:
    place(music, t0 - 0.05, pad(notes, d + 0.05, bright=br, a=0.25 if t0 > 0 else 0.05, rel=1.4), gain=g, send=0.35)

# choir swells
place(music, 4.8, choir([62, 69, 74], 4.6, a=0.6), gain=0.18, send=0.5)
place(music, 26.4, choir([62, 65, 70], 1.2, a=0.7, rel=0.6), gain=0.22, send=0.5)
place(music, 27.6, choir([65, 69, 72, 77], 2.4, a=0.25, rel=2.0), gain=0.32, send=0.6)

# felt piano motif (intro, ending, "what's left", climax)
motif = [(0.05, 69, 0.75), (0.65, 74, 0.6), (1.25, 76, 0.6), (1.85, 77, 0.7), (2.45, 72, 0.5), (3.05, 69, 0.55),
         (24.05, 77, 0.55), (25.25, 76, 0.5), (25.85, 74, 0.45),
         (26.4, 74, 0.6), (27.0, 77, 0.6), (27.6, 81, 0.8), (28.2, 79, 0.6), (28.8, 77, 0.65), (29.4, 76, 0.6),
         (31.3, 69, 0.7), (31.9, 74, 0.55), (32.5, 76, 0.55), (33.1, 77, 0.5)]
for t0, m, v in motif:
    place(music, t0, piano(m, v), gain=1.0, pan=(m - 72) / 20, send=0.55)
    place(music, t0, piano(m - 12, v * 0.6), gain=0.5, pan=(m - 84) / 20, send=0.55)

# ------------------------------------------------------------------ rhythm
beats = np.arange(0, DUR, BEAT)
for k, b in enumerate(beats):
    in_intro = b < T["boom"] - 0.05
    in_end = b >= T["implode"] + 0.2
    in_grid = 7.2 <= b < 14.4
    in_sleep = 14.4 <= b < 19.2
    in_phone = 19.2 <= b < T["cut"]
    in_climax = 27.6 <= b < 30.0
    if in_intro or in_end or in_grid or in_phone or in_climax:
        place(drums, b, tick(k % 2 == 0), gain=0.16 if (in_intro or in_end) else 0.11, pan=0.25 if k % 2 else -0.25, send=0.2)
    if in_sleep and k % 2 == 0:
        place(drums, b, tick(True), gain=0.05, send=0.4)
    bar_pos = round((b / BEAT) % 4)
    if in_grid or in_phone or in_climax:
        if bar_pos == 0:
            place(drums, b, kick(), gain=0.9)
        if bar_pos == 2:
            place(drums, b, snare(), gain=0.38, send=0.3)
        if in_phone and bar_pos in (1, 3) and b + BEAT / 2 < T["cut"]:
            place(drums, b + BEAT / 2, kick(0.6, 9), gain=0.6)
        for h in (0.5,):
            if b + BEAT * h >= T["cut"] and in_phone:
                continue
            place(drums, b + BEAT * h, filt(noise(int(0.04 * SR)), "highpass", 7000) * np.exp(-tt(int(0.04 * SR)) * 90),
                  gain=0.05, pan=0.4)
    if in_sleep and bar_pos == 0:
        place(drums, b, filt(kick(1, 4), "lowpass", 300), gain=0.6)
# 16th hats + glitch stutters while the phone eats the weeks
for k, b in enumerate(np.arange(19.2, T["cut"], BEAT / 4)):
    h = filt(noise(int(0.025 * SR)), "highpass", 8000) * np.exp(-tt(int(0.025 * SR)) * 140)
    place(drums, b, bitcrush(h, 5, 3), gain=0.05 * (1.3 if k % 4 == 2 else 0.8), pan=0.5 * np.sin(k))

# ------------------------------------------------------------------ the story, as sound
# 0.0  the dot ignites
place(sfx, 0.02, bell(mtof(81), 3.2), gain=0.13, pan=0.0, send=0.7)
place(sfx, 0.0, kick(1, 3.5, 38), gain=0.35)
place(sfx, T["implode"], bell(mtof(81), 3.2), gain=0.15, send=0.8)
place(sfx, T["implode"], boom(0.5, 2.5, 70, 26), gain=0.6)

# 2.4 -> 4.8 energy gathers, then the inhale before the bang
place(sfx, T["gather"], riser(4.72 - T["gather"], 0.32), send=0.25)
place(sfx, 4.8 - 2.0, reverse_swell(2.0, 0.12), send=0.4)

# 4.8  BOOM — 4,160 weeks
place(sfx, T["boom"], boom(1.0, 3.5), gain=0.85, send=0.25)
place(sfx, T["boom"], whoosh(1.1, 0.5, 4200, -0.3, 0.3), send=0.3)
place(sfx, T["boom"] + 0.05, reverse_swell(0.01, 0.0))
glitter = np.zeros((2, int(1.6 * SR)))
for g in range(220):
    tg = RNG.exponential(0.35)
    if tg > 1.4:
        continue
    m = RNG.choice([86, 89, 91, 93, 96, 98, 101])
    i = int(tg * SR)
    s = bell(mtof(m), 0.2, 1.0)[: glitter.shape[1] - i] * RNG.uniform(0.2, 1.0) * np.exp(-tg * 2)
    glitter[:, i:i + len(s)] += pan2(s, RNG.uniform(-0.9, 0.9))
place(sfx, T["boom"], glitter, gain=0.05, send=0.6)

# 5.6 -> 7.2  every row locks in: 80 rising plucks (D minor pentatonic, three octaves)
penta = [62, 65, 67, 69, 72]
for r, tr in enumerate(cues["rowLock"]):
    deg = int(r * 16 / 80)
    m = penta[deg % 5] + 12 * (deg // 5)
    place(music, tr, pluck(m, 0.5 + 0.5 * r / 80), gain=0.07, pan=0.6 if r % 2 else -0.6, send=0.5)
# 7.2  the grid is complete
place(sfx, T["lockEnd"], boom(0.45, 2.0, 80, 32), gain=0.55, send=0.3)
place(sfx, T["lockEnd"] - 0.9, reverse_swell(0.9, 0.08), send=0.3)

# 10.8 -> 13.4  the first 25 years burn
burn = np.array(cues["burn"])
for tb in burn[::2]:
    place(sfx, tb + RNG.uniform(0, 0.08), crackle(), gain=RNG.uniform(0.03, 0.1), pan=RNG.uniform(-0.8, 0.8))
for tb in burn[::9]:
    place(sfx, tb + RNG.uniform(0.1, 0.6), crackle(), gain=RNG.uniform(0.02, 0.05), pan=RNG.uniform(-1, 1), send=0.5)
n = int(4.0 * SR)
roar = filt(np.stack([noise(n), noise(n)]), "lowpass", 380, 4)
roar *= np.interp(tt(n), [0, 0.6, 2.4, 4.0], [0, 1, 0.8, 0]) * (0.8 + 0.2 * np.sin(2 * np.pi * 3.1 * tt(n)))
place(sfx, T["burn"] - 0.2, roar, gain=0.22)
place(sfx, T["burn"] - 0.1, whoosh(3.0, 0.16, 1800, 0.4, -0.4), send=0.4)
place(sfx, T["hereMark"], chirp(1760, 1760, 0.06), gain=0.08, send=0.4)
place(sfx, T["hereMark"] + 0.09, chirp(2637, 2637, 0.08), gain=0.06, send=0.4)

# 14.4 -> 19.2  sleep: the world goes under water, slow breathing
place(sfx, 14.4 - 0.8, reverse_swell(0.8, 0.07, 1500), send=0.5)
for k in range(2):
    place(sfx, 14.4 + 0.4 + k * 2.4, breath(2.4), gain=0.045, send=0.5)
n = int(5.0 * SR)
place(sfx, 14.4, filt(np.stack([noise(n), noise(n)]), "lowpass", 120, 4) * env_pad(n, 1.2, 1.5), gain=0.5)
for ts in np.array(cues["sleep"])[::14]:
    place(sfx, ts, bell(mtof(RNG.choice([74, 77, 81, 84])), 1.5, 0.6), gain=0.012, pan=RNG.uniform(-0.9, 0.9), send=0.9)

# 19.2 -> 23.6  the phone
for k in range(2):
    place(sfx, T["glitch"] + k * 0.42, buzz(0.3), gain=0.16)
fly = np.array(cues["fly"])
for k, tf in enumerate(fly[::3]):
    f0 = RNG.uniform(1800, 3600)
    place(sfx, tf, chirp(f0, f0 * RNG.uniform(1.2, 1.8), 0.03), gain=0.035, pan=RNG.uniform(-0.8, 0.8))
place(sfx, T["fly"], whoosh(1.1, 0.22, 3000, -0.5, 0.2), send=0.3)
arp = [74, 77, 81, 84, 81, 77]
t_a, k = T["scroll"], 0
while t_a < T["swipe"]:
    step = BEAT / 4 if t_a < T["scroll"] + 0.6 else BEAT / 6 if t_a < T["scroll"] + 1.0 else BEAT / 8
    n = int(0.09 * SR)
    m = arp[k % len(arp)] + (-2 if t_a >= 21.6 else 0)
    x = (saw(mtof(m), n) - saw(mtof(m), n, 0.5)) * 0.5     # pulse wave
    x = filt(bitcrush(x * np.exp(-tt(n) * 30), 6, 2), "lowpass", 5000)
    place(music, t_a, x, gain=0.05, pan=0.5 * np.sin(k * 1.3), send=0.2)
    t_a += step
    k += 1
place(sfx, T["swipe"] - 0.05, whoosh(0.75, 0.5, 6000, 0.0, 0.0), send=0.2)
n = int(0.8 * SR)
gl = np.zeros(n)
for s0 in range(0, n, int(0.03 * SR)):
    if RNG.random() < 0.6:
        seg = min(int(0.03 * SR), n - s0)
        gl[s0:s0 + seg] = np.sign(np.sin(2 * np.pi * RNG.uniform(200, 2400) * tt(seg))) * RNG.uniform(0.3, 1)
place(sfx, T["swipe"], filt(bitcrush(gl, 4, 6), "lowpass", 7000), gain=0.07, pan=0.2)

# 23.6  cut to silence. 24.0 "So what's left?" — just a heartbeat
for hb in T["heartbeats"]:
    place(sfx, hb, heartbeat(), gain=1.0)
n = int(2.6 * SR)
place(music, 23.9, sine(mtof(86), n) * env_pad(n, 0.8, 1.0) * 0.5 + sine(mtof(74), n) * env_pad(n, 0.8, 1.0), gain=0.03, send=0.8)
place(sfx, T["lift"] - 1.0, reverse_swell(1.0, 0.12), send=0.4)
place(sfx, T["lift"] - 1.0, riser(1.0, 0.18, 500, 7000, (62, 74)))

# 26.4 -> 27.6  the weeks lift off and swirl into a number, 27.6 they land
place(sfx, T["lift"], whoosh(1.25, 0.35, 3500, -0.8, 0.8), send=0.4)
place(sfx, T["lift"] + 0.3, whoosh(0.95, 0.25, 5000, 0.8, -0.8), send=0.4)
place(sfx, T["lift"], kick(1, 4, 40), gain=0.6)
place(sfx, T["land"], boom(1.0, 3.2, 100, 30), gain=0.8, send=0.3)
place(sfx, T["land"], snare(1.2), gain=0.5, send=0.5)
shim = sum(bell(mtof(m), 2.5, 1.2) for m in (81, 84, 88, 93)) / 4
place(sfx, T["land"], shim, gain=0.07, send=0.8)

# 30.0 -> 31.0  everything is pulled back into one single week
place(sfx, T["collapse"], reverse_swell(1.0, 0.18, 1200), send=0.6)
n = int(1.0 * SR)
suck = sweep_filter(np.stack([noise(n), noise(n)]), "bandpass", lambda tc: 6000 * (1 - tc) ** 2 + 200) * np.linspace(0.2, 1, n) ** 2
place(sfx, T["collapse"], suck, gain=0.25)

# ------------------------------------------------------------------ mix
t_all = tt(N)
# sidechain: music breathes with kicks and impacts
duck = np.ones(N)
hits = [T["boom"], T["lockEnd"], T["land"], T["implode"]] + [b for b in beats if round((b / BEAT) % 4) == 0 and (7.2 <= b < 23.6 or 27.6 <= b < 30)]
for h in hits:
    i = int(h * SR)
    k = np.exp(-tt(N - i) * 7)
    duck[i:] *= 1 - 0.35 * k

def lp_curve(tc):
    # sleep: music and drums go under water; phone section opens up again; collapse closes down
    if tc < 14.2:
        return 18000
    if tc < 15.2:
        return 18000 * (650 / 18000) ** ((tc - 14.2) / 1.0)
    if tc < 18.6:
        return 650
    if tc < 19.25:
        return 650 * (18000 / 650) ** ((tc - 18.6) / 0.65)
    if 29.9 < tc < 31.0:
        return 18000 * (400 / 18000) ** ((tc - 29.9) / 1.1)
    return 18000


rl = int(3.8 * SR)
ir = np.stack([noise(rl), noise(rl)]) * np.exp(-tt(rl) * 1.9)
ir = filt(ir, "lowpass", 7000)
ir[:, : int(0.02 * SR)] = 0
ir /= np.sqrt((ir ** 2).sum(axis=1, keepdims=True))


def render_set(m, d, s, v):
    m = sweep_filter(m * duck, "lowpass", lp_curve, block=512)
    d = sweep_filter(d, "lowpass", lp_curve, block=512)
    wet = np.stack([signal.oaconvolve(v[c], ir[c])[:N] for c in range(2)])
    return m + d * 0.9 + s + wet * 0.55


pre = render_set(music, drums, sfx, verb_send)
gate = np.ones(N)
a0, a1 = int(T["cut"] * SR), int((T["cut"] + 0.012) * SR)
gate[a0:a1] = np.linspace(1, 0, a1 - a0)
gate[a1:] = 0
post = render_set(POST[id(music)], POST[id(drums)], POST[id(sfx)], verb_post)
mix = filt(pre * gate + post, "highpass", 28, 2)

# wrap the tail around for a seamless loop
L = int(DUR * SR)
out = mix[:, :L].copy()
out[:, : N - L] += mix[:, L:]

# glue: gentle soft clip + peak normalize (loudness is set by ffmpeg loudnorm afterwards)
out /= np.max(np.abs(out)) + 1e-9
out = np.tanh(out * 1.4) / np.tanh(1.4)
out *= 0.89

with wave.open(OUT, "wb") as w:
    w.setnchannels(2)
    w.setsampwidth(2)
    w.setframerate(SR)
    w.writeframes((np.clip(out.T, -1, 1) * 32767).astype(np.int16).tobytes())
print("wrote", OUT, f"{L / SR:.2f}s")
