// SPDX-License-Identifier: GPL-3.0-only
// The module library: definitions (shared with the editor) and DSP implementations.

import type { ModuleDef, ParamDef, PortDef } from './patch';

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

/** white noise, or with `color` a one-pole low pass on it: c = 2^(-5 color), so color 1 rolls off from about 220 Hz */
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

const ALL = [fm1, osc, lfo, noise, constant, scale, adsr, vca, filter, mixer, delay, reverb, output, glide, shape, pan, xfade, vowel, phaser, crush];

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
