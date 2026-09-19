#!/usr/bin/env python3
"""Compose a 432 Hz piece: a chord progression with movement, not one held chord.

Three layers, all tuned to A=432:

  pad     the progression itself, chords crossfading into each other
  bass    the root an octave or two down, slower than the changes
  accents sparse struck tones drawn from the current chord

    python compose.py --key A3 --mode aeolian --prog i-VI-III-VII --out a.wav
    python compose.py --catalog
"""
from __future__ import annotations

import argparse
import wave
from pathlib import Path

import numpy as np

from synth import NOTES, SR, TEXTURES, note_to_freq, A4_432

# scale degrees in semitones
MODES: dict[str, tuple[int, ...]] = {
    "aeolian": (0, 2, 3, 5, 7, 8, 10),      # natural minor — the default mood here
    "dorian":  (0, 2, 3, 5, 7, 9, 10),      # minor with a raised 6th, less bleak
    "ionian":  (0, 2, 4, 5, 7, 9, 11),      # major
    "lydian":  (0, 2, 4, 6, 7, 9, 11),      # major with a raised 4th, floating
    "phrygian":(0, 1, 3, 5, 7, 8, 10),      # minor with a flat 2nd, darker
    "mixolydian":(0, 2, 4, 5, 7, 9, 10),    # major with a flat 7th, open
}

# Roman numerals -> scale degree index. Case is ignored; the mode decides
# whether a degree comes out major or minor, which is the point of being modal.
DEGREES = {"i":0,"ii":1,"iii":2,"iv":3,"v":4,"vi":5,"vii":6}

PROGRESSIONS: dict[str, str] = {
    "descent":    "i-VII-VI-VII",
    "lament":     "i-VI-III-VII",
    "suspended":  "i-IV-i-VII",
    "opening":    "I-V-vi-IV",
    "drift":      "i-III-VII-IV",
    "circle":     "vi-IV-I-V",
    "static":     "i-i-VII-i",
    "rise":       "IV-V-vi-I",
}


def parse_prog(text: str) -> list[int]:
    out = []
    for tok in text.replace(" ", "").split("-"):
        if not tok:
            continue
        key = tok.lower()
        if key not in DEGREES:
            raise ValueError(f"unknown degree {tok!r}")
        out.append(DEGREES[key])
    return out


def diatonic_chord(root_hz: float, mode: tuple[int, ...], degree: int,
                   seventh: bool = False) -> list[float]:
    """Stack thirds *within the mode*, so quality follows the scale."""
    idx = [degree, degree + 2, degree + 4] + ([degree + 6] if seventh else [])
    freqs = []
    for i in idx:
        octave, step = divmod(i, len(mode))
        freqs.append(root_hz * (2 ** ((mode[step] + 12 * octave) / 12)))
    return freqs


def _partial_stack(freq: float, tex: dict, n: int, rng, detune: float = 0.0) -> np.ndarray:
    t = np.arange(n) / SR
    out = np.zeros(n)
    for k, amp in tex["partials"]:
        f = freq * k * (1 + tex["inharm"] * k * k) * (1 + detune)
        if f >= SR / 2:
            continue
        out += amp * np.sin(2 * np.pi * f * t + rng.uniform(0, 2 * np.pi))
    return out


def compose(key: str, mode_name: str, prog_text: str, texture: str,
            seconds: float = 120.0, seventh: bool = True,
            a4: float = A4_432, seed: int = 11) -> np.ndarray:
    mode = MODES[mode_name]
    degrees = parse_prog(prog_text)
    tex = TEXTURES[texture]
    rng = np.random.default_rng(seed)

    n_total = int(seconds * SR)
    root = note_to_freq(key, a4)

    # one bar per chord, looping the progression to fill the duration
    n_bars = max(len(degrees), int(round(seconds / 15.0)))
    n_bars = int(np.ceil(n_bars / len(degrees)) * len(degrees))
    bar = n_total / n_bars
    xf = min(bar * 0.45, 5.0 * SR / SR)          # crossfade, seconds
    xf_n = int(xf * SR)
    bar_n = int(bar)

    left = np.zeros(n_total + bar_n)
    right = np.zeros(n_total + bar_n)

    for b in range(n_bars):
        deg = degrees[b % len(degrees)]
        chord = diatonic_chord(root, mode, deg, seventh)
        start = int(b * bar)
        seg_n = bar_n + xf_n
        seg_l = np.zeros(seg_n)
        seg_r = np.zeros(seg_n)

        for vi, f in enumerate(chord):
            # two slightly detuned copies per voice → slow chorus, no flanging
            v = (_partial_stack(f, tex, seg_n, rng, +0.0012 * (vi + 1))
                 + _partial_stack(f, tex, seg_n, rng, -0.0012 * (vi + 1))) * 0.5
            v /= max(1.0, len(chord) * 0.85)
            pan = 0.30 + 0.40 * (vi / max(1, len(chord) - 1))
            seg_l += v * np.cos(pan * np.pi / 2)
            seg_r += v * np.sin(pan * np.pi / 2)

        # equal-power crossfade in and out so chord changes never click
        env = np.ones(seg_n)
        env[:xf_n] = np.sin(np.linspace(0, np.pi / 2, xf_n)) ** 2
        env[-xf_n:] = np.cos(np.linspace(0, np.pi / 2, xf_n)) ** 2
        seg_l *= env
        seg_r *= env

        left[start:start + seg_n] += seg_l
        right[start:start + seg_n] += seg_r

    # ---- bass: moves at half the rate of the chords, so it anchors them ----
    bass = np.zeros(n_total + bar_n)
    for b in range(0, n_bars, 2):
        deg = degrees[b % len(degrees)]
        f = diatonic_chord(root, mode, deg, False)[0] * 0.5
        start = int(b * bar)
        seg_n = int(bar * 2) + xf_n
        t = np.arange(seg_n) / SR
        v = (np.sin(2 * np.pi * f * t)
             + 0.30 * np.sin(2 * np.pi * f * 2 * t)
             + 0.10 * np.sin(2 * np.pi * f * 3 * t))
        env = np.ones(seg_n)
        env[:xf_n] = np.linspace(0, 1, xf_n) ** 2
        env[-xf_n:] = np.linspace(1, 0, xf_n) ** 2
        seg = (v * env * 0.30)[:len(bass) - start]
        bass[start:start + len(seg)] += seg
    left += bass * 0.7
    right += bass * 0.7

    # ---- accents: sparse struck chord tones, decaying ----
    acc_l = np.zeros(n_total + bar_n)
    acc_r = np.zeros(n_total + bar_n)
    tt = 3.0
    while tt < seconds - 4:
        b = min(n_bars - 1, int(tt / (bar / SR)))
        chord = diatonic_chord(root, mode, degrees[b % len(degrees)], seventh)
        f = float(rng.choice(chord)) * float(rng.choice([2.0, 2.0, 4.0]))
        dur = rng.uniform(2.5, 5.0)
        m = int(dur * SR)
        t = np.arange(m) / SR
        v = (np.sin(2*np.pi*f*t) + 0.5*np.sin(2*np.pi*f*2.01*t)
             + 0.25*np.sin(2*np.pi*f*3.02*t))
        v *= np.exp(-t * (2.2 / dur)) * 0.10
        v[:200] *= np.linspace(0, 1, 200)
        s = int(tt * SR)
        m = min(m, len(acc_l) - s)
        pan = rng.uniform(0.2, 0.8)
        acc_l[s:s+m] += v[:m] * np.cos(pan*np.pi/2)
        acc_r[s:s+m] += v[:m] * np.sin(pan*np.pi/2)
        tt += rng.uniform(5.0, 11.0)
    left += acc_l
    right += acc_r

    stereo = np.stack([left[:n_total], right[:n_total]])

    # breath on the same 8s cycle as the picture
    t = np.arange(n_total) / SR
    stereo *= (0.93 + 0.07 * (0.5 - 0.5*np.cos(2*np.pi*t/8.0)))

    # top and tail
    a_n, r_n = int(2.5*SR), int(4.0*SR)
    env = np.ones(n_total)
    env[:a_n] = np.linspace(0, 1, a_n) ** 1.6
    env[-r_n:] = np.linspace(1, 0, r_n) ** 1.6
    stereo *= env

    peak = np.abs(stereo).max()
    if peak > 0:
        stereo *= (10 ** (-3.0/20)) / peak
    return stereo


def write_wav(path: Path, stereo: np.ndarray) -> None:
    ints = np.clip(stereo.T * 32767, -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR)
        w.writeframes(ints.tobytes())


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--key", default="A3")
    p.add_argument("--mode", default="aeolian", choices=sorted(MODES))
    p.add_argument("--prog", default="lament")
    p.add_argument("--texture", default="bowed", choices=sorted(TEXTURES))
    p.add_argument("--seconds", type=float, default=120.0)
    p.add_argument("--no-seventh", action="store_true")
    p.add_argument("--seed", type=int, default=11)
    p.add_argument("--out", default="piece.wav")
    p.add_argument("--catalog", action="store_true")
    a = p.parse_args()

    if a.catalog:
        keys = [f"{n}{o}" for o in (2, 3) for n in NOTES]
        total = len(keys) * len(MODES) * len(PROGRESSIONS) * len(TEXTURES)
        print(f"keys         {len(keys):>6}")
        print(f"modes        {len(MODES):>6}")
        print(f"progressions {len(PROGRESSIONS):>6}")
        print(f"textures     {len(TEXTURES):>6}")
        print(f"unique       {total:>6} pieces")
        print(f"             {total/30:>6.0f} months at 30/mo")
        return

    prog = PROGRESSIONS.get(a.prog, a.prog)
    st = compose(a.key, a.mode, prog, a.texture, a.seconds,
                 seventh=not a.no_seventh, seed=a.seed)
    write_wav(Path(a.out), st)
    print(f"wrote {a.out}  ({a.key} {a.mode}, {a.prog} = {prog}, {a.texture})")


if __name__ == "__main__":
    main()
