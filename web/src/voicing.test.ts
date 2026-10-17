// SPDX-License-Identifier: GPL-3.0-only
// Voicing (issue #22, now on Voice allocators): legato / priority of an allocator, its legato / jump outputs, the oscillator's blend / stack, the glide curve, the Random walk, and the conversion of old patches.
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { blendWeights, DEFS, hash32, walkHold, walkInit, walkStep } from './modules';
import { addModule, connect, emptyPatch, validatePatch, type Patch, type PolyCfg } from './patch';
import { addAlloc } from './test-poly';
import { makeAssembly } from './assembly';
import { polyGroups } from './poly';

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

/** a poly assembly (one voice unless `cfg` says) of allocator gate -> ADSR -> output l, allocator `port` -> output r */
function envPatch(port = 'pitch', cfg: Partial<PolyCfg> = {}): { p: Patch } {
  const p = emptyPatch();
  addModule(p, DEFS.fm1, 0, 0);
  const part = addAlloc(p, { parts: 1, ...cfg });
  const env = addModule(p, DEFS.adsr, 0, 0);
  Object.assign(env.params, { a: 0.005, d: 0.05, s: 0.3, r: 0.05 });
  const out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 1;
  wire(p, part.id, 'gate', env.id, 'gate');
  wire(p, env.id, 'env', out.id, 'l');
  wire(p, part.id, port, out.id, 'r');
  makeAssembly(p, [part.id, env.id], 'voice').poly = {};
  return { p };
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

  it('a note that takes over a sounding part restarts its envelope unless legato is on', () => {
    for (const [mode, dips] of [[0, true], [2, false]] as const) {
      const { p } = envPatch('gate', { legato: mode, parts: 2 });
      p.modules.find((m) => m.type === 'output')!.params.level = 0.4; // two gates sum to 0.8, under the output clamp
      const e = new Engine(SR);
      e.load(p);
      e.noteOn(60);
      e.noteOn(64);
      render(e, BLOCK * 4);
      e.noteOn(67); // steals 60
      const r = render(e, BLOCK);
      // r = the sum of both parts' gates: one low sample on the taken-over part gives 0.4 instead of 0.8
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

  it('several parts: legato per part', () => {
    const { p } = envPatch('legato', { parts: 3 });
    const e = new Engine(SR);
    e.load(p);
    e.noteOn(60);
    expect(render(e, BLOCK).r[0]).toBe(0);
    e.noteOn(64);
    expect(render(e, BLOCK).r[0]).toBe(1); // the sum over the parts: only the second note overlapped
  });
});

/** in a one-voice poly assembly: allocator pitch -> glide -> output l; the glide's p1 from the allocator's `src` (through math abs for jump) sets its time */
function glidePatch(src: 'legato' | 'jump' | 'none', glide: Record<string, number>, range?: [number, number]): Patch {
  const p = emptyPatch();
  addModule(p, DEFS.fm1, 0, 0);
  const kb = addAlloc(p, { parts: 1 }).id;
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
    makeAssembly(p, [kb, g.id, m], 'voice').poly = {};
    return p;
  }
  if (src === 'legato') wire(p, kb, 'legato', g.id, 'p1');
  makeAssembly(p, [kb, g.id], 'voice').poly = {};
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
function oscOut(params: Record<string, number>): Engine {
  const p = emptyPatch();
  const kb = addModule(p, DEFS.fm1, 0, 0);
  const o = addModule(p, DEFS.osc, 0, 0);
  Object.assign(o.params, { level: 0.5, ...params });
  const out = addModule(p, DEFS.output, 0, 0);
  out.params.level = 1;
  wire(p, kb.id, 'pitch', o.id, 'pitch');
  wire(p, o.id, 'out', out.id, 'l');
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

describe('oscillator: blend, stack', () => {
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

  it('the Random walk stays in -1..1, moves slowly and retargets at its rate', () => {
    const w = walkInit(hash32(7));
    const hold = walkHold(SR, 1.5);
    expect(hold).toBe(250);
    let max = 0, step = 0;
    for (let b = 0; b < 20000; b++) {
      const y0 = w.y;
      walkStep(w, hold);
      max = Math.max(max, Math.abs(w.y));
      step = Math.max(step, Math.abs(w.y - y0));
    }
    expect(max).toBeLessThanOrEqual(32768);
    expect(step).toBeLessThan(600); // under 2 % of the range per block
  });
});

describe('patches from before poly assemblies', () => {
  /** an old patch: Main pitch / gate -> osc -> output, with old fields */
  function old(extra: (p: Patch, ids: { kb: number; osc: number; out: number }) => void): Patch {
    const p = emptyPatch();
    const kb = addModule(p, DEFS.fm1, 0, 0);
    const osc = addModule(p, DEFS.osc, 300, 0);
    const out = addModule(p, DEFS.output, 600, 0);
    wire(p, kb.id, 'pitch', osc.id, 'pitch');
    wire(p, osc.id, 'out', out.id, 'l');
    extra(p, { kb: kb.id, osc: osc.id, out: out.id });
    return validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
  }

  it('Main legato / priority move to a one-part poly assembly (unit is dropped); a plain mono patch stays as it is', () => {
    const q = old((p, { kb }) => Object.assign(p.modules.find((m) => m.id === kb)!.params, { legato: 2, priority: 1, unit: 9 }));
    expect(polyGroups(q)[0].cfg).toEqual({ parts: 1, assign: 2, legato: 2, priority: 1 }); // the unit is gone (the flaws replaced it)
    expect(q.modules.find((m) => m.type === 'fm1')!.params).not.toHaveProperty('legato');
    const plain = old(() => {});
    expect(plain.assemblies).toBeUndefined();
    expect(plain.modules.map((m) => m.type)).toEqual(['fm1', 'osc', 'output']);
  });

  it('Main tol / drift become Random modules (fixed / walk) in the region of their destination', () => {
    const q = old((p, { kb, osc }) => {
      (p as Patch & { voices: number }).voices = 2;
      p.cables.push({ from: { module: kb, port: 'tol' }, to: { module: osc, port: 'p1' } }, { from: { module: kb, port: 'drift' }, to: { module: osc, port: 'p2' } });
    });
    const rs = q.modules.filter((m) => m.type === 'random');
    expect(rs.map((r) => r.params.mode).sort()).toEqual([0, 1]);
    const g = polyGroups(q)[0];
    for (const r of rs) {
      expect(g.modules.has(r.id)).toBe(true); // per part, as the old per-voice outputs were
      expect(q.cables.some((c) => c.from.module === r.id && c.to.port.startsWith('p'))).toBe(true);
    }
  });

  it('the oscillator\'s drift becomes a Random walk into fine tune through a free pin, drift / 2 cents at full swing', () => {
    const q = old((p, { osc }) => (p.modules.find((m) => m.id === osc)!.params.drift = 20));
    const o = q.modules.find((m) => m.type === 'osc')!;
    const r = q.modules.find((m) => m.type === 'random')!;
    expect(o.params).not.toHaveProperty('drift');
    expect(r.params.mode).toBe(1);
    expect(q.cables).toContainEqual({ from: { module: r.id, port: 'out' }, to: { module: o.id, port: 'p2' } });
    expect(o.map!.p2).toEqual(['fine']);
    expect(o.att![1]).toBeCloseTo(10 / 200, 6);
  });
});
