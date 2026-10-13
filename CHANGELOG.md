# Changelog

## Unreleased (firmware `M1-1.1.0-dev`, app 1.1.0-dev)

The merge of the four-voice firmware (1.0.2) with the polyphony, assembly and module work. Host-tested (vitest, golden vectors, arpeggiator and protocol tests, LCD preview), **not built with the JieLi toolchain and not flashed**.

### Added
- **Polyphony per voice:** each of the four voices' patches plays 1..8 notes (the editor's `voices` row; on the FM-1 the ALGORITHM encoder on the mixer page, shown as MONO / POLY n per voice and in the Main page title).
- Modules from the development branch: glide, shaper, level/rate envelope, string, wavetable, chorus, sequencer, clock divider, S&H, quantizer, pulse, pan, crossfade, vowel, phaser, digitizer; noise colour; oscillator feedback and oversampled FM; sync inputs; the Main module's `spread` output; assemblies in the editor.
- **Oscillator unison:** `unison` (1..5 detuned copies) and `detune` (cents) on the plain path; binary patch format 11 (older stored patches fall back to the factory patch).
- Module **Freq shift** (`shift`): a single-sideband frequency shifter with `up` and `down` outputs, cv and mix.
- **Pitch bend** (±2 semitones on the Main module's pitch, plus a `bend` output), **mod wheel** (`mod` output), **channel aftertouch** (`at` output) and **CC 16..19** to the Main module's knobs, in the browser and on the FM-1 (USB and TRS MIDI).
- Modules **Comb** (tuned feedback comb with signed feedback and damping) and **Modal** (six-partial modal resonator, harmonic to bar-like, with decay, damp and brightness).
- Module **Granular** (`grain`): a one second recording with up to eight pitch-shifted, windowed grains, density, position, spray, trig input and freeze. Shared like the delay; one line on the FM-1 (one-voice build only).
- Modules **Math** (add, sub, mul, min, max, abs, cmp of two scaled signals) and **Logic** (and, or, xor, not of two gates).
- Module **Compressor** (`dyn`): a peak envelope follower with an `env` output and a compressor (threshold, ratio, attack, release, makeup) with a `side` input.
- Module **Ladder**: a four-pole ladder low pass with drive and self-oscillating resonance (outputs `lp24`, `lp12`; the saturator sits inside the loop). Cutoff modulation per block.
- The LFO's restart input is `reset` (it was `sync` on the development branch; patches are converted on load) next to upstream's `clk`.
- **Module on / off (bypass):** the ⏻ button on a card (editor), the FX button for the selected module (FM-1). A bypassed module passes its main input to every output (or is muted when it has none) and keeps its state. Binary patch format 12 (bit 7 of the type byte), protocol command BYPASS (0x22). An assembly's ⏻ switches all of its modules and restores their own switches when it comes back.

### Changed
- **One patch at a time:** the voice count is a build switch (`ENG_VOICES`, engine.h; `M1_VOICES=4` for `tools/build.py` and the host test scripts) and the default build has one voice. With one voice SEL does nothing, the top bar shows the patch name without a voice number, the mixer has one row (K1 level, F# mute, ALGORITHM polyphony), the MIDI tab one `MIDI CHANNEL` row, the loading screen says `PATCH`, and the manual reads accordingly. The saved state record keeps four voice slots, so it moves between the builds (a one-voice build reads voice 1 of a four-voice record and writes empty slots for the rest).
- **Memory:** the signal buffers, module instances, delay / reverb / string / chorus lines are pools shared by the voices (each slot has an owner; a load frees and takes its voice's slots). A patch loads when enough is free, else NO ROOM. One-voice build: 255 buffers, 128 instances, 1 delay (521 ms), 1 reverb, 8 strings, 1 chorus, 1 granular line (about 391 KB of the 418 KB pool in a stand-in compile). Four-voice build: 126 buffers, 92 instances, 4 delays, 2 reverbs, 6 strings, 1 chorus, no granular line. Per voice: 32 modules, 192 cables, patch size 3072 bytes. The HELLO reply and the editor's budget (`DEVICE`) follow the build.
- Binary patch format 10 (the Main module's outputs are pitch gate vel k1..k4 clock spread). Older stored patches fall back to the factory patch.
- **Sliders and ranges:** logarithmic sliders in the editor no longer round to whole numbers (glide time, envelope rates, chorus / phaser rate, drive, grain size, decays were stuck on 0, 1, 2 ...). Filter and Ladder cutoff go to 16 kHz (was 4 kHz). LFO rate and the ADSR times are logarithmic. The Delay's time knob ends at 520 ms, the length of its line (it went to 1000 ms and did nothing beyond 521).
- The manual's MEMORY section lists the shared limits.

### Not verified
- Everything on the device: the firmware build with the JieLi toolchain, the pool headroom, CPU load with four polyphonic voices, the mixer page's polyphony column.

## 1.0.2 (firmware `M1-1.0.2`, app 1.0.2)

### Fixed
- The PRESET knob scrolls the MANUAL page and moves between rows in the settings menu; before, it loaded the next patch even with the menu open (edits on that voice were lost).
- Holding OCT- and OCT+ right as the loading screen ends no longer drops the FM-1 into the update loader at once: the 5 s hold now counts from the end of the splash.
- During the 5 s loading screen the FM-1 answers the editor, the flasher and the UBOOT request, and plays incoming MIDI notes, instead of ignoring them until the screen is gone.
- Fewer redundant redraws at the end of boot.
- Host preview tool: the menu tab and manual line arguments are clamped.

### Not verified
- Not yet seen on the display.

## 1.0.1 (firmware `M1-1.0.1`, app 1.0.1)

### Added
- **Loading screen:** the name, the version, a `LOADING INPUT / AUDIO / USB / MIDI / STATE / VOICE n` line and a bar, shown while the FM-1 starts and the patches load, and for at least 5 seconds. The pages stay hidden until it is done; the restore note (STATE RESTORED or RESTORE FAILED) follows in the top bar.
- **MANUAL tab in the settings menu:** one scrollable page (SELECT scrolls) with the controls, the MIDI mapping, the editor address and the memory limits. Control names are in the accent colour.

### Changed
- Wording: a stored sound is called a **patch** on the device and in the web app (tab "Patches", "Patch bank", "Factory patches", "Load patch…"). Only the hardware PRESET knob keeps its name.

### Not verified
- The loading screen and the manual page were checked in a host preview and flashed, but not reviewed on the display by me.

## 1.0 (firmware `M1-1.0`, app 1.0.0)

Four voices, a mixer, a settings menu and a complete saved state. First version that is no longer a bring-up.

### Voices
- Four independent patches play at once (`ENG_VOICES` 4). SEL cycles the voice that the keys, knobs, LCD and editor act on; each voice has its own accent colour (orange, purple, cyan, green), arpeggiator and MIDI channel (defaults 1 to 4).
- Voices 2 to 4 use voice 1's arpeggiator scale.
- Limits per voice: 24 modules, 128 cables, one delay (up to 521 ms) and one reverb. The browser engine uses the same delay length, so the web app sounds like the device.

### Panel
- **Mixer (GLO):** K1 to K4 set the voice levels; the black keys F#3, G#3, A#3 and C#4 (OP1 to OP4) mute voices 1 to 4 and light their LEDs while muted.
- **Settings menu (hold HOME):** tabs DISPLAY, CONTROL, MIDI and SYSTEM in Felucca's layout. Rows: LEDS (off, dim low, dim high), CPU in bar, knob acceleration, octave, V1 to V4 MIDI channel, MIDI clock in, program change, version, CPU peak, update mode and DEFAULTS (restores everything and erases the saved state).
- The top bar shows the preset name and the CPU load.
- LED glow: DIM LOW is the former glow, DIM HIGH is brighter.

### Saved state
- SAVE stores the whole state in one record: all four patches including knob edits, all arpeggiators, mixer levels and mutes, menu settings, MIDI channels, octave, and each voice's module and preset. Older records still load.
- The bar shows STATE RESTORED after boot (RESTORE FAILED if a saved record did not load).

### Main module
- New gate output `clock` (24 ppqn): from the arpeggiator while it runs, else from MIDI clock; silent without a source.
- The delay has tempo sync (it follows that clock), note-length division and ping-pong.

### Changed
- The Drone preset's delay is 500 ms (was 700 ms) because of the shorter delay line.
- The editor's HELLO reply reports the new limits (24 modules, 128 cables, 1 delay); patch size limit is 2048 bytes.

### Not verified
- Four voices on the device: CPU load and audio quality under load.
- That the OP3 and OP4 keys are A#3 and C#4.
- TRS MIDI input with a real source.
