# Modular-1 — notes for Claude

Nord Modular–style patchable synth for the **M-VAVE FM-1**, with a browser app to edit patches and flash firmware. Owner: morgulbrut. Read `README.md`, `docs/ARCHITECTURE.md`, `LICENSING.md` first.

## Decisions already made with the user

- **No FM engine and no Felucca features.** Only Felucca's flashing path and hardware layer (HAL, USB, update loader) are reused. GPL-3.0-only for the whole repo; keep Felucca's SPDX/copyright headers on copied files.
- Own repo (this one), not the stikka repos. The default branch is `main` (the work of `claude/nord-modular-fm1-webapp-cikr6h` and the dependabot bumps, vite 8 / vitest 5, were merged into it); GitHub Pages deploys from `main`. No PR unless asked.
- Aftermarket firmwares exist: Felucca (`hugelton/Felucca`, GPL-3.0, source at commit `a4d7ca2e`), Sloop (installer only, no source found). Felucca is the reference; its source is the only documentation of the hardware.

## State (milestone 1 done, pushed)

- `web/`: Vite + TS. `src/patch.ts` (data model, ordering, validation), `src/modules.ts` (12 module defs + DSP), `src/engine.ts` (block engine, 1..8 voices), `src/worklet.ts` + `src/audio.ts` (AudioWorklet, bundled via `?worker&url`), `src/editor.ts` (DOM cards + SVG cables), `src/flasher.ts` (UI over Felucca's `src/flasher/fm1ota.js`, `fm1pkg.js`), `src/presets.ts`, `src/input.ts`.
- `npm test` (vitest, 10 tests), `npm run build`, `npm run dev` all pass. The built app was smoke-tested in headless Chromium: audio worklet produces sound on key down, silent after release, cable drag/remove works.
- `firmware/hal`, `firmware/crt0.S`, `firmware/app.ld`, `tools/*` are copies from Felucca (`build.py` adapted, loader ID changed to `ota-FM-1_800`).

## Added since milestone 1 (web only, tests pass: 14)

- Preset `303 Acid`; osc `pw` (pulse width); LFO wave `S&H`.
- Every param has a CV input `<param>_cv` (`cvPort` in `modules.ts`): effective = base + mean(cv over block) * (max-min), clamped, applied per block in `Engine.applyCv`. Exception: module `fm1`.
- Module `fm1` ("FM-1 panel"): pitch/gate/vel plus knobs k1..k4 (sliders on the card). Buttons and the other 3 encoders were deliberately left out.
- A single-file HTML build was tried and reverted at the user's request; the build stays multi-file.
- Firmware build was attempted: blocked on macOS (no Docker, toolchain is Linux x86-64), no `firmware/src/`, no SDK files. The user moves to a Linux box, so step 1 below can run natively.

## Firmware build (works, not flashed)

- `nix develop` (flake.nix) sets `JIELI_TOOLCHAIN=~/.jieli/toolchain` and `AC79_SDK=~/.jieli/ac79-sdk`. Toolchain: `tools/get_toolchain.sh`; SDK: sparse clone of `cpu/wl82/tools` at tag `AC79NN_SDK_V1.2.1_2023-12-13` (the 3 files match the expected SHA-256). The prebuilt clang runs on NixOS via nix-ld.
- `python3 tools/build.py` builds `build/modular-1.bin` (15 KB), `build/loader/ota.bin` and `build/modular-1.fwsc` (identity `FM-1_800`) with no warnings; all checks pass.
- `firmware/src/` (bring-up): `modular.c` (single unit), `main.c` (reduced Felucca boot: boot-loop guard, OCT-/OCT+ 5 s UBOOT, OTA, UBOOT SysEx), `audio.c` (sine voice on MIDI notes), `font5x7.c`, plus Felucca's `usb.c`, `ota.c`, `ota_hw.c`, `storage_hw.c`, `lcd.c`, `libc.c` (ota_hw.c edited to use `text5x7`). Felucca source: `~/.jieli/felucca` at `a4d7ca2e`.
- build.py no longer runs `generate()` (the gen_*.py tools are not in this repo) and skips `size_fns.py` unless `FELUCCA_SIZE=1`.
- The sine/MIDI/LCD code has never run on hardware.

## Measured on device (flashing works, user-confirmed)

Benchmark (`firmware/src/bench.c`, numbers in docs/ARCHITECTURE.md): no FPU, float 40-70x slower than Q15 (osc 489 us vs 7 us per 128-frame block). **Decision: audio path fixed point only.** `tools/build.py` links `libcompiler-rt.a` from the toolchain; install with `nix develop -c python3 tools/fm1_install.py build/modular-1.fwsc` (mido/rtmidi are in the flake; the tool asks for confirmation interactively).

## Engine port (done on the host, not yet measured on device)

- `firmware/src/engine.c` (+ `engine.h`, generated `defs.h`, `presets.h`, `dsp_tables.h`): fixed-point port of all 13 modules, 1..8 voices, Q16.16. `tools/golden.sh` (inside `nix develop`) compares it with `web/src/engine.ts`: 11 patches pass (rms error <= 3 % of reference rms; smooth patches ~0.1 %).
- Regenerate after changing `modules.ts` or `presets.ts`: `cd web && npm run export-defs` (defs.h, presets.h); tables: `python3 tools/gen_dsp_tables.py`. Binary patch format: `web/src/patchbin.ts` (type/port indices are append-only).
- **Verified on the FM-1 (M1-0.2): sound is clean.** 303 Acid costs 11 % of the audio budget (peak 12 %, ISR time per 128-frame half incl. key scan and USB). The 27 keys play F3..G5 (`fm1_in.notes`), the MASTER pot is a software gain read via ADC (square law, `master_q12`); output samples are 24-bit in the LOW bits of each I2S word (Q16 << 6, -6 dBFS ceiling), not left-justified as the HAL comment suggests.
- Device: audio ISR renders the engine; MIDI program change = factory patch, the CPU figure is no longer drawn (`eng_us_last`/`eng_us_max` remain).
- `firmware/src/bench.c` is only compiled with `-DM1_BENCH`.

## Patch transfer (M1-0.3, host-tested, NOT yet run on the device)

- SysEx protocol in `web/src/protocol.ts` (documented there) <-> `firmware/src/proto.c`; hooks and flash store in `main.c` / `patchstore.c`; browser side `web/src/device.ts` + toolbar in `index.html`/`main.ts`; terminal tool `tools/m1_link.py` (`info`, `upload build/golden/303-acid.m1p`, `param`, `store`, `note`, `bank` = write the 32 factory presets from `presets.h` into the flash bank, `bank-info`, `bank-clear`; the bank commands are untested on the device).
- First thing to do after flashing M1-0.3: `nix develop -c python3 tools/m1_link.py info`, then upload, param, store, power-cycle (the stored patch must come back: label `STORED PATCH`). Flash writes by the app (sectors 0x97000/0x98000) have never run on the device.

## Parameter inputs + matrix + module select (M1-0.6, host-tested; device UI not yet seen)

- Replaces the per-parameter `<param>_cv` inputs: two inputs `p1`, `p2` per module (not fm1/output) with attenuverters `att` (-1..1) and a matrix `map` (sources p1 p2 k1..k4 -> parameters). Model in `web/src/patch.ts` (`fixMatrix`, `defaultMap`, version 2, v1 migration), semantics in `engine.ts applyCv` and `engine.c apply_cv`, binary patch format 2 (`web/src/patchbin.ts`: +8 byte attenuverters +6 byte masks per module that has inputs), protocol cmd 0x21 ATT.
- Device: SELECT (encoder 0) steps through the modules, K1..K4 change the parameters of the selected module per its matrix column (fm1 module: k1..k4 as before). LCD shows module name, the four knob rows and the P1/P2 attenuverters + assignments. Patch size limit 3072 B. Old stored patches (format 1) are refused at boot -> factory patch 0.
- Found and fixed with the golden test: the filter had a DC offset at low cutoff (truncation bias in Q16 states); states are now Q20 and products rounded.
- M1-0.7: the `midi` module is gone. Keys and USB MIDI feed the one voice, which only the `fm1` (FM-1 panel) module outputs (pitch/gate/vel + k1..k4); old patches with `midi` load as `fm1`. Binary patch format is now 3 (type indices moved). A patch needs an FM-1 panel module to be playable.
- Factory patch "FM-1 Panel synth" uses p1/p2 of filter and delay with explicit matrices.

## Preset bank + 32 factory presets (M1-0.8, host-tested; flash bank not yet run on the device)

- `web/src/presets.ts`: 32 factory presets (5 original + 27 generated with `voice()` / `toOut()` helpers, all playing from the FM-1 panel module). `cd web && npm run export-defs` regenerates `firmware/src/presets.h` (all 32 are compiled into the firmware as fallback).
- Bank in flash: `firmware/src/slotstore.c` (32 sectors at 0xA0000), protocol commands SLOT 0x13 / SLOT_ERASE 0x14 / SLOT_INFO 0x15 (reply 0x42), web page `web/src/bank.ts` (tab "Presets", list stored in localStorage `modular-1.bank`). Device: encoder 6 (PRESET) and program change step through the bank (or the factory list if the bank is empty); boot loads the STOREd patch if any, else entry 0.
- Hazard I hit: never `git checkout <file>` on a file with uncommitted work (I lost presets.ts once and had to rewrite it).

## M1-0.9 (host-tested; device UI/buttons not yet seen)

- Buttons: OCT- (id 0) / OCT+ (id 1) octave shift of the keys, SAVE (id 9) stores the state (patch + octave + selected module + preset) via `m1_store`; unused buttons show nothing (ids from Felucca's panel table: only PLAY/REC were measured, SAVE may differ: check on the device).
- LCD rewritten in `firmware/src/ui.c`; preview without a device: `nix develop -c tools/ui_preview.sh out.png PRESET [MODULE [OCTAVE]]`. Font now has + % & > = ( ) ? ! # * < , _ '.
- Choice names / units / input names / log flags are generated into `defs.h` (`export-defs.ts`).
- New module `reverb`; patch binary format 4; filter cutoff is logarithmic (`ParamDef.log`); each preset in `presets.ts` ends with plain `wire(kb, 'kN', module, 'p1'|'p2')` lines for K1..K4 (the module's `add` has the base value, `map` and `att`; the panel's `add` the k1..k4 start positions; `voice()` returns `[vca, adsr]` and takes optional opts for both) (rules in docs/ARCHITECTURE.md).
- Pool use is 318 KB of 368 KB (signal buffers, 2 delays, 2 reverbs, the LCD picture buffer).

## Filter rework (host-tested, golden 42 patches pass; not flashed)

- Module `filter` (label now just "Filter", it was "SVF filter"): outputs in this order `lp24`, `lp12` (was `lp`, old patches are migrated in `validatePatch`), `bp`, `hp`, `mix`; input `morph` (after `cv`); params `track` (check box, `ParamDef.toggle`; cutoff follows the played pitch 1 oct/oct, C4 = cutoff as set, per block) and `morph` (0 = 24 dB LP .. 1 = HP, plus the input, clamped). lp24 = a second SVF stage on lp12, damped (k = sqrt 2), so the resonance comes from stage 1. `hp` is the 12 dB high pass of stage 1.
- Binary patch format is now 6 (5: port indices after `cv` moved, 2 new params; 6: filter output order); old stored patches fall back to factory patch 0.

## Panel and LCD pass (host-previewed / built, not flashed)

- LCD: top bar = preset name only (black on `C_ACC`, messages replace it for 1 s); module page like the arp pages (`text_mid` = 1.5x font, 9 px per char), value bars on every knob row (`param_bar`), patch diagram as a vertical strip at x 164..240. `screen_idle` no longer blanks the screen (page switches still do); `put_param` terminates its string.
- Buttons (main.c): OCT- 0, OCT+ 1, FX 2, SEL 3, ENV 4, LFO 5, EDIT 6, GLO 7, HOME 8 (FM-1 panel page), SAVE 9, ARP 10, SEQ 11, PLAY 12, REC 13; unused ones do nothing. HOME/ARP/SEQ/LFO glow dimly; octave LEDs breathe with speed by |octave| (HAL `fm1_br_step`, one shared speed, PLAY's green LED breathes while the arp runs).
- TRS MIDI in: `firmware/src/midi_uart.c` (Felucca's parser), polled in the TIMER5 ISR; never tried with a real source (TRS type A/B unknown).
- USB product string is `Modular-1` (port "Modular-1:Modular-1 MIDI 1"); host tools match felucca|modular|fm-1. Boot splash is off (`-DM1_SPLASH`).

## Flash tab (simplified)

- One click installs the firmware bundled with the app: `tools/build.py` then `cd web && npm run firmware` copies `build/modular-1.fwsc` to `web/public/firmware/modular-1.fwsc` + `modular-1.json` (version, product, sha256; git-ignored). If the FM-1 is sitting in its update loader from an interrupted install, the same button finishes that write. "Return to stock" needs the official `FM-1.fwsc`; "Install another package" takes any `.fwsc` that carries the loader. The "combine the official V15 with an app.bin" step is gone (`buildFeluccaPackage` is no longer used by the UI).

## Polyphony (host-tested, golden 45 patches pass; not flashed) — device controls superseded by the merge section at the end

- `Patch.voices` (1..8, absent = mono), binary header byte 3 (was reserved 0; firmware reads 0 as 1, the patch version stays 6 so older firmware plays such patches mono). `voiceSplit` (patch.ts) = the per-voice set, `voicesOf`, `VOICE_PORTS`, `SHARED_TYPES`; the rules are in docs/ARCHITECTURE.md "Polyphony". The control is a `voices` row on the Main card (`Editor.voicesRow`), `×N` badge on per-voice cards (editor.ts), `deviceBudget` / `DEVICE` in patchbin.ts (the row shows the buffer count, goes red, and main.ts puts it in the status line when the FM-1 would refuse the patch). Device: GLO button = `PAGE_GLO` 4 (`glo_ui.c`, `glo_view_draw`), K1 -> `voices_set` (main.c: header byte 3 of `m1_cur`, `eng_load`, rollback on error), `eng_voices()`, Main page title shows the count.
- engine.ts: `Inst` per voice, `VoiceState` allocator (`noteOn` / `noteOff`), `voiceNotes()` / `nvoices` for tests. engine.c: `inst_t` in `inst_pool` (`.pool`, `ENG_MAX_INST` 128), `node_t` = `inst0, ninst`, `voice_t E.vc[]`, `cur_v`, `port_poly` / `buf_of`, `eng_voices()`. Module functions take `(const node_t *nd, inst_t *it, n)`. `MAX_SUM` 192, `MAX_SRC` 512. Load errors: -6 out of buffers / sources, -7 out of instances.
- The engine's sample type is `esig_t` now (`sig_t` is a typedef in macOS `<signal.h>`; `tools/golden.sh` therefore runs on macOS with plain gcc/clang + node). `tools/ui_preview.sh` runs on macOS too: ui.c's picture buffer uses `UI_POOL` (empty on the host, `.pool` in modular.c); the preview takes an optional 9th argument POLY (after PAGE, ARP_STEP, MENU_TAB, MANUAL_LINE).
- CPU per voice on the device: not measured. Memory added: `inst_pool` about 16 KB in the pool, `sum_src` 2 KB in .bss.
- Not done: INFO reply without `ENG_MAX_VOICES`, unison. Button id 7 = GLO is from Felucca's panel table and unmeasured, like the other named buttons.

## Not verified — do not claim otherwise

- The flash tab and installer have never run against a real FM-1 in this project.
- Polyphony has only run on the host (vitest + golden); the firmware with it has not been built with the JieLi toolchain nor flashed.
- FM-1 CPU clock, RAM and flash sizes are unknown. A single reverse-engineering write-up (not seen first-hand) names the chip JieLi AC791N / pi32v2. Memory map hints: `firmware/app.ld`, `tools/build.py` (app slot 0x8DFBC bytes).
- Whether `buildFeluccaPackage` (patch an app.bin into the user's official V15) also swaps in the Felucca loader. Read `web/src/flasher/fm1pkg.js` `Package.setApp` before relying on it.
- Product identity `FM-1_800` (`PRODUCT` in `web/src/flasher.ts` and `tools/build.py`) is a choice, not something the device mandated; it must match `FELUCCA_ID` in the firmware build.

## How the flash path works (from reading Felucca)

SysEx over USB MIDI. The device *pulls* blocks: it sends read requests (cmd 0x30) for addresses in a "logical image" (package minus 20 marker bytes after each of the first 20 32-byte blocks); the host answers with `response()`. Step 1: running firmware checks the package (finish addr `0xE0000000`) and stages the loader; step 2: the loader (`usb_hid_ota.bin`, marker `FELUCCA-LOADER-1`) reads everything and writes flash (finish `0xF0000000`), then reboots. Identity handshake `F0 00 32 45 00 00 00 40 7F F7`; upgrade command `F0 22 24 35 7F F7`. Recovery: an interrupted write leaves the device as `ota-FM-1_*` ("WL80UBOOT" USB name); run the install again. Return to stock: official V15 file, sha256 `db1642b2…edb8a`. Hold OCT− + OCT+ for 5 s on a running Felucca to enter UBOOT.

## Next steps (in order)

1. (done, see above) **Get the toolchain.** `tools/get_toolchain.sh` (downloads from `pkgman.jieliapp.com`) and the AC79 SDK (`Gitee Jieli-Tech/fw-AC79_AIoT_SDK`, tag `AC79NN_SDK_V1.2.1_2023-12-13`; needs `cpu/wl82/tools/uboot.boot`, `cfg_tool.bin`, `cfg/eq_cfg_hw.bin`). These hosts were blocked in the cloud sandbox but should work on the user's machine. Linux x86-64 native; macOS uses Docker (`JIELI_DOCKER`). Env: `JIELI_TOOLCHAIN`, `AC79_SDK`.
2. (built, untested on device) **Hello-world firmware** in `firmware/src/` (`main.c` etc.): boot on the Felucca HAL, LCD text, sine out, identity `FM-1_800`. Reuse Felucca's `main.c` boot order, `fm1_cstart`, `usb.c` (MIDI + the OTA request handling in `ota.c`/`ota_hw.c` must stay so the device can be re-flashed!), `audio.c`, `lcd.c`. Strip everything engine/UI related. Adapt `tools/build.py` (it compiles only `firmware/src/felucca.c` as a single unit including the other `.c` files, and runs `mmio_check`: register access only inside `hal/`).
3. Run `tools/build.py`, flash with `web/` flasher or `tools/fm1_install.py`. Keep the official `FM-1.fwsc` handy for return-to-stock. Test the recovery path (interrupt a write) deliberately before trusting anything.
4. (done on host) Port the engine to fixed-point C; golden-vector test against `web/src/engine.ts`. Measure CPU on device (Felucca shows CPU load in MENU > SYSTEM > INFO; its `tests/target_budget.py` is a reference).
5. Patch transfer over SysEx, panel mapping. See `docs/ARCHITECTURE.md`.

## Gotchas

- **Chromium aborts the whole browser (SIGILL) in `midi::MidiManager::SetInputPortState`** (its ALSA Web MIDI backend, Chromium 151 on this NixOS box; `coredumpctl list` shows a series) when MIDI ports change while any page holds MIDI access, e.g. the FM-1 re-enumerating after a reset or during a firmware update, or other programs (`fm1_install.py`, `m1_link.py`: rtmidi/ALSA clients) coming and going. The web app therefore requests MIDI only on a click (Enable MIDI keyboard, Connect FM-1, the flasher) and has Release MIDI (reload). Prefer `tools/fm1_install.py` for flashing; close the app's tab before running CLI tools. Headless Chromium runs I started also dump core when killed.

- Never flash untested firmware that lacks Felucca's OTA handling; that removes the way back (apart from the loader/stock path).
- `pkill -f "<pattern>"` inside a Bash tool call matches the shell itself; use `pgrep`+PID or a pidfile.
- Web MIDI + SysEx needs Chrome/Edge and https or localhost.
- Engine buffers are 128 frames; modules read `ctx.n` (≤128), not `BLOCK`.
- Keep patch-format changes in `patch.ts` and update `validatePatch`, presets and tests together.

## FM oscillator (host-tested, golden 47 patches pass; not flashed)

- `osc` parameter `fb` (0..1, operator feedback, pi per unit of the two-sample average at 1) and an FM mode: with `pm` connected (index > 0) or `fb` > 0 the oscillator runs 2x oversampled with a polyphase allpass half-band decimator (same Q16 coefficients in `modules.ts` and `engine.c`, see docs/ARCHITECTURE.md "FM oscillator"). The plain path is untouched.
- Binary patch format is now 7 (the osc record has 7 parameters, `MAX_PAR` 7); old stored patches fall back to factory patch 0. Golden adds `osc-feedback` and `fm-2op`.
- Measured in the reference engine: aliasing of bright FM notes down 9..13 dB to about -41 dB; the decimated signal overshoots the level by up to ~1.4x, so a carrier at level 1 straight into the output can clip. `inst_t.s.osc` grew to 13 words (feedback history, pm interpolation, decimator states).

## Assemblies (editor only, browser-tested)

- `web/src/assembly.ts` (model, no DOM), `web/src/assemblies.ts` (library page, localStorage `modular-1.assemblies`, factory set from `web/src/assemblies/*.json` via `import.meta.glob`), `editor.ts` (selection: shift-click / rubber band; container cards; expanded frames; membership by drag; snapshot undo). `Patch.assemblies` is an optional overlay; the engine, encoder, protocol and firmware ignore it, old editors keep it as an unknown field. Tests: `assembly.test.ts` (12).
- Factory assemblies: `web/scripts/gen-assemblies.ts` defines thirteen of them as small patches (grid positions, cables, exposed ports with `also` for merged gates, promoted parameters) and writes `web/src/assemblies/*.json`; `voice.json` and `echo.json` are kept as files. `assembly.test.ts` lists the names, inserts every one and plays it. The operator and the drums use the level/rate envelope, the subtractive voices keep the ADSR.
- Class names: `.pin` is the parameter-input row (pins), the expose / promote toggle button is `.tog`.

## Sync, glide, shaper, spread (host-tested, golden 49 patches pass; not flashed)

- `osc` / `lfo` input `sync` (rising edge restarts the phase), modules `glide` (one-pole slew, Q24 state in C) and `shape` (soft / hard / fold), panel output `spread` (-1..1 per voice, in `VOICE_PORTS` and `port_poly`). Appended to `ALL` in `modules.ts` so type indices stay; binary format 8. Golden adds `sync-glide-shape` and `spread` (3 voices).
- Lesson: a Q16 one-pole with a small coefficient stalls about 1 % short of its target (the step rounds to 0); keep such states in Q24 / Q30 as the ADSR does.


## Level/rate envelope, string, wavetable, chorus (host-tested, golden 53 patches pass; not flashed)

- Modules `env` (DX7 level / rate envelope), `string` (Karplus-Strong, `exc` input, 8 per patch, `str_pool`), `wavetable` (banks from `tools/gen_wavetables.py` -> `web/src/wavetables.json` + `firmware/src/wt_tables.h`; rerun the script after changing the recipes), `chorus` (shared, stereo, one per patch). Appended to `ALL`; binary format 9 (also: u16 matrix masks).
- The string loop is clamped to ±2 in both engines (a steady `exc` would grow by 1 / (1 − g)); its int16 line uses error feedback. Falling `env` segments end after `r` (not when within 1e-4 like the ADSR decay), else the next segment starts about 2 r late.
- Pool: about 10 KB free after this batch (numbers in docs/ARCHITECTURE.md). The LCD colours of new types go in `TYPE_COLOR` (ui.c), or the module page draws them black.

## Sequencer, clock divider, S&H, quantizer, pulse (host-tested, golden 55 patches pass; not flashed)

- Modules `seq` (10 params: s1..s8, len, dir; rest = step at −1), `clkdiv` (out / d2 / d4 / d8, reset), `sh` (hold / track), `quant` (scales in `SCALES` in modules.ts and engine.c: keep both lists in the same order), `pulse`. Appended to `ALL`; MAX_PAR is 10 now (inst_t.eff grew by 3 words).
- A square LFO is the clock in tests and golden kits (rising edge at sample 0 because the square starts high); a reset edge on the same sample as a clock edge wins.
## Pan, crossfade, vowel, phaser, digitizer, noise colour (host-tested, golden 52 patches pass; not flashed)

- Modules `pan` (in, pos → l, r; equal power), `xfade` (a, b, pos → out), `vowel` (three formant band passes, position per block), `phaser` (four allpasses, triangle sweep per block, feedback), `crush` (bits / rate reduction); `noise` got a `color` parameter after `level` (color 0 = unchanged output). Appended to `ALL`; formulas in docs/ARCHITECTURE.md. `inst_t` union grew: `vow` (6 words), `phs` (10 words); `MAX_IN` / `MAX_OUT` / `MAX_PAR` are unchanged (6 / 8 / 7). Golden adds `pan-xfade` (3 voices), `vowel-phaser`, `crush-color`.
## Assemblies: merged ports, placement, nesting (browser-tested)

- `PortRef.also` = merged container inputs; `AssemblyInst.children` = nesting (MAX_DEPTH 3); `freeSpot` = placement. Model in `assembly.ts` (tests in `assembly.test.ts`, 18), editor glue in `editor.ts` (`mergeTools`, `nesting`, `moveTree`, `containers` map). Drops into a frame are judged by the card header (`HEAD_Y`), not the card centre: cards are tall.
- Verified in Chrome with synthetic pointer events (real drags cannot be generated by the automation): merge / split, cable to a merged jack and its removal, insert placement, nesting by drag, exposing a child's merged port on the parent, saving and re-inserting a nested definition, undo.
## Delay sync / ping-pong (host-tested, golden pass; not flashed)

- Module `delay`: inputs `in`, `clk`; outputs `out`, `r`; params `time`, `fb`, `mix`, `sync` (toggle), `pingpong` (toggle). Sync: the same `time` knob picks a note length (range split in `DELAY_DIVS`, shortest first: 1/16T .. 1/1, shared with the LFO's `div`; `ParamDef.altText` shows the name, LCD special case in `ui.c`, `delay_div()` in engine.c). Tempo = the last 24 pulses of `clk` (the Main module's clock, 24 ppqn), smoothed; 120 bpm until a clock has come in. Ping-pong: one buffer split in two halves, so the time is limited to ~525 ms then; `out` = left, `r` = right (without ping-pong `r` = `out`); `fb` and `mix` apply to both sides. Binary patch format 8.

## Main clock output (host-tested, golden pass; not flashed)

- Module `fm1` (Main) has a gate output `clock` after `k4` (appended, patch format unchanged). Source: the arpeggiator's 24 ppqn tick while `arp_play`, else MIDI clock (0xF8 from USB or TRS; 0xFC mutes until 0xFA/0xFB), else no output. `eng_clock_tick()` counts ticks; `m_fm1` / `Engine.voice.clock` turn a block that saw a tick into a pulse over its first half (block-quantized, ticks within one block merge). Browser: Web MIDI 0xF8/0xFA/0xFB/0xFC via `input.ts` -> worklet `clock` / `clockrun`.

## Two voices (host-tested, golden + arp tests pass; not flashed, CPU not measured)

- Bi-timbral: the engine has `ENG_VOICES` = 2 independent patches (`eng_t EV[]`, `E` = the selected one via `eng_voice_select`; `eng_render` mixes both and restores the pointer, the clock `clk_ticks` is shared). Per voice pool: 80 buffers, 1 delay, 1 reverb (was 160/2/2 for the one patch; same total pool, 323660 B; a patch with two delays or reverbs no longer loads, no preset uses them).
- SEL (button 3) switches the voice that keys, MIDI, knobs, LCD (bar shows `1 NAME` / `2 NAME`), program change and editor uploads act on; the SEL LED is lit on voice 2; notes held on the old voice end. Per-voice panel state is in `vs[]` (ui.c, macros `sel`, `cur_preset`, `patch_label`, `load_err`), the patch copy in `m1_curv[]` (proto.c). One arpeggiator per voice (`AV[2]`, `arp_p` = the selected voice's; PLAY and the arp pages act on it; the clock output follows voice 1's arp, else voice 2's, else MIDI); voice 2's scale is always voice 1's (the scale knob is refused there).
- Storage: see "Saved state" below. Editor STORE is refused while voice 2 is selected.
- LCD accent (`C_ACC`): orange on voice 1, purple (0xA19F) on voice 2; preset names are per voice (`label_buf[]`); the module colours in the patch picture are unchanged.
- Both voices rendering doubles the audio ISR time: measure on the device (`eng_us_max`).

## Mixer page + settings menu (host-previewed / built, not flashed)

- `firmware/src/menu.c` (included after `arp_ui.c`): GLO opens the mixer (`PAGE_MIXER` 4): K1 / K2 the level of voice 1 / 2 (percent, square law, `eng_voice_gain`), the F#3 (OP1) and G#3 (OP2) keys mute voice 1 / 2 and play no notes (`keys_poll`, `MIX_KEYS`). HOME held 0.7 s opens the settings menu (`PAGE_MENU` 5, Felucca style: ALGO steps the tabs DISPLAY / CONTROL / MIDI / SYSTEM, PRESET or SELECT the rows, K1..K4 or OCT-/OCT+ the value; HOME tap or hold closes). HOME now acts on release (tap = go to Main).
- Rows: LEDS, CPU IN BAR, KNOB ACCEL, OCTAVE, MIDI TO (selected / voice 1 / voice 2, notes only; program change stays on the selected voice), CLOCK IN, PROG CHANGE, VERSION, CPU PEAK, UPDATE MODE (OCT+ twice within 3 s -> UBOOT). Settings are `cfg` (ui.c); they and the mixer levels / mutes are saved by SAVE in the upper bits of `ps_state[0]` (`state_pack` / `state_unpack` in main.c; bit 15 marks a record that has them).
- The top bar shows the name at the left and the CPU load at the right (`cpu_pct`: peak ISR time of the last 0.5 s in % of the 2.9 ms half buffer, `cpu_poll`).

## Saved state + defaults (built, not flashed)

- SAVE (and the editor's STORE) writes the whole panel state as one blob into the patch store (`blob_build` in main.c; sectors 0x97000 / 0x98000, `PS_MAX` 3840 B): both voices' patches as they run (parameter edits included), both arpeggiators' settings (`arp_pack`, transport not saved), plus in the header words the octave, menu settings and mixer levels / mutes (`state_pack`), each voice's selected module and preset. Boot: `boot_blob`; a record from before (a bare patch, first byte 0xA1) still loads as voice 1. Too big for the sector: `ERROR`. RAM .bss is now 60 KB of 72.
- MENU > SYSTEM > DEFAULTS (OCT+ twice within 3 s): settings, mixer, arps, octave back to the defaults, voice 1 = preset 0, voice 2 = preset 1, and the stored state is erased (`defaults_now`, `ps_erase`).

## MIDI channels per voice, LED modes, mute LEDs (built, not flashed)

- `cfg.ch[2]`: voice 1 / 2 listen to their own MIDI channel (menu rows V1 / V2 CHANNEL, 0 = omni, defaults 1 and 2; both on the same channel = both play). Notes, CC 123 and program change go to the voices whose channel matches (`midi_drain`); program change loads into that voice. The panel keys still play the selected voice. MENU > MIDI TO is gone.
- `cfg.leds`: OFF / DIM LOW / DIM HIGH (`fm1_led_dim_level`, default dim high). Channels and LED mode are saved in a 3 byte tail of the state blob (after the two patches); the old bits 8 and 13..14 of `ps_state[0]` are no longer used.
- The F#3 / G#3 key LEDs are lit while voice 1 / 2 is muted (`mix_apply`), on every page.

## Four voices, LED levels (built, host tests + golden pass; not flashed, CPU not measured) — the per-voice memory slices were replaced by shared pools, see the merge section

- `ENG_VOICES` = 4 (engine.h): four independent patches, SEL cycles 1 -> 2 -> 3 -> 4, colours orange / purple / cyan / green (`VOICE_COLOR`, `C_ACC`), one arpeggiator each (`AV[4]`, scale of voices 2..4 = voice 1's), per voice MIDI channel (defaults 1..4), mixer rows K1..K4, mute keys F#3 G#3 A#3 C#4 = OP1..OP4 (`MIX_KEY_BIT`; OP3/OP4 positions are a guess), mute LEDs on those keys. The clock output follows the lowest voice whose arp runs.
- Memory: to fit four engines, per voice 24 modules, 128 cables, 40 signal buffers, one delay of `DELAY_LEN` 23000 samples (521 ms, the TS reference engine uses the same length now; the old 1.05 s did not fit), one reverb; `M1_PATCH_MAX` 2048. RAM region of app.ld is 24 KB, pool 408 KB (everything big is `ENG_POOL`: `EV`, `m1_curv`, the staging buffers). Pool headroom is 10 KB (build.py wants >= 8 KB). Preset 27 Drone's delay was 700 ms, now 500. The editor's HELLO reply reports 24 modules / 128 cables / 1 delay.
- Saved state blob version 2 (4 patches, 4 arps, tail with channels, LED mode, mixer levels and mutes); version 1 and bare-patch records are still read. Word 1 of the record holds one selected-module byte per voice, word 2 one preset byte per voice. Boot shows STATE RESTORED (or RESTORE FAILED when a record was there but did not load).
- LEDs: OFF / DIM LOW (the old glow, `FM1_LED_DIM_NS` 3.2 us) / DIM HIGH (`FM1_LED_DIM_HI_NS` 8 us, the tick waits the rest of the pulse); `fm1_led_dim_level(0|1|2)`.

## Loading screen (flashed in 1.0.1; not seen on the display by Claude)

- The boot splash is always on now: `splash_draw` right after `lcd_init`, then `boot_step(what)` prints `LOADING INPUT / AUDIO / USB / MIDI / STATE / VOICE n` and a bar (accent colour) while `fm1_main` and `patch_boot` run; it stays up at least `SPLASH_MS` = 5 s (the bar is the elapsed time; after loading the line reads READY; meanwhile `midi_drain` and `host_poll` (editor SysEx, M-UPGRADE, UBOOT SysEx) run, so hosts are answered from the start). The OCT- + OCT+ 5 s UBOOT hold counts from the end of the splash (`t_btn`). While `booting` is set (ui.c) `screen_idle` draws nothing, so the page does not flash through; after `patch_boot` the screen is cleared and the page plus the bar are drawn, and the restore note (STATE RESTORED / RESTORE FAILED) comes from `boot_msg`. The old `M1_SPLASH` define is gone. Host preview sets `booting = 0`.

## Manual tab (flashed in 1.0.1; not seen on the display by Claude)

- The settings menu has a fifth tab MANUAL (`menu.c`, text in `manual.c`): controls, MIDI mapping, editor link, memory limits, one scrollable page (SELECT or PRESET scrolls; PRESET only steps patches outside the menu, ALGO changes tab, OCT buttons do nothing there). Lines are `MANUAL[]` entries, first character = style (`#` heading, ` ` text, `~` dim), at most 35 characters, capitals only (no `;` in the font). Keep it in step with the buttons, `midi_drain` and the limits. Preview: `tools/ui_preview.sh out.png 1 0 0 5 0 4 <first line>`.

- Wording: in user-visible text (LCD manual, web app) a stored sound is a "patch", not a "preset"; only the hardware PRESET knob keeps its name. Identifiers (`PRESETS`, `preset_load`, `#presets` tab id, file names) are unchanged.

## Merge with upstream main 1.0.2 (host-tested: vitest 86, golden 65, arp + proto tests, LCD preview; NOT built with the JieLi toolchain, not flashed)

- Upstream's four **voices** = four patches (`EV[ENG_VOICES]`, SEL, mixer, per-voice MIDI channel, blob state). This branch's polyphony (`Patch.voices`, 1..8) is kept per patch; the firmware calls those **notes** (`pv_t`, `ENG_MAX_POLY`, `eng_poly()`; `voices_set` became `poly_set`). Rules and numbers in docs/ARCHITECTURE.md "Voices and the shared pools".
- **Shared pools with owners** (engine.c): `inst_own[]`, `buf_own[]`, `dly_own[]`, `rev_own[]`, `str_own[]`, `ch_own[]`; `eng_load` frees the loading voice's slots, then `slot_take` / `slots_take`. Sizes: 128 buffers, 96 instances, 4 delays (23000 samples = 521 ms, as the web engine), 2 reverbs, 6 strings, 1 chorus; per voice 32 modules, 192 cables, MAX_SUM 128, MAX_SRC 256, patch 3072 B. Stand-in build (clang `--target=riscv32-unknown-elf -fno-integrated-as -S`, the HAL's inline asm cannot be assembled on macOS; `scratchpad/sizes.sh` idea: sum the `.size` directives of `.pool`) says 408.5 KB of 417.8 KB; it overestimated upstream's 1.0.2 by about 7 KB against build.py, so expect ~16 KB real headroom. Tune the `#define`s at the top of engine.c, `DEVICE` in patchbin.ts and the MEMORY lines of manual.c together.
- **Ports / format:** Main outputs `pitch gate vel k1..k4 clock spread` (clock shared by the notes, `port_poly`; spread per note). LFO inputs `clk`, `reset` (this branch's `sync` input renamed: `validatePatch` converts cables, `gen-assemblies.ts` and golden kits updated; osc / wavetable keep `sync`). Delay as upstream (clk, r, sync, pingpong). Binary format 10; `ENG_PATCH_VERSION` 10.
- **Panel:** GLO = mixer (upstream); ALGO on the mixer page steps the selected voice's polyphony (`poly_set`, MONO / POLY n in the rows and the Main page title). `glo_ui.c` is gone. Manual MEMORY lines list the shared limits. HELLO reply says 32 modules / 192 cables / 4 delays. Version strings `M1-1.1.0-dev` / `1.1.0-dev` (bump at release as upstream does).
- Editor: `paramRow` got upstream's `altText` (synced delay time as a note length) through `refreshers`; tabs are "Patches" + "Assemblies"; `Engine.clockTick` / `clockRun` set `clock` on every note's `Voice`.
- Fixed on the way: dev's main.c used `voices_set` before its definition (the JieLi toolchain never saw it); upstream's `vgain[]` initialised only two of four voices (harmless, `mix_apply_all` runs at boot).
- Hazard: `git merge` auto-merged several upstream fragments into engine.c (`buf_pool[VOICE_NO]`, `eng_clock_tick`, the voice API at the end, the delay's state struct) without conflict markers; check the whole file, not only the hunks, after a merge there.
- `web/public/firmware/modular-1.fwsc` / `.json` are upstream's 1.0.2 package (CI rebuilds it for Pages); not rebuilt here.

## Handoff

- `docs/HANDOFF.md` (2026-10-13): the decisions after the upstream merge (one-voice build via `ENG_VOICES`, one delay + one reverb, granular budget, feature order) and the plan for the first new modules. Read it before continuing that work.

## One-voice build switch (handoff step 1, done 2026-10-13; host-tested, NOT built with the JieLi toolchain, not flashed)

- `ENG_VOICES` (engine.h) defaults to 1; `M1_VOICES=4 python3 tools/build.py` and `M1_VOICES=4 tools/golden.sh | arp_test.sh | ui_preview.sh` build the four-voice panel. Pool sizes follow the count (`#if ENG_VOICES == 1` at the top of engine.c: 255 buffers, 128 instances, 1 delay, 1 reverb, 8 strings, 1 chorus; else 126 buffers, 92 instances, 4 delays, 2 reverbs, 6 strings). `ENG_VOICE_INIT(a, b, c, d)` makes per-voice initialisers (arp.c `ARP_INIT`, menu.c, ui.c, main.c, engine.c `vgain`).
- Panel with one voice: SEL does nothing (LED off), no voice number in the top bar, the mixer has one row `K1 LEVEL (OP1: MUTE)`, the MIDI tab one `MIDI CHANNEL` row (`CH_TAB`, hidden rows have tab `MT_NONE`; the menu walks rows by `menu_row_at` / `menu_pos`, not `first + r`), loading line `PATCH`, manual text under `#if ENG_VOICES > 1`. `arp_any_play()` (arp.c) is the clock-source test.
- Saved state: record version 2 with `BLOB_NV` 4 slots in both builds (the handoff's "version 3" was not needed). HELLO reply uses the defines; `DEVICE` in patchbin.ts is 255 / 128 (the one-voice build).
- `tools/pool_sizes.sh [-DENG_VOICES=4]` is the stand-in pool estimate (clang for riscv32 `-S` on modular.c, sums the `.size` of `.pool` symbols; runs on this Mac): one voice 302,338 B of 417,792 B (115 KB free; the granular buffer of 88 KB fits), four voices 408,482 B.

## New modules after the switch (host-tested: vitest 105, golden 73; not built with the JieLi toolchain, not flashed)

- `ladder` (4-pole ZDF ladder with a saturator in the loop, cv per block), osc `unison` / `detune` (patch format 11, `inst_t.s.osc.ph[4]`), `dyn` (peak follower + compressor; note `exp2_q16` returns a plain integer: add `16 << 16` for Q16), `math`, `logic`, `grain` (shared; `gr_pool` of `grain_line_t` = 1 s int16 + 8 grain records, `ENG_NGRAIN` 1 in the one-voice build, 0 with four voices). Formulas in docs/ARCHITECTURE.md, each with a golden kit.
- `comb` (the string's line and `it->s.str`, shares `ENG_NSTRING`) and `modal` (six 2-pole resonators, Q30 coefficients; cos θ via `sin_turn30` and the half angle, a Q16 cosine detuned it by 1 %). Golden kits `comb`, `modal`.
- Main outputs `bend`, `mod`, `at` (shared; `pitch` includes the bend at ±2 st); `Engine.bend / cc / aftertouch`, worklet messages `bend` / `cc` / `at`, firmware `eng_ctl_v` + `midi_drain` (CC 1 mod, CC 16..19 knobs via `eng_find(T_FM1)`). The TS engine clamps its final output to ±1: test control outputs near 0.
- `shift` (Hilbert pair + quadrature oscillator; the sideband naming was verified by test, the formula's sign is the pair's convention). Stand-in pool with everything: 392,278 B (25 KB free).
- Golden lessons: anything that spawns events from an accumulator must use the same quantized increment in both engines (the grain's density increment is floored to 2^-24 in TS); a spawn inside a block must see the per-sample write index, not the block's start value.
- Stand-in pool (`tools/pool_sizes.sh`): 392,278 B of 417,792 B with the granular line (25 KB free). The four-voice build has no granular line (`ENG_NGRAIN` 0), 126 buffers and 92 instances (trimmed from 128 / 96 when `inst_t` grew), about 409 KB; `M1_VOICES=4 tools/golden.sh` skips the grain kit.

## Bypass + slider audit (host-tested: vitest 108, golden 74; not built with the JieLi toolchain, not flashed)

- Bypass: `ModuleInst.bypass`, `thruInput(def)` / `ModuleDef.thru` (mixer `in1`, xfade `a`, else the input named `in`, else mute), binary format 12 = bit 7 of the type byte (proto.c masks it with `M1_TYPE`), `def_t.thru`, engine.c `m_bypass`, protocol 0x22, editor ⏻ button (`bypassButton`, undo via `history`), FM-1 FX button (`bypass_toggle` in main.c; proto.c reaches the LCD through the `m1_ui_changed` hook since ui.c comes after it in modular.c). Assemblies: `bypassAssembly` (`AssemblyInst.bypass` / `kept`, the careful restore). Details in docs/ARCHITECTURE.md "Bypass".
- Slider audit: the editor's log sliders rounded to integers (`snapTo` now), cutoff max 16000, LFO rate and ADSR a/d/r log, delay time 1..520 (`DELAY_TIME_MIN/MAX`). Changing a log parameter's range changes how far a parameter input moves it (octaves of the range): the Pluck preset's K1 start was recomputed (test "knob routing leaves the sound").

## Issue sweep (2026-10-13, host-tested: vitest 131, golden 80 kits in both builds, arp + proto tests, LCD previews, Chrome checks; NOT built with the JieLi toolchain locally, not flashed)

All 20 issues of the fork (`glvno/Modular-1`) except #1 (device build and flash) were implemented on `dev`, in the order sound, editor, rest:

- Sound: filter outputs `notch` `peak` `ap` (#11); `os` oversampling on `shape` / `crush` (#14); `seq` `glide` / `gate` (#12); the reverb is an 8-line FDN (`RV_LINE`, 16 KB, #13); patch morphing (#4: `paramsB`, Main `morph` param + input, format 14, `morph_unit` / `morph_value`, mixer K2, CC 20); 23 factory assemblies + the `909 Kit` preset (#15, #18: the modal body needs a `hit` scale of 0.015..0.06 in front). Patch format is **15** (format 13: os + seq params; 14: morph B set after the cables, header flag bit 0; 15: macro range section after that, flag bit 1).
- Editor: macro ranges (#3: `ModuleInst.range`, `paramUnit` / `paramValue`, RANGE 0x23, `node_t.ranged` + `E.ranges`, LCD bracket); the arpeggiator in TS (#5: `web/src/arp.ts`, `Patch.arp`, ARP 0x24, INFO byte 5 = features, hook `m1_arp_set`); scope (#7: `Engine.probe`, worklet rings, `web/src/scope.ts`); diff + A/B (#8: `web/src/diff.ts`, `Editor.applyLive`); shortcuts + palette (#9, main.ts); mobile (#10: `Editor.zoom`, pinch / pan, long press); share links (#17: `web/src/share.ts`, `#p=`); factory patches carry an `assemblies` overlay (#19: five recipe assemblies; `patchbin.test` checks the binaries are unchanged).
- Rest: `.github/workflows/firmware.yml` (#2); the ENV performance page `PAGE_PERF` (#6); boot-safe mode `boot_safe` (#16); Pages enabled on the fork with the workflow on `dev` too (#20: https://glvno.github.io/Modular-1/; the `github-pages` environment needed a deployment branch policy for `dev`, added via the API, or the deploy job is rejected).
- `tools/build.py` rejects any immediate between 0xFFC00000 and 0xFFD00000 (it looks like a chip ROM address): a Q16 constant of -64 .. -48 trips it (the exponent clamp `-(60 << 16)` did; it is -(47 << 16) now). The real CI build: no warnings; pool 399,112 B (one voice, 18.7 KB free) / 401,224 B (four voices, 16.6 KB free): the stand-in overestimates the four-voice build by about 8 KB.
- Pool trims for the four-voice build on the way: `ENG_NBUF` 108, `ENG_MAX_INST` 72 (stand-in 8.8 KB free); one voice 18.7 KB free. `presets.h` must be regenerated after a format bump (it was stale at 14 once; the firmware CI now checks `export-defs` output is committed).
- Browser checks run against the user's own dev server on port 5173 (it serves this checkout); do not start a second one.
- Editor UX pass (2026-10-13, decided with the user): patch = complete sound (New patch = `newPatch(DEFS)`: Main + Output, deletable), assembly = building block (never Main / Output: editor filter + `stripPatchIO` in `validateAssemblyDef`); module select grouped by `MODULE_GROUPS` (main.ts) inserts on pick; `AssemblyBrowser` (browser.ts, shelves = `CATEGORIES` in assemblies.ts, `category` per `asm()` in gen-assemblies.ts, voice.json / echo.json by hand); one Library tab (`tab-library` holds the bank and the assemblies sections). The user wants the core-module / assembly distinction visible in the controls: a plain select for modules, a browser for assemblies; no merged "Add…" control.
- Shaper `sym` / `stages` (after the sweep): `shapeChain` / `shape_chain`, no state, patch format **16**, golden kit `wavefold` (81 kits).

## Slider ticks, knob colours, side pins (2026-10-14, browser-checked on the user's dev server; editor only)

- Slider thumb = the live (modulated) value from the engine; a tick in the secondary colour marks the base (`slider-jack.ts setBase`, `.slider-base`). A drag moves the base by the thumb's travel (`offset` in `paramRow`), so the live value stays under the pointer for additive routes; rows whose display is a product (VCA gain x cv, pan, mix, vowel) still settle part way back. The track is inset by half a thumb so min / max ticks sit flush with its ends.
- FM-1 knobs K1..K4 are colour coded in Sloop's hues (`--k1`..`--k4` in style.css, blue / green / yellow / orange; light and dark values): the Main card's k rows and output jacks (`data-knob`), the cables from them (`.cable.knob-kN`), and a tick under every slider a knob reaches (`web/src/knob-rest.ts knobRests`: cable from kN to a p1 / p2 pin via `att` + `map` or a macro range, to an `inputMap` route, or to a dedicated input via the new `ParamDef.rest` formula; only knobs that move the parameter off its base). `Editor.refreshKnobTicks` runs after `drawCables` and on every slider input (a knob or a base it rests on). The knob tick is centred on the track like the base tick, so a thumb over it hides it. Yellow and orange are close to the gate (gold) and audio (coral) cable colours.
- The p1 / p2 pins are in the input column with the other jacks (the `.pins` row and `Editor.pins` are gone).

## Tutorial course + permanent fixed links (2026-10-14, browser-checked on the user's dev server; editor only)

- A parameter's dedicated input (`ParamDef.input`: VCA cv, filter / ladder cutoff cv, morph, shift cv, pan / crossfade pos, vowel) is permanently linked: the route is drawn grey and inert (`.cable.alias.fixed`), `disabledInputs` is dropped by `validatePatch`, the encoder never writes format 17 / flag bit 2, the firmware still reads it. Golden kits `fixed-links`, `side-input-fanout`.
- `web/src/tutorial/`: `model.ts` (Step / Chapter types, `TutorialState`, `Actions`, patch helpers, `HeadlessSession` + `runCourse`), `chapters.ts` (the 11 chapters; `courseRun()` memoizes the headless run: canned starts / ends, bundled copies of the five saved assemblies; `tutorialDef(tag, name, library)` = the user's by tag, then name, else bundled), `tutorial.ts` (panel, chapter menu, progress in localStorage `matryoshka.tutorial`, 400 ms poll, target highlight, Actions adapter), `tutorial.test.ts`. Design: docs/TUTORIAL.md. The old `tour.ts` is gone; `starter.ts` stays as the first-run patch.
- Step flags: `transient` (editor state / counters, skipped when judging whether a patch continues a chapter), `superseded` (a later step of the chapter undoes it: not re-checked, not re-applied). `completes(ch, patch, lib)` is that judgement. Every apply must be idempotent-by-check (the runtime and tests skip apply when the check already passes).
- Host hooks in main.ts: `tutorial.noteOn / undone / redone / zoomed / flipped / shared / bypassed`, `EditorEvents.onHistory`, `Editor.transact / selectOnly`, `AssemblyDef.tutorial` tag, `bank.addToBank`. Examples picker has a "Tutorial" optgroup = `chapterEnd(i)`.
- The scope traces nothing on its own any more (the automatic output traces are gone from scope.ts and the worklet): it starts hidden, appears with the first ◎ probe, and shows a hint when it has none.
- A done step auto-advances after `ADVANCE_MS` (900 ms); Back holds the previous step (`hold`) and shows Next instead.
- A step's check is a list of named parts (`need(...)` in chapters.ts: `cable`, `gone`, `added`, `knob`, `promoted` helpers), each with its own elements, labelled as an imperative to the user ("Cable Main gate → VCA cv", "Set cutoff to 800 Hz or below"; the helpers add the verb): the panel lists the unmet parts under the text ("Still to do") and highlights the first unmet one (`Step.focus`), so a locked Next always says why and points where. A panel with nothing to sit beside (intro, chapter done, welcome) is centred on the screen.
- Interior routes (the user's own, `.cable.alias`) get an invisible `.cable-hit` path 1.5x the stroke on top of the card's controls (`.internal-cables` z-index 3); the visible path takes no pointer events. The scope's default corner is the top right.
- The panel places itself beside the step's first target (right, left, below, above; never over any highlighted element; `Tutorial.place`), follows it each poll tick, and stays where the user dragged it until the target changes. The highlight is re-applied every tick because the editor rebuilds its cards.
- Chapter 1 puts a gated VCA in front of the Output before any audio reaches it (test: silent without a key after every step); the Output's default `level` is 0.15 for the same reason (defs.h regenerated; engine tests that need the old loudness pin 0.7; the `fixed-links` golden kit was made louder since its chain sat at the Q16 floor).
- A VCA with nothing plugged into cv is closed (both engines; `m_vca` reads the zero buffer, modules.ts no longer treats an unconnected cv as 1). No factory patch or assembly had an unplugged VCA cv; tests and golden kits that did now feed a Constant of 1.
- Lesson: an apply that deletes a module must use `removeModule` (cables too) or the engine throws on a dangling cable.
