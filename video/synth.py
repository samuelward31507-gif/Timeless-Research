#!/usr/bin/env python3
"""Generate 432 Hz-tuned sustained chords as WAV.

The whole catalogue is deterministic: root note x octave x chord x texture.
Nothing here needs a model — it's arithmetic on sine waves.

    python synth.py --note B2 --chord "minor triad" --texture wood --out b2.wav
    python synth.py --catalog            # print how many unique tracks exist
"""
from __future__ import annotations

import argparse
import struct
import wave
from pathlib import Path

import numpy as np

SR = 44100
A4_432 = 432.0

NOTES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# semitone offsets from the root
CHORDS: dict[str, tuple[int, ...]] = {
    "minor triad":   (0, 3, 7),
    "major triad":   (0, 4, 7),
    "sus2":          (0, 2, 7),
    "sus4":          (0, 5, 7),
    "minor seventh": (0, 3, 7, 10),
    "major seventh": (0, 4, 7, 11),
    "add9":          (0, 4, 7, 14),
    "minor ninth":   (0, 3, 7, 10, 14),
    "sixth":         (0, 4, 7, 9),
    "quartal":       (0, 5, 10),
    "open fifth":    (0, 7, 12),
    "diminished":    (0, 3, 6),
}

# Each texture is a harmonic recipe: (partial number, relative amplitude).
# `inharm` detunes upper partials the way a struck bar or bell behaves.
TEXTURES: dict[str, dict] = {
    "wood":   {"partials": [(1, 1.0), (2, .32), (3, .16), (4, .07), (5, .035), (6, .02)],
               "attack": .45, "release": 3.2, "inharm": .0004, "noise": .010, "vib": .0},
    "breath": {"partials": [(1, 1.0), (2, .18), (3, .10), (4, .05)],
               "attack": 1.40, "release": 4.0, "inharm": .0002, "noise": .045, "vib": .0},
    "bowed":  {"partials": [(1, 1.0), (2, .50), (3, .30), (4, .20), (5, .12), (6, .08), (7, .05)],
               "attack": 1.10, "release": 3.0, "inharm": .0001, "noise": .012, "vib": .0022},
    "bell":   {"partials": [(1, 1.0), (2, .42), (2.76, .28), (5.4, .14), (8.1, .06)],
               "attack": .06, "release": 6.5, "inharm": .0018, "noise": .004, "vib": .0},
    "hollow": {"partials": [(1, 1.0), (3, .34), (5, .17), (7, .09), (9, .045)],
               "attack": .90, "release": 3.6, "inharm": .0003, "noise": .016, "vib": .0009},
}


def note_to_freq(name: str, a4: float = A4_432) -> float:
    """'B2' -> Hz in the given tuning. Middle A = A4."""
    pitch, octave = name[:-1], int(name[-1])
    if pitch not in NOTES:
        raise ValueError(f"unknown note {name!r}")
    midi = (octave + 1) * 12 + NOTES.index(pitch)
    return a4 * (2 ** ((midi - 69) / 12))


def _voice(freq: float, n: int, tex: dict, rng: np.random.Generator) -> np.ndarray:
    t = np.arange(n) / SR
    out = np.zeros(n)
    for k, amp in tex["partials"]:
        f = freq * k * (1 + tex["inharm"] * k * k)
        if f >= SR / 2:                       # never synthesise above Nyquist
            continue
        phase = rng.uniform(0, 2 * np.pi)
        sig = np.sin(2 * np.pi * f * t + phase)
        if tex["vib"]:                        # slow, shallow pitch drift
            sig = np.sin(2 * np.pi * f * t + phase
                         + tex["vib"] * np.sin(2 * np.pi * 0.19 * t) * 40)
        out += amp * sig
    if tex["noise"]:                          # breath / bow noise, band-limited
        nz = rng.normal(0, 1, n)
        kernel = np.ones(64) / 64
        out += tex["noise"] * np.convolve(nz, kernel, mode="same")
    return out


def render(note: str, chord: str, texture: str, seconds: float = 120.0,
           a4: float = A4_432, seed: int = 7) -> np.ndarray:
    if chord not in CHORDS:
        raise ValueError(f"unknown chord {chord!r}")
    if texture not in TEXTURES:
        raise ValueError(f"unknown texture {texture!r}")

    rng = np.random.default_rng(seed)
    tex = TEXTURES[texture]
    n = int(seconds * SR)
    root = note_to_freq(note, a4)

    left = np.zeros(n)
    right = np.zeros(n)
    voices = CHORDS[chord]
    for i, semis in enumerate(voices):
        f = root * (2 ** (semis / 12))
        v = _voice(f, n, tex, rng)
        v /= max(1.0, len(voices) * 0.8)
        # spread the voices across the field so the chord has width
        pan = 0.5 if len(voices) == 1 else i / (len(voices) - 1)
        pan = 0.30 + 0.40 * pan
        left += v * np.cos(pan * np.pi / 2)
        right += v * np.sin(pan * np.pi / 2)

    stereo = np.stack([left, right])

    # slow breath, matched to the 8s visual cycle so picture and sound agree
    t = np.arange(n) / SR
    stereo *= (0.90 + 0.10 * (0.5 - 0.5 * np.cos(2 * np.pi * t / 8.0)))

    # envelope: attack in, release out, no clicks at either end
    env = np.ones(n)
    a = int(tex["attack"] * SR)
    r = int(tex["release"] * SR)
    if a: env[:a] = np.linspace(0, 1, a) ** 1.6
    if r: env[-r:] = np.linspace(1, 0, r) ** 1.6
    stereo *= env

    peak = np.abs(stereo).max()
    if peak > 0:
        stereo *= (10 ** (-3.0 / 20)) / peak      # -3 dBFS, leaves AAC headroom
    return stereo


def write_wav(path: Path, stereo: np.ndarray) -> None:
    ints = np.clip(stereo.T * 32767, -32768, 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(2)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(ints.tobytes())


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--note", default="B2")
    p.add_argument("--chord", default="minor triad")
    p.add_argument("--texture", default="wood")
    p.add_argument("--seconds", type=float, default=120.0)
    p.add_argument("--a4", type=float, default=A4_432)
    p.add_argument("--out", default="out.wav")
    p.add_argument("--catalog", action="store_true")
    a = p.parse_args()

    if a.catalog:
        roots = [f"{n}{o}" for o in (2, 3, 4) for n in NOTES]
        total = len(roots) * len(CHORDS) * len(TEXTURES)
        print(f"roots    {len(roots):>5}  (12 notes x octaves 2-4)")
        print(f"chords   {len(CHORDS):>5}")
        print(f"textures {len(TEXTURES):>5}")
        print(f"unique   {total:>5} tracks")
        print(f"         {total/90:>5.1f} months at 90/mo")
        return

    write_wav(Path(a.out), render(a.note, a.chord, a.texture, a.seconds, a.a4))
    print(f"wrote {a.out}  ({a.note} {a.chord}, {a.texture}, {a.seconds:g}s, A={a.a4:g})")


if __name__ == "__main__":
    main()
