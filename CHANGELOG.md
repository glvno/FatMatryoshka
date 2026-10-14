# Changelog

## Matryoshka

- Shorten the scope’s audio window from 64 ms to 16 ms, showing one-quarter as many samples across the canvas.

- Return scope traces to their original 1.5 px thickness and use 50% opacity to soften overlapping waveforms.

- Match scope traces to their cable signal colors. Center traces in one-third of the canvas height and show roughly 64 ms of audio across the full width for a steadier view with more cycles.

- Restore full-strength scope palette colors and use thicker, rounded traces. Draw waveforms through the original sample positions to eliminate pixel-stepped lines without filtering the signal.

- Replace the floating oscilloscope window with a transparent, canvas-wide background. Scope the rendered stereo output by default for every preset; keep waveforms fixed while the dot grid zooms and pans with the patch. Retain extra jack probes and move scope mode/visibility controls to Commands.

- Rename the project and active app branding to Matryoshka; remove FAT from the approved wordmark while preserving its MATRYOSHKA outlines and doll artwork. Make the shortened wordmark the type lab’s default.
- Move the app and source repository to lowercase `matryoshka`. Point the existing `/FatMatryoshka-1` redirect directly to `/matryoshka`, preserving paths, queries and shared-patch fragments.

## FatMatryoshka workspace and identity

- Ship the selected Roboto Flex R/1 wordmark and four-doll artwork in the sidebar, About screen, favicon and README. Generate the active assets from the saved selection and support light/dark wordmark colors; retain the full-axis lab and earlier studies.
- Hide the yellow cable-arm terminations behind the coral parent’s rim, removing the exposed interior collars while retaining the side-aligned routing.
- Match cable jackets to the doll whose arms they represent: coral outer arms, yellow middle arms and teal sibling arms, including the shared sibling connection.
- Add an all-coral cable-jacket variant to the brand lab, preserving the port alignment, sibling connection and black-and-gold external plug hardware.
- Give both smallest teal dolls white faces with black eyes and no mouths. Align the coral outer shell’s internal cable origins beneath its external ports to clarify the through-shell connections.
- Save the selected one-line wordmark as the type lab’s default and current-wordmark preset. Repair the yellow center doll’s right cable to connect upward to the coral parent and add a simple smile, preserving the two teal siblings and their connections.
- Add a full-axis Roboto Flex type lab with independent word or line controls, mixed-case studies, live width comparison, theme-aware SVG exports and shareable settings. Include FAT / MAT / RYO / SHKA and FAT / MAT / RYOSHKA arrangements with separate gap sliders. Preserve the teal R/1 signature across variable stroke weight, capital height and slant; match its serif to the selected thin stroke.
- Add round-three brand studies: four Roboto Flex wordmarks with separate FAT/MATRYOSHKA proportions and a teal R-stem numeral 1, plus two teal sibling dolls inside the yellow middle doll, with a direct inner-jack connection and simpler faces. Reuse the existing brand palette. Include light/dark sidebar previews and downloadable artwork.
- Paint slider tracks below internal cables, with draggable controls and jack thumbs above them.
- Remove opaque backgrounds from parameter labels, values and port text so their grid cells no longer hide internal cable segments.
- Use Barlow for patch controls and Barlow Semi Condensed for module and assembly names. Enlarge labels, align tabular values, and wrap assembly actions when needed. Reposition cables when fonts finish loading.
- Keep the wordmark’s 1-shaped K stem at the same height as all the small caps. Add a second comparison gallery with twelve outlined wordmarks and twelve pictorial studies, including pair previews and shareable selections.
- Keep slider backgrounds transparent so internal routes remain visible all the way to their thumbs. Add a separate New patch sidebar button and keep the Examples dropdown for examples.
- Explain the tutorial in plain language. Draw the wordmark as sans-serif small caps in SVG, with teal F, M, and a footless 1 for the K stem; keep its diagonals in the regular text color.
- Rename the project to **FatMatryoshka**. A self-hosted small-caps wordmark integrates “1” into the K ascender. Pages deploys only `main` at `/FatMatryoshka/`; the old URL has a small forwarding page.
- Confine internal cables to their own module layer; keep cross-card wires behind cards. Clicking a partially obscured card or assembly raises it.
- Resize both collapsed assemblies and expanded frames, with pointer or arrow keys. Sizes survive patch export and library round-trips; expanded frames retain enough space for their contents.
- Give Add module and Add assembly equal sidebar prominence. Start new visitors with a simple voice and a reversible five-step tour of signals, controls and reusable assemblies.
- Enable browser audio automatically, resuming on the first interaction when required by autoplay policy; queue notes while the worklet loads.
- Arpeggiate held keys in both browser and firmware. Enabling with no held notes is silent; releasing keys and Panic stop playback. Legacy scale/root fields remain serialized for compatibility; the hardware melody page now exposes rate and octaves.
- Provide ten logo concept candidates and a separate, unimplemented UX proposal report.

## Unreleased (firmware `M1-1.1.0-dev`, app 1.1.0-dev)

The merge of the four-voice firmware (1.0.2) with the polyphony, assembly and module work. Host-tested (vitest, golden vectors, arpeggiator and protocol tests, LCD preview), **not built with the JieLi toolchain and not flashed**.

### Added
- **Keyboard notes after controls:** closed dropdowns, checkboxes and other non-text controls no longer swallow note keys. Holding a note cannot trigger dropdown typeahead. Open dropdowns, text editing, dialogs and keyboard navigation retain their normal behavior, with regression tests for focus and note release.
- **Command palette:** searchable module / assembly tags, shelves and prefab contents; direct insertion of factory and saved assemblies, including same-name variants, with all matching results available.
- **Canvas-first workspace:** removed the header, current-patch container, toolbars and zoom buttons. A 208 px sidebar holds branding, patch/preset controls, adding, audio and navigation. File actions, history, snapshots, hardware settings and help live in the command palette, with browse filters and accessible keyboard selection. Mobile uses a dismissible sidebar drawer. Tab navigates controls; Alt+B switches A/B. Patch names follow history changes, and undo shortcuts leave hidden workspaces and open dialogs alone.
- **Cable and menu layering:** cards and wires share one zoom transform; external cables sit behind cards, and internal routes sit below each card's controls. Routing menus open above the canvas and stay within the screen. Cable endpoints remain aligned when scrolling, and Fit uses actual visible card/assembly sizes.
- **Side-input fan-out:** any side input can feed multiple parameter thumbs; dragging adds a branch, and each branch can be removed independently. Extra destinations keep receiving the signal when its original fixed link is switched off. P1/P2 depth and ranges remain compatible. Additional routes persist in patches and reusable assemblies, with matching browser and firmware DSP (binary format 18; firmware still reads 16/17).
- **Editable internal cables:** click a side-jack-to-slider cable to remove that route, or drag between the side jack and thumb to reconnect it. Fixed CV links are independently switchable as well as p1/p2 assignments; incoming cables and other routes stay connected. State survives patch saves, assembly reuse and undo/redo. Browser and firmware engines support the switches; binary format 17 is used only when fixed links are disabled, and the updated firmware still reads format 16.
- **Slider input jacks:** slider thumbs also patch their existing inputs. Normal drag adjusts, Alt-drag patches, and output cables can be dropped directly on a thumb. Moving thumbs and cable branches follow modulation; targets hold still while patching. The matrix grid is replaced by per-parameter routing menus for depth, ranges and hardware knob assignments, preserving the patch format and device routing.
- **Dedicated CV animation:** filter cutoff, VCA gain and other dedicated CV controls now display the values used by the DSP. This fixes stationary sliders in presets such as Wobble 2, including promoted assembly controls.
- **Live parameter displays:** browser sliders and assembly controls follow effective parameter-input modulation, macro ranges, morphing and MIDI knob values at animation-frame cadence. Dragging keeps control of the base value, saved patches stay unchanged by animation, and stale snapshots are discarded after loading another patch. Polyphony follows the newest held voice.
- Editor: "New patch" starts with Main and Output (the module-free "Empty patch" is gone); the module select is grouped by kind and inserts on pick (no "Add module" button); "Insert assembly" opens a browser with shelves (your library, Drums, Voices, Effects, Textures, Utilities), descriptions, ports and a search; Main and Output never enter an assembly (left out of a selection, stripped from imports); the Patches and Assemblies tabs are one Library tab.
- Shaper: `sym` (asymmetry: an offset before the curve) and `stages` (the curve cascaded 1..4 times, a denser wavefolder); binary patch format 16.
- Assembly cards: the toggle button reads expand / collapse (was open / close); hints and docs follow (#21).
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
- **Filter** outputs `notch`, `peak` and `ap` (allpass) after `mix`, from the same states (no patch format change).
- **Pages from the fork:** the Pages workflow also runs on `dev` and publishes to https://glvno.github.io/Modular-1/ (the firmware step is the first build of this branch with the real toolchain).
- **Performance page** (ENV button): big knob destinations and values, the patch strip, arp / polyphony / octave / bypass count in one line; K1..K4 act on the Main knobs.
- **Safe mode:** SAVE held during the loading screen (or after a failed boot) skips the stored state; the factory patch plays and the state stays in flash.
- **Firmware CI** (`.github/workflows/firmware.yml`): the JieLi build for both voice counts on every push and pull request, failing on compiler warnings, stale generated headers or a pool headroom below 8 KB; the golden, arpeggiator, protocol and LCD-preview tests; the `.fwsc` as an artifact.
- **Factory patches open as assemblies:** five recipe assemblies (filter voice, adsr operator, noise voice, stack voice, vibrato) and an `assemblies` overlay in 29 of the 33 factory patches (binaries unchanged, checked by a test).
- **Phone / tablet:** canvas zoom (pinch, Ctrl + wheel, buttons, fit), one-finger pan, bigger jacks and controls on touch screens, long-press card actions, a floating palette button, narrow-screen toolbars.
- **Share link:** a patch as a URL (deflated JSON in the fragment); opening it loads the patch, the Patches page imports one into the bank list.
- **Diff and A/B:** a Diff panel against the patch as last loaded / uploaded / stored; Set A / Set B and a toggle (Tab) that swaps the values in place when the structure matches.
- **Keyboard:** a command palette (`/`, Ctrl/Cmd+K: add module, insert assembly, load patch), click-to-connect, Delete / B / G / Ctrl+D / arrows on the selection, Space for the arpeggiator, `?` for the list.
- **Scope:** a ◎ on every output jack puts the signal on a panel at the bottom of the canvas: time view (triggered for audio, min / max / mean for control signals) and spectrum (FFT, peak readout), several probes in colours.
- **Arpeggiator in the editor:** the FM-1's arpeggiator ported to TypeScript (same modes, scales, Euclid, clock), its settings on the Main card and saved with the patch (`arp`), sent to the FM-1 with every upload and change (ARP 0x24, INFO feature byte); play from the editor.
- **Macro ranges:** a `↔` in the matrix gives p1 / p2 a travel per destination (two ends, octaves for a log parameter) so that one knob opens the filter from 200 Hz to 8 kHz and shortens the decay at the same time; binary format 15 (a range section after the cables), protocol RANGE (0x23), a bracket over the bar on the LCD.
- **Factory assemblies:** 23 more (38 in all): drums without samples (kick with a click, hats with a choke, clap, rim, cowbell, tom, tabla), granular (cloud, shimmer, stutter, time smear, slicer, reverse pad), modal (glass bell, gamelan, kalimba, marimba, bowed glass, rain, resonator bank), bowed string, barber pole, sidechain pump, talking filter; and the factory patch **909 Kit** (kick, snare, hihat from three sequencers).
- **Patch morphing:** a patch can carry the parameters of another patch of the same structure as its B side (the "B side" picker on the Main card); the Main module's new `morph` parameter and `morph` input fade every parameter from A to B (octaves for log parameters, switches flip at the midpoint) while notes keep sounding. Binary patch format 14 (the B set follows the cables); on the FM-1 the mixer page's K2 and CC 20.
- **Reverb** rebuilt as an eight-line FDN (Householder feedback, damping and a 60 dB decay time per line, two diffusion allpasses, a `pre`-delay up to 40 ms and `mod`, a slow chorusing of two lines). Same ports; `size` now sets the decay time (0.2 .. 6.4 s). 16 KB per instance (was 12).
- **Oversampling** (`os`) on the Shaper and the Digitizer: 2x with the FM oscillator's half-band as interpolator and decimator; the folded harmonics drop by about 11 dB.
- **Sequencer** `glide` (slew between steps, a fraction of the clock period) and `gate` (gate length as a fraction of the period; 1 = legato). Binary patch format 13.
- **Module on / off (bypass):** the ⏻ button on a card (editor), the FX button for the selected module (FM-1). A bypassed module passes its main input to every output (or is muted when it has none) and keeps its state. Binary patch format 12 (bit 7 of the type byte), protocol command BYPASS (0x22). An assembly's ⏻ switches all of its modules and restores their own switches when it comes back.

### Changed
- The project repository and Pages deployment move to `glvno/FatMatryoshka-1` and https://glvno.github.io/FatMatryoshka-1/.
- **FatMatryoshka-1 identity:** a nested synth-doll logo, prominent upstream creator and repository credits, and a coral / teal / gold palette across the browser editor, cables and scope in light and dark themes. Existing patch formats, saved-library keys and firmware package paths remain compatible.
- **One patch at a time:** the voice count is a build switch (`ENG_VOICES`, engine.h; `M1_VOICES=4` for `tools/build.py` and the host test scripts) and the default build has one voice. With one voice SEL does nothing, the top bar shows the patch name without a voice number, the mixer has one row (K1 level, F# mute, ALGORITHM polyphony), the MIDI tab one `MIDI CHANNEL` row, the loading screen says `PATCH`, and the manual reads accordingly. The saved state record keeps four voice slots, so it moves between the builds (a one-voice build reads voice 1 of a four-voice record and writes empty slots for the rest).
- **Memory:** the signal buffers, module instances, delay / reverb / string / chorus lines are pools shared by the voices (each slot has an owner; a load frees and takes its voice's slots). A patch loads when enough is free, else NO ROOM. One-voice build: 255 buffers, 128 instances, 1 delay (521 ms), 1 reverb, 8 strings, 1 chorus, 1 granular line (about 391 KB of the 418 KB pool in a stand-in compile). Four-voice build: 108 buffers, 72 instances, 4 delays, 2 reverbs, 6 strings, 1 chorus, no granular line. Per voice: 32 modules, 192 cables, patch size 3072 bytes. The HELLO reply and the editor's budget (`DEVICE`) follow the build.
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
