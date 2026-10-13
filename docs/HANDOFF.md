# Handoff: after the upstream merge, before the one-voice build and the new modules

Written 2026-10-13 at the end of a session. Read CLAUDE.md first (its last section, "Merge with upstream main 1.0.2",
has the merge facts); this file has the decisions and the plan that came after it.

## Where things stand

- Branch `dev` = upstream `main` 1.0.2 merged with all of this branch's work, commit c3e3eee, pushed to the fork
  (`glvno/Modular-1`). No PR to upstream (`WiggisModular/Modular-1`): agreed to build and flash first.
- Host-tested only: vitest 86, `tools/golden.sh` 65 kits, `tools/arp_test.sh`, proto test, `tools/ui_preview.sh`. Never
  built with the JieLi toolchain (Linux only; this Mac has no Docker, no `~/.jieli`), never flashed.
- First thing on the Linux box: `nix develop -c python3 tools/build.py`, read the pool headroom it prints (must be
  >= 8 KB), then `nix develop -c python3 tools/fm1_install.py build/modular-1.fwsc`.
- Versions are `M1-1.1.0-dev` (modular.c) / `1.1.0-dev` (web/package.json, package-lock.json).

## Decisions made with the user (this session)

1. **Instrument shape: one patch at a time, polyphonic.** Upstream's four voices (four patches with SEL, mixer, per-voice
   MIDI channel) are not wanted in the user's build. Keep the code, make `ENG_VOICES` a real build switch, build with 1.
   Reason to keep it: every upstream merge otherwise becomes a repeat of this one.
2. **Keep one delay (521 ms) and one reverb.** Reverb could go (it is always last in the chain), delay stays because it is
   patched inside the graph (LFO on its time, feedback into filters, clock-synced ping-pong). `ENG_NDELAY 1`, `ENG_NREV 1`.
3. **Granular: yes.** Budget fixed as a 1 s int16 buffer (88 KB), up to 8 grains, one module per patch, shared like the
   delay. It records whatever is patched into it (no audio input on the FM-1), a freeze toggle stops recording.
4. **Priority order:** ENG_VOICES switch + pool sizes, ladder filter with drive, unison/detune on the oscillator,
   envelope follower + compressor, math/logic modules, granular, then modal resonator, comb filter, pitch bend / mod
   wheel / aftertouch as Main outputs + CC to knobs, frequency shifter, drum samples from flash (needs a flash-map decision).

## Memory picture (stand-in build, see CLAUDE.md for the method)

Pool is 417,792 B. Now (four voices): 408,482 B. With one voice, one delay, one reverb: about 230 KB used, so about
190 KB free; the 1 s grain buffer takes 88 KB of that. Big items: delay line 46 KB each, reverb 12 KB, LCD strip 30 KB,
signal buffers 512 B each, instances 224 B each (the delay's clock ring made `inst_t` grow), `eng_t` 5.3 KB each.
Proposed one-voice sizes: `ENG_NBUF` 255, `ENG_MAX_INST` 128, `ENG_NSTRING` 8, `ENG_NDELAY` 1, `ENG_NREV` 1,
`ENG_NCHORUS` 1, plus the grain buffer. Keep `DEVICE` in `web/src/patchbin.ts` and the MEMORY lines of
`firmware/src/manual.c` in step with the defines at the top of `firmware/src/engine.c`.

## Step 1: the `ENG_VOICES` build switch (not started)

`ENG_VOICES` is defined in `firmware/src/engine.h`. Places that assume four (C initialisers with four elements fail to
compile with fewer; found with grep in the last session):

- `menu.c`: `MIX_KEY_BIT[ENG_VOICES] = {1, 3, 5, 8}`, `mix_vol[] = {100, 100, 100, 100}`, rows `MR_CH1..MR_CH4` and
  their `ROW_NAME` / `ROW_TAB` entries (make the channel rows `ENG_VOICES` many, or keep four rows and clamp).
- `ui.c`: `VOICE_COLOR[ENG_VOICES] = {4 colours}`, `cfg = {2, 1, 1, {1, 2, 3, 4}, 1, 1}`, `cfg_defaults` sets `ch[0..3]`.
- `main.c`: `VOICE_LINE[ENG_VOICES]`, `boot_blob`: `l[ENG_VOICES] = {0, 0, 0, 0}` and `nv = b[1] == 1 ? 2 : 4`;
  `midi_drain`: `AV[0].play | AV[1].play | AV[2].play | AV[3].play`; the state blob is version 2 = four patches.
  Plan: blob version 3 with the voice count in byte 2, `boot_blob` restores `min(record count, ENG_VOICES)` voices and
  still reads versions 1 and 2.
- `arp.c`: `ARP_N 4`, `AV[ARP_N]` initialiser with four entries (use `ENG_VOICES` and a loop or designated initialisers).
- `engine.c`: `vgain[ENG_VOICES] = {ENG_ONE x4}` (just `{ENG_ONE}` and fill the rest in `eng_voice_select`'s first call,
  or a static initialiser via a loop at load).
- `proto.c`: fine (`m1_curv[ENG_VOICES]`). `manual.c`: text mentions four voices; make the MEMORY / CONTROLS lines
  conditional or neutral.
- Build with both values and run the host tests for each: `tools/golden.sh`, `tools/arp_test.sh`, `tools/ui_preview.sh`.
  The stand-in compile for riscv32 (`clang --target=riscv32-unknown-elf -fno-integrated-as -S`, CLAUDE.md) catches the
  initialiser errors on the Mac.

## How a module is added (the pattern every item below follows)

- `web/src/modules.ts`: a `ModuleImpl` (def + init + process), appended to `ALL` (type indices are append-only).
  Shared-per-patch modules (delay-like) go into `SHARED_TYPES` in `web/src/patch.ts`.
- `cd web && npm run export-defs` regenerates `firmware/src/defs.h` (T_*, port and parameter indices, MAX_IN/OUT/PAR)
  and `presets.h`.
- `firmware/src/engine.c`: a state struct in the `inst_t` union, `m_<type>(const node_t *nd, inst_t *it, uint32_t n)`,
  a case in `process()`, allocation in `eng_load` if it needs a line (copy the delay / string pattern with `slot_take`),
  `init_state` if it needs a seed. Q16.16 signals, `mul16` / `mulr` / `clampi`, tables in `dsp_tables.h` (SIN_T, EXP2_T,
  TAN_T, EXPN_T, LOG2_T; `svf_g()` gives tan(pi f / sr) from a phase increment).
- `firmware/src/ui.c`: a colour in `TYPE_COLOR`, else the patch picture draws the module black.
- Tests: a `describe` in `web/src/engine.test.ts`; a kit in `web/scripts/golden.ts` (`kit(name, (add, wire) => ...)`),
  then `tools/golden.sh` must pass (rel rms <= 5 %, smooth patches reach 0.1 %).
- Docs: a section in `docs/ARCHITECTURE.md`, a line in README's module list, CHANGELOG "Unreleased".
- Bump `VERSION` in `web/src/patchbin.ts` and `ENG_PATCH_VERSION` in `engine.h` only if a record layout changes (a new
  type appended does not; new parameters on an existing module do).

## Notes for the first modules

- **Ladder with drive**: model it on `m_filter` (Q20 integrator states, rounded products, `svf_g` for the warped cutoff,
  `exp2_scale` for cv/tracking). Four one-pole stages with a tanh-ish saturator (use `shape`'s soft clip or a small table)
  on the input and in the feedback, resonance up to self-oscillation, `drive` parameter, outputs `lp24` and `lp12`
  (2-pole tap). Keep cutoff log (`log: true`) and `cvamt`, `track` like the SVF so the knob pages read the same.
- **Unison**: parameters `unison` (1..5, step 1) and `detune` (cents) on `osc`; in the plain path run N phases with a
  symmetric detune spread and sum / N; `inst_t.s.osc` needs N phases (it has 13 words now; 5 phases fit). Not for the
  FM path at first. Patch format bump (new parameters on an existing module).
- **Envelope follower + compressor**: one module `dyn` with `in`, `side` inputs, `env` (control) and `out` outputs;
  attack / release one-poles in Q24 (Q16 one-poles stall, see CLAUDE.md "Lesson"), threshold / ratio in dB via LOG2_T.
- **Math / logic**: `math` (a, b -> add, mul, min, max, abs, cmp) and `logic` (gates: and, or, xor, not) as tiny modules.
- **Granular**: `grain` module, shared, 1 s int16 line from a new pool (`gr_pool`, `ENG_NGRAIN 1`), params position,
  size, density, pitch, spray, freeze (toggle), mix; up to 8 grains with a Hann window from SIN_T; linear interpolation.
