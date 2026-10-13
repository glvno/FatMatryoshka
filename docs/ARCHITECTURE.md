# Architecture and plan

## Goal

Patch a small modular synth in the browser, run it on an M-VAVE FM-1. No FM engine, sampler, sequencer or UI from Felucca: only its flashing path and its hardware layer.

## What the FM-1 is (as far as known)

From the Felucca and FM-1 reverse-engineering projects: a JieLi AC791N SoC (pi32v2 core), 240×240 colour LCD, 27 keys, 7 knobs plus volume, USB MIDI/audio, TRS MIDI in, battery. CPU clock, RAM and flash sizes are **not verified** here; Felucca's `firmware/app.ld` and `tools/build.py` hold the memory map (app slot 0x8DFBC bytes, app RAM + a pool region).

## Flash path (reused from Felucca)

1. Browser (or `tools/fm1_install.py`) talks SysEx over USB MIDI. The *device* asks for blocks of a "logical image" (the package minus 20 marker bytes) and the host answers.
2. Step 1: the running firmware verifies parts of the package and stages Felucca's update loader. Step 2: the loader reads the whole package and writes flash. Then the device restarts and the identity (`FM-1_<n>`) is checked.
3. A package is built by `tools/fm1pkg_make.py` / `tools/build.py` (app.bin + loader ota.bin + three JieLi SDK files). The browser can also patch an app.bin into the user's own official V15 (`buildFeluccaPackage`).

## Patch engine

`web/src/engine.ts` and `web/src/modules.ts` are the reference implementation: float DSP, 128-frame blocks, patch graph ordered by `processingOrder` (loops become one-block feedback). Module definitions (`ModuleDef`) are data and are shared by the editor and, later, the firmware.

## Firmware

Builds with `tools/build.py` inside `nix develop` (see CLAUDE.md), flashes with the web flasher or `tools/fm1_install.py`.

- `firmware/src/engine.c` is the fixed-point port of `web/src/engine.ts` and `modules.ts` (all 13 modules, mono voice, CV inputs, feedback cables as one block of delay). Signals and parameters are Q16.16, oscillator phase u32, filter coefficients Q24, envelope Q30; sine, exp2 and tan come from tables (`tools/gen_dsp_tables.py` -> `dsp_tables.h`). No float anywhere. The 32x32->64 multiply and the 32-bit divide are hardware; 64-bit division (a libcall) is used only at block rate and on waveform edges.
- `firmware/src/defs.h` and `presets.h` are generated from the TypeScript definitions (`npm run export-defs` in `web/`): module/port/parameter indices and the factory patches in the binary format of `web/src/patchbin.ts`. Port and type indices are append-only.
- The audio ISR (`audio.c`) renders 128 frames per half buffer. MIDI program change selects a factory patch, note on/off and CC 123 drive the voice. The LCD shows the patch name in the top bar; the measured CPU load (ISR time per half buffer, key scan and USB nested in it) is kept in `eng_us_last` / `eng_us_max` but no longer drawn.
- `tools/golden.sh` renders 11 patches with the TypeScript engine and the C engine (host build) and compares them. Smooth patches agree to about 0.1 % rms (-60 dB), patches with saw/square edges to 1-2 % rms: the Q16 pitch grid moves an edge by a fraction of a sample, which gives short spikes at the edges and no audible difference.
- Memory: signal buffers 82 KB and two delay lines of 93 KB (int16, Q13) sit in the 360 KB pool; limits are 32 modules, 192 cables, 2 delays.

Measured on the FM-1: the 303 Acid factory patch (8 modules, one delay) uses 11 % of the audio budget (peak 12 %).

Patch transfer (M1-0.3): `web/src/protocol.ts` defines the SysEx messages (`F0 7D 4D 31 cmd payload F7`, payload packed to 7 bit): HELLO/INFO, patch upload in 384-byte CHUNKs with an ACK each, COMMIT with a CRC-16, STORE, live PARAM. `firmware/src/proto.c` implements it (host-tested bit-exactly by `firmware/test/proto_test.c` through `tools/golden.sh`), `patchstore.c` keeps the patch in two A/B flash sectors (0x97000, 0x98000) and the firmware boots the stored patch, else factory patch 0. A failed commit leaves the previous patch running; STORE saves the live-edited parameters too. `web/src/device.ts` is the browser side (toolbar: Connect FM-1, Live, Send patch, Store on FM-1); `tools/m1_link.py` does the same from a terminal.

**Parameter inputs and the source matrix (patch format 2, M1-0.6).** Every module except the FM-1 panel and the output has exactly two parameter inputs, `p1` and `p2`, each with an attenuverter (-1..1; scales and inverts), and a matrix with the sources p1, p2, k1, k2, k3, k4 on one axis and the module's parameters on the other. A parameter's effective value is base + (block mean of p1 x att1 and of p2 x att2, for the inputs the matrix assigns to it) x (max - min), clamped. The four knobs k1..k4 are the FM-1's encoders: on the device the SELECT encoder steps through the modules of the patch, and K1..K4 change the parameters their matrix column assigns on the selected module (one click = 1/100 of the range, or the parameter's own step if larger; five times that when turned fast). The FM-1 panel module is the patch's only input and the exception that stays as it was (there is no separate MIDI module: the keys and USB MIDI are handled by the firmware, and by the browser host, and play the one voice that the panel module outputs as pitch, gate and vel; a saved `midi` module becomes the panel module on load): its parameters are k1..k4 themselves and its outputs feed the patch, so with it selected the knobs work as the panel knobs. Default matrix: p1, k1 -> parameter 1, p2, k2 -> parameter 2, k3 -> parameter 3, k4 -> parameter 4. Old (version 1) JSON patches with `<param>_cv` cables are converted on load. The editor shows each card's two inputs with sliders and the matrix as a checkbox grid; changes to the matrix re-send the patch, attenuverters and parameters are live.

**Preset bank (M1-0.8).** The firmware has the 32 factory presets compiled in (`presets.h`, generated from `web/src/presets.ts`). The editor's Presets page lets you choose up to 32 presets (factory ones or the patch in the editor), order them, and upload them: each goes into one flash sector (`slotstore.c`, slots 0..31 at 0xA0000..0xC0000, header with name and CRC written last) through the SLOT / SLOT_ERASE / SLOT_INFO commands, without being loaded. With a non-empty bank the PRESET knob (encoder 6) and MIDI program change step through the occupied slots, otherwise through the compiled-in presets; the top bar shows the preset name. The bank is separate from the current patch of STORE (patchstore.c), which wins at boot.

Not done yet: the FM-1's buttons, a patch name on the device, reading a patch back, the knob matrix columns have no meaning in the browser (there the sliders are the knobs).

## Open questions

- ~~Per-voice polyphony~~ done, see below; the CPU cost per voice on the device is not measured yet.
- ~~Fixed-point vs. float on pi32v2~~ settled by measurement, see below.
- Patch binary format and flash layout (must not touch the loader or the boot-guard areas).

## Measured CPU budget (benchmark firmware, `firmware/src/bench.c`)

Per 128-frame block (2902 us of audio), interrupts off, 16 repetitions, 1 us resolution, run on a real FM-1:

| kernel | us/block | instances in 70 % of a block |
|---|---|---|
| osc, Q15 parabolic sine | 7 | 290 |
| 4x Q15 multiply-add | 9 | 225 |
| state variable filter, Q15 | 8 | 253 |
| osc, float | 489 | 4 |
| 4x float multiply-add | 444 | 4 |
| state variable filter, float | 340 | 5 |
| float to int16 per frame | 116 | 17 |

Conclusions: the core has no FPU (float links against `libcompiler-rt.a` soft float) and float is 40 to 70 times slower, so the audio path is **fixed point only** (Q15 samples, 32-bit accumulators, no float, no 64-bit division). Float is acceptable only at control rate (per block), and better avoided. The fixed kernels are tiny; real modules will cost several times their bare kernel (buffer traffic, modulation, CV), so plan for tens of module instances, and measure the real engine before promising more. The 1 us resolution makes the fixed numbers coarse (+-1 us).

## Panel buttons, saved state, LCD (M1-0.9)

- **OCT- / OCT+** (matrix buttons 0 / 1) shift the keys by up to three octaves (the shifted button's LED breathes, faster the further from 0: ±1 slow, ±2 medium, ±3 fast; a message `OCTAVE +1` shows in the top bar); a held key ends the note it started. **SAVE** (button 9) writes the current state to flash: the patch with its edited parameters, the octave, the selected module and the preset index (the unused words of the current-patch header). **HOME** (8) selects the FM-1 panel module and returns from the arpeggiator pages. ARP 10, SEQ 11, LFO 5, PLAY 12 are the arpeggiator pages and transport; FX 2, SEL 3, ENV 4, EDIT 6, GLO 7 and REC 13 are named and unused (no banner). HOME, ARP, SEQ and LFO glow dimly (`fm1_led_dim`). The button ids are Felucca's panel table; only PLAY and REC there were measured on hardware.
- **LCD** (`firmware/src/ui.c`, previewed on the host with `tools/ui_preview.sh OUT.png PRESET [MODULE [OCTAVE]]`): a top bar with the preset name (black on the accent colour; messages replace it for a moment), a picture of the patch as a vertical strip on the right third (modules as coloured boxes in rows by depth, cables as lines, the selected module framed), the selected module laid out like the arpeggiator pages (small label, value at 1.5x size, value bar per knob row), and the two parameter inputs with their attenuverters and assignments. Choice parameters show their names (SAW, TRIANGLE, S&H), numbers their units (180 HZ, 3.19 OCT) and the value the sound really uses (base plus modulation). With the FM-1 panel selected the rows name where each knob goes (`K1 FILTER CUTOFF`, found from the cables and the target's matrix) and show the knob's position as a bar.

## Reverb, logarithmic cutoff, default knob routing

- **Reverb module**: Freeverb-style, mono: four damped feedback combs in parallel into two allpasses; parameters size, damp, mix. State is int16 (Q13) in the pool (about 12 KB per instance, two per patch).
- **Logarithmic parameters**: `ParamDef.log` (the filter cutoff): parameter inputs, the editor slider and the knobs move it in octaves, so a fraction of the range is a fraction of the octaves (`modulate` in `patch.ts`, `eng_step_param` and the log2 / exp2 tables in `engine.c`).
- **Knobs in the factory presets** (plain `wire(kb, 'k1', module, 'p1')` lines at the end of each preset in `presets.ts`; the module's `add(...)` carries the base value, the matrix and the attenuverter, the panel's `add` the knob start positions): every preset routes K1..K4 from its FM-1 panel module to useful parameters. Rules: K1 is the filter cutoff when there is a filter, K4 the delay mix when there is a delay, K3 the reverb mix when there is a reverb. The panel knobs start at the position that leaves the preset's sound as designed (a test checks this and the rules).

## Polyphony

A patch carries `voices` (1..8, `MAX_VOICES`; the JSON field is absent for mono, byte 3 of the binary header, which was reserved and 0, now holds it: an older firmware plays such a patch mono, the new firmware reads 0 as 1). Nothing else in the patch changes: the voices are implicit, as on the Nord Modular.

**Which modules are per voice** (`voiceSplit` in `web/src/patch.ts`, the same loop in `eng_load`): with more than one voice the FM-1 panel's `pitch`, `gate` and `vel` outputs are per voice (its `k1..k4` are not), and every module reached from them through cables (`p1` / `p2` included) is per voice, except `delay`, `reverb` and `output`, which always run once. A cable from a per-voice output into a shared module carries the **sum of the voices**; a cable from a shared output into a per-voice module reaches every voice. A module nothing per-voice reaches (a free LFO, a noise, a constant) runs once. With one voice nothing is per voice and both engines behave exactly as before (the tests compare the renders).

**Engines.** `engine.ts`: a node has one `Inst` (state, buffers, effective parameters) per voice if per voice, else one; the panel is shared but keeps per-voice `pitch` / `gate` / `vel` buffers (`vout`). `engine.c`: the same split with `inst_t` records in `inst_pool` (in the pool section, `ENG_MAX_INST` 128); a node is `inst0, ninst`, the panel has `nv` instances whose knob outputs share one buffer. Rendering walks the processing order once and runs each node's instances in turn; a shared instance that reads a per-voice output has one summing source per voice. The filter's key tracking follows the pitch of the instance's voice (voice 0 on a shared filter). Both engines: `voices` 1 keeps the held-note stack with last-note priority and legato.

**Voice allocation** (identical in both): a note goes to the voice already holding that key, else to the free voice that has been free the longest, else to the oldest sounding voice. A voice taken over while sounding (`retrig`) outputs one low gate sample at the start of the next block, so its envelopes restart (the ADSR retriggers from its current level). Note off drops the gate of the voice holding that note; nothing is recovered when a stolen note's key is still held.

**Limits on the device.** Signal buffers: 160 (`ENG_NBUF`), one per connected output and instance plus one per summed input; instances 128; `eng_load` returns -6 / -7 when a patch does not fit, which the editor reports as a refused patch. `deviceBudget` in `web/src/patchbin.ts` counts the same way and the toolbar shows it (red when too big). A typical voice (osc, filter, two envelopes, VCA) takes about 7 buffers and 5 instances, so 8 voices of such a patch fit. CPU: a voice costs the per-voice modules' time; 303 Acid uses 11 % of the audio budget mono, so expect 3 or 4 voices of a patch of that size before the budget is gone. Not measured on the device yet.

**Golden vectors.** `web/scripts/golden.ts` adds `poly-pluck` (4 voices, two envelopes, shared delay, more notes than voices), `poly-shared` (3 voices, a shared LFO into every voice's filter `p1`, shared noise through a per-voice VCA, velocity on `p1`, key tracking, two cables into one per-voice input, shared reverb) and `poly-feedback` (2 voices, a feedback cable inside the voice and a shared delay fed back into every voice's mixer), with their own note events; the C engine agrees with the reference to about 0.1 % rms on all of them.

**Controls.** Editor: a `voices` row on the Main module's card (mono, 2..8) with the FM-1 buffer count next to it (red when the firmware would refuse the patch). Device: the GLO button (id 7) opens page 4 (`glo_ui.c`), K1 steps the voice count; `voices_set` in main.c writes header byte 3 of the current patch binary and reloads it with `eng_load` (module state restarts, held notes end); if the firmware has no room for that count the old one is reloaded and the bar says `NO ROOM FOR n`. SAVE stores the patch with the count. The Main module's page shows `MAIN  4 VOICES`. `tools/ui_preview.sh OUT PRESET MODULE OCTAVE PAGE STEP VOICES` previews both.

Not done: the HELLO / INFO reply does not report `ENG_MAX_VOICES`; unison / detune.

## FM oscillator

The oscillator has two ways to make FM-style timbres: the `pm` input (phase modulation by another signal, the `pm` parameter is the index in radians per unit of input, 0..8) and the `fb` parameter (operator feedback: the raw wave modulates its own phase, by pi radians per unit of the average of the last two samples at `fb` = 1, the DX7's level 7). Feedback inside the module replaces the one-block-late feedback cable for this purpose.

**FM mode.** When `pm` is connected with an index above 0, or `fb` is above 0, the oscillator runs at twice the sample rate: two waves per frame (the `pm` input interpolated linearly between frames), then a polyphase half-band decimator of four first-order allpass sections, two per path (coefficients Q16 `5376 17567 35764 55599`, flat to 0.22 fs, 41 dB down above 0.28 fs: 19.4 kHz and 24.7 kHz at 44.1 kHz). Sidebands between the old Nyquist and the oversampled one are filtered out instead of folding back; on bright high notes the non-harmonic (aliased) energy drops from -27..-33 dB to about -41 dB, the decimator's floor. Both engines use the same coefficients; the fixed-point one keeps the allpass states in Q16 (`inst_t.s.osc`). Cost: about 2.3 oscillators. The plain path (no pm, no feedback) is unchanged, so patches without FM render exactly as before.

Two things to know when patching: the band-limited signal overshoots the level (up to about 1.4x on very bright settings), so leave headroom before the output; and the feedback loop runs at the oversampled rate, so the sound for a given `fb` is a little brighter than the same number on a 44.1 kHz implementation.

Binary patch format 7: the oscillator record grew by the `fb` parameter.

## Assemblies (editor only)

`web/src/assembly.ts` is the model, `web/src/assemblies.ts` the library page and the factory set (`web/src/assemblies/*.json`), `editor.ts` the canvas side. The patch stays flat: `Patch.assemblies` is an overlay of entries `{ v, id, name, label, x, y, open, modules, inputs, outputs, params }` where `modules` are ids in `patch.modules`, `inputs` / `outputs` are exposed inner ports (`{ module, port, label }`) and `params` promoted inner parameters (`{ module, param, label }`). Cables always join inner ports, so the engine, `voiceSplit`, `encodePatch`, the protocol and the firmware are untouched, and `validatePatch` keeps the field as an unknown one; `fixAssemblies` (called by the editor when a patch comes in) drops entries that do not fit the modules and reports them. Members are plain modules, never the panel or an output, and never in two assemblies; `v` is there so an entry can later name another assembly as a member.

Rules: `reconcile` keeps an assembly consistent after every structural change (departed members leave, every inner port with an outside cable is exposed, labels of ports that stay are kept); `hidePort` refuses while an outside cable uses the port; a module that joins (`addMember`) retracts the exposures that only its cables had caused. A saved assembly (`AssemblyDef`, `format: "modular-1-assembly"`) is a small patch with local ids 1..n, positions from the top left member, the cables between members, exposed ports and promoted parameters, parameter values as defaults, p1 / p2 matrix and attenuverters, and no K1..K4 assignments (also stripped on insert, since knobs belong to the patch). `insertAssembly` gives fresh ids, places the collapsed card at the next free grid slot and refuses past the 32-module cap. The editor keeps a 40-step snapshot undo of the patch JSON for structural changes (Ctrl/Cmd+Z, Shift for redo). On the canvas a collapsed assembly is one card whose port dots carry the inner module ids, so dragging cables works unchanged; an open one is a frame laid out around its member cards, which get the expose / pin toggles, and dropping a card into or out of the frame changes membership.

## Sync, glide, shaper, spread

- `sync` (a gate input) on `osc` and `lfo`: a rising edge through 0.5 sets the phase to 0 before that sample's increment; the previous sample is kept in the state (`s1`). The oscillator honours it in both the plain and the FM path.
- `glide`: `y += k (x - y)` per sample with the ADSR's rate curve (`env_rate`, 99 % in `time`); the fixed-point state is Q24 because in Q16 the step rounds to nothing while the output is still about 1 % short, which on a pitch is audible and broke the golden comparison.
- `shape`: `drive` (1..32, log) into soft (`1.5 x - x^3 / 2` to the knee at 1, then flat), hard (clamp) or fold (triangle of period 4, two's complement masking does the modulo in fixed point), then `level`. The peak is 1 in every mode.
- `spread`: a new per-voice panel output (`VOICE_PORTS`), `(2 v - (n - 1)) / (n - 1)` for voice v of n, 0 for one voice. `port_poly` in the firmware treats it like pitch / gate / vel.
- Binary patch format 8: the two sync inputs moved `p1` / `p2` of osc and lfo, two module types were appended, the panel grew an output. `TYPE_COLOR` in `ui.c` has entries for the new types.


## Level/rate envelope, string, wavetable, chorus

- `env`: four levels and four times, Q30 state like the ADSR. A rising segment adds 2^30 / (r sr) per sample (so 0..1 takes `r`), a falling one approaches at the ADSR's `env_rate` and ends after `r` samples (the last 1 % is stepped so the next segment starts on time). Stages 0 (idle, tracks `l4`), 1..3, 4 (holds `l3`), 5 (release).
- `string`: a delay line of one period with a one-pole (`cl = 1 − 0.9 damp`) in the loop; per block from the block's first pitch: the period (clamped to 2..1102 samples), the loop gain `g = 2^(−log2(1000) · period / (decay · sr))`, and the fractional delay `period − (1 − cl) / cl` (the one-pole's low-frequency delay), read with linear interpolation. A rising gate loads a burst of `round(period)` samples. The loop is clamped to ±2. Firmware: int16 Q13 lines (`str_pool`, 8 × 1104 samples, 17.7 KB) written with first-order error feedback, because the loop would otherwise recirculate the rounding noise with gain 1 / (1 − g); golden `string` matches to 0.04 %.
- `wavetable`: `tools/gen_wavetables.py` defines 32 frames by their first 32 harmonics (cos / sin coefficients, normalized to a peak of 1), writes them as `web/src/wavetables.json` (the reference builds its tables from them at start) and as `firmware/src/wt_tables.h` (int16 Q15, 257 samples per frame, three mip levels of 32 / 16 / 8 harmonics, 49 KB of flash). The mip is chosen per block from the first pitch (32 harmonics below sr / 64, 16 below sr / 32, else 8); frames are read with linear interpolation and crossfaded by `pos`. Phase modulation is the plain oscillator's (not oversampled).
- `chorus`: shared like the delay (`SHARED_TYPES`, `T_CHORUS` in the firmware's voice split); a 927-sample Q13 line, two taps `12 ms ± 8 ms · depth · sin`, the right one a quarter cycle behind, linear interpolation. One instance per patch (`ch_pool`).
- Pool budget after this batch (device pointers): signal buffers 80 KB, delays 181 KB, reverbs 23 KB, strings 17.7 KB, chorus 1.9 KB, instances 17 KB, LCD strip 29 KB: about 10 KB left of the 360 KB pool. The two 1.05 s delays are the place to look if more is needed.

## Sequencer, clock divider, S&H, quantizer, pulse

- All five act on rising edges through 0.5 (Q16 32768), like `sync`. `seq`: ten parameters (the first module above eight, hence the u16 masks of format 9); `out` is `s[pos]` every sample, so the step's knob is live; the random direction uses the LCG of the LFO's S&H. `clkdiv` counts edges modulo 16 · div (a common multiple of div, 2, 4, 8) and starts at −1 so the first edge is a downbeat. `quant`: semitones = 12 · in − root, octave by floor division, the nearest of the scale's degrees or the next root; ties go down (the two engines can differ at an exact float tie, which modulation never hits). `pulse`: a sample countdown of round(time · sr).
- Golden `seq-clock` (clock -> divider -> pendulum sequencer -> quantizer -> oscillator, sequencer gate -> pulse -> ADSR, d4 -> sync) and `sh-random` (clocked S&H on noise -> pentatonic quantizer, a tracking S&H on the filter, a random sequencer on pulse width; 2 voices) pass at 1.5 % and 0.2 %: the edge decisions line up sample for sample.
## Pan, crossfade, vowel, phaser, digitizer, noise colour

- `pan`: l = in·cos((p+1)π/4), r = in·sin((p+1)π/4) with p = clamp(pan + pos, −1, 1), per sample (C: sin_turn at (p+1)/8 of a turn).
- `xfade`: out = a·(1−m) + b·m, m = clamp(mix + pos, 0, 1).
- `vowel`: three SVF stages (the normalized band output k·v1, peak 1) at the formant frequencies of A (730, 1090, 2440), E (530, 1840, 2480), I (390, 1990, 2550), O (570, 840, 2410), U (440, 1020, 2240) Hz with gains 1, ½, ¼; the position v = clamp(vowel + input[0], 0, 4) interpolates the frequencies linearly between neighbours once per block; k = 1/Q, Q = 2 + 18·res. The C version reuses svf_g / svf_stage and Q20 states like the filter.
- `phaser`: four first-order allpasses y = a(x − y₁) + x₁ with one coefficient a = (g−1)/(g+1), g = tan(πf/sr), f = center·2^(2·depth·tri), tri a triangle LFO at `rate` read once per block; the input of stage 1 is in + fb·(stage 4's previous output), clamped to ±8; out = in·(1−mix) + wet·mix. In C the coefficient is Q24 from one 64-bit division per block.
- `crush`: step 2^(1−bits), y = floor(x/step + ½)·step on the taken sample, held for `rate` samples (C: shift by 17 − bits).
- `noise` `color`: y += c·(white − y), c = 2^(−5·color) (color 0 is c = 1: the old noise bit for bit); the state is Q24 in C.
- Golden kits: `pan-xfade` (3 voices), `vowel-phaser`, `crush-color`.
## Assemblies: merged ports, placement, nesting

- Merged ports: `PortRef.also` (inputs only) lists the further inner inputs a container jack feeds; `targetsOf` / `findRef` resolve them, `mergePorts` / `unmergePort` edit them, `hidePort` treats a group as one and refuses while any target has an outside cable. Cables stay per inner input: the editor creates one per target when a cable lands on the jack (`dot.dataset.also`) and removes the hidden siblings when the drawn one is clicked. Dedupe on the canvas is free: only the primary's dot exists while the assembly is collapsed.
- Placement: `freeSpot(occupied, w, h)` scans `GRID` cells in reading order against the rectangles of the visible cards, containers and frames (the editor measures the DOM, or the model before the first layout).
- Nesting: `AssemblyInst.children` (ids), `allModules` / `descendants` / `parentOf` / `depthOf`, `MAX_DEPTH` 3. `boundary` and `outsideCables` use all modules; a parent's `inputs` / `outputs` / `params` may point at a descendant's module only while the direct child exposes / promotes it (`reconcile` enforces, so `reconcileAll` goes children first and loops until stable). `makeAssembly` nests when the selection is inside one assembly; `addChild` / `removeChild` move an assembly (the editor calls them after a container drag, judged by the card header). `ungroup` lifts members one level, `deleteAssembly` removes direct modules only. Saved files gain `children` and `assemblies` (NestedDef with local ids); `validateAssemblyDef` checks the tree, `fixAssemblies` repairs a loaded overlay (missing children, two parents, loops, depth).
