# Modular-1
I always liked the concept of the Nord Modular (never used one though) so i decided to give it a try. Here we are

## Webapp

There's a Webappp here: https://wiggismodular.github.io/Modular-1/ that allows you to make patches, like you would do on a modular system and upload it to the FM-1

Modules have two parameter inputs: p1 and p2 with an attenuverter

Then there's a matrix for to map p1 and p2 as well as k1-4 to some parameter of the module. p1 and p2 are global. k1-4 only when you're on that module (see later) 

### Voices

A patch is mono unless you pick a voice count (2..8) on the Main module's card (or on the FM-1: GLO opens the mixer, where the ALGORITHM encoder sets the polyphony of the patch, SAVE keeps it). Like on the Nord Modular you don't patch the voices yourself: every module that hears the Main module's pitch, gate or vel (through any chain of cables, p1 / p2 included) runs once per voice, marked `×4` on its card. Delay, reverb and output always run once and receive the sum of the voices; a module that hears no voice signal (a free-running LFO, a noise) runs once and feeds every voice. Notes take a free voice first, then the oldest sounding one. On the FM-1 each voice costs the CPU time of the per-voice modules, so 3 or 4 voices of a typical patch is the realistic range; the voices row on the Main card shows the buffer count and turns red when a patch needs more than the firmware has.

The firmware plays one patch at a time (the default build). The four-patch firmware of upstream 1.0.2, where the panel calls the four patches voices 1..4 (SEL switches between them, each with its own MIDI channel, arpeggiator and mixer level, the pools shared between them), is a build switch: `M1_VOICES=4 python3 tools/build.py`.

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
* **GLO** opens the mixer: K1 sets the level, the black key F# mutes, ALGORITHM sets the polyphony (the patch reloads with the new count). Four-voice build: K1-K4 and F# G# A# C# for the four voices (patches), ALGORITHM acts on the selected one
* **SEL** switches to the next voice (patch) in the four-voice build; keys, knobs, LCD and the editor act on it. Unused in the one-voice build

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
- **Shaper** drives a signal into a soft clip (smooth up to the knee), a hard clip or a triangle fold, with the peak kept at 1 and a `level` after it. It is the drive for a bass and the safety for a hot FM carrier. `os` runs it 2x oversampled: the harmonics above 22 kHz are filtered out instead of folding back as inharmonic grit (about 2.3x the CPU of the module; off by default).
- The Main panel has a `spread` output: a constant per voice from -1 (first voice) to 1 (last), 0 in mono. Into an oscillator's `p1` with `fine` ticked it detunes the voices into a unison pad; into two VCAs with opposite attenuverters it pans them.


## Level/rate envelope, string, wavetable, chorus

- **Env L/R** is the DX7 envelope: on a gate it runs to `l1`, `l2`, `l3` in `r1`, `r2`, `r3`, holds `l3`, and releases to `l4` in `r4`. Rising segments are linear (the rate that covers 0..1 in `r`), falling ones exponential (99 % in `r`). Put it on a VCA for percussion, and through a Scale on an oscillator's `pitch` for a drum's pitch drop.
- **String** is a plucked string (Karplus-Strong). Main `pitch` and `gate` play it: a `gate` fires a one-period burst of `noise` or a `pulse` into a loop that decays to −60 dB in `decay`; `damp` darkens it. Anything into `exc` plucks or rings it too, so a short oscillator click is a different pick, and a steady signal makes it a tuned resonator. Lowest note 40 Hz; the FM-1 has 8 string lines (6 in the four-voice build, shared by its voices).
- **Wavetable** is an oscillator with four banks of eight single-cycle frames (`analog`: sine, triangle, saw, square, pulses; `organ`: drawbar sets; `formant`: a moving bump of harmonics; `digital`: steps and corners). `pos` sweeps the frames with crossfades; an LFO into `p1` on `pos` is the classic wavetable sweep. It has `pm` and `sync` like the Oscillator (the FM path is not oversampled), and it is band-limited in three steps so high notes stay clean.
- **Chorus** is a stereo chorus (two taps in quadrature around 12 ms, swept up to ±8 ms) with `l` and `r` outputs for the Output. Like the Delay it runs once for all voices; one per patch on the FM-1.

## Sequencer, clock divider, S&H, quantizer, pulse

- **Sequencer**: eight steps (`s1`..`s8`, −1..1), `len` and `dir` (forward, backward, pendulum, random). A rising edge on `clock` moves on, `reset` goes back to step 1. `out` is the current step all the time, `gate` follows the clock while the step is not a rest; a step turned fully down is a rest. A square LFO is a clock; Main `gate` into `reset` restarts the pattern on every key. `glide` slews `out` from step to step (the time is that fraction of the clock period, so it follows the tempo; 0 = steps), `gate` sets the gate length as a fraction of the period (0 = the clock's own width, 1 = legato: the steps tie and an ADSR does not retrigger). Both measure the period from the last two clock edges.
- **Clock div**: `out` passes every `div`-th clock pulse, `d2` `d4` `d8` every 2nd, 4th and 8th; `reset` makes the next pulse a downbeat.
- **S&H**: `out` takes `in` on a clock edge (`hold`) or follows it while the clock is up (`track`). Noise into a clocked S&H into a Quantizer is a random melody.
- **Quantizer**: snaps a pitch to the nearest note of a scale on a root (chromatic, major, minor, pentatonics, dorian, mixolydian, blues, whole tone, fifths, octaves). Put it after a Sequencer, an S&H, a Glide or an LFO into `pitch`.
- **Pulse**: a trigger in, a gate of `time` out; a new trigger restarts it. It turns a short clock tick into a gate long enough for an envelope's attack, or a long gate into a short one.
## Pan, crossfade, vowel, phaser, digitizer, noise colour

- **Pan** places a signal with an equal-power law; its `pos` input adds to the `pan` knob, so Main `spread` into it spreads the voices across the stereo field and an LFO autopans.
- **Crossfade** fades between `a` and `b` by `mix` + `pos` (an envelope or an LFO on `pos`).
- **Vowel** is three band passes at the formants of A E I O U; `vowel` morphs between them (0..4), the input adds to it, `res` is the sharpness.
- **Phaser** sweeps four allpass stages ±2 `depth` octaves around `center` at `rate`, with `fb` and `mix`.
- **Digitizer** reduces the bit depth (`bits`) and the sample rate (`rate` = every sample held that many times). `os` as on the Shaper: the steps are rounded off at twice the rate before coming back down, so the images of the held samples alias less.
- **Noise** has a `color` parameter: 0 is white, 1 rolls the top off from about 220 Hz.
## Unison

- The **Oscillator** has `unison` (1..5 copies) and `detune` (cents, spread from −detune to +detune): a supersaw or a thick pulse from one module, summed so the peak stays at `level`. Sync restarts all copies. With `pm` connected or `fb` above 0 the oscillator runs its FM path, which plays one copy.

## Frequency shifter

- **Freq shift** moves every partial by the same number of Hz (not a pitch shift: harmonics become inharmonic): `up` and `down` outputs, `shift` ±1000 Hz with `cv` × `cvamt`, `mix`. A few Hz for a slow barber-pole phasing, hundreds for bells and clangs out of a saw.

## Performance controls

- Pitch bend moves the Main module's `pitch` by ±2 semitones in every patch; the wheel is also a `bend` output (−1..1). The mod wheel (CC 1) is the `mod` output, channel aftertouch the `at` output: patch them into any `p1` / `p2`. CC 16..19 turn the Main module's K1..K4 from a controller. In the browser the editor's sliders do not follow CC.

## Comb filter and modal resonator

- **Comb** is a tuned feedback comb: a delay of one period of the `pitch` (plus `coarse`) with `fb` (positive: a peak at every harmonic; negative: the odd ones, hollow) and `damp`, mixed by `mix`. A flanger with an LFO on `pitch`, a resonator on noise, a Karplus string without the pluck.
- **Modal** is a resonator of six partials at the `pitch`: harmonic at `struct` 0, a metal bar at 1; `decay` is the ring time, `damp` shortens the upper partials, `bright` their level. Hit it with a short burst (a pulse, a gated noise, a plucked string) for bells, bars and drums; a steady input makes it howl.

## Granular

- **Granular** records whatever is patched into it (one second, `freeze` stops the recording) and plays grains from it: `density` grains per second or one per rising edge on `trig`, each reading `size` seconds from `position` back in the buffer (0 = the newest audio) scattered by `spray`, at `pitch` semitones, under a smooth window, up to eight at once, mixed with the input by `mix`. A frozen chord into a cloud, a stutter from a square LFO on `trig`, a pitch-shifted echo. One per patch on the FM-1 (not in the four-voice build).

## Math and logic

- **Math** takes two signals (`a` scaled by `ka` plus `off`, `b` scaled by `kb`) and outputs their sum, difference, product, min, max, |a| and a gate that is high while a > b: ring modulation, a CV mixer, a comparator, a rectifier.
- **Logic** combines two gates: `and`, `or`, `xor`, `not` (of `a`), high from `thresh` on. Two clocks into `xor` make a rhythm.

## Compressor

- **Compressor** is an envelope follower and compressor in one: `env` outputs the follower (a control: an oscillator's loudness as a CV, a sidechain pump from a kick into a VCA), `out` the signal compressed above `thresh` by `ratio` with `attack`, `release` and makeup `gain`. The `side` input is the sidechain; without it the detector listens to `in`.

## On a phone or tablet

- The canvas zooms: pinch, Ctrl/Cmd + wheel, or the − / + buttons (the percentage button fits the whole patch, then back to 100 %). One finger on empty canvas pans; cards drag by their header as before. On touch screens the jacks are bigger, the controls taller, and a long press on a card header opens its actions (bypass, duplicate, select, remove); a round **+** at the bottom right opens the palette to add a module, insert an assembly or load a patch. Below 640 px the toolbars wrap and the panels go full width. Web MIDI over USB works on Android Chrome in principle; the FM-1 link from a phone has not been tried.

## Share a patch as a link

- **Share link** (toolbar) copies a link that opens this patch: the JSON, layout and assemblies included, deflated into the URL fragment (`#p=…`, about 800 characters for a factory patch). Opening the link loads the patch into the editor without replacing the patch the browser remembers until you change something; the Patches page has an "Import link" field that puts a linked patch into the bank list. A patch too big for a link (over 8000 characters) travels without its card positions and assembly overlay, and opens on a grid.

## Diff and A/B

- **Diff** (toolbar) lists what changed since the patch was last loaded, uploaded or stored on the FM-1: parameters as old → new, modules and cables added or removed, and switches, attenuverters, matrix, macro ranges, voices and arpeggiator changes as one line each.
- **A/B**: "Set A" and "Set B" keep two versions of the patch; the A/B button (or Tab) flips between them while you play. When both versions have the same modules and cables only the values move, so notes keep sounding through the flip (the side you leave keeps whatever you changed on it); otherwise the other version is loaded whole.

## Keyboard

- `/` or Ctrl/Cmd+K opens a **command palette**: type part of a name to add a module, insert an assembly (library or factory) or load a patch; Enter runs the first match, arrows choose. `?` lists every shortcut.
- Click a jack, then a jack of the other kind, to connect them (Esc cancels; dragging works as before). With cards selected (shift-click or a box): Delete removes them, B bypasses them, G groups them into an assembly, Ctrl/Cmd+D duplicates them with their settings and the cables among them, the arrows nudge them (Shift: ×10). Space starts and stops the arpeggiator, Tab flips A/B, Ctrl/Cmd+Z and Shift+Ctrl/Cmd+Z undo and redo. The shortcuts are off while a text field has focus; the note keys (A W S E D F T G Y H U J K) still play when they are not taken.

## Scope

- Every output jack has a small **◎**: click it and the signal appears in the scope panel at the bottom of the canvas, several at once in their own colours (the jack gets a ring). The **time** view auto-scales; audio signals are triggered on a rising zero crossing so the wave stands still, control and gate signals show the whole last 85 ms with a min / max / mean readout. The **spectrum** view is a 2048-point FFT (log frequency, 0 dB = a full-scale sine) with the peak's frequency in the readout, so an oscillator can be tuned by eye. Probes cost nothing on the FM-1: they live in the browser's engine.

## Arpeggiator in the editor

- The FM-1's arpeggiator (MELODY / RHYTHM / CHAOS pages) is on the Main card too, under **Arpeggiator**: mode, scale (the device's 67 scales and chords), root, bpm, rate, Euclidean steps / pulses / rotation, octaves and the three chaos amounts, plus a **play** switch. The browser runs the same arpeggiator (the same clock, modes, random generator and 65 % gate), so a patch grooves the same way on both. The settings are saved with the patch (`arp` in the JSON; the binary patch does not carry them) and reach the FM-1 with every upload and with every change (the ARP command); play starts and stops the device's arpeggiator as the PLAY button does. A patch without the section leaves the FM-1's settings alone.

## Macro ranges

- A parameter input normally *adds* to a parameter: p1 at 1 moves it up by the attenuverter's share of its range. A **macro range** makes the input *set* it between two ends instead: in the matrix, a `↔` next to a checked p1 / p2 box opens a row with the two ends (as values; for a logarithmic parameter the travel is in octaves). One Main knob into p1 of the filter and of the envelope then opens the cutoff from 200 Hz to 8 kHz while it shortens the decay from 0.5 s to 50 ms, each over its own travel; swapped ends make a knob go down. The slider's own value is ignored while a range is set; the attenuverter scales the travel, the input is clamped to 0..1 (for a bipolar LFO put a Scale with offset 0.5 in front). The ranges travel with the patch (binary format 15) and live edits reach the FM-1 (RANGE command); the LCD draws the travel as a bracket over the knob row's bar.

## Patch morphing

- A patch can carry a **B side**: the parameters of another stored patch with the same modules and cables. Pick it on the Main card ("B side": the Patches page and the factory list are offered, only those of the same structure), then the Main module's `morph` slider fades every parameter from this patch (A, at 0) to the other (B, at 1): linearly, in octaves for a logarithmic one (a cutoff morphs musically), a choice or a switch flips at the midpoint. Notes keep sounding while you morph: only the parameters move. The Main module has a `morph` input as well; it adds to the slider, so an LFO, an envelope or a sequencer can morph the patch (block rate, one block late). On the FM-1 the mixer page's K2 is the morph (one-voice build) and CC 20 sets it; the B side travels with the patch (binary format 14) and is saved with it. To get a B side: save the patch under a second name, change its sounds, come back to the first and pick the copy.

## Reverb


- The **Reverb** is an eight-line feedback network (dense from the first reflections on, no metallic ring thanks to a slow modulation of two of its lines). `size` is the decay: 0.2 s at 0 to 6.4 s at 1 (60 dB), `damp` rolls off the highs in the tail, `pre` holds the tail back by up to 40 ms so the attack stays clear, `mod` is the chorusing of the tail (0 for a static, perfectly repeatable tail), `mix` the wet share. One per patch, like the Delay. Old patches keep their size / damp / mix and get the new tail.

## Filter: notch, peak, allpass

- The **Filter** has three more outputs after `mix`: `notch` (a null at the cutoff, the rest passes: the opposite of `bp`), `peak` (flat, with a resonant bump at the cutoff set by `res`: a parametric boost) and `ap` (allpass: everything passes, the phase turns through 360° around the cutoff; summed with `in` it is a phaser stage, modulated and summed with the dry signal a one-stage phaser). They come from the same two integrators, so they cost nothing extra when unused.

## Ladder filter


- **Ladder** is a four-pole low pass of the Moog kind with `drive`: four one-pole stages in a feedback loop with a soft saturator inside it, so `res` goes up to self-oscillation (at 1) and `drive` (1..8) pushes the signal into the saturator for grit. Outputs `lp24` and `lp12`; `cv` with `cvamt` and `track` as on the Filter. Its cutoff modulation is updated once per block (fine for envelopes and LFOs; the Filter is the one for audio-rate cutoff).

## Assemblies: merged ports, placement, nesting

- **Merged ports.** On an open assembly, every exposed input has a `merge…` list of the card's other inputs of the same kind. Merging turns two jacks into one that feeds both (the factory `voice` has one `gate` for its two envelopes); the card shows `×2` and a `split` button. A cable into a merged jack goes to every input behind it, and removing it takes them all.
- **Placement.** "Add module" and "Insert" put the new card on the first free grid cell instead of on top of what is there.
- **Nesting.** An assembly can hold assemblies, three levels deep: select modules inside an open assembly and "Make assembly", or drop a collapsed card into an open frame. The parent's card may show whatever its children expose; closing the parent hides everything inside. Ungroup dissolves one level, delete keeps the nested ones. Saved assemblies carry their nested ones.

## Factory assemblies

The Assemblies page ships forty-three, made by `web/scripts/gen-assemblies.ts` (edit the script, rerun it, commit the files; `voice` and `echo` are kept by hand):

- The recipes of the factory patches: **filter voice** (oscillator, filter, one ADSR on the VCA, the filter's cv exposed), **adsr operator** (oscillator into a VCA with an ADSR: the operator of the FM patches), **noise voice**, **stack voice** (two oscillators, mixer, filter, ADSR, VCA, with `in3` for a third oscillator), **vibrato** (LFO through a Scale). 29 of the 33 factory patches open as a few of these cards plus an **echo** (the four that do not share a recipe stay flat); the overlay is editor-only, so the sound and the binary patch are unchanged, and a patch saved from the editor keeps its grouping in the JSON and the bank while the FM-1 and the binary form drop it.

- Voices: **operator** (oscillator, level/rate envelope, VCA: an FM operator, with `pm` in and `level cv`), **fm pair** (a modulator with its own envelope into a carrier: one `pitch`, one `gate`), **voice** (subtractive: oscillator, filter, two ADSRs), **sub bass** (glide, square an octave down, dark tracking filter), **wavetable pad** (slow frame sweep, filter, slow ADSR), **vowel voice** (saw through the vowel filter swept by an LFO), **pluck** (string into a tracking low pass).
- Drums (no samples: modal bodies, noise and envelopes): **kick** (sine with a pitch drop, a 1 ms click, decay envelope, drive), **snare** (noise through a high pass plus a sine body), **hihat** (noise through a high pass, very short), **hats** (a detuned square cluster plus noise through a 7 kHz high pass: `gate` is the closed hat, `open` the open one, and the closed hat chokes the open one), **clap** (a noise band with a flam and a tail), **rim** (a strike into a short inharmonic body and a tuned comb), **cowbell** (two squares a sixth apart, band pass, short envelope), **tom** (a harmonic modal body with a pitch drop; `tune` picks the size), **tabla** (a slightly inharmonic head with a slap; velocity opens `bright`, a slow envelope bends the pitch down). All take one `gate`; the drums ignore pitch (tabla takes it), so one key per drum through a Sequencer's gate or the Main gate. The factory patch **909 Kit** plays kick, snare and hihat from three sequencers on one clock.
- Granular (one Granular per patch): **cloud** (a dense pitch-true cloud of whatever comes in; `freeze` and play over it), **shimmer** (the reverb's tail fed back through grains an octave up; holds the patch's Reverb), **stutter** (grains fired by an internal divided clock, the read position jumping), **time smear** (a feedback delay into grains an octave down, crossfaded with the dry signal; holds the patch's Delay), **slicer** (a step sequencer picks the read position of the last second, its gate fires the grain), **reverse pad** (long grains from `age` seconds back under a slow attack).
- Modal: **glass bell** (a strike into a bar-like body with a little frequency shift; velocity opens `bright`), **gamelan** (two bar bodies a fifth apart, the second a little sharp, one noise burst), **kalimba** (a plucked tine with a comb body), **marimba** (a bar with a resonator tube by `tube` and a tremolo `motor` for vibes), **bowed glass** (noise through a tracking ladder into a modal body under a slow envelope, a compressor evens the sustain), **rain** (a fast random clock samples noise into a pentatonic pitch and strikes a body), **resonator bank** (three bodies on the root, fifth and octave: a drone from a chord, tuned percussion from a drum loop). Their `hit` parameter is the strike level: the modal body rings loud, so a strike of 0.02..0.06 is the range.
- Comb, shifter, compressor: **bowed string** (noise through a ladder into a high-feedback comb at the pitch, glide), **barber pole** (a slow frequency shift up and down crossfaded by an LFO: an endless rise), **sidechain pump** (a compressor ducked by an internal clock's pulse), **talking filter** (the input's envelope opens the vowel).
- Sequencing: **clock** (square LFO with /2 /4 /8 /div), **step sequencer** (clock, eight steps, quantizer: `pitch` and `gate` out, add its `pitch` to Main's into an oscillator), **random melody** (clocked S&H on noise, quantizer, pulse gate).
- Utilities: **auto pan** (LFO on a Pan: `in` to `l` `r`), **echo** (delay into reverb).


## Module on / off

Every module except Main and Output has a power button in its card header: off, the module is bypassed like a device in a DAW rack. Its main input (`in`, the mixer's `in1`, the crossfade's `a`) goes straight to every output, so a filter, delay, reverb, shaper or compressor drops out of the chain without a repatch; a module without such an input (an oscillator, LFO or envelope) is muted. The module keeps its state and resumes when turned on again. On the FM-1 the FX button toggles the selected module; the switch is saved with the patch. An assembly has the same button: it switches every module inside, and remembers the ones you had switched off yourself so they stay off when the group comes back.
