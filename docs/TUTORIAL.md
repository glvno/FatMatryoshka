# Tutorial design (decided with the owner, 2026-10-14)

The editor's tutorial is a **course of 11 chapters** that teaches the editor and, at the same time, how to build synths from
modules. It replaces the five-step tour (`web/src/tour.ts`).

## Rules

- **Hybrid do-it-yourself.** Every step tells the user one action; the tutorial watches the patch and editor state and shows a
  check mark when the step's **strict structural check** passes (this cable exists, this module exists, this parameter is in
  this range, the assembly is expanded, the scope watches this jack, a note-on arrived, undo restored the previous state).
  Next unlocks on the check; it never auto-advances. **Do it for me** applies the step and advances. If a later edit breaks an
  earlier step the panel says so and Do it for me restores it. Back re-reads the previous step without undoing anything.
  No skip-chapter button: the chapter menu jumps anywhere.
- **Chapters have canned start and end patches.** Starting chapter N: if the open patch passes chapter N−1's final check it
  continues with it, else the canned start is loaded and the panel says so. The canned end patches are listed in the Examples
  picker under "Tutorial".
- **Nothing is lost.** Starting the course puts the open patch into the bank under its name if it is not there yet; the
  chapter patch becomes the working patch. Leaving offers "Save tutorial patch to the bank".
- **Library is real.** Assemblies saved in the course ("My voice" ch 4, "My space" ch 5, "FM keys" ch 6, "Pluck" ch 7) go to
  the real library with a `tutorial` tag on the definition. Later chapters look them up by tag, then name, then fall back to a
  bundled copy and say which they used.
- **Browser only.** K1..K4 are explained as the FM-1's knobs; the device bar and diff are not in the course. Morph A/B is
  taught in chapter 9, the share link closes chapter 11.
- **Text.** Each chapter opens with a short intro that carries the synthesis concept; steps are one action in two or three
  sentences, key first and button in the same sentence ("press G, or click Make assembly"); a step with a real idea in it has a
  collapsible "Why" paragraph, closed by default. UI words: "Tutorial", "Chapter 3 of 11".
- **Targeting.** The step's target element(s) (card, jack, slider, button) get a pulsing outline and are scrolled into view.
  No ghost cables.
- **Panel.** The bottom-right panel, draggable like the scope; docks to the bottom edge under 650 px. An "audio is off"
  hint line appears whenever audio is not enabled (chapter 1 makes enabling audio its first step).
- **Menu.** Sidebar button "Tutorial" (replaces "How a patch works") opens a dialog listing the chapters with ticks, Resume
  on the current one, Start on the others, Reset progress at the bottom. The first-visit welcome leads to chapter 1. Progress
  lives in localStorage.
- **Tests.** For every chapter the Do-it-for-me chain from the canned start passes every check, ends at the canned end,
  validates, and sound chapters render non-silence for a held note. A check must fail on the canned start before its step.

## Fixed links (done first, own commit)

A parameter whose definition names a dedicated input (`ParamDef.input`: VCA gain from `cv`, filter / ladder cutoff from `cv`,
filter and Main `morph`, shift `cv`, pan / crossfade `pos`, vowel) is **permanently** fed by it: that wiring defines the
module. The route is always drawn, grey, dashed, not interactive (tooltip "built in: cv sets cutoff"). `disabledInputs` is
dropped by `validatePatch` (old patches get the link back), the encoder never writes flag bit 2, the firmware keeps reading
it. User-made routes (`inputMap`, side input to slider thumb) stay coloured and editable. Alt-dragging the thumb of a
parameter with a fixed input cables the source to that input.

## Chapters

1. **Hello sound** - enable audio, New patch (Main + Output), add an Oscillator, cable pitch and audio, play a note, scope ◎,
   a wrong cable and Ctrl+Z. Teaches: add module, cable colours, keys, scope, undo.
2. **Shaping a note** - VCA and ADSR: gate opens the envelope, the envelope drives gain (VCA's built-in cv → gain link).
   Teaches: sliders, thumb = jack, Alt-drag, undo / redo.
3. **Subtractive voice** - Filter: cutoff, resonance, morph, track; LFO into the filter's cv (fixed link, depth = cvamt);
   K1 into p1 with the matrix sending it to cutoff and resonance (attenuverter). Teaches: pins, att, matrix, knob colours,
   rest ticks, live thumb vs base tick.
4. **Your first assembly** - select osc + ADSR + VCA + filter, G, expose pitch / gate / out, promote cutoff and release, name
   "My voice", expand, resize, collapse, save. Teaches: select, group, expose / promote, expand / resize, library.
5. **An effect assembly** - Delay + Reverb + Chorus, promote time / mix, B to bypass, Ctrl+D, zoom to fit; save "My space".
6. **Second instrument: FM** - new patch, two oscillators (pm, fb), level / rate envelope; insert "My space" inside the new
   assembly (nesting), merged gate inputs, edit "My voice" to expose p1; save "FM keys".
7. **Plucked and struck** - String (gate plucks it; a noise burst through exc), Modal body, Comb; glide; ×N polyphony;
   save "Pluck".
8. **Wavetables and grains** - Wavetable pad into Granular, Pan, Phaser; a big patch: zoom, pinch, Fit.
9. **Two instruments, one keyboard** - insert My voice + FM keys, Mixer, Pan, Output; arp on the Main card (Space); voices
   count; macro range on a knob; morph A/B.
10. **A random melody machine** - square LFO clock → Clock divider, Noise → S&H → Quantizer → pitch, Pulse → gate, driving
    Pluck and FM keys; Sequencer as the alternative; last step swaps the LFO for Main's clock (arp / MIDI clock).
11. **Drums from noise** - a hi-hat from Noise + level / rate env + Filter; factory kick and snare; Sequencer + divider
    rhythm; share link.

Sound sources covered: osc (1), noise (10, 11), wavetable and granular (8), string / modal / comb (7).
