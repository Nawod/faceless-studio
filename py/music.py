"""Procedural, copyright-free background music and sound effects.

usage: python music.py <out_music.wav> <out_sfx.wav> --seconds 70 --mood curious --seed 42 [--events events.json]
events.json: [{"t": 1.2, "type": "whoosh|pop|riser|ding|tick|thud"}, ...]
Every run with a different seed gives a different key, progression, tempo nudge and pattern,
so no two videos share a bed (no Content ID matches, no repetition flags).
"""
import argparse, json
import numpy as np
from scipy.signal import butter, sosfilt
from scipy.io import wavfile

SR = 44100
rng = np.random.default_rng(0)

MOODS = {
    #            bpm  mode     progressions (scale-degree roots)            drums   bell_ratio
    "curious":    (100, "lydian",  [[0, 4, 5, 3], [0, 5, 3, 4], [5, 3, 0, 4]], "soft",  3.5),
    "epic":       (88,  "minor",   [[0, 5, 2, 6], [0, 3, 5, 4], [5, 6, 0, 0]], "toms",  2.0),
    "playful":    (118, "major",   [[0, 3, 4, 0], [0, 5, 3, 4], [3, 4, 0, 5]], "bounce", 4.0),
    "mysterious": (80,  "minor",   [[0, 5, 6, 4], [0, 1, 0, 6], [0, 3, 6, 5]], "sparse", 2.76),
    "calm":       (76,  "major",   [[0, 3, 5, 4], [3, 4, 0, 5], [0, 5, 3, 3]], "none",  3.0),
    "upbeat":     (124, "major",   [[0, 4, 5, 3], [5, 3, 0, 4], [0, 3, 0, 4]], "four",  3.5),
}
SCALES = {"major": [0, 2, 4, 5, 7, 9, 11], "minor": [0, 2, 3, 5, 7, 8, 10], "lydian": [0, 2, 4, 6, 7, 9, 11]}

hz = lambda m: 440.0 * 2 ** ((m - 69) / 12)


def lp(x, f, order=2):
    return sosfilt(butter(order, min(f, SR / 2 - 100), "low", fs=SR, output="sos"), x)


def hp(x, f, order=2):
    return sosfilt(butter(order, f, "high", fs=SR, output="sos"), x)


def bp(x, lo, hi):
    return sosfilt(butter(2, [lo, hi], "band", fs=SR, output="sos"), x)


def env(n, a, r, sustain=1.0):
    e = np.ones(n) * sustain
    na, nr = max(1, int(a * SR)), max(1, int(r * SR))
    e[:na] = np.linspace(0, sustain, na)
    if nr < n:
        e[-nr:] *= np.linspace(1, 0, nr)
    return e


def saw(f, n):
    t = np.arange(n) / SR
    return 2 * ((f * t + rng.random()) % 1.0) - 1


def pad(midis, dur):
    n = int(dur * SR)
    x = np.zeros(n)
    for m in midis:
        for d in (-0.08, 0.0, 0.08):
            x += saw(hz(m + d), n)
    x = lp(x / (len(midis) * 3), 1400)
    return x * env(n, min(1.2, dur / 3), min(1.5, dur / 3))


def bell(m, dur, ratio, bright=1.0):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = hz(m)
    idx = 2.2 * bright * np.exp(-t * 6)
    return np.sin(2 * np.pi * f * t + idx * np.sin(2 * np.pi * f * ratio * t)) * np.exp(-t * 3.2) * env(n, 0.004, 0.05)


def bass(m, dur):
    n = int(dur * SR)
    t = np.arange(n) / SR
    x = np.sin(2 * np.pi * hz(m) * t) + 0.25 * np.sin(4 * np.pi * hz(m) * t)
    return np.tanh(1.4 * x) * env(n, 0.01, 0.12) * 0.8


def kick(dur=0.35):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = 45 + 110 * np.exp(-t * 28)
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 9)


def hat(dur=0.06):
    n = int(dur * SR)
    return hp(rng.standard_normal(n), 7000) * np.exp(-np.arange(n) / SR * 70) * 0.35


def clap(dur=0.18):
    n = int(dur * SR)
    return bp(rng.standard_normal(n), 900, 2600) * np.exp(-np.arange(n) / SR * 22) * 0.6


def tom(m, dur=0.5):
    n = int(dur * SR)
    t = np.arange(n) / SR
    f = hz(m) * (1 + 0.5 * np.exp(-t * 20))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * np.exp(-t * 6)


def add(buf, x, start, gain=1.0):
    i = int(start * SR)
    if i >= len(buf):
        return
    j = min(len(buf), i + len(x))
    buf[i:j] += x[: j - i] * gain


def music(seconds, mood, seed):
    global rng
    rng = np.random.default_rng(seed)
    bpm, mode, progs, drums, ratio = MOODS.get(mood, MOODS["curious"])
    bpm *= 1 + rng.uniform(-0.04, 0.04)
    beat = 60 / bpm
    bar = beat * 4
    key = 48 + int(rng.integers(0, 12))
    scale = SCALES[mode]
    prog = progs[int(rng.integers(0, len(progs)))]
    arp_pat = [[0, 2, 4, 2], [0, 4, 2, 4], [0, 2, 4, 7], [4, 2, 0, 2]][int(rng.integers(0, 4))]
    n = int((seconds + 1) * SR)
    L, R = np.zeros(n), np.zeros(n)
    deg = lambda d, octv=0: key + 12 * (octv + d // 7) + scale[d % 7]
    nbars = int(seconds / bar) + 2
    for b in range(nbars):
        t0 = b * bar
        root = prog[b % len(prog)]
        chord = [deg(root), deg(root + 2), deg(root + 4), deg(root + 6 if mode != "major" or b % 2 else root + 7)]
        p = pad([c + 12 for c in chord], bar + 0.6)
        add(L, p, t0, 0.20); add(R, p, t0, 0.20)
        section_full = 2 <= b < nbars - 1 and not (int(nbars * 0.55) <= b < int(nbars * 0.55) + 1)
        if drums != "none" or b >= 1:
            sub = 8 if bpm < 100 else 8
            for s in range(sub):
                if drums == "sparse" and s % 2:
                    continue
                d = root + arp_pat[s % 4] + (7 if s >= 4 and b % 2 else 0)
                x = bell(deg(d, 2), beat * 1.6, ratio, 0.8 + 0.4 * rng.random())
                pan = 0.5 + 0.35 * np.sin(s)
                g = 0.13 * (0.75 + 0.25 * rng.random())
                add(L, x, t0 + s * bar / sub, g * (1 - pan) * 2); add(R, x, t0 + s * bar / sub, g * pan * 2)
        if section_full:
            for k in range(2 if drums != "four" else 4):
                add(L, bass(deg(root, -1), beat * (2 if drums != "four" else 1) * 0.95), t0 + k * beat * (2 if drums != "four" else 1), 0.22)
                add(R, bass(deg(root, -1), beat * (2 if drums != "four" else 1) * 0.95), t0 + k * beat * (2 if drums != "four" else 1), 0.22)
            for q in range(4):
                tq = t0 + q * beat
                if drums in ("soft", "bounce", "four") and (drums == "four" or q % 2 == 0):
                    k = kick(); add(L, k, tq, 0.42); add(R, k, tq, 0.42)
                if drums in ("bounce", "four", "soft"):
                    h = hat(); add(L, h, tq + beat / 2, 0.5); add(R, h, tq + beat / 2, 0.42)
                if drums == "bounce" and q % 2 == 1:
                    c = clap(); add(L, c, tq, 0.35); add(R, c, tq, 0.35)
                if drums == "toms" and q in (0, 2):
                    tt = tom(key - 24 + (q * 2)); add(L, tt, tq, 0.4); add(R, tt, tq, 0.4)
                if drums == "sparse" and q == 0 and b % 2 == 0:
                    k = kick(0.5); add(L, k, tq, 0.3); add(R, k, tq, 0.3)
    st = np.stack([L, R], 1)[: int(seconds * SR)]
    fade = int(2.0 * SR)
    st[-fade:] *= np.linspace(1, 0, fade)[:, None]
    st[: int(0.3 * SR)] *= np.linspace(0, 1, int(0.3 * SR))[:, None]
    return st / (np.max(np.abs(st)) + 1e-9) * 0.7


def sfx_track(seconds, events, seed):
    global rng
    rng = np.random.default_rng(seed + 7)
    n = int(seconds * SR)
    L, R = np.zeros(n), np.zeros(n)

    def whoosh(d=0.45):
        m = int(d * SR); t = np.arange(m) / SR
        x = rng.standard_normal(m)
        f = 400 + 3800 * np.sin(np.pi * t / d) ** 2
        y = np.zeros(m); seg = 512
        for i in range(0, m, seg):
            y[i:i + seg] = bp(x[i:i + seg + 64], max(200, f[i] * 0.6), min(15000, f[i] * 1.4))[: len(y[i:i + seg])]
        return y * np.sin(np.pi * t / d) ** 1.5 * 0.9

    def pop():
        m = int(0.09 * SR); t = np.arange(m) / SR
        return np.sin(2 * np.pi * (700 + 500 * np.exp(-t * 60)) * t) * np.exp(-t * 45) * 0.6

    def riser(d=1.2):
        m = int(d * SR); t = np.arange(m) / SR
        return (hp(rng.standard_normal(m), 2000) * 0.3 + 0.3 * np.sin(2 * np.pi * np.cumsum(200 + 900 * (t / d) ** 2) / SR)) * (t / d) ** 2

    def tick():
        m = int(0.03 * SR)
        return hp(rng.standard_normal(m), 3000) * np.exp(-np.arange(m) / SR * 200) * 0.5

    def thud():
        return kick(0.4) * 0.8 + np.concatenate([bp(rng.standard_normal(int(0.08 * SR)), 80, 400) * 0.3, np.zeros(int(0.32 * SR))])

    makers = {"whoosh": whoosh, "pop": pop, "riser": riser, "tick": tick, "thud": thud,
              "ding": lambda: bell(84, 1.2, 3.5) * 0.5}
    for e in events:
        typ = e.get("type")
        if typ not in makers:
            continue
        x = makers[typ]()
        start = e["t"] - (1.2 if typ == "riser" else 0.15 if typ == "whoosh" else 0)
        pan = 0.5 + rng.uniform(-0.25, 0.25)
        g = e.get("gain", 1.0)
        add(L, x, max(0, start), g * (1 - pan) * 1.6); add(R, x, max(0, start), g * pan * 1.6)
    st = np.stack([L, R], 1)
    peak = np.max(np.abs(st))
    return st / peak * 0.8 if peak > 0.8 else st


def write(path, st):
    wavfile.write(path, SR, (np.clip(st, -1, 1) * 32767).astype(np.int16))


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("music_wav"); ap.add_argument("sfx_wav")
    ap.add_argument("--seconds", type=float, required=True); ap.add_argument("--mood", default="curious")
    ap.add_argument("--seed", type=int, default=1); ap.add_argument("--events", default="")
    a = ap.parse_args()
    write(a.music_wav, music(a.seconds, a.mood, a.seed))
    ev = json.load(open(a.events)) if a.events else []
    write(a.sfx_wav, sfx_track(a.seconds, ev, a.seed))
    print("ok")
