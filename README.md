# Modular-1
I always liked the concept of the Nord Modular (never used one though) so i decided to give it a try. Here we are

## Webapp

There's a Webappp here: https://wiggismodular.github.io/Modular-1/ that allows you to make patches, like you would do on a modular system and upload it to the FM-1

Modules have two parameter inputs: p1 and p2 with an attenuverter

Then there's a matrix for to map p1 and p2 as well as k1-4 to some parameter of the module. p1 and p2 are global. k1-4 only when you're on that module (see later) 

### Voices

A patch is mono unless you pick a voice count (2..8) on the Main module's card (or on the FM-1: the GLO button opens the patch page, K1 sets the voices, SAVE keeps it). Like on the Nord Modular you don't patch the voices yourself: every module that hears the Main module's pitch, gate or vel (through any chain of cables, p1 / p2 included) runs once per voice, marked `×4` on its card. Delay, reverb and output always run once and receive the sum of the voices; a module that hears no voice signal (a free-running LFO, a noise) runs once and feeds every voice. Notes take a free voice first, then the oldest sounding one. On the FM-1 each voice costs the CPU time of the per-voice modules, so 3 or 4 voices of a typical patch is the realistic range; the voices row on the Main card shows the buffer count and turns red when a patch needs more than the firmware has.

## FM-1

In addition to the modular synth engine, there's also some complex arpeggiator. 

Knobs and stuff.

* **PRESETS** scrolls trough the patches 
* **SELECT** scrolls trough the modules in the patch
* **KNOB1 - 4** do what's described
* **ARP** opens the arpeggiator's melody page (mode, scale, root note, speed)
* **SEQ** opens the arpeggiator's rhythm page (euclid steps, pulses, rotation, rate)
* **LFO** opens arpeggiator's chaos page, adds some randomness and lets select how many octaves the arpeggio spans.
* **HOME** opens the main page of the patch
* **GLO** opens the patch page: K1 sets the number of voices (the patch reloads with the new count)

## Hack it

- Run it yourself: `cd web && npm install && npm run dev`
- Build the firmware: `nix develop`, then `python3 tools/build.py`

## License

GPL-3.0-only. The flasher, loader, hardware layer and tools are copied from [Felucca](https://github.com/hugelton/Felucca) by Leo Kuroshita / Hügelton Instruments (GPL-3.0-only); see [LICENSING.md](LICENSING.md).

## Assemblies

An assembly is a group of prewired modules that appears as one card with the ports and parameters it exposes: an "operator" of oscillator, envelope and VCA, a whole subtractive voice, an echo. Select modules in the editor (shift-click, or drag a box on the canvas) and click **Make assembly**: the ports that had cables to the outside become the card's ports. **open** shows the modules inside a frame, where ○ / ● next to a port or a parameter puts it on the card; drag cards into or out of the frame to change what belongs to it. **save** puts the assembly into the library (the Assemblies page), from where it can be inserted into any patch, exported as a `.json` file and imported again. Three come with the editor: operator, voice and echo.

Assemblies are an editor-only overlay: the patch stays a flat list of modules and cables, the FM-1 receives it unchanged, and an older editor loads such a patch and only loses the grouping. Knob assignments (K1..K4) are not part of a saved assembly, since the knobs belong to the patch. Ctrl/Cmd+Z undoes structural changes, Shift redoes.

## Sync, glide, shaper, spread

- The Oscillator and the LFO have a `sync` input: a rising edge (the Main gate, a square LFO, anything above 0.5) restarts the phase. Main `gate` into an oscillator's `sync` gives every note the same attack, the way FM synths do; one oscillator's output into another's `sync` is hard sync.
- **Glide** is a one-pole slew for any control: Main `pitch` through a Glide into the oscillator is portamento; `time` is how long a step takes to get within 1 %.
- **Shaper** drives a signal into a soft clip (smooth up to the knee), a hard clip or a triangle fold, with the peak kept at 1 and a `level` after it. It is the drive for a bass and the safety for a hot FM carrier.
- The Main panel has a `spread` output: a constant per voice from -1 (first voice) to 1 (last), 0 in mono. Into an oscillator's `p1` with `fine` ticked it detunes the voices into a unison pad; into two VCAs with opposite attenuverters it pans them.


## Level/rate envelope, string, wavetable, chorus

- **Env L/R** is the DX7 envelope: on a gate it runs to `l1`, `l2`, `l3` in `r1`, `r2`, `r3`, holds `l3`, and releases to `l4` in `r4`. Rising segments are linear (the rate that covers 0..1 in `r`), falling ones exponential (99 % in `r`). Put it on a VCA for percussion, and through a Scale on an oscillator's `pitch` for a drum's pitch drop.
- **String** is a plucked string (Karplus-Strong). Main `pitch` and `gate` play it: a `gate` fires a one-period burst of `noise` or a `pulse` into a loop that decays to −60 dB in `decay`; `damp` darkens it. Anything into `exc` plucks or rings it too, so a short oscillator click is a different pick, and a steady signal makes it a tuned resonator. Lowest note 40 Hz, 8 strings per patch on the FM-1.
- **Wavetable** is an oscillator with four banks of eight single-cycle frames (`analog`: sine, triangle, saw, square, pulses; `organ`: drawbar sets; `formant`: a moving bump of harmonics; `digital`: steps and corners). `pos` sweeps the frames with crossfades; an LFO into `p1` on `pos` is the classic wavetable sweep. It has `pm` and `sync` like the Oscillator (the FM path is not oversampled), and it is band-limited in three steps so high notes stay clean.
- **Chorus** is a stereo chorus (two taps in quadrature around 12 ms, swept up to ±8 ms) with `l` and `r` outputs for the Output. Like the Delay it runs once for all voices; one per patch on the FM-1.

## Sequencer, clock divider, S&H, quantizer, pulse

- **Sequencer**: eight steps (`s1`..`s8`, −1..1), `len` and `dir` (forward, backward, pendulum, random). A rising edge on `clock` moves on, `reset` goes back to step 1. `out` is the current step all the time, `gate` follows the clock while the step is not a rest; a step turned fully down is a rest. A square LFO is a clock; Main `gate` into `reset` restarts the pattern on every key.
- **Clock div**: `out` passes every `div`-th clock pulse, `d2` `d4` `d8` every 2nd, 4th and 8th; `reset` makes the next pulse a downbeat.
- **S&H**: `out` takes `in` on a clock edge (`hold`) or follows it while the clock is up (`track`). Noise into a clocked S&H into a Quantizer is a random melody.
- **Quantizer**: snaps a pitch to the nearest note of a scale on a root (chromatic, major, minor, pentatonics, dorian, mixolydian, blues, whole tone, fifths, octaves). Put it after a Sequencer, an S&H, a Glide or an LFO into `pitch`.
- **Pulse**: a trigger in, a gate of `time` out; a new trigger restarts it. It turns a short clock tick into a gate long enough for an envelope's attack, or a long gate into a short one.
## Pan, crossfade, vowel, phaser, digitizer, noise colour

- **Pan** places a signal with an equal-power law; its `pos` input adds to the `pan` knob, so Main `spread` into it spreads the voices across the stereo field and an LFO autopans.
- **Crossfade** fades between `a` and `b` by `mix` + `pos` (an envelope or an LFO on `pos`).
- **Vowel** is three band passes at the formants of A E I O U; `vowel` morphs between them (0..4), the input adds to it, `res` is the sharpness.
- **Phaser** sweeps four allpass stages ±2 `depth` octaves around `center` at `rate`, with `fb` and `mix`.
- **Digitizer** reduces the bit depth (`bits`) and the sample rate (`rate` = every sample held that many times).
- **Noise** has a `color` parameter: 0 is white, 1 rolls the top off from about 220 Hz.
