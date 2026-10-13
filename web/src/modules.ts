// SPDX-License-Identifier: GPL-3.0-only
// The module library: definitions (shared with the editor) and DSP implementations.

import type { ModuleDef, ParamDef, PortDef } from './patch';
import WT from './wavetables.json';

export interface Voice {
  /** octaves relative to middle C (MIDI 60) */
  pitch: number;
  gate: number;
  velocity: number;
  /** where this voice sits among the voices, -1 (first) .. 1 (last); 0 with one voice */
  spread: number;
  /** a clock tick (24 per quarter note) falls in this block */
  clock: boolean;
  /** the performance controls, the same for every voice: pitch bend -1..1, mod wheel 0..1, channel aftertouch 0..1 */
  bend: number;
  mod: number;
  at: number;
}

/** the pitch bend range: +-2 semitones on the Main module's pitch output */
export const BEND_OCT = 2 / 12;

export interface Ctx {
  sr: number;
  n: number;
  inp: Record<string, Float32Array>;
  out: Record<string, Float32Array>;
  connected: Record<string, boolean>;
  p: Record<string, number>;
  voice: Voice;
}

export interface ModuleImpl<S = any> {
  def: ModuleDef;
  init(sr: number): S;
  process(c: Ctx, st: S): void;
}

const audio = (name: string): PortDef => ({ name, kind: 'audio' });
const control = (name: string): PortDef => ({ name, kind: 'control' });
const gate = (name: string): PortDef => ({ name, kind: 'gate' });
const param = (name: string, min: number, max: number, def: number, extra: Partial<ParamDef> = {}): ParamDef => ({
  name,
  min,
  max,
  default: def,
  ...extra,
});

const WAVES = ['sine', 'triangle', 'saw', 'square'];
const C4 = 261.6255653;

function polyBlep(t: number, dt: number): number {
  if (t < dt) {
    t /= dt;
    return t + t - t * t - 1;
  }
  if (t > 1 - dt) {
    t = (t - 1) / dt;
    return t * t + t + t + 1;
  }
  return 0;
}

function wave(kind: number, phase: number, dt: number, pw = 0.5): number {
  switch (kind) {
    case 0:
      return Math.sin(2 * Math.PI * phase);
    case 1:
      return 4 * Math.abs(phase - Math.floor(phase + 0.5)) - 1;
    case 2:
      return 2 * phase - 1 - polyBlep(phase, dt);
    default: {
      let v = phase < pw ? 1 : -1;
      v += polyBlep(phase, dt);
      v -= polyBlep((phase + 1 - pw) % 1, dt);
      return v;
    }
  }
}

/**
 * The FM-1 front panel as a module, the patch's only input: the voice that the 27 note keys and MIDI play
 * (pitch/gate/velocity; MIDI is handled by the firmware / the browser host, not by a module) and encoders 1-4 as 0..1 values. In the browser the panel is the module's own sliders; on the
 * device the encoders feed the same outputs.
 */
const N_KNOBS = 4;
const knobNames = Array.from({ length: N_KNOBS }, (_, i) => `k${i + 1}`);

const fm1: ModuleImpl<null> = {
  def: {
    type: 'fm1',
    label: 'Main',
    inputs: [],
    outputs: [control('pitch'), gate('gate'), control('vel'), ...knobNames.map(control), gate('clock'), control('spread'), control('bend'), control('mod'), control('at')],
    params: [...knobNames.map((n) => param(n, 0, 1, 0.5, { step: 0.01 }))],
  },
  init: () => null,
  process(c) {
    c.out.pitch.fill(c.voice.pitch + c.voice.bend * BEND_OCT, 0, c.n); // the bend is already in the pitch (+-2 st)
    c.out.gate.fill(c.voice.gate, 0, c.n);
    c.out.vel.fill(c.voice.velocity, 0, c.n);
    c.out.spread.fill(c.voice.spread, 0, c.n); // -1..1 across the voices: detune or pan them with one cable
    c.out.bend.fill(c.voice.bend, 0, c.n); // the raw wheel, for other uses
    c.out.mod.fill(c.voice.mod, 0, c.n);
    c.out.at.fill(c.voice.at, 0, c.n);
    for (const n of knobNames) c.out[n].fill(c.p[n] ?? 0, 0, c.n);
    // clock: 24 ppqn from the arpeggiator or MIDI in, a pulse of half a block per tick; nothing without a source
    const hi = c.voice.clock ? Math.ceil(c.n / 2) : 0;
    c.out.clock.fill(1, 0, hi);
    c.out.clock.fill(0, hi, c.n);
  },
};

/** operator feedback: fb = 1 moves the phase by pi radians per unit of the two-sample average of the raw wave (the DX7's level 7) */
const FB_RAD = Math.PI;
/** the 2x decimator of the FM oscillator: a polyphase half-band of four first-order allpass sections (two per path), Q16 like the
 *  firmware: flat to 0.22 fs_os (19.4 kHz), 41 dB down above 0.28 fs_os (24.7 kHz, what folds onto 19.4 kHz) */
const HB = [5376, 17567, 35764, 55599].map((q) => q / 65536);

interface OscState {
  phase: number;
  /** the previous sync sample: a rising edge (through 0.5) restarts the phase */
  s1: number;
  /** the last two raw wave values (feedback) and the previous pm sample (interpolation), only in FM mode */
  y1: number;
  y2: number;
  pm1: number;
  /** the decimator: the odd sub-sample waiting for the next frame and x1 / y1 of the four allpass sections */
  xb: number;
  ap: number[];
  /** the phases of unison voices 2..5 (voice 1 is `phase`), plain path only */
  ph: number[];
}

/** unison voice j of n: its detune in octaves, spread symmetrically from -detune to +detune cents */
const unisonOct = (j: number, n: number, detune: number): number => (n > 1 ? (detune * ((2 * j) / (n - 1) - 1)) / 1200 : 0);

/** one first-order allpass section of the decimator: y = a (x - y1) + x1 */
function allpass(s: number[], k: number, a: number, x: number): number {
  const y = a * (x - s[k + 1]) + s[k];
  s[k] = x;
  s[k + 1] = y;
  return y;
}

const osc: ModuleImpl<OscState> = {
  def: {
    type: 'osc',
    label: 'Oscillator',
    inputs: [control('pitch'), audio('pm'), gate('sync')],
    outputs: [audio('out')],
    params: [
      param('wave', 0, 3, 0, { step: 1, choices: WAVES }),
      param('pw', 0.05, 0.95, 0.5, { step: 0.01 }),
      param('coarse', -48, 48, 0, { step: 1, unit: 'st' }),
      param('fine', -100, 100, 0, { step: 1, unit: 'ct' }),
      param('pm', 0, 8, 0, { step: 0.01 }),
      param('level', 0, 1, 0.8, { step: 0.01 }),
      param('fb', 0, 1, 0, { step: 0.01 }),
      param('unison', 1, 5, 1, { step: 1 }),
      param('detune', 0, 100, 10, { step: 1, unit: 'ct' }),
    ],
  },
  init: () => ({ phase: 0, s1: 0, y1: 0, y2: 0, pm1: 0, xb: 0, ap: [0, 0, 0, 0, 0, 0, 0, 0], ph: [0, 0, 0, 0] }),
  process(c, s) {
    const { pitch, pm, sync } = c.inp;
    const pw = Math.min(0.95, Math.max(0.05, c.p.pw ?? 0.5));
    const base = (c.p.coarse ?? 0) / 12 + (c.p.fine ?? 0) / 1200;
    const kind = Math.round(c.p.wave ?? 0);
    const idx = c.connected.pm ? (c.p.pm ?? 0) : 0;
    const fb = c.p.fb ?? 0;
    const lvl = c.p.level ?? 1;
    const out = c.out.out;
    if (idx <= 0 && fb <= 0) {
      // the plain oscillator: one wave per frame; unison: n detuned copies (phases s.phase, s.ph[0..n-2]) summed / n
      const nu = Math.max(1, Math.min(5, Math.round(c.p.unison ?? 1)));
      const det = c.p.detune ?? 0;
      const inv = 1 / nu;
      for (let i = 0; i < c.n; i++) {
        const f = C4 * Math.pow(2, pitch[i] + base);
        const rst = sync[i] >= 0.5 && s.s1 < 0.5;
        s.s1 = sync[i];
        if (nu === 1) {
          const dt = Math.min(f / c.sr, 0.45);
          if (rst) s.phase = 0;
          s.phase += dt;
          if (s.phase >= 1) s.phase -= 1;
          out[i] = wave(kind, s.phase, dt, pw) * lvl;
          continue;
        }
        const dt0 = Math.min(f * Math.pow(2, unisonOct(0, nu, det)) / c.sr, 0.45);
        if (rst) s.phase = 0;
        s.phase += dt0;
        if (s.phase >= 1) s.phase -= 1;
        let y = wave(kind, s.phase, dt0, pw);
        for (let j = 1; j < nu; j++) {
          const dtj = Math.min(f * Math.pow(2, unisonOct(j, nu, det)) / c.sr, 0.45);
          if (rst) s.ph[j - 1] = 0;
          s.ph[j - 1] += dtj;
          if (s.ph[j - 1] >= 1) s.ph[j - 1] -= 1;
          y += wave(kind, s.ph[j - 1], dtj, pw);
        }
        out[i] = y * inv * lvl;
      }
      s.y1 = s.y2 = s.pm1 = s.xb = 0;
      s.ap.fill(0);
      return;
    }
    // FM mode (phase modulation or feedback): two waves per frame, pm interpolated between frames, then the half-band
    // decimator, so sidebands up to the old sample rate are filtered out instead of folding back
    const K = 1 / (2 * Math.PI);
    for (let i = 0; i < c.n; i++) {
      const f = C4 * Math.pow(2, pitch[i] + base);
      const dt = Math.min(f / c.sr, 0.45) / 2;
      if (sync[i] >= 0.5 && s.s1 < 0.5) s.phase = 0;
      s.s1 = sync[i];
      const pmNow = idx > 0 ? pm[i] : 0;
      const pmMid = (s.pm1 + pmNow) / 2;
      s.pm1 = pmNow;
      let ya = 0;
      for (let sub = 0; sub < 2; sub++) {
        s.phase += dt;
        if (s.phase >= 1) s.phase -= 1;
        let ph = s.phase + (idx * (sub ? pmNow : pmMid) + fb * FB_RAD * (s.y1 + s.y2) * 0.5) * K;
        ph -= Math.floor(ph);
        const y = wave(kind, ph, dt, pw);
        s.y2 = s.y1;
        s.y1 = y;
        if (sub) {
          // path 0 takes the even sub-sample, path 1 the odd one of the previous frame (the z^-1 of the half-band)
          const p0 = allpass(s.ap, 4, HB[2], allpass(s.ap, 0, HB[0], ya));
          const p1 = allpass(s.ap, 6, HB[3], allpass(s.ap, 2, HB[1], s.xb));
          s.xb = y;
          out[i] = (p0 + p1) * 0.5 * lvl;
        } else ya = y;
      }
    }
  },
};

/** Note lengths of the synced delay, shortest first (the time knob steps through them): name and length in quarter notes = num / den. */
export const DELAY_DIVS: { name: string; num: number; den: number }[] = [
  { name: '1/16T', num: 1, den: 6 },
  { name: '1/16', num: 1, den: 4 },
  { name: '1/8T', num: 1, den: 3 },
  { name: '1/16.', num: 3, den: 8 },
  { name: '1/8', num: 1, den: 2 },
  { name: '1/8.', num: 3, den: 4 },
  { name: '1/4', num: 1, den: 1 },
  { name: '3/8', num: 3, den: 2 },
  { name: '1/2', num: 2, den: 1 },
  { name: '5/8', num: 5, den: 2 },
  { name: '1/1', num: 4, den: 1 },
];
/** the clock input is the Main module's clock: 24 pulses per quarter note */
export const DELAY_CLK_PPQN = 24;

/** the delay's time knob, ms: as long as its line (DELAY_LEN; ping-pong halves it) */
export const DELAY_TIME_MIN = 1;
export const DELAY_TIME_MAX = 520;

/** which note length the time knob selects when the delay is synced: its range split into DELAY_DIVS.length steps */
export function delayDivIndex(time: number, tmin: number, tmax: number): number {
  return Math.max(0, Math.min(DELAY_DIVS.length - 1, Math.round(((time - tmin) / (tmax - tmin)) * (DELAY_DIVS.length - 1))));
}

const LFO_WAVES = [...WAVES, 'S&H'];

interface LfoState {
  phase: number;
  seed: number;
  held: number;
  clkHi: boolean;
  rstHi: boolean;
  /** clk edges counted since the last cycle start (synced) */
  ticks: number;
  /** samples since the last clk edge, and the smoothed distance between edges (0 = none seen yet) */
  since: number;
  interval: number;
}

/**
 * LFO. `rate` in Hz, or, with `sync`, one cycle per note length `div` (as the delay). The clk input is a 24 ppqn clock (the
 * Main module's clock output): the cycle snaps to every n-th edge (n = 24 x the note length in quarter notes) and runs at the
 * measured clock speed in between. Without a clock (none for half a second) it runs at `bpm`. A rising edge at reset restarts
 * the cycle. S&H draws a new value at every cycle start.
 */
const lfo: ModuleImpl<LfoState> = {
  def: {
    type: 'lfo',
    label: 'LFO',
    inputs: [gate('clk'), gate('reset')],
    outputs: [control('out')],
    params: [
      param('wave', 0, 4, 0, { step: 1, choices: LFO_WAVES }),
      param('rate', 0.02, 40, 4, { unit: 'Hz', step: 0.01, log: true }),
      param('depth', 0, 1, 1, { step: 0.01 }),
      param('sync', 0, 1, 0, { step: 1, choices: ['free', 'sync'], toggle: true }),
      param('div', 0, DELAY_DIVS.length - 1, 6, { step: 1, choices: DELAY_DIVS.map((d) => d.name) }),
      param('bpm', 40, 300, 120, { step: 1 }),
    ],
  },
  init: (sr) => ({ phase: 0, seed: 0x2545f491, held: 0, clkHi: false, rstHi: false, ticks: 0, since: sr, interval: 0 }),
  process(c, s) {
    const kind = Math.round(c.p.wave ?? 0);
    const depth = c.p.depth ?? 1;
    const sync = (c.p.sync ?? 0) >= 0.5;
    const { num, den } = DELAY_DIVS[Math.max(0, Math.min(DELAY_DIVS.length - 1, Math.round(c.p.div ?? 6)))];
    const perCycle = (24 * num) / den; // clock ticks per cycle
    const dtBpm = ((c.p.bpm ?? 120) * den) / (60 * num * c.sr);
    const dtFree = (c.p.rate ?? 1) / c.sr;
    const newCycle = (): void => {
      // sample & hold: new random value (-1..1) at every cycle start
      s.seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0;
      s.held = s.seed / 0x80000000 - 1;
    };
    for (let i = 0; i < c.n; i++) {
      const clk = c.inp.clk[i] >= 0.5;
      const rst = c.inp.reset[i] >= 0.5;
      if (s.since < c.sr) s.since++;
      if (clk && !s.clkHi) {
        if (s.since >= c.sr / 2) s.interval = 0;
        else s.interval = s.interval > 0 ? s.interval + (s.since - s.interval) / 8 : s.since;
        s.since = 0;
        if (sync && ++s.ticks >= perCycle) {
          s.ticks = 0;
          s.phase = 0;
          newCycle();
        }
      }
      s.clkHi = clk;
      if (rst && !s.rstHi) {
        s.phase = 0;
        s.ticks = 0;
        newCycle();
      }
      s.rstHi = rst;
      const live = sync && s.interval > 0 && s.since < c.sr / 2;
      const dt = !sync ? dtFree : live ? 1 / (perCycle * s.interval) : dtBpm;
      s.phase += dt;
      if (s.phase >= 1) {
        if (live) s.phase = 1 - 1e-6; // wait for the clock's next cycle start
        else {
          s.phase -= 1;
          newCycle();
        }
      }
      c.out.out[i] = (kind === 4 ? s.held : wave(kind, s.phase, dt)) * depth;
    }
  },
};

const noise: ModuleImpl<{ seed: number; y: number }> = {
  def: { type: 'noise', label: 'Noise', inputs: [], outputs: [audio('out')], params: [param('level', 0, 1, 0.5, { step: 0.01 }), param('color', 0, 1, 0, { step: 0.01 })] },
  init: () => ({ seed: 0x1234567, y: 0 }),
  process(c, s) {
    const lvl = c.p.level ?? 1;
    const k = Math.pow(2, -5 * (c.p.color ?? 0));
    for (let i = 0; i < c.n; i++) {
      s.seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0;
      s.y += k * ((s.seed / 0x80000000) - 1 - s.y);
      c.out.out[i] = s.y * lvl;
    }
  },
};

const constant: ModuleImpl<null> = {
  def: { type: 'const', label: 'Constant', inputs: [], outputs: [control('out')], params: [param('value', -4, 4, 0, { step: 0.01 })] },
  init: () => null,
  process(c) {
    c.out.out.fill(c.p.value ?? 0, 0, c.n);
  },
};

const scale: ModuleImpl<null> = {
  def: {
    type: 'scale',
    label: 'Scale',
    inputs: [control('in')],
    outputs: [control('out')],
    params: [param('gain', -4, 4, 1, { step: 0.01 }), param('offset', -4, 4, 0, { step: 0.01 })],
  },
  init: () => null,
  process(c) {
    for (let i = 0; i < c.n; i++) c.out.out[i] = c.inp.in[i] * (c.p.gain ?? 1) + (c.p.offset ?? 0);
  },
};

interface AdsrState {
  stage: 0 | 1 | 2 | 3 | 4; // idle, attack, decay, sustain, release
  v: number;
  prev: number;
}

const adsr: ModuleImpl<AdsrState> = {
  def: {
    type: 'adsr',
    label: 'ADSR',
    inputs: [gate('gate')],
    outputs: [control('env')],
    params: [
      param('a', 0.001, 5, 0.01, { unit: 's', step: 0.001, log: true }),
      param('d', 0.001, 5, 0.2, { unit: 's', step: 0.001, log: true }),
      param('s', 0, 1, 0.6, { step: 0.01 }),
      param('r', 0.001, 8, 0.3, { unit: 's', step: 0.001, log: true }),
    ],
  },
  init: () => ({ stage: 0, v: 0, prev: 0 }),
  process(c, s) {
    const rate = (t: number) => 1 - Math.exp(-4.6 / Math.max(t * c.sr, 1)); // reaches ~99% in t seconds
    const ad = rate(c.p.d ?? 0.2);
    const ar = rate(c.p.r ?? 0.3);
    const aInc = 1 / Math.max((c.p.a ?? 0.01) * c.sr, 1);
    const sus = c.p.s ?? 0.6;
    for (let i = 0; i < c.n; i++) {
      const g = c.inp.gate[i] > 0.5 ? 1 : 0;
      if (g && !s.prev) s.stage = 1;
      else if (!g && s.prev) s.stage = 4;
      s.prev = g;
      switch (s.stage) {
        case 1:
          s.v += aInc;
          if (s.v >= 1) {
            s.v = 1;
            s.stage = 2;
          }
          break;
        case 2:
          s.v += (sus - s.v) * ad;
          if (Math.abs(s.v - sus) < 1e-4) s.stage = 3;
          break;
        case 3:
          s.v = sus;
          break;
        case 4:
          s.v -= s.v * ar;
          if (s.v < 1e-4) {
            s.v = 0;
            s.stage = 0;
          }
          break;
      }
      c.out.env[i] = s.v;
    }
  },
};

const vca: ModuleImpl<null> = {
  def: {
    type: 'vca',
    label: 'VCA',
    inputs: [audio('in'), control('cv')],
    outputs: [audio('out')],
    params: [param('gain', 0, 2, 1, { step: 0.01 })],
  },
  init: () => null,
  process(c) {
    const open = !c.connected.cv;
    for (let i = 0; i < c.n; i++) c.out.out[i] = c.inp.in[i] * (open ? 1 : c.inp.cv[i]) * (c.p.gain ?? 1);
  },
};

/** state variable filter, two stages: stage 1 (12 dB) gives lp12 / bp / hp, stage 2 takes lp12 and adds the other 12 dB (lp24) */
const filter: ModuleImpl<{ ic1: number; ic2: number; jc1: number; jc2: number }> = {
  def: {
    type: 'filter',
    label: 'Filter',
    inputs: [audio('in'), control('cv'), control('morph')],
    outputs: [audio('lp24'), audio('lp12'), audio('bp'), audio('hp'), audio('mix')],
    params: [
      param('cutoff', 20, 16000, 1200, { unit: 'Hz', step: 1, log: true, bend: true }),
      param('res', 0, 1, 0.2, { step: 0.01 }),
      param('cvamt', 0, 4, 1, { unit: 'oct', step: 0.01 }),
      param('track', 0, 1, 0, { step: 1, choices: ['off', 'on'], toggle: true }),
      param('morph', 0, 1, 0, { step: 0.01 }),
    ],
  },
  init: () => ({ ic1: 0, ic2: 0, jc1: 0, jc2: 0 }),
  process(c, s) {
    const k = 2 - 1.98 * (c.p.res ?? 0);
    const k2 = Math.SQRT2; // stage 2 is damped (Q 0.7): the resonance peak comes from stage 1 alone
    const tr = (c.p.track ?? 0) >= 0.5 ? c.voice.pitch : 0; // keyboard tracking: the cutoff follows the played pitch 1 octave per octave (C4 = the cutoff as set)
    for (let i = 0; i < c.n; i++) {
      const fc = Math.min((c.p.cutoff ?? 1000) * Math.pow(2, c.inp.cv[i] * (c.p.cvamt ?? 1) + tr), c.sr * 0.45);
      const g = Math.tan((Math.PI * fc) / c.sr);
      const a1 = 1 / (1 + g * (g + k));
      const a2 = g * a1;
      const a3 = g * a2;
      const v0 = c.inp.in[i];
      const v3 = v0 - s.ic2;
      const v1 = a1 * s.ic1 + a2 * v3;
      const v2 = s.ic2 + a2 * s.ic1 + a3 * v3;
      s.ic1 = 2 * v1 - s.ic1;
      s.ic2 = 2 * v2 - s.ic2;
      const hp = v0 - k * v1 - v2;
      const b1 = 1 / (1 + g * (g + k2));
      const b2 = g * b1;
      const b3 = g * b2;
      const w3 = v2 - s.jc2;
      const w1 = b1 * s.jc1 + b2 * w3;
      const w2 = s.jc2 + b2 * s.jc1 + b3 * w3;
      s.jc1 = 2 * w1 - s.jc1;
      s.jc2 = 2 * w2 - s.jc2;
      const m = Math.min(1, Math.max(0, (c.p.morph ?? 0) + c.inp.morph[i]));
      c.out.lp12[i] = v2;
      c.out.bp[i] = v1;
      c.out.hp[i] = hp;
      c.out.lp24[i] = w2;
      c.out.mix[i] = w2 + (hp - w2) * m; // morph 0 = 24 dB low pass, 1 = high pass
    }
  },
};

/**
 * Ladder filter (four one-pole stages in a feedback loop, the Moog shape) with drive. Zero-delay feedback: the loop is
 * solved linearly (y4 = (G^4 x + S) / (1 + k G^4) with the stage states S), then the loop input u = sat(drive x - k y4)
 * runs through the four stages, so the saturator sits in the loop (self-oscillation at res 1 limits itself). sat is
 * v - v^3 / 6.75 up to |v| = 1.5 and +-1 beyond (slope 1 at 0, peak 1). The coefficients (G = g / (1 + g),
 * g = tan(pi fc / sr)) are computed once per block from the block mean of the cv input, cvamt and key tracking: cheaper
 * than the SVF's per-sample update, which the Filter module keeps for audio-rate cutoff modulation. Outputs: lp24 (stage
 * 4) and lp12 (stage 2). No resonance compensation: the passband drops with res as on the original.
 */
const ladder: ModuleImpl<{ s: Float64Array }> = {
  def: {
    type: 'ladder',
    label: 'Ladder',
    inputs: [audio('in'), control('cv')],
    outputs: [audio('lp24'), audio('lp12')],
    params: [
      param('cutoff', 20, 16000, 1200, { unit: 'Hz', step: 1, log: true, bend: true }),
      param('res', 0, 1, 0.2, { step: 0.01 }),
      param('drive', 1, 8, 1, { step: 0.01, log: true }),
      param('cvamt', 0, 4, 1, { unit: 'oct', step: 0.01 }),
      param('track', 0, 1, 0, { step: 1, choices: ['off', 'on'], toggle: true }),
    ],
  },
  init: () => ({ s: new Float64Array(4) }),
  process(c, st) {
    const s = st.s;
    let cvm = 0;
    for (let i = 0; i < c.n; i++) cvm += c.inp.cv[i];
    cvm /= c.n;
    const tr = (c.p.track ?? 0) >= 0.5 ? c.voice.pitch : 0;
    const fc = Math.min((c.p.cutoff ?? 1000) * Math.pow(2, cvm * (c.p.cvamt ?? 1) + tr), c.sr * 0.45);
    const g = Math.tan((Math.PI * fc) / c.sr);
    const G = g / (1 + g);
    const G2 = G * G, G3 = G2 * G, G4 = G3 * G, hG = 1 - G;
    const k = 4 * (c.p.res ?? 0);
    const drive = c.p.drive ?? 1;
    const F = 1 / (1 + k * G4);
    for (let i = 0; i < c.n; i++) {
      const x = c.inp.in[i];
      const S = (G3 * s[0] + G2 * s[1] + G * s[2] + s[3]) * hG;
      const y4 = (G4 * x + S) * F;
      let u = drive * x - k * y4;
      u = u >= 1.5 ? 1 : u <= -1.5 ? -1 : u - (u * u * u) / 6.75;
      let y2 = 0;
      for (let j = 0; j < 4; j++) {
        const v = G * (u - s[j]);
        u = v + s[j];
        s[j] = u + v;
        if (j === 1) y2 = u;
      }
      c.out.lp24[i] = u;
      c.out.lp12[i] = y2;
    }
  },
};

/** 20 log10(x) = DB_PER_OCT log2(x) */
const DB_PER_OCT = 6.0205999;

/**
 * Envelope follower and compressor. The detector is a peak follower of |side| (or of |in| when side is not connected): one
 * pole that reaches 99 % in `attack` on the way up and in `release` on the way down (the ADSR's rate formula). `env` outputs
 * it (0..1, a control). Above `thresh` (dB) the signal is compressed by `ratio`: gain = (thresh / env)^(1 - 1/ratio), in the
 * log domain, then `gain` dB of makeup. Below the threshold only the makeup applies.
 */
const dyn: ModuleImpl<{ env: number }> = {
  def: {
    type: 'dyn',
    label: 'Compressor',
    inputs: [audio('in'), audio('side')],
    outputs: [audio('out'), control('env')],
    params: [
      param('thresh', -40, 0, -12, { unit: 'dB', step: 0.5 }),
      param('ratio', 1, 20, 4, { step: 0.1 }),
      param('attack', 0.001, 0.2, 0.01, { unit: 's', step: 0.001, log: true }),
      param('release', 0.01, 1, 0.1, { unit: 's', step: 0.01, log: true }),
      param('gain', 0, 24, 0, { unit: 'dB', step: 0.5 }),
    ],
  },
  init: () => ({ env: 0 }),
  process(c, s) {
    const ka = 1 - Math.exp(-4.6 / Math.max((c.p.attack ?? 0.01) * c.sr, 1));
    const kr = 1 - Math.exp(-4.6 / Math.max((c.p.release ?? 0.1) * c.sr, 1));
    const det = c.connected.side ? c.inp.side : c.inp.in;
    const thrLog = (c.p.thresh ?? -12) / DB_PER_OCT;
    const thr = Math.pow(2, thrLog);
    const slope = 1 - 1 / Math.max(1, c.p.ratio ?? 4);
    const makeupLog = (c.p.gain ?? 0) / DB_PER_OCT;
    const makeup = Math.pow(2, makeupLog);
    for (let i = 0; i < c.n; i++) {
      const a = Math.abs(det[i]);
      s.env += (a > s.env ? ka : kr) * (a - s.env);
      const g = s.env > thr ? Math.pow(2, makeupLog - slope * (Math.log2(s.env) - thrLog)) : makeup;
      c.out.out[i] = c.inp.in[i] * g;
      c.out.env[i] = s.env;
    }
  },
};

/** arithmetic on two signals: a' = a·ka + off, b' = b·kb; add, sub, mul, min, max, abs (of a'), cmp (1 while a' > b') */
const math: ModuleImpl<null> = {
  def: {
    type: 'math',
    label: 'Math',
    inputs: [control('a'), control('b')],
    outputs: [control('add'), control('sub'), control('mul'), control('min'), control('max'), control('abs'), gate('cmp')],
    params: [param('ka', -4, 4, 1, { step: 0.01 }), param('kb', -4, 4, 1, { step: 0.01 }), param('off', -4, 4, 0, { step: 0.01 })],
  },
  init: () => null,
  process(c) {
    const ka = c.p.ka ?? 1, kb = c.p.kb ?? 1, off = c.p.off ?? 0;
    const o = c.out;
    for (let i = 0; i < c.n; i++) {
      const a = c.inp.a[i] * ka + off, b = c.inp.b[i] * kb;
      o.add[i] = a + b;
      o.sub[i] = a - b;
      o.mul[i] = a * b;
      o.min[i] = Math.min(a, b);
      o.max[i] = Math.max(a, b);
      o.abs[i] = Math.abs(a);
      o.cmp[i] = a > b ? 1 : 0;
    }
  },
};

/** gates from two inputs (high at or above `thresh`): and, or, xor, not (of a) */
const logic: ModuleImpl<null> = {
  def: {
    type: 'logic',
    label: 'Logic',
    inputs: [gate('a'), gate('b')],
    outputs: [gate('and'), gate('or'), gate('xor'), gate('not')],
    params: [param('thresh', 0.05, 0.95, 0.5, { step: 0.01 })],
  },
  init: () => null,
  process(c) {
    const t = c.p.thresh ?? 0.5;
    const o = c.out;
    for (let i = 0; i < c.n; i++) {
      const a = c.inp.a[i] >= t, b = c.inp.b[i] >= t;
      o.and[i] = a && b ? 1 : 0;
      o.or[i] = a || b ? 1 : 0;
      o.xor[i] = a !== b ? 1 : 0;
      o.not[i] = a ? 0 : 1;
    }
  },
};

/** the granular module's buffer: one second, and up to this many grains at once */
export const GRAIN_SECONDS = 1;
export const GRAIN_MAX = 8;
/** spray scatters a grain's start by up to this many seconds */
const GRAIN_SPRAY_S = 0.25;

interface Grain {
  /** start sample in the buffer, samples played so far, samples to play, read rate (samples per sample) */
  start: number;
  t: number;
  len: number;
  rate: number;
  left: number;
}
interface GrainState {
  buf: Float32Array;
  w: number;
  /** the spawn accumulator (grains per sample), the random seed, the previous trig sample */
  acc: number;
  seed: number;
  prev: number;
  g: Grain[];
}

/**
 * Granular: records its input into a one second buffer (freeze stops the recording) and plays up to GRAIN_MAX grains from
 * it. `density` grains per second start on their own (0 = none), a rising edge on `trig` starts one too. A grain reads
 * `size` seconds of the buffer, `position` back from the newest audio (0 = the newest, 1 = the oldest) plus a random
 * `spray` (up to 0.25 s), at the rate 2^(pitch / 12), under a Hann window, linearly interpolated; the grains are summed
 * (not normalised: density x size is the average overlap). out = in (1 - mix) + grains mix. Shared like the delay: one
 * instance per patch, one line on the FM-1.
 */
const grain: ModuleImpl<GrainState> = {
  def: {
    type: 'grain',
    label: 'Granular',
    inputs: [audio('in'), gate('trig')],
    outputs: [audio('out')],
    params: [
      param('position', 0, 1, 0.3, { step: 0.01 }),
      param('size', 0.01, 0.5, 0.08, { unit: 's', step: 0.001, log: true }),
      param('density', 0, 100, 20, { unit: 'Hz', step: 0.5 }),
      param('pitch', -24, 24, 0, { unit: 'st', step: 1 }),
      param('spray', 0, 1, 0.2, { step: 0.01 }),
      param('freeze', 0, 1, 0, { step: 1, choices: ['off', 'on'], toggle: true }),
      param('mix', 0, 1, 0.5, { step: 0.01 }),
    ],
  },
  init: (sr) => ({
    buf: new Float32Array(Math.round(sr * GRAIN_SECONDS)),
    w: 0,
    acc: 0,
    seed: 0x7f4a7c15,
    prev: 0,
    g: Array.from({ length: GRAIN_MAX }, () => ({ start: 0, t: 0, len: 0, rate: 1, left: 0 })),
  }),
  process(c, s) {
    const LEN = s.buf.length;
    const dinc = Math.floor(((c.p.density ?? 0) / c.sr) * 16777216) / 16777216; // grains per sample, in steps of 2^-24 like the firmware, so both spawn on the same samples
    const rate = Math.pow(2, Math.trunc(c.p.pitch ?? 0) / 12);
    let len = Math.max(1, Math.round((c.p.size ?? 0.08) * c.sr));
    let span = Math.floor(len * rate) + 1;
    if (span > LEN - 2) {
      len = Math.floor((LEN - 2) / rate);
      span = Math.floor(len * rate) + 1;
    }
    const avail = LEN - 1 - span;
    const position = c.p.position ?? 0;
    const sprayS = Math.floor((c.p.spray ?? 0) * GRAIN_SPRAY_S * c.sr);
    const freeze = (c.p.freeze ?? 0) >= 0.5;
    const mix = c.p.mix ?? 0.5;
    const dry = 1 - mix;
    const spawn = (): void => {
      let g: Grain | undefined;
      for (const k of s.g) if (k.left === 0) { g = k; break; }
      s.seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0;
      if (!g) return;
      const rnd = (s.seed >>> 8) / 16777216;
      let off = Math.floor(position * avail) + Math.floor(rnd * sprayS);
      if (off > avail) off = avail;
      const back = span + off;
      g.start = s.w >= back ? s.w - back : s.w + LEN - back;
      g.t = 0;
      g.len = len;
      g.rate = rate;
      g.left = len;
    };
    for (let i = 0; i < c.n; i++) {
      const x = c.inp.in[i];
      const tr = c.inp.trig[i];
      s.acc += dinc;
      if (s.acc >= 1) {
        s.acc -= 1;
        spawn();
      }
      if (tr >= 0.5 && s.prev < 0.5) spawn();
      s.prev = tr;
      let sum = 0;
      for (const g of s.g) {
        if (g.left === 0) continue;
        const rp = g.t * g.rate;
        let i0 = g.start + Math.floor(rp);
        if (i0 >= LEN) i0 -= LEN;
        const i1 = i0 + 1 === LEN ? 0 : i0 + 1;
        const fr = rp - Math.floor(rp);
        const v = s.buf[i0] + (s.buf[i1] - s.buf[i0]) * fr;
        const sn = Math.sin((Math.PI * g.t) / g.len);
        sum += v * sn * sn;
        g.t++;
        g.left--;
      }
      if (!freeze) {
        s.buf[s.w] = x;
        if (++s.w === LEN) s.w = 0;
      }
      c.out.out[i] = x * dry + sum * mix;
    }
  },
};

/**
 * Comb filter: a delay line of one period (pitch + coarse, like the string) with signed feedback and a one-pole damping
 * in the loop: y = in + fb lp(y[n - period]), clamped to +-2; out = in (1 - mix) + y mix. Positive feedback peaks at the
 * harmonics of the pitch, negative at the odd ones. Lowest note 40 Hz (the string's line length).
 */
const comb: ModuleImpl<{ buf: Float32Array; w: number; lp: number }> = {
  def: {
    type: 'comb',
    label: 'Comb',
    inputs: [audio('in'), control('pitch')],
    outputs: [audio('out')],
    params: [
      param('coarse', -24, 24, 0, { step: 1, unit: 'st' }),
      param('fb', -0.98, 0.98, 0.7, { step: 0.01 }),
      param('damp', 0, 1, 0.2, { step: 0.01 }),
      param('mix', 0, 1, 1, { step: 0.01 }),
    ],
  },
  init: (sr) => ({ buf: new Float32Array(Math.ceil(sr / STR_LOW) + 1), w: 0, lp: 0 }),
  process(c, s) {
    const len = s.buf.length;
    const f = C4 * Math.pow(2, c.inp.pitch[0] + (c.p.coarse ?? 0) / 12);
    const period = Math.min(len - 2, Math.max(2, c.sr / f));
    const cl = 1 - 0.9 * (c.p.damp ?? 0.2);
    const d = Math.max(1, period - (1 - cl) / cl);
    const di = Math.floor(d);
    const fr = d - di;
    const fb = c.p.fb ?? 0;
    const mix = c.p.mix ?? 1;
    for (let i = 0; i < c.n; i++) {
      const x = c.inp.in[i];
      const r0 = s.buf[(s.w - di + len) % len];
      const r1 = s.buf[(s.w - di - 1 + len) % len];
      s.lp += (r0 + (r1 - r0) * fr - s.lp) * cl;
      const y = Math.max(-2, Math.min(2, x + s.lp * fb));
      s.buf[s.w] = y;
      s.w = (s.w + 1) % len;
      c.out.out[i] = x * (1 - mix) + y * mix;
    }
  },
};

/** the modal resonator's partials: harmonic ratios and the ratios of a free bar, `struct` morphs between them */
const MODAL_N = 6;
const MODAL_BAR = [1, 2.756, 5.404, 8.933, 13.34, 18.64];

/**
 * Modal resonator: six two-pole resonators y = a sin(th) x + 2 r cos(th) y1 - r^2 y2 (impulse response r^n sin(th n): the
 * ring of an impulse has the input's amplitude) at the ratios of the harmonics (struct 0) to a free bar (struct 1) of the
 * pitch; `decay` is the fundamental's time to -60 dB, partial i decays in decay / (1 + 2 damp i); the amplitudes fall as
 * (0.3 + 0.7 bright)^i and are normalised to a sum of 1. Partials above 0.45 sr are left out. The states are held to +-8:
 * excite it with short bursts (a pulse, a plucked string, a gated noise); a steady input builds up to the clamp.
 */
const modal: ModuleImpl<{ y1: Float64Array; y2: Float64Array }> = {
  def: {
    type: 'modal',
    label: 'Modal',
    inputs: [audio('in'), control('pitch')],
    outputs: [audio('out')],
    params: [
      param('coarse', -24, 24, 0, { step: 1, unit: 'st' }),
      param('decay', 0.05, 5, 1, { unit: 's', step: 0.01, log: true }),
      param('struct', 0, 1, 0, { step: 0.01 }),
      param('bright', 0, 1, 0.5, { step: 0.01 }),
      param('damp', 0, 1, 0.3, { step: 0.01 }),
    ],
  },
  init: () => ({ y1: new Float64Array(MODAL_N), y2: new Float64Array(MODAL_N) }),
  process(c, s) {
    const f0 = C4 * Math.pow(2, c.inp.pitch[0] + (c.p.coarse ?? 0) / 12);
    const st = c.p.struct ?? 0, damp = c.p.damp ?? 0.3, decay = c.p.decay ?? 1;
    const bw = 0.3 + 0.7 * (c.p.bright ?? 0.5);
    const g = new Float64Array(MODAL_N), c1 = new Float64Array(MODAL_N), c2 = new Float64Array(MODAL_N);
    let sum = 0, a = 1;
    const amp = new Float64Array(MODAL_N);
    for (let i = 0; i < MODAL_N; i++) {
      amp[i] = a;
      sum += a;
      a *= bw;
    }
    for (let i = 0; i < MODAL_N; i++) {
      const f = f0 * (i + 1 + st * (MODAL_BAR[i] - (i + 1)));
      if (f >= c.sr * 0.45) continue;
      const th = (2 * Math.PI * f) / c.sr;
      const r = Math.pow(2, -LOG2_1000 / ((decay / (1 + 2 * damp * i)) * c.sr));
      g[i] = (amp[i] / sum) * Math.sin(th);
      c1[i] = 2 * r * Math.cos(th);
      c2[i] = r * r;
    }
    for (let n = 0; n < c.n; n++) {
      const x = c.inp.in[n];
      let y = 0;
      for (let i = 0; i < MODAL_N; i++) {
        const v = Math.max(-8, Math.min(8, g[i] * x + c1[i] * s.y1[i] - c2[i] * s.y2[i]));
        s.y2[i] = s.y1[i];
        s.y1[i] = v;
        y += v;
      }
      c.out.out[n] = y;
    }
  },
};

/** the Hilbert pair: two chains of four second-order allpasses y = a^2 (x + y2) - x2 whose outputs are 90 degrees apart
 *  (Olli Niemitalo's coefficients); chain A's output is delayed by one sample */
const HILBERT_A = [0.6923878, 0.9360654322959, 0.988229522686, 0.9987488452737];
const HILBERT_B = [0.4021921162426, 0.856171088242, 0.9722909545651, 0.9952884791278];

/** one chain, each section in the form w = x + a^2 w2, y = a^2 w - w2 (two states per section: s holds w1, w2) */
function hilbert(s: Float64Array, a: number[], x: number): number {
  for (let k = 0; k < 4; k++) {
    const o = 2 * k;
    const w = x + a[k] * a[k] * s[o + 1];
    x = a[k] * a[k] * w - s[o + 1];
    s[o + 1] = s[o];
    s[o] = w;
  }
  return x;
}

/**
 * Frequency shifter (single sideband): the Hilbert pair gives I (chain A, one sample late) and Q (chain B), a quadrature
 * oscillator at `shift` + cv x cvamt Hz (per block, from the block mean of cv) moves the whole spectrum: up = I cos + Q sin,
 * down = I cos - Q sin (with this Hilbert pair's sign convention); each output is in (1 - mix) + shifted mix. A negative
 * shift swaps the two.
 */
const shift: ModuleImpl<{ a: Float64Array; b: Float64Array; ia: number; phase: number }> = {
  def: {
    type: 'shift',
    label: 'Freq shift',
    inputs: [audio('in'), control('cv')],
    outputs: [audio('up'), audio('down')],
    params: [
      param('shift', -1000, 1000, 100, { unit: 'Hz', step: 0.5 }),
      param('cvamt', 0, 1000, 100, { unit: 'Hz', step: 1 }),
      param('mix', 0, 1, 1, { step: 0.01 }),
    ],
  },
  init: () => ({ a: new Float64Array(8), b: new Float64Array(8), ia: 0, phase: 0 }),
  process(c, s) {
    let cvm = 0;
    for (let i = 0; i < c.n; i++) cvm += c.inp.cv[i];
    cvm /= c.n;
    const hz = (c.p.shift ?? 0) + cvm * (c.p.cvamt ?? 0);
    const inc = hz / c.sr;
    const mix = c.p.mix ?? 1;
    const dry = 1 - mix;
    for (let i = 0; i < c.n; i++) {
      const x = c.inp.in[i];
      const ya = hilbert(s.a, HILBERT_A, x);
      const I = s.ia;
      s.ia = ya;
      const Q = hilbert(s.b, HILBERT_B, x);
      const co = Math.cos(2 * Math.PI * s.phase), si = Math.sin(2 * Math.PI * s.phase);
      s.phase += inc;
      s.phase -= Math.floor(s.phase);
      c.out.up[i] = x * dry + (I * co + Q * si) * mix;
      c.out.down[i] = x * dry + (I * co - Q * si) * mix;
    }
  },
};

const mixer: ModuleImpl<null> = {
  def: {
    type: 'mixer',
    label: 'Mixer 4',
    inputs: [audio('in1'), audio('in2'), audio('in3'), audio('in4')],
    thru: 'in1',
    outputs: [audio('out')],
    params: [1, 2, 3, 4].map((n) => param(`l${n}`, 0, 1, 0.7, { step: 0.01 })),
  },
  init: () => null,
  process(c) {
    for (let i = 0; i < c.n; i++) {
      c.out.out[i] =
        c.inp.in1[i] * (c.p.l1 ?? 0) + c.inp.in2[i] * (c.p.l2 ?? 0) + c.inp.in3[i] * (c.p.l3 ?? 0) + c.inp.in4[i] * (c.p.l4 ?? 0);
    }
  },
};

interface DelayState {
  buf: Float32Array;
  w: number;
  /** clock tempo: sample counter, the last 24 pulse times, pulses seen, previous level, samples per quarter note */
  t: number;
  ring: Float64Array;
  seen: number;
  prev: boolean;
  beat: number;
}

/**
 * Delay. free: `time` in ms; sync: `time` picks a note length (DELAY_DIVS) at the tempo of the `clk` input (the Main module's
 * clock; 120 bpm until 24 pulses have come in). The tempo is the time of the last 24 pulses, smoothed. Ping-pong splits the
 * one buffer in two halves (A, B): the input enters A, A's echo goes to B, B's back to A, so the echoes alternate out
 * (left) and r (right), each with feedback `fb`; the dry/wet `mix` applies to both. Each half is at most half the buffer, so
 * the delay time is limited to about 525 ms then. Without ping-pong r is the same as out.
 */
const delay: ModuleImpl<DelayState> = {
  def: {
    type: 'delay',
    label: 'Delay',
    inputs: [audio('in'), gate('clk')],
    outputs: [audio('out'), audio('r')],
    params: [
      param('time', DELAY_TIME_MIN, DELAY_TIME_MAX, 250, { unit: 'ms', step: 1, altText: { when: 'sync', text: (v) => DELAY_DIVS[delayDivIndex(v, DELAY_TIME_MIN, DELAY_TIME_MAX)].name } }),
      param('fb', 0, 0.95, 0.4, { step: 0.01 }),
      param('mix', 0, 1, 0.3, { step: 0.01 }),
      param('sync', 0, 1, 0, { step: 1, choices: ['free', 'sync'], toggle: true }),
      param('pingpong', 0, 1, 0, { step: 1, choices: ['off', 'on'], toggle: true }),
    ],
  },
  init: (sr) => ({ buf: new Float32Array(Math.round((sr * 23000) / 44100)), w: 0, t: 0, ring: new Float64Array(DELAY_CLK_PPQN), seen: 0, prev: false, beat: Math.round(sr / 2) }),
  process(c, s) {
    const len = s.buf.length;
    const half = Math.floor(len / 2);
    const pp = (c.p.pingpong ?? 0) >= 0.5;
    if (c.connected.clk) {
      for (let i = 0; i < c.n; i++) {
        s.t++;
        const hi = c.inp.clk[i] >= 0.5;
        if (hi && !s.prev) {
          const k = s.seen % DELAY_CLK_PPQN;
          if (s.seen >= DELAY_CLK_PPQN) {
            const m = s.t - s.ring[k];
            if (m >= c.sr * 0.2 && m <= c.sr * 1.5) s.beat = s.seen === DELAY_CLK_PPQN ? m : s.beat + Math.trunc((m - s.beat) / 4);
          }
          s.ring[k] = s.t;
          s.seen++;
        }
        s.prev = hi;
      }
    }
    let samples: number;
    if ((c.p.sync ?? 0) >= 0.5) {
      const div = DELAY_DIVS[delayDivIndex(c.p.time ?? 250, DELAY_TIME_MIN, DELAY_TIME_MAX)];
      samples = Math.round((div.num * s.beat) / div.den);
    } else samples = Math.round(((c.p.time ?? 250) / 1000) * c.sr);
    const fb = c.p.fb ?? 0;
    const mix = c.p.mix ?? 0;
    const o = c.out.out;
    const r = c.out.r;
    if (!pp) {
      const d = Math.max(1, Math.min(len - 1, samples));
      for (let i = 0; i < c.n; i++) {
        const e = s.buf[(s.w - d + len) % len];
        s.buf[s.w] = c.inp.in[i] + e * fb;
        s.w = (s.w + 1) % len;
        o[i] = c.inp.in[i] * (1 - mix) + e * mix;
        r[i] = o[i];
      }
      return;
    }
    const d = Math.max(1, Math.min(half - 1, samples));
    if (s.w >= half) s.w = 0;
    for (let i = 0; i < c.n; i++) {
      const rp = (s.w - d + half) % half;
      const ea = s.buf[rp];
      const eb = s.buf[half + rp];
      s.buf[half + s.w] = ea * fb;
      s.buf[s.w] = c.inp.in[i] + eb * fb;
      s.w = (s.w + 1) % half;
      const dry = c.inp.in[i] * (1 - mix);
      o[i] = dry + ea * mix;
      r[i] = dry + eb * mix;
    }
  },
};

/**
 * A small Freeverb-style reverb (mono): four lowpass-damped feedback combs in parallel into two series allpasses.
 * size sets the comb feedback (0.70 .. 0.98), damp the lowpass in the feedback, mix the wet share.
 */
const RV_COMB = [1116, 1188, 1277, 1356]; // delay lengths at 44.1 kHz
const RV_AP = [556, 441];
interface ReverbState {
  comb: Float32Array[];
  ci: number[];
  lp: number[];
  ap: Float32Array[];
  ai: number[];
}

const reverb: ModuleImpl<ReverbState> = {
  def: {
    type: 'reverb',
    label: 'Reverb',
    inputs: [audio('in')],
    outputs: [audio('out')],
    params: [param('size', 0, 1, 0.5, { step: 0.01 }), param('damp', 0, 1, 0.4, { step: 0.01 }), param('mix', 0, 1, 0.3, { step: 0.01 })],
  },
  init: (sr) => {
    const len = (n: number): number => Math.max(1, Math.round((n * sr) / 44100));
    return { comb: RV_COMB.map((n) => new Float32Array(len(n))), ci: [0, 0, 0, 0], lp: [0, 0, 0, 0], ap: RV_AP.map((n) => new Float32Array(len(n))), ai: [0, 0] };
  },
  process(c, s) {
    const fb = 0.7 + 0.28 * (c.p.size ?? 0.5);
    const d1 = (c.p.damp ?? 0.4) * 0.4;
    const mix = c.p.mix ?? 0.3;
    for (let i = 0; i < c.n; i++) {
      const x = c.inp.in[i];
      const g = x * 0.0625;
      let sum = 0;
      for (let k = 0; k < 4; k++) {
        const buf = s.comb[k];
        const o = buf[s.ci[k]];
        s.lp[k] = o * (1 - d1) + s.lp[k] * d1;
        buf[s.ci[k]] = g + s.lp[k] * fb;
        if (++s.ci[k] === buf.length) s.ci[k] = 0;
        sum += o;
      }
      for (let k = 0; k < 2; k++) {
        const buf = s.ap[k];
        const bo = buf[s.ai[k]];
        const y = bo - sum;
        buf[s.ai[k]] = sum + bo * 0.5;
        if (++s.ai[k] === buf.length) s.ai[k] = 0;
        sum = y;
      }
      c.out.out[i] = x * (1 - mix) + sum * mix;
    }
  },
};

const output: ModuleImpl<null> = {
  def: {
    type: 'output',
    label: 'Output',
    inputs: [{ ...audio('l'), label: 'l (mono)' }, audio('r')],
    outputs: [],
    params: [param('level', 0, 1, 0.7, { step: 0.01 })],
  },
  init: () => null,
  process() {
    /* read by the engine */
  },
};

/** portamento, or a slew on any control: a one-pole glide that reaches 99 % of a step in `time` */
const glide: ModuleImpl<{ y: number }> = {
  def: {
    type: 'glide',
    label: 'Glide',
    inputs: [control('in')],
    outputs: [control('out')],
    params: [param('time', 0.001, 5, 0.1, { unit: 's', step: 0.001, log: true })],
  },
  init: () => ({ y: 0 }),
  process(c, s) {
    const k = 1 - Math.exp(-4.6 / Math.max((c.p.time ?? 0.1) * c.sr, 1));
    for (let i = 0; i < c.n; i++) {
      s.y += k * (c.inp.in[i] - s.y);
      c.out.out[i] = s.y;
    }
  },
};

const SHAPES = ['soft', 'hard', 'fold'];

/** a waveshaper: drive into a cubic soft clip, a hard clip or a triangle fold; the peak stays at 1 */
const shape: ModuleImpl<null> = {
  def: {
    type: 'shape',
    label: 'Shaper',
    inputs: [audio('in')],
    outputs: [audio('out')],
    params: [param('drive', 1, 32, 2, { step: 0.01, log: true }), param('mode', 0, 2, 0, { step: 1, choices: SHAPES }), param('level', 0, 1, 0.7, { step: 0.01 })],
  },
  init: () => null,
  process(c) {
    const drive = c.p.drive ?? 1;
    const mode = Math.round(c.p.mode ?? 0);
    const lvl = c.p.level ?? 1;
    for (let i = 0; i < c.n; i++) {
      const x = c.inp.in[i] * drive;
      let y: number;
      if (mode === 1) y = Math.max(-1, Math.min(1, x));
      else if (mode === 2) {
        const t = (((x + 1) % 4) + 4) % 4; // a triangle of period 4: back and forth between -1 and 1
        y = t < 2 ? t - 1 : 3 - t;
      } else y = Math.abs(x) >= 1 ? Math.sign(x) : 1.5 * x - 0.5 * x * x * x; // cubic: smooth up to the knee at 1
      c.out.out[i] = y * lvl;
    }
  },
};

/**
 * A level / rate envelope (the DX7 shape): on a gate it runs through three segments to l1, l2, l3 (each in its time r),
 * holds l3 while the gate stays up, and on release goes to l4 in r4 and stays there. A rising segment is linear at the
 * rate that would cover 0..1 in r (the ADSR's attack); a falling one approaches its level exponentially, 99 % in r (the
 * ADSR's decay) and ends after r (the last 1 % is stepped). A segment that starts at its level is skipped. Stage: 0 idle at
 * l4, 1..3 the segments, 4 holding l3, 5 the release.
 */
interface EnvState {
  stage: 0 | 1 | 2 | 3 | 4 | 5;
  v: number;
  prev: number;
  /** samples spent in the current segment */
  t: number;
}

const env: ModuleImpl<EnvState> = {
  def: {
    type: 'env',
    label: 'Env L/R',
    inputs: [gate('gate')],
    outputs: [control('env')],
    params: [
      param('l1', 0, 1, 1, { step: 0.01 }),
      param('r1', 0.001, 10, 0.01, { unit: 's', step: 0.001, log: true }),
      param('l2', 0, 1, 0.6, { step: 0.01 }),
      param('r2', 0.001, 10, 0.3, { unit: 's', step: 0.001, log: true }),
      param('l3', 0, 1, 0.6, { step: 0.01 }),
      param('r3', 0.001, 10, 1, { unit: 's', step: 0.001, log: true }),
      param('l4', 0, 1, 0, { step: 0.01 }),
      param('r4', 0.001, 10, 0.5, { unit: 's', step: 0.001, log: true }),
    ],
  },
  init: () => ({ stage: 0, v: 0, prev: 0, t: 0 }),
  process(c, s) {
    const lv = [0, c.p.l1 ?? 1, c.p.l2 ?? 0.6, c.p.l3 ?? 0.6, c.p.l3 ?? 0.6, c.p.l4 ?? 0];
    const tm = [0, c.p.r1 ?? 0.01, c.p.r2 ?? 0.3, c.p.r3 ?? 1, 0, c.p.r4 ?? 0.5];
    const len = tm.map((t) => Math.max(Math.round(t * c.sr), 1));
    const inc = len.map((l) => 1 / l);
    const k = len.map((l) => 1 - Math.exp(-4.6 / l));
    for (let i = 0; i < c.n; i++) {
      const g = c.inp.gate[i] > 0.5 ? 1 : 0;
      if (g && !s.prev) {
        s.stage = 1;
        s.t = 0;
      } else if (!g && s.prev) {
        s.stage = 5;
        s.t = 0;
      }
      s.prev = g;
      // a segment: linear up, exponential down; done -> the next stage (the hold stages track their level)
      for (let guard = 0; guard < 4; guard++) {
        const st = s.stage;
        if (st === 0 || st === 4) {
          s.v = lv[st === 0 ? 5 : 3];
          break;
        }
        const t = lv[st];
        s.t++;
        if (s.v < t) {
          s.v += inc[st];
          if (s.v < t) break;
        } else if (s.t < len[st]) {
          s.v += (t - s.v) * k[st];
          break;
        }
        s.v = t;
        s.stage = st === 5 ? 0 : ((st + 1) as EnvState['stage']);
        s.t = 0;
      }
      c.out.env[i] = s.v;
    }
  },
};

/**
 * A plucked string (Karplus-Strong): a delay line of one period with a one-pole damping filter in its loop. A rising gate
 * fires a burst of one period (noise, or a square cycle) into the loop; whatever comes in at `exc` is added too, so an
 * oscillator click or a noise hit plucks it, and a steady signal makes it a tuned resonator. `decay` is the time to -60 dB
 * (per block, from the block's first pitch), `damp` the loop lowpass (0 = bright), whose delay the tuning compensates.
 * The period is set once per block: lowest note 40 Hz (period 1/40 s). The loop is held to +-2 (a steady exciter is
 * amplified by 1 / (1 - g)).
 */
const STR_LOW = 40;
const LOG2_1000 = Math.log2(1000);
interface StringState {
  buf: Float32Array;
  w: number;
  lp: number;
  s1: number;
  seed: number;
  /** burst samples left and the burst's length */
  burst: number;
  blen: number;
}

const string: ModuleImpl<StringState> = {
  def: {
    type: 'string',
    label: 'String',
    inputs: [control('pitch'), gate('gate'), audio('exc')],
    outputs: [audio('out')],
    params: [
      param('decay', 0.05, 10, 2, { unit: 's', step: 0.01, log: true }),
      param('damp', 0, 1, 0.3, { step: 0.01 }),
      param('burst', 0, 1, 0, { step: 1, choices: ['noise', 'pulse'] }),
      param('coarse', -24, 24, 0, { step: 1, unit: 'st' }),
      param('level', 0, 1, 0.8, { step: 0.01 }),
    ],
  },
  init: (sr) => ({ buf: new Float32Array(Math.ceil(sr / STR_LOW) + 1), w: 0, lp: 0, s1: 0, seed: 0x3779b97f, burst: 0, blen: 1 }),
  process(c, s) {
    const len = s.buf.length;
    const f = C4 * Math.pow(2, c.inp.pitch[0] + (c.p.coarse ?? 0) / 12);
    const period = Math.min(len - 2, Math.max(2, c.sr / f));
    const cl = 1 - 0.9 * (c.p.damp ?? 0.3);
    const dl = (1 - cl) / cl; // the one-pole's delay at low frequencies, taken off the line
    const d = Math.max(1, period - dl);
    const di = Math.floor(d);
    const fr = d - di;
    const g = Math.pow(2, (-LOG2_1000 * period) / ((c.p.decay ?? 2) * c.sr));
    const kind = Math.round(c.p.burst ?? 0);
    const lvl = c.p.level ?? 1;
    const bl = Math.round(period);
    for (let i = 0; i < c.n; i++) {
      const gate = c.inp.gate[i];
      if (gate >= 0.5 && s.s1 < 0.5) {
        s.burst = bl;
        s.blen = bl;
      }
      s.s1 = gate;
      let x = c.inp.exc[i];
      if (s.burst > 0) {
        if (kind === 0) {
          s.seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0;
          x += s.seed / 0x80000000 - 1;
        } else x += s.blen - s.burst < s.blen >> 1 ? 1 : -1;
        s.burst--;
      }
      const r0 = s.buf[(s.w - di + len) % len];
      const r1 = s.buf[(s.w - di - 1 + len) % len];
      const r = r0 + (r1 - r0) * fr;
      s.lp += (r - s.lp) * cl;
      const y = Math.max(-2, Math.min(2, x + s.lp * g)); // a steady exciter would otherwise grow by 1 / (1 - g)
      s.buf[s.w] = y;
      s.w = (s.w + 1) % len;
      c.out.out[i] = y * lvl;
    }
  },
};

/**
 * The wavetables (tools/gen_wavetables.py): four banks of eight frames, each frame its first 32 harmonics, at three mip
 * levels (32, 16, 8 harmonics) so the high notes do not alias. Built once from the coefficients in wavetables.json; the
 * firmware has the same tables as int16 in wt_tables.h.
 */
const WT_N = 256;
const WT_MIPS = [32, 16, 8];
const WT_BANKS: string[] = WT.banks;
const WT_T: Float32Array[][] = WT_MIPS.map((nh) =>
  (WT.frames as number[][][]).map((f) => {
    const t = new Float32Array(WT_N + 1);
    for (let i = 0; i < WT_N; i++) {
      let y = 0;
      for (let k = 1; k <= nh; k++) y += f[k - 1][0] * Math.cos((2 * Math.PI * k * i) / WT_N) + f[k - 1][1] * Math.sin((2 * Math.PI * k * i) / WT_N);
      t[i] = y;
    }
    t[WT_N] = t[0];
    return t;
  }),
);

interface WtState {
  phase: number;
  s1: number;
}

const wavetable: ModuleImpl<WtState> = {
  def: {
    type: 'wavetable',
    label: 'Wavetable',
    inputs: [control('pitch'), audio('pm'), gate('sync')],
    outputs: [audio('out')],
    params: [
      param('bank', 0, WT_BANKS.length - 1, 0, { step: 1, choices: WT_BANKS }),
      param('pos', 0, 1, 0, { step: 0.01 }),
      param('coarse', -48, 48, 0, { step: 1, unit: 'st' }),
      param('fine', -100, 100, 0, { step: 1, unit: 'ct' }),
      param('pm', 0, 8, 0, { step: 0.01 }),
      param('level', 0, 1, 0.8, { step: 0.01 }),
    ],
  },
  init: () => ({ phase: 0, s1: 0 }),
  process(c, s) {
    const { pitch, pm, sync } = c.inp;
    const base = (c.p.coarse ?? 0) / 12 + (c.p.fine ?? 0) / 1200;
    const bank = Math.round(c.p.bank ?? 0);
    const posf = Math.min(7, Math.max(0, (c.p.pos ?? 0) * 7));
    const f0 = Math.floor(posf);
    const f1 = Math.min(7, f0 + 1);
    const fm = posf - f0;
    const idx = c.connected.pm ? (c.p.pm ?? 0) : 0;
    const lvl = c.p.level ?? 1;
    const K = 1 / (2 * Math.PI);
    // the mip level from the block's first pitch: 32 harmonics below sr / 64, 16 below sr / 32, else 8
    const dt0 = (C4 * Math.pow(2, pitch[0] + base)) / c.sr;
    const mip = dt0 < 1 / 64 ? 0 : dt0 < 1 / 32 ? 1 : 2;
    const ta = WT_T[mip][bank * 8 + f0];
    const tb = WT_T[mip][bank * 8 + f1];
    for (let i = 0; i < c.n; i++) {
      const f = C4 * Math.pow(2, pitch[i] + base);
      const dt = Math.min(f / c.sr, 0.45);
      if (sync[i] >= 0.5 && s.s1 < 0.5) s.phase = 0;
      s.s1 = sync[i];
      s.phase += dt;
      if (s.phase >= 1) s.phase -= 1;
      let ph = s.phase + idx * pm[i] * K;
      ph -= Math.floor(ph);
      const x = ph * WT_N;
      const xi = Math.floor(x);
      const xf = x - xi;
      const ya = ta[xi] + (ta[xi + 1] - ta[xi]) * xf;
      const yb = tb[xi] + (tb[xi + 1] - tb[xi]) * xf;
      c.out.out[i] = (ya + (yb - ya) * fm) * lvl;
    }
  },
};

/**
 * A stereo chorus: one delay line, two taps swept in quadrature by a sine at `rate` around 12 ms by up to 8 ms (`depth`),
 * read with linear interpolation. Shared like the delay (one per patch on the FM-1); its l / r go to the output.
 */
const CH_BASE = 0.012;
const CH_SWING = 0.008;
interface ChorusState {
  buf: Float32Array;
  w: number;
  phase: number;
}

const chorus: ModuleImpl<ChorusState> = {
  def: {
    type: 'chorus',
    label: 'Chorus',
    inputs: [audio('in')],
    outputs: [audio('l'), audio('r')],
    params: [param('rate', 0.05, 5, 0.6, { unit: 'Hz', step: 0.01, log: true }), param('depth', 0, 1, 0.5, { step: 0.01 }), param('mix', 0, 1, 0.5, { step: 0.01 })],
  },
  init: (sr) => ({ buf: new Float32Array(Math.ceil(sr * 0.021)), w: 0, phase: 0 }),
  process(c, s) {
    const len = s.buf.length;
    const dphi = (c.p.rate ?? 0.6) / c.sr;
    const base = CH_BASE * c.sr;
    const swing = CH_SWING * c.sr * (c.p.depth ?? 0.5);
    const mix = c.p.mix ?? 0.5;
    const dry = 1 - mix;
    const tap = (d: number): number => {
      const di = Math.floor(d);
      const fr = d - di;
      const a = s.buf[(s.w - di + len) % len];
      const b = s.buf[(s.w - di - 1 + len) % len];
      return a + (b - a) * fr;
    };
    for (let i = 0; i < c.n; i++) {
      const x = c.inp.in[i];
      s.buf[s.w] = x;
      const dl = base + swing * Math.sin(2 * Math.PI * s.phase);
      const dr = base + swing * Math.sin(2 * Math.PI * (s.phase + 0.25));
      c.out.l[i] = x * dry + tap(dl) * mix;
      c.out.r[i] = x * dry + tap(dr) * mix;
      s.w = (s.w + 1) % len;
      s.phase += dphi;
      if (s.phase >= 1) s.phase -= 1;
    }
  },
};

/**
 * An eight-step control sequencer. A rising edge on `clock` moves to the next step (`len` steps, `dir`: forward, backward,
 * pendulum without repeating the ends, random); `reset` goes back to step 1. `out` is the current step's value all the
 * time (turning the step's knob is heard at once); `gate` follows the clock while the step is not a rest. A step turned
 * fully down (-1) is a rest.
 */
const SEQ_DIRS = ['fwd', 'back', 'pendulum', 'random'];
interface SeqState {
  pos: number;
  down: number;
  c1: number;
  r1: number;
  seed: number;
}

const seq: ModuleImpl<SeqState> = {
  def: {
    type: 'seq',
    label: 'Sequencer',
    inputs: [gate('clock'), gate('reset')],
    outputs: [control('out'), gate('gate')],
    params: [
      ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => param(`s${n}`, -1, 1, 0, { step: 0.01 })),
      param('len', 1, 8, 8, { step: 1 }),
      param('dir', 0, 3, 0, { step: 1, choices: SEQ_DIRS }),
    ],
  },
  init: () => ({ pos: 0, down: 0, c1: 0, r1: 0, seed: 0x9e3779b9 }),
  process(c, s) {
    const steps = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => c.p[`s${n}`] ?? 0);
    const len = Math.min(8, Math.max(1, Math.round(c.p.len ?? 8)));
    const dir = Math.round(c.p.dir ?? 0);
    const { clock, reset } = c.inp;
    for (let i = 0; i < c.n; i++) {
      const rst = reset[i] >= 0.5 && s.r1 < 0.5;
      const clk = clock[i] >= 0.5 && s.c1 < 0.5;
      s.r1 = reset[i];
      s.c1 = clock[i];
      if (rst) {
        s.pos = 0;
        s.down = 0;
      } else if (clk) {
        if (s.pos >= len) s.pos = len - 1;
        if (dir === 1) s.pos = (s.pos + len - 1) % len;
        else if (dir === 2) {
          if (!s.down) {
            if (s.pos + 1 < len) s.pos++;
            else {
              s.pos = Math.max(len - 2, 0);
              s.down = 1;
            }
          } else if (s.pos > 0) s.pos--;
          else {
            s.pos = Math.min(1, len - 1);
            s.down = 0;
          }
        } else if (dir === 3) {
          s.seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0;
          s.pos = (s.seed >>> 16) % len;
        } else s.pos = (s.pos + 1) % len;
      }
      const v = steps[Math.min(s.pos, len - 1)];
      c.out.out[i] = v;
      c.out.gate[i] = clock[i] >= 0.5 && v > -1 ? 1 : 0;
    }
  },
};

/** a clock divider: `out` passes every `div`-th clock pulse (its width is the clock's), `d2` `d4` `d8` every 2nd, 4th, 8th; `reset` restarts the count so the next pulse is a downbeat */
const clkdiv: ModuleImpl<{ count: number; c1: number; r1: number }> = {
  def: {
    type: 'clkdiv',
    label: 'Clock div',
    inputs: [gate('clock'), gate('reset')],
    outputs: [gate('out'), gate('d2'), gate('d4'), gate('d8')],
    params: [param('div', 1, 16, 3, { step: 1 })],
  },
  init: () => ({ count: -1, c1: 0, r1: 0 }),
  process(c, s) {
    const div = Math.min(16, Math.max(1, Math.round(c.p.div ?? 3)));
    const { clock, reset } = c.inp;
    for (let i = 0; i < c.n; i++) {
      if (reset[i] >= 0.5 && s.r1 < 0.5) s.count = -1;
      else if (clock[i] >= 0.5 && s.c1 < 0.5) s.count = (s.count + 1) % (16 * div);
      s.r1 = reset[i];
      s.c1 = clock[i];
      const hi = clock[i] >= 0.5 && s.count >= 0;
      c.out.out[i] = hi && s.count % div === 0 ? 1 : 0;
      c.out.d2[i] = hi && s.count % 2 === 0 ? 1 : 0;
      c.out.d4[i] = hi && s.count % 4 === 0 ? 1 : 0;
      c.out.d8[i] = hi && s.count % 8 === 0 ? 1 : 0;
    }
  },
};

/** sample & hold: `out` takes `in` on a rising edge of `clock` (hold), or follows it while the clock is up (track) */
const sh: ModuleImpl<{ v: number; c1: number }> = {
  def: {
    type: 'sh',
    label: 'S&H',
    inputs: [control('in'), gate('clock')],
    outputs: [control('out')],
    params: [param('mode', 0, 1, 0, { step: 1, choices: ['hold', 'track'] })],
  },
  init: () => ({ v: 0, c1: 0 }),
  process(c, s) {
    const track = Math.round(c.p.mode ?? 0) === 1;
    const { clock } = c.inp;
    for (let i = 0; i < c.n; i++) {
      const up = clock[i] >= 0.5;
      if (track ? up : up && s.c1 < 0.5) s.v = c.inp.in[i];
      s.c1 = clock[i];
      c.out.out[i] = s.v;
    }
  },
};

/** the scales of the quantizer as semitones above the root */
const SCALES: { name: string; st: number[] }[] = [
  { name: 'chromatic', st: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { name: 'major', st: [0, 2, 4, 5, 7, 9, 11] },
  { name: 'minor', st: [0, 2, 3, 5, 7, 8, 10] },
  { name: 'pent maj', st: [0, 2, 4, 7, 9] },
  { name: 'pent min', st: [0, 3, 5, 7, 10] },
  { name: 'dorian', st: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'mixolydian', st: [0, 2, 4, 5, 7, 9, 10] },
  { name: 'blues', st: [0, 3, 5, 6, 7, 10] },
  { name: 'whole', st: [0, 2, 4, 6, 8, 10] },
  { name: 'fifths', st: [0, 7] },
  { name: 'octaves', st: [0] },
];
const NOTES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const SCALE_TABLE = SCALES;

/** a pitch quantizer: the nearest note of `scale` on `root` (pitch in octaves, C4 = 0; ties go down) */
const quant: ModuleImpl<null> = {
  def: {
    type: 'quant',
    label: 'Quantizer',
    inputs: [control('in')],
    outputs: [control('out')],
    params: [param('scale', 0, SCALES.length - 1, 1, { step: 1, choices: SCALES.map((x) => x.name) }), param('root', 0, 11, 0, { step: 1, choices: NOTES })],
  },
  init: () => null,
  process(c) {
    const sc = SCALES[Math.min(SCALES.length - 1, Math.max(0, Math.round(c.p.scale ?? 0)))].st;
    const root = Math.round(c.p.root ?? 0);
    for (let i = 0; i < c.n; i++) {
      const semis = c.inp.in[i] * 12 - root;
      const oct = Math.floor(semis / 12);
      const w = semis - 12 * oct;
      let best = sc[0];
      let bd = Math.abs(w - best);
      for (let k = 1; k <= sc.length; k++) {
        const d = k < sc.length ? sc[k] : sc[0] + 12;
        const dd = Math.abs(w - d);
        if (dd < bd) {
          bd = dd;
          best = d;
        }
      }
      c.out.out[i] = (12 * oct + best + root) / 12;
    }
  },
};

/** a trigger to a gate of a set length: a rising edge on `trig` raises `out` for `time` (a new edge restarts it) */
const pulse: ModuleImpl<{ rem: number; t1: number }> = {
  def: {
    type: 'pulse',
    label: 'Pulse',
    inputs: [gate('trig')],
    outputs: [gate('out')],
    params: [param('time', 0.001, 2, 0.1, { unit: 's', step: 0.001, log: true })],
  },
  init: () => ({ rem: 0, t1: 0 }),
  process(c, s) {
    const len = Math.max(1, Math.round((c.p.time ?? 0.1) * c.sr));
    const { trig } = c.inp;
    for (let i = 0; i < c.n; i++) {
      if (trig[i] >= 0.5 && s.t1 < 0.5) s.rem = len;
      s.t1 = trig[i];
      c.out.out[i] = s.rem > 0 ? 1 : 0;
      if (s.rem > 0) s.rem--;
    }
  },
};


/** equal-power pan: l = cos, r = sin of (position + 1) pi / 4; the `pos` input adds to the parameter (the panel's spread, an LFO) */
const pan: ModuleImpl<null> = {
  def: {
    type: 'pan',
    label: 'Pan',
    inputs: [audio('in'), control('pos')],
    outputs: [audio('l'), audio('r')],
    params: [param('pan', -1, 1, 0, { step: 0.01 })],
  },
  init: () => null,
  process(c) {
    const base = c.p.pan ?? 0;
    for (let i = 0; i < c.n; i++) {
      const p = Math.min(1, Math.max(-1, base + c.inp.pos[i]));
      const a = ((p + 1) * Math.PI) / 4;
      c.out.l[i] = c.inp.in[i] * Math.cos(a);
      c.out.r[i] = c.inp.in[i] * Math.sin(a);
    }
  },
};

/** linear crossfade a -> b by mix + pos */
const xfade: ModuleImpl<null> = {
  def: {
    type: 'xfade',
    label: 'Crossfade',
    inputs: [audio('a'), audio('b'), control('pos')],
    thru: 'a',
    outputs: [audio('out')],
    params: [param('mix', 0, 1, 0.5, { step: 0.01 })],
  },
  init: () => null,
  process(c) {
    const base = c.p.mix ?? 0.5;
    for (let i = 0; i < c.n; i++) {
      const m = Math.min(1, Math.max(0, base + c.inp.pos[i]));
      c.out.out[i] = c.inp.a[i] * (1 - m) + c.inp.b[i] * m;
    }
  },
};

/** the formants (Hz) of A E I O U and their gains: three parallel band passes, the position morphs between neighbours */
const FORMANTS = [
  [730, 1090, 2440],
  [530, 1840, 2480],
  [390, 1990, 2550],
  [570, 840, 2410],
  [440, 1020, 2240],
];
const FORMANT_GAIN = [1, 0.5, 0.25];

interface VowelState {
  ic1: number[];
  ic2: number[];
}

/** a vowel filter: three SVF band passes (normalized band, peak 1) at the formants of the vowel `vowel` + input, once per block */
const vowel: ModuleImpl<VowelState> = {
  def: {
    type: 'vowel',
    label: 'Vowel',
    inputs: [audio('in'), control('vowel')],
    outputs: [audio('out')],
    params: [param('vowel', 0, 4, 0, { step: 0.01 }), param('res', 0, 1, 0.5, { step: 0.01 }), param('level', 0, 1, 0.7, { step: 0.01 })],
  },
  init: () => ({ ic1: [0, 0, 0], ic2: [0, 0, 0] }),
  process(c, s) {
    const v = Math.min(4, Math.max(0, (c.p.vowel ?? 0) + c.inp.vowel[0]));
    const vi = Math.min(3, Math.floor(v));
    const t = v - vi;
    const k = 1 / (2 + 18 * (c.p.res ?? 0.5));
    const lvl = c.p.level ?? 0.7;
    const a1: number[] = [];
    const a2: number[] = [];
    const a3: number[] = [];
    for (let f = 0; f < 3; f++) {
      const hz = FORMANTS[vi][f] + (FORMANTS[vi + 1][f] - FORMANTS[vi][f]) * t;
      const g = Math.tan((Math.PI * Math.min(hz, c.sr * 0.45)) / c.sr);
      a1[f] = 1 / (1 + g * (g + k));
      a2[f] = g * a1[f];
      a3[f] = g * a2[f];
    }
    for (let i = 0; i < c.n; i++) {
      const v0 = c.inp.in[i];
      let sum = 0;
      for (let f = 0; f < 3; f++) {
        const v3 = v0 - s.ic2[f];
        const v1 = a1[f] * s.ic1[f] + a2[f] * v3;
        const v2 = s.ic2[f] + a2[f] * s.ic1[f] + a3[f] * v3;
        s.ic1[f] = 2 * v1 - s.ic1[f];
        s.ic2[f] = 2 * v2 - s.ic2[f];
        sum += FORMANT_GAIN[f] * k * v1;
      }
      c.out.out[i] = sum * lvl;
    }
  },
};

interface PhaserState {
  /** the sweep LFO's phase, 0..1 */
  ph: number;
  /** x1 / y1 of the four allpass stages */
  ap: number[];
  /** the last output of stage 4 (feedback) */
  fbv: number;
}

/** a four-stage phaser: one allpass coefficient for all stages from a triangle sweep of +-2 depth octaves around center, set once per block */
const phaser: ModuleImpl<PhaserState> = {
  def: {
    type: 'phaser',
    label: 'Phaser',
    inputs: [audio('in')],
    outputs: [audio('out')],
    params: [
      param('rate', 0.02, 10, 0.5, { unit: 'Hz', step: 0.01, log: true }),
      param('depth', 0, 1, 0.7, { step: 0.01 }),
      param('center', 100, 4000, 800, { unit: 'Hz', step: 1, log: true }),
      param('fb', 0, 0.9, 0.3, { step: 0.01 }),
      param('mix', 0, 1, 0.5, { step: 0.01 }),
    ],
  },
  init: () => ({ ph: 0, ap: [0, 0, 0, 0, 0, 0, 0, 0], fbv: 0 }),
  process(c, s) {
    const rate = c.p.rate ?? 0.5;
    const tri = wave(1, s.ph, 0);
    const f = Math.min(c.sr * 0.45, Math.max(20, (c.p.center ?? 800) * Math.pow(2, 2 * (c.p.depth ?? 0) * tri)));
    const g = Math.tan((Math.PI * f) / c.sr);
    const a = (g - 1) / (g + 1);
    const fb = c.p.fb ?? 0;
    const mix = c.p.mix ?? 0.5;
    for (let i = 0; i < c.n; i++) {
      const x0 = c.inp.in[i];
      let x = Math.min(8, Math.max(-8, x0 + fb * s.fbv));
      for (let k = 0; k < 4; k++) x = allpass(s.ap, 2 * k, a, x);
      s.fbv = x;
      c.out.out[i] = x0 * (1 - mix) + x * mix;
    }
    s.ph += (c.n * rate) / c.sr;
    s.ph -= Math.floor(s.ph);
  },
};

/** bit depth and sample rate reduction: 2^bits levels over -1..1, every taken sample held for `rate` samples */
const crush: ModuleImpl<{ held: number; cnt: number }> = {
  def: {
    type: 'crush',
    label: 'Digitizer',
    inputs: [audio('in')],
    outputs: [audio('out')],
    params: [param('bits', 1, 16, 8, { step: 1 }), param('rate', 1, 64, 1, { step: 1 })],
  },
  init: () => ({ held: 0, cnt: 0 }),
  process(c, s) {
    const bits = Math.round(c.p.bits ?? 8);
    const rate = Math.round(c.p.rate ?? 1);
    const q = Math.pow(2, bits - 1);
    for (let i = 0; i < c.n; i++) {
      if (s.cnt <= 0) {
        s.held = Math.floor(c.inp.in[i] * q + 0.5) / q;
        s.cnt = rate;
      }
      s.cnt--;
      c.out.out[i] = s.held;
    }
  },
};

const ALL = [fm1, osc, lfo, noise, constant, scale, adsr, vca, filter, mixer, delay, reverb, output, glide, shape, env, string, wavetable, chorus, seq, clkdiv, sh, quant, pulse, pan, xfade, vowel, phaser, crush, ladder, dyn, math, logic, grain, comb, modal, shift];

/**
 * Every module except the FM-1 panel (the input) and the output has two parameter inputs, p1 and p2, each with an
 * attenuverter (-1..1), and a matrix that says which parameters p1, p2 and the knobs k1..k4 control. A parameter's
 * effective value is its base + (block mean of p1 x att1 + block mean of p2 x att2, for the inputs that control it) x
 * (max - min), clamped.
 */
export const PIN_EXEMPT = new Set(['fm1', 'output']);
export const PIN_NAMES = ['p1', 'p2'] as const;
for (const m of ALL)
  if (!PIN_EXEMPT.has(m.def.type) && m.def.params.length) {
    m.def.paramInputs = true;
    m.def.inputs.push({ name: 'p1', kind: 'control', pin: 1 }, { name: 'p2', kind: 'control', pin: 2 });
  }

export const IMPLS: Record<string, ModuleImpl> = Object.fromEntries(ALL.map((m) => [m.def.type, m as ModuleImpl]));

export const DEFS: Record<string, ModuleDef> = Object.fromEntries(Object.values(IMPLS).map((m) => [m.def.type, m.def]));
