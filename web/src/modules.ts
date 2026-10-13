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
}

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
    outputs: [control('pitch'), gate('gate'), control('vel'), ...knobNames.map(control), control('spread')],
    params: [...knobNames.map((n) => param(n, 0, 1, 0.5, { step: 0.01 }))],
  },
  init: () => null,
  process(c) {
    c.out.pitch.fill(c.voice.pitch, 0, c.n);
    c.out.gate.fill(c.voice.gate, 0, c.n);
    c.out.vel.fill(c.voice.velocity, 0, c.n);
    c.out.spread.fill(c.voice.spread, 0, c.n); // -1..1 across the voices: detune or pan them with one cable
    for (const n of knobNames) c.out[n].fill(c.p[n] ?? 0, 0, c.n);
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
}

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
    ],
  },
  init: () => ({ phase: 0, s1: 0, y1: 0, y2: 0, pm1: 0, xb: 0, ap: [0, 0, 0, 0, 0, 0, 0, 0] }),
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
      // the plain oscillator: one wave per frame
      for (let i = 0; i < c.n; i++) {
        const f = C4 * Math.pow(2, pitch[i] + base);
        const dt = Math.min(f / c.sr, 0.45);
        if (sync[i] >= 0.5 && s.s1 < 0.5) s.phase = 0;
        s.s1 = sync[i];
        s.phase += dt;
        if (s.phase >= 1) s.phase -= 1;
        out[i] = wave(kind, s.phase, dt, pw) * lvl;
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

const LFO_WAVES = [...WAVES, 'S&H'];

const lfo: ModuleImpl<{ phase: number; seed: number; held: number; s1: number }> = {
  def: {
    type: 'lfo',
    label: 'LFO',
    inputs: [gate('sync')],
    outputs: [control('out')],
    params: [param('wave', 0, 4, 0, { step: 1, choices: LFO_WAVES }), param('rate', 0.02, 40, 4, { unit: 'Hz', step: 0.01 }), param('depth', 0, 1, 1, { step: 0.01 })],
  },
  init: () => ({ phase: 0, seed: 0x2545f491, held: 0, s1: 0 }),
  process(c, s) {
    const dt = (c.p.rate ?? 1) / c.sr;
    const kind = Math.round(c.p.wave ?? 0);
    const depth = c.p.depth ?? 1;
    const sync = c.inp.sync;
    for (let i = 0; i < c.n; i++) {
      if (sync[i] >= 0.5 && s.s1 < 0.5) s.phase = 0; // a rising edge restarts the cycle (key sync, or a sequencer step)
      s.s1 = sync[i];
      s.phase += dt;
      if (s.phase >= 1) {
        s.phase -= 1;
        // sample & hold: new random value (-1..1) at every cycle start
        s.seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0;
        s.held = s.seed / 0x80000000 - 1;
      }
      c.out.out[i] = (kind === 4 ? s.held : wave(kind, s.phase, dt)) * depth;
    }
  },
};

const noise: ModuleImpl<{ seed: number }> = {
  def: { type: 'noise', label: 'Noise', inputs: [], outputs: [audio('out')], params: [param('level', 0, 1, 0.5, { step: 0.01 })] },
  init: () => ({ seed: 0x1234567 }),
  process(c, s) {
    for (let i = 0; i < c.n; i++) {
      s.seed = (Math.imul(s.seed, 1664525) + 1013904223) >>> 0;
      c.out.out[i] = ((s.seed / 0x80000000) - 1) * (c.p.level ?? 1);
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
      param('a', 0.001, 5, 0.01, { unit: 's', step: 0.001 }),
      param('d', 0.001, 5, 0.2, { unit: 's', step: 0.001 }),
      param('s', 0, 1, 0.6, { step: 0.01 }),
      param('r', 0.001, 8, 0.3, { unit: 's', step: 0.001 }),
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
      param('cutoff', 20, 4000, 1200, { unit: 'Hz', step: 1, log: true, bend: true }),
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

const mixer: ModuleImpl<null> = {
  def: {
    type: 'mixer',
    label: 'Mixer 4',
    inputs: [audio('in1'), audio('in2'), audio('in3'), audio('in4')],
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

const delay: ModuleImpl<{ buf: Float32Array; w: number }> = {
  def: {
    type: 'delay',
    label: 'Delay',
    inputs: [audio('in')],
    outputs: [audio('out')],
    params: [param('time', 1, 1000, 250, { unit: 'ms', step: 1 }), param('fb', 0, 0.95, 0.4, { step: 0.01 }), param('mix', 0, 1, 0.3, { step: 0.01 })],
  },
  init: (sr) => ({ buf: new Float32Array(Math.ceil(sr * 1.05)), w: 0 }),
  process(c, s) {
    const len = s.buf.length;
    const d = Math.max(1, Math.min(len - 1, Math.round(((c.p.time ?? 250) / 1000) * c.sr)));
    for (let i = 0; i < c.n; i++) {
      const r = s.buf[(s.w - d + len) % len];
      s.buf[s.w] = c.inp.in[i] + r * (c.p.fb ?? 0);
      s.w = (s.w + 1) % len;
      c.out.out[i] = c.inp.in[i] * (1 - (c.p.mix ?? 0)) + r * (c.p.mix ?? 0);
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
    inputs: [audio('l'), audio('r')],
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

const ALL = [fm1, osc, lfo, noise, constant, scale, adsr, vca, filter, mixer, delay, reverb, output, glide, shape, env, string, wavetable, chorus, seq, clkdiv, sh, quant, pulse];

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
