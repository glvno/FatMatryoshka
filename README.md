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


## Pan, crossfade, vowel, phaser, digitizer, noise colour

- **Pan** places a signal with an equal-power law; its `pos` input adds to the `pan` knob, so Main `spread` into it spreads the voices across the stereo field and an LFO autopans.
- **Crossfade** fades between `a` and `b` by `mix` + `pos` (an envelope or an LFO on `pos`).
- **Vowel** is three band passes at the formants of A E I O U; `vowel` morphs between them (0..4), the input adds to it, `res` is the sharpness.
- **Phaser** sweeps four allpass stages ±2 `depth` octaves around `center` at `rate`, with `fb` and `mix`.
- **Digitizer** reduces the bit depth (`bits`) and the sample rate (`rate` = every sample held that many times).
- **Noise** has a `color` parameter: 0 is white, 1 rolls the top off from about 220 Hz.
