// SPDX-License-Identifier: GPL-3.0-only
// Voicing (issue #22): legato / priority on the Main module, its legato / jump / tol / drift outputs, the oscillator's
// blend / stack / drift and the glide curve.
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { blendWeights, DEFS, hash32, tolOf, walkInit, walkStep } from './modules';
import { addModule, connect, emptyPatch, type Patch } from './patch';

const SR = 48000;
const BLOCK = 128;

function render(e: Engine, frames: number): { l: Float32Array; r: Float32Array } {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  e.render(l, r);
  return { l, r };
}
const wire = (p: Patch, a: number, ap: string, b: number, bp: string): void => {
  expect(connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })).toBe(true);
};
const rms = (a: Float32Array): number => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

/** Main gate -> ADSR -> output l, Main `port` -> output r */
function envPatch(port = 'pitch', main: Record<string, number> = {}): { p: Patch; main: number } {
  const p = emptyPatch();
  const kb = addModule(p, DEFS.fm1, 0, 0);
  Object.assign(kb.params, main);
  const env = addModule(p, DEFS.adsr, 0, 0);
  Object.assign(env.params, { a: 0.005, d: 0.05, s: 0.3, r: 0.05 });
  const out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 1;
  wire(p, kb.id, 'gate', env.id, 'gate');
  wire(p, env.id, 'env', out.id, 'l');
  wire(p, kb.id, port, out.id, 'r');
  return { p, main: kb.id };
}

describe('voicing: legato and priority', () => {
  it('mono legato auto / on: a second key re-pitches the held note and no envelope restarts; off: the envelope restarts', () => {
    for (const [mode, restarts] of [[0, false], [2, false], [1, true]] as const) {
      const { p } = envPatch('pitch', { legato: mode });
      const e = new Engine(SR);
      e.load(p);
      e.noteOn(60);
      render(e, SR / 2); // at sustain (0.3)
      e.noteOn(64);
      const r = render(e, SR / 50);
      expect(r.r[r.r.length - 1], `mode ${mode}`).toBeCloseTo(4 / 12, 5);
      const peak = Math.max(...r.l);
      if (restarts) expect(peak, `mode ${mode}`).toBeGreaterThan(0.9);
      else expect(peak, `mode ${mode}`).toBeLessThan(0.31);
      expect(e.voiceNotes()[0]).toEqual({ note: 64, on: true });
    }
  });

  it('priority last / low / high picks the sounding key among three held, and falls back on release', () => {
    const want = [[64, 60, 67], [60, 60, 67]]; // [sounding with 60, 67, 64 held], [after releasing 64]
    [0, 1, 2].forEach((prio) => {
      const { p } = envPatch('pitch', { priority: prio });
      const e = new Engine(SR);
      e.load(p);
      for (const n of [60, 67, 64]) e.noteOn(n);
      let r = render(e, BLOCK * 2);
      expect(r.r[BLOCK] * 12 + 60, `priority ${prio}`).toBeCloseTo(want[0][prio], 4);
      e.noteOff(64);
      r = render(e, BLOCK * 2);
      expect(r.r[BLOCK] * 12 + 60, `priority ${prio} after release`).toBeCloseTo(prio === 0 ? 67 : want[1][prio], 4);
    });
  });

  it('a poly note that steals a sounding voice restarts its envelope unless legato is on', () => {
    for (const [mode, dips] of [[0, true], [2, false]] as const) {
      const { p } = envPatch('gate', { legato: mode });
      p.voices = 2;
      p.modules.find((m) => m.type === 'output')!.params.level = 0.4; // two gates sum to 0.8, under the output clamp
      const e = new Engine(SR);
      e.load(p);
      e.noteOn(60);
      e.noteOn(64);
      render(e, BLOCK * 4);
      e.noteOn(67); // steals 60
      const r = render(e, BLOCK);
      // r = the sum of both voices' gates: one low sample on the stolen voice gives 0.4 instead of 0.8
      expect(r.r[0] < 0.6, `mode ${mode}`).toBe(dips);
    }
  });

  it('the legato output is 1 only for a note that began over a held one; jump is the signed step in octaves', () => {
    for (const port of ['legato', 'jump']) {
      const { p } = envPatch(port);
      const e = new Engine(SR);
      e.load(p);
      const at = (): number => render(e, BLOCK * 2).r[BLOCK];
      e.noteOn(60);
      const first = at();
      e.noteOn(67);
      const over = at();
      e.noteOff(67); // back to 60 while held: also a legato transition
      const back = at();
      e.noteOff(60);
      at();
      e.noteOn(72); // detached
      const detached = at();
      if (port === 'legato') expect([first, over, back, detached]).toEqual([0, 1, 1, 0]);
      else {
        expect(first).toBeCloseTo(0, 6); // from the resting pitch, C4
        expect(over).toBeCloseTo(7 / 12, 6);
        expect(back).toBeCloseTo(-7 / 12, 6);
        expect(detached).toBeCloseTo(1, 6);
      }
    }
  });

  it('poly: legato and jump per voice', () => {
    const { p } = envPatch('legato');
    p.voices = 3;
    const e = new Engine(SR);
    e.load(p);
    e.noteOn(60);
    expect(render(e, BLOCK).r[0]).toBe(0);
    e.noteOn(64);
    expect(render(e, BLOCK).r[0]).toBe(1); // the sum over the voices: only the second note overlapped
  });
});

/** Main pitch -> glide -> output l; the glide's p1 from Main `src` (through math abs when `abs`) sets its time */
function glidePatch(src: 'legato' | 'jump' | 'none', glide: Record<string, number>, range?: [number, number]): Patch {
  const p = emptyPatch();
  const kb = addModule(p, DEFS.fm1, 0, 0).id;
  const g = addModule(p, DEFS.glide, 0, 0);
  Object.assign(g.params, glide);
  g.map = { p1: ['time'], p2: [], k1: [], k2: [], k3: [], k4: [] };
  if (range) g.range = { p1: { time: range } };
  const out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 1;
  wire(p, kb, 'pitch', g.id, 'in');
  wire(p, g.id, 'out', out.id, 'l');
  if (src === 'jump') {
    const m = addModule(p, DEFS.math, 0, 0).id;
    wire(p, kb, 'jump', m, 'a');
    wire(p, m, 'abs', g.id, 'p1');
  } else if (src === 'legato') wire(p, kb, 'legato', g.id, 'p1');
  return p;
}

/** samples until the output gets within 10 % of the step from `from` to `to` */
function settle(e: Engine, from: number, to: number, max = SR): number {
  const r = render(e, max).l;
  const i = r.findIndex((v) => Math.abs(v - to) < 0.1 * Math.abs(to - from));
  return i < 0 ? max : i;
}

describe('voicing: portamento', () => {
  it('legato-only glide: the legato output through a macro range glides overlapping notes, a detached note jumps', () => {
    const e = new Engine(SR);
    e.load(glidePatch('legato', { time: 0.001 }, [0, 0.7]));
    e.noteOn(60);
    render(e, SR / 10);
    e.noteOff(60);
    render(e, BLOCK);
    e.noteOn(72); // detached: no glide
    expect(settle(e, 0, 1)).toBeLessThan(BLOCK);
    e.noteOn(84); // over 72: glides
    expect(settle(e, 1, 2)).toBeGreaterThan(SR / 50);
  });

  it('scaled glide: |jump| into the time makes a fifth slower than a semitone', () => {
    const t = (step: number): number => {
      const e = new Engine(SR);
      e.load(glidePatch('jump', { time: 0.01 }));
      e.noteOn(60);
      render(e, SR / 5);
      e.noteOn(60 + step);
      return settle(e, 0, step / 12);
    };
    expect(t(7)).toBeGreaterThan(1.5 * t(1));
  });

  it('the lin curve glides at a constant rate: an octave in `time`, a fifth in 7/12 of it', () => {
    const t = (step: number): number => {
      const e = new Engine(SR);
      e.load(glidePatch('none', { time: 0.1, curve: 1 }));
      e.noteOn(60);
      render(e, SR / 2);
      e.noteOn(60 + step);
      const r = render(e, SR / 2).l;
      return r.findIndex((v) => v >= step / 12 - 1e-6);
    };
    expect(t(12) / SR).toBeCloseTo(0.1, 2);
    expect(t(7) / SR).toBeCloseTo((0.1 * 7) / 12, 2);
  });
});

/** one oscillator into the output, held at C4 */
function oscOut(params: Record<string, number>, main: Record<string, number> = {}, voices = 1): Engine {
  const p = emptyPatch();
  const kb = addModule(p, DEFS.fm1, 0, 0);
  Object.assign(kb.params, main);
  const o = addModule(p, DEFS.osc, 0, 0);
  Object.assign(o.params, { level: 0.5, ...params });
  const out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 1;
  wire(p, kb.id, 'pitch', o.id, 'pitch');
  wire(p, o.id, 'out', out.id, 'l');
  p.voices = voices;
  const e = new Engine(SR);
  e.load(p);
  e.noteOn(60);
  return e;
}

/** the amplitude of the component at `hz` (a single-bin DFT) */
function bin(a: Float32Array, hz: number): number {
  let re = 0, im = 0;
  for (let i = 0; i < a.length; i++) {
    re += a[i] * Math.cos((2 * Math.PI * hz * i) / SR);
    im += a[i] * Math.sin((2 * Math.PI * hz * i) / SR);
  }
  return (2 * Math.hypot(re, im)) / a.length;
}

describe('oscillator: blend, stack, drift', () => {
  it('blend weights: 0.5 is the plain average, 0 the centre only, 1 the sides only', () => {
    expect(blendWeights(5, 0.5)).toEqual([0.2, 0.2, 0.2, 0.2, 0.2]);
    expect(blendWeights(5, 0)).toEqual([0, 0, 1, 0, 0]);
    expect(blendWeights(4, 0)).toEqual([0, 0.5, 0.5, 0]);
    expect(blendWeights(3, 1)).toEqual([0.5, 0, 0.5]);
    expect(blendWeights(2, 0)).toEqual([0.5, 0.5]);
  });

  it('blend 0 is the centre copy alone: the same as unison 1', () => {
    const a = render(oscOut({ unison: 5, detune: 40, blend: 0 }), 4096).l;
    const b = render(oscOut({ unison: 1 }), 4096).l;
    for (let i = 0; i < a.length; i++) expect(a[i]).toBeCloseTo(b[i], 5);
  });

  it('stack +oct adds the octave above at the same level: a sine splits half and half between 262 and 523 Hz', () => {
    const plain = render(oscOut({ wave: 0, detune: 0 }), SR / 2).l;
    const stack = render(oscOut({ wave: 0, detune: 0, stack: 1 }), SR / 2).l;
    expect(bin(plain, 261.63)).toBeCloseTo(0.5, 2);
    expect(bin(stack, 261.63)).toBeCloseTo(0.25, 2);
    expect(bin(stack, 523.25)).toBeCloseTo(0.25, 2);
    expect(bin(render(oscOut({ wave: 0, detune: 0, stack: 4 }), SR / 2).l, 130.81)).toBeCloseTo(0.25, 2); // -oct
  });

  it('drift 0 changes nothing; drift detunes, differently per unit and per voice', () => {
    const ref = render(oscOut({ wave: 2 }), 8192).l;
    expect(rms(ref)).toBeGreaterThan(0.1);
    const same = render(oscOut({ wave: 2, drift: 0 }, { unit: 5 }), 8192).l;
    expect(Array.from(same)).toEqual(Array.from(ref));
    const d = render(oscOut({ wave: 0, drift: 50 }), SR).l;
    const f = (a: Float32Array): number => {
      let n = 0;
      for (let i = 1; i < a.length; i++) if (a[i - 1] < 0 && a[i] >= 0) n++;
      return n;
    };
    const cents = (a: Float32Array): number => 1200 * Math.log2(f(a) / 261.63);
    const c0 = cents(d);
    expect(Math.abs(c0)).toBeGreaterThan(1);
    expect(Math.abs(c0)).toBeLessThan(51);
    const c1 = cents(render(oscOut({ wave: 0, drift: 50 }, { unit: 1 }), SR).l);
    expect(c1).not.toBeCloseTo(c0, 0);
  });

  it('the drift walk stays in -1..1 and moves slowly', () => {
    const w = walkInit(hash32(7), 5);
    let max = 0, step = 0;
    for (let b = 0; b < 20000; b++) {
      const y0 = w.y[0];
      walkStep(w);
      max = Math.max(max, ...Array.from(w.y, Math.abs));
      step = Math.max(step, Math.abs(w.y[0] - y0));
    }
    expect(max).toBeLessThanOrEqual(32768);
    expect(step).toBeLessThan(600); // under 2 % of the range per block
  });
});

describe('Main tol and drift outputs', () => {
  it('tol is fixed per voice and unit, different between voices; drift wanders slowly per voice', () => {
    const { p } = envPatch('tol', { unit: 3 });
    const e = new Engine(SR);
    e.load(p);
    e.noteOn(60);
    expect(render(e, BLOCK).r[0]).toBeCloseTo(tolOf(3, 0) / 32768, 6);
    expect(tolOf(3, 0)).not.toBe(tolOf(3, 1));
    expect(tolOf(3, 0)).not.toBe(tolOf(4, 0));
    const d = envPatch('drift');
    const f = new Engine(SR);
    f.load(d.p);
    const a = render(f, SR * 2).r;
    expect(Math.max(...a) - Math.min(...a)).toBeGreaterThan(0.01);
    for (let i = 1; i < a.length; i++) expect(Math.abs(a[i] - a[i - 1])).toBeLessThan(0.02);
  });
});
