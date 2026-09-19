# Audio generation

`synth.py` renders the 432 Hz-tuned chords the videos sit on. It is arithmetic
on sine waves — deterministic, no model involved.

```bash
python synth.py --note B2 --chord "minor triad" --texture wood --out b2.wav
python synth.py --catalog        # size of the unique-track space
```

## Verified against the source material

The original tracks measure a **121.0 Hz** fundamental. B2 is 123.47 Hz at
A=440 and **121.23 Hz at A=432**, confirming the source really is 432-tuned.

Generated output matched the original across all six measurable partials:

| partial | original | generated | B minor @432 |
|---|---|---|---|
| root B2   | 120.4 | 121.0 | 121.2 |
| min 3rd D3| 143.3 | 144.0 | 144.2 |
| 5th F#3   | 180.8 | 181.5 | 181.6 |
| octave B3 | 241.2 | 242.8 | 242.5 |
| 5th+8 F#4 | 287.1 | 288.5 | — |
| 3rd+8 D4  | 362.1 | 363.8 | — |

Within 0.7 Hz throughout, which is FFT bin resolution at this window length.

## Catalogue

36 roots (12 notes x octaves 2-4) x 12 chords x 5 textures = **2160 unique
tracks**, or two years at 90/month before a repeat.

## How the textures work

Each is a harmonic recipe plus an envelope. `wood` is a fast-decaying
even/odd series; `breath` is quiet upper partials with band-limited noise;
`bowed` is a full series with shallow vibrato; `bell` uses *inharmonic*
partials (2.76x, 5.4x) and a long release, which is what makes struck metal
sound like metal; `hollow` is odd partials only, like a stopped pipe.

The amplitude breathes on an 8-second cycle — deliberately the same period as
the visual pulse in `scene.html`, so picture and sound move together.

Output is normalised to -3 dBFS, which leaves headroom for the AAC encode.

## Note on scale

Generating 90 videos a month is technically trivial. YouTube's monetization
policy explicitly targets mass-produced templated content, and a channel of
near-identical procedural uploads is what that rule was written for. Volume is
not the constraint here; policy risk is.
