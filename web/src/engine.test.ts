// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { BLOCK, Engine } from './engine';
import { DEFS, DELAY_TIME_MAX, DELAY_TIME_MIN } from './modules';
import { addModule, clearMorph, connect, disconnect, emptyPatch, fromUnit, hasMorph, modulate, morphValue, paramUnit, paramValue, processingOrder, removeModule, sameStructure, setMorphTarget, toUnit, validatePatch, POLY_DEFAULT, type Patch, type PolyCfg } from './patch';
import { copiesOf, polyGroups } from './poly';
import { fixAssemblies, makeAssembly } from './assembly';
import { polyCfg, withParts } from './test-poly';
import { PRESETS } from './presets';
import { encodePatch, recordSize } from './patchbin';

const SR = 48000;

function render(e: Engine, frames: number): { l: Float32Array; r: Float32Array } {
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  e.render(l, r);
  return { l, r };
}

const rms = (a: Float32Array): number => Math.sqrt(a.reduce((s, v) => s + v * v, 0) / a.length);

/** frequency estimate from zero crossings */
function freq(a: Float32Array): number {
  let n = 0;
  for (let i = 1; i < a.length; i++) if (a[i - 1] < 0 && a[i] >= 0) n++;
  return (n * SR) / a.length;
}

describe('patch model', () => {
  it('connects, rejects duplicates and bad ports, removes with cables', () => {
    const p = emptyPatch();
    const a = addModule(p, DEFS.osc, 0, 0);
    const b = addModule(p, DEFS.output, 0, 0);
    expect(connect(p, DEFS, { module: a.id, port: 'out' }, { module: b.id, port: 'l' })).toBe(true);
    expect(connect(p, DEFS, { module: a.id, port: 'out' }, { module: b.id, port: 'l' })).toBe(false);
    expect(connect(p, DEFS, { module: a.id, port: 'nope' }, { module: b.id, port: 'l' })).toBe(false);
    expect(connect(p, DEFS, { module: a.id, port: 'out' }, { module: a.id, port: 'pm' })).toBe(false);
    disconnect(p, p.cables[0]);
    expect(p.cables).toHaveLength(0);
    connect(p, DEFS, { module: a.id, port: 'out' }, { module: b.id, port: 'l' });
    removeModule(p, a.id);
    expect(p.cables).toHaveLength(0);
  });

  it('orders producers before consumers and marks loop-closing cables as feedback', () => {
    const p = emptyPatch();
    const o = addModule(p, DEFS.osc, 0, 0);
    const f = addModule(p, DEFS.filter, 0, 0);
    const v = addModule(p, DEFS.vca, 0, 0);
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: f.id, port: 'in' });
    connect(p, DEFS, { module: f.id, port: 'lp12' }, { module: v.id, port: 'in' });
    let r = processingOrder(p);
    expect(r.order).toEqual([o.id, f.id, v.id]);
    expect(r.feedback.size).toBe(0);
    connect(p, DEFS, { module: v.id, port: 'out' }, { module: o.id, port: 'pm' });
    r = processingOrder(p);
    expect(r.feedback.size).toBe(1);
    expect(r.order).toHaveLength(3);
  });

  it('validates JSON patches', () => {
    expect(() => validatePatch({ version: 2 }, DEFS)).toThrow();
    const p = PRESETS['Subtractive saw']();
    expect(validatePatch(JSON.parse(JSON.stringify(p)), DEFS).modules).toHaveLength(p.modules.length);
    const bad = JSON.parse(JSON.stringify(p));
    bad.cables[0].to.port = 'ghost';
    expect(() => validatePatch(bad, DEFS)).toThrow(/no input/);
  });

  it('refuses more than the module cap', () => {
    const p = emptyPatch();
    for (let i = 0; i < 32; i++) addModule(p, DEFS.const, 0, 0);
    expect(() => addModule(p, DEFS.const, 0, 0)).toThrow();
  });
});

describe('engine', () => {
  it('is silent without a note and sounds at the right pitch with one', () => {
    const e = new Engine(SR);
    const p = emptyPatch();
    const kb = addModule(p, DEFS.fm1, 0, 0);
    const o = addModule(p, DEFS.osc, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    connect(p, DEFS, { module: kb.id, port: 'pitch' }, { module: o.id, port: 'pitch' });
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: out.id, port: 'l' });
    e.load(p);
    // oscillator runs freely: check pitch instead of silence
    e.noteOn(69); // A4
    const { l } = render(e, SR);
    expect(freq(l)).toBeGreaterThan(438);
    expect(freq(l)).toBeLessThan(442);
    e.noteOn(81); // A5
    expect(freq(render(e, SR).l)).toBeGreaterThan(878);
  });

  it('applies the ADSR: silent before the note, sounding while held, decaying after release', () => {
    const e = new Engine(SR);
    e.load(PRESETS['Subtractive saw']());
    expect(rms(render(e, 4800).l)).toBeLessThan(1e-4);
    e.noteOn(48);
    expect(rms(render(e, 9600).l)).toBeGreaterThan(0.02);
    e.noteOff(48);
    render(e, SR * 12); // the release is up to ~4 s with K4 at its start position
    expect(rms(render(e, 4800).l)).toBeLessThan(1e-3);
  });

  it('303 Acid preset is finite, audible and not clipping', () => {
    const e = new Engine(SR);
    e.load(PRESETS['303 Acid']());
    e.noteOn(36);
    const { l } = render(e, SR);
    expect(l.every(Number.isFinite)).toBe(true);
    expect(rms(l)).toBeGreaterThan(0.01);
    expect(Math.max(...l.map(Math.abs))).toBeLessThan(2);
  });

  it('LFO sample & hold and osc pulse width run and stay finite', () => {
    const p = emptyPatch();
    const lfo = addModule(p, DEFS.lfo, 0, 0);
    lfo.params.wave = 4;
    lfo.params.rate = 20;
    const osc = addModule(p, DEFS.osc, 0, 0);
    Object.assign(osc.params, { wave: 3, pw: 0.2, level: 1 });
    const out = addModule(p, DEFS.output, 0, 0);
    expect(connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: osc.id, port: 'p2' })).toBe(true); // p2 controls pw by default
    expect(connect(p, DEFS, { module: osc.id, port: 'out' }, { module: out.id, port: 'l' })).toBe(true);
    const e = new Engine(SR);
    e.load(p);
    const { l } = render(e, SR / 2);
    expect(l.every(Number.isFinite)).toBe(true);
    expect(rms(l)).toBeGreaterThan(0.1);
  });

  it('every module but fm1 and output has the two parameter inputs and a matrix', () => {
    for (const d of Object.values(DEFS)) {
      const has = d.inputs.filter((i) => i.pin).map((i) => i.name);
      if (['fm1', 'output'].includes(d.type) || !d.params.length) expect(has, d.type).toEqual([]); // nothing to modulate (the Part)
      else expect(has, d.type).toEqual(['p1', 'p2']);
      const m = addModule(emptyPatch(), d, 0, 0);
      expect(!!m.map, d.type).toBe(!!d.paramInputs);
    }
    const osc = addModule(emptyPatch(), DEFS.osc, 0, 0);
    expect(osc.map!.p1).toEqual(['wave']);
    expect(osc.map!.k4).toEqual(['fine']);
  });

  it('a parameter input moves the parameters the matrix assigns it to, scaled and inverted by its attenuverter', () => {
    const build = (att: number, assigned: boolean) => {
      const p = emptyPatch();
      const osc = addModule(p, DEFS.osc, 0, 0);
      osc.params.level = 0.5;
      osc.map!.p1 = assigned ? ['level'] : [];
      osc.att = [att, 1];
      const k = addModule(p, DEFS.const, 0, 0);
      k.params.value = 0.25;
      const out = addModule(p, DEFS.output, 0, 0);
      connect(p, DEFS, { module: osc.id, port: 'out' }, { module: out.id, port: 'l' });
      expect(connect(p, DEFS, { module: k.id, port: 'out' }, { module: osc.id, port: 'p1' })).toBe(true);
      const e = new Engine(SR);
      e.load(p);
      e.noteOn(60);
      return rms(render(e, 4800).l);
    };
    const base = build(1, false); // not assigned: no effect, level stays 0.5
    expect(build(1, true) / base).toBeGreaterThan(1.4); // 0.5 + 0.25 = 0.75
    expect(build(1, true) / base).toBeLessThan(1.6);
    expect(build(-1, true) / base).toBeGreaterThan(0.45); // 0.5 - 0.25 = 0.25
    expect(build(-1, true) / base).toBeLessThan(0.55);
    expect(build(0, true) / base).toBeCloseTo(1, 1);
  });

  it('turns a saved MIDI module into the FM-1 panel (same pitch, gate and vel outputs)', () => {
    const old = {
      version: 2,
      name: 'old',
      modules: [
        { id: 1, type: 'midi', x: 0, y: 0, params: {} },
        { id: 2, type: 'osc', x: 0, y: 0, params: {} },
        { id: 3, type: 'output', x: 0, y: 0, params: {} },
      ],
      cables: [
        { from: { module: 1, port: 'pitch' }, to: { module: 2, port: 'pitch' } },
        { from: { module: 2, port: 'out' }, to: { module: 3, port: 'l' } },
      ],
    };
    const p = validatePatch(old, DEFS);
    expect(p.modules[0].type).toBe('fm1');
    const e = new Engine(SR);
    e.load(p);
    e.noteOn(69);
    expect(freq(render(e, SR).l)).toBeGreaterThan(438);
  });

  it('converts version 1 patches (a <param>_cv cable becomes p1 / p2 with that parameter assigned)', () => {
    const old = {
      version: 1,
      name: 'old',
      modules: [
        { id: 1, type: 'const', x: 0, y: 0, params: { value: 0.5 } },
        { id: 2, type: 'osc', x: 0, y: 0, params: { level: 0 } },
        { id: 3, type: 'output', x: 0, y: 0, params: { level: 0.7 } },
      ],
      cables: [
        { from: { module: 1, port: 'out' }, to: { module: 2, port: 'level_cv' } },
        { from: { module: 2, port: 'out' }, to: { module: 3, port: 'l' } },
      ],
    };
    const p = validatePatch(old, DEFS);
    expect(p.version).toBe(2);
    expect(p.cables[0].to.port).toBe('p1');
    expect(p.modules[1].map!.p1).toEqual(['level']);
    const e = new Engine(SR);
    e.load(p);
    expect(rms(render(e, 4800).l)).toBeGreaterThan(0.1);
  });

  it('FM-1 panel module outputs keys and knobs', () => {
    const p = emptyPatch();
    const panel = addModule(p, DEFS.fm1, 0, 0);
    Object.assign(panel.params, { k3: 0.25 });
    const osc = addModule(p, DEFS.osc, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    expect(connect(p, DEFS, { module: panel.id, port: 'pitch' }, { module: osc.id, port: 'pitch' })).toBe(true);
    osc.map!.p1 = ['level'];
    expect(connect(p, DEFS, { module: panel.id, port: 'k3' }, { module: osc.id, port: 'p1' })).toBe(true);
    expect(connect(p, DEFS, { module: osc.id, port: 'out' }, { module: out.id, port: 'l' })).toBe(true);
    const e = new Engine(SR);
    e.load(p);
    e.noteOn(69);
    const { l } = render(e, SR);
    expect(l.every(Number.isFinite)).toBe(true);
    expect(rms(l)).toBeGreaterThan(0.05);
  });

  it('keeps running state when the patch is edited, but not output order assumptions', () => {
    const e = new Engine(SR);
    const p = PRESETS['Subtractive saw']();
    e.load(p);
    e.noteOn(48);
    render(e, 4800);
    const before = rms(render(e, 1200).l);
    p.modules[1].params.level = 0.4;
    e.load(p);
    const after = rms(render(e, 1200).l);
    expect(after).toBeGreaterThan(before * 0.2); // no restart-to-silence: envelope state survived
  });

  it('FM changes the spectrum compared to the unmodulated carrier', () => {
    const e = new Engine(SR);
    const p = PRESETS['Two-operator FM']();
    e.load(p);
    e.noteOn(60);
    const a = render(e, 8000).l;
    const carrier = p.modules.find((m) => m.type === 'osc' && m.params.pm > 0)!;
    carrier.params.pm = 0;
    e.load(p);
    render(e, 2000);
    const b = render(e, 8000).l;
    let diff = 0;
    for (let i = 0; i < 8000; i++) diff += Math.abs(a[i] - b[i]);
    expect(diff).toBeGreaterThan(10);
  });

  it('survives a feedback cable without NaNs', () => {
    const e = new Engine(SR);
    const p = PRESETS['Subtractive saw']();
    const vca = p.modules.find((m) => m.type === 'vca')!;
    const osc = p.modules.find((m) => m.type === 'osc')!;
    connect(p, DEFS, { module: vca.id, port: 'out' }, { module: osc.id, port: 'pm' });
    osc.params.pm = 2;
    e.load(p);
    e.noteOn(55);
    const { l } = render(e, 20000);
    expect(l.every(Number.isFinite)).toBe(true);
  });

  it('renders every preset without NaN or clipping runaway', () => {
    for (const [name, make] of Object.entries(PRESETS)) {
      const e = new Engine(SR);
      e.load(make());
      e.noteOn(48);
      const { l, r } = render(e, 24000);
      expect(l.every(Number.isFinite), name).toBe(true);
      expect(rms(l), name).toBeGreaterThan(0.005);
      expect(rms(r), name).toBeGreaterThan(0.005);
    }
  });

  it('the filter cutoff is logarithmic: modulation moves it in octaves', () => {
    const cutoff = DEFS.filter.params.find((q) => q.name === 'cutoff')!;
    expect(cutoff.log).toBe(true);
    expect(toUnit(cutoff, 20)).toBeCloseTo(0, 6);
    expect(toUnit(cutoff, 16000)).toBeCloseTo(1, 6);
    expect(cutoff.bend).toBe(true); // inverse logarithmic: the position is the square root of the octave fraction
    expect(fromUnit(cutoff, 0.5)).toBeCloseTo(20 * Math.pow(800, 0.25), 3);
    expect(toUnit(cutoff, fromUnit(cutoff, 0.3))).toBeCloseTo(0.3, 9);
    expect(modulate(cutoff, 200, 5)).toBeCloseTo(16000, 6);
    const level = DEFS.osc.params.find((q) => q.name === 'level')!;
    expect(modulate(level, 0.5, 0.25)).toBeCloseTo(0.75, 9); // the others stay linear
  });

  it('K1 moves the filter cutoff the same way in every factory preset: 20..4000 Hz over the whole knob', () => {
    const cutoff = DEFS.filter.params.find((q) => q.name === 'cutoff')!;
    for (const [name, make] of Object.entries(PRESETS)) {
      const p = make();
      const panel = p.modules.find((m) => m.type === 'fm1')!;
      const flt = p.modules.find((m) => m.type === 'filter');
      if (!flt) continue;
      const cable = p.cables.find((c) => c.from.module === panel.id && c.from.port === 'k1' && c.to.module === flt.id);
      expect(cable, `${name}: K1 reaches the filter`).toBeTruthy();
      const pin = cable!.to.port === 'p1' ? 0 : 1;
      expect(flt.map![pin === 0 ? 'p1' : 'p2'], name).toEqual(['cutoff']);
      expect(flt.att![pin], `${name}: full attenuverter`).toBe(1);
      expect(flt.params.cutoff, `${name}: K1 = 0 is the bottom`).toBeCloseTo(cutoff.min, 6);
      expect(modulate(cutoff, flt.params.cutoff, 1), name).toBeCloseTo(cutoff.max, 3); // K1 = 1 is the top
    }
  });

  it('the factory presets route the knobs: K1 is the filter cutoff, K4 the delay mix, K3 the reverb mix', () => {
    for (const [name, make] of Object.entries(PRESETS)) {
      const p = make();
      const panel = p.modules.find((m) => m.type === 'fm1')!;
      const dest = (k: number) =>
        p.cables
          .filter((c) => c.from.module === panel.id && c.from.port === `k${k}`)
          .map((c) => {
            const m = p.modules.find((x) => x.id === c.to.module)!;
            return { type: m.type, params: m.map?.[c.to.port as 'p1' | 'p2'] ?? [] };
          });
      for (let k = 1; k <= 4; k++) expect(dest(k).length, `${name} K${k}`).toBeGreaterThan(0);
      if (p.modules.some((m) => m.type === 'filter')) expect(dest(1).some((d) => d.type === 'filter' && d.params.includes('cutoff')), `${name}: K1 is the cutoff`).toBe(true);
      if (p.modules.some((m) => m.type === 'delay')) expect(dest(4).some((d) => d.type === 'delay' && d.params.includes('mix')), `${name}: K4 is the delay mix`).toBe(true);
      if (p.modules.some((m) => m.type === 'reverb')) expect(dest(3).some((d) => d.type === 'reverb' && d.params.includes('mix')), `${name}: K3 is the reverb mix`).toBe(true);
    }
  });

  it('knob routing leaves the sound of a preset where it was (the knobs start where the values are)', () => {
    const p = PRESETS['Pluck']();
    const filt = p.modules.find((m) => m.type === 'filter')!;
    const panel = p.modules.find((m) => m.type === 'fm1')!;
    const cutoff = DEFS.filter.params.find((q) => q.name === 'cutoff')!;
    const moved = modulate(cutoff, filt.params.cutoff, panel.params.k1 * filt.att![0]);
    expect(moved).toBeGreaterThan(299);
    expect(moved).toBeLessThan(301);
  });
});

describe('filter', () => {
  /** noise -> filter -> output left, taken from the given filter output */
  function rig(port: string, params: Record<string, number>, note?: number): Float32Array {
    const e = new Engine(SR);
    const p = emptyPatch();
    addModule(p, DEFS.fm1, 0, 0);
    const n = addModule(p, DEFS.noise, 0, 0);
    const f = addModule(p, DEFS.filter, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    Object.assign(f.params, { res: 0, ...params });
    connect(p, DEFS, { module: n.id, port: 'out' }, { module: f.id, port: 'in' });
    connect(p, DEFS, { module: f.id, port: port }, { module: out.id, port: 'l' });
    e.load(p);
    if (note !== undefined) e.noteOn(note);
    render(e, 4800);
    return render(e, SR).l;
  }

  it('has a 24 dB and a 12 dB low pass: the 24 dB one takes more of the highs away', () => {
    const highs = (a: Float32Array): number => rms(a.slice(2).map((v, i) => v - 2 * a[i + 1] + a[i])); // second difference: the content far above the cutoff
    const lp12 = highs(rig('lp12', { cutoff: 500 }));
    const lp24 = highs(rig('lp24', { cutoff: 500 }));
    expect(lp12).toBeGreaterThan(1e-5);
    expect(lp24).toBeLessThan(lp12 * 0.3);
  });

  it('the mix output morphs from the 24 dB low pass (morph 0) to the high pass (morph 1)', () => {
    const lp24 = rig('lp24', { cutoff: 800 }), hp = rig('hp', { cutoff: 800 });
    const m0 = rig('mix', { cutoff: 800, morph: 0 }), m1 = rig('mix', { cutoff: 800, morph: 1 });
    expect(rms(m0)).toBeCloseTo(rms(lp24), 6);
    expect(rms(m1)).toBeCloseTo(rms(hp), 6);
    expect(rms(m0)).not.toBeCloseTo(rms(m1), 3);
  });

  it('key tracking moves the cutoff with the pitch of the played note', () => {
    const off = rms(rig('lp12', { cutoff: 300, track: 0 }, 84));
    const on = rms(rig('lp12', { cutoff: 300, track: 1 }, 84)); // C6: 2 octaves above C4
    expect(on).toBeGreaterThan(off * 1.5);
    expect(rms(rig('lp12', { cutoff: 300, track: 1 }, 60))).toBeCloseTo(rms(rig('lp12', { cutoff: 300, track: 0 }, 60)), 6); // C4: no shift
  });

  /** a sine at `hz` through the given filter output, rms over a second after a short settling */
  function sineThrough(port: string, hz: number, params: Record<string, number>): number {
    const e = new Engine(SR);
    const p = emptyPatch();
    addModule(p, DEFS.fm1, 0, 0);
    const o = addModule(p, DEFS.osc, 0, 0);
    const f = addModule(p, DEFS.filter, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    o.params.coarse = Math.round(12 * Math.log2(hz / 261.6255653)); // the nearest semitone
    o.params.fine = 100 * (12 * Math.log2(hz / 261.6255653) - o.params.coarse);
    o.params.level = 0.1; // room for the resonant peak below the output's clamp
    Object.assign(f.params, { res: 0, ...params });
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: f.id, port: 'in' });
    connect(p, DEFS, { module: f.id, port }, { module: out.id, port: 'l' });
    e.load(p);
    render(e, 4800);
    return rms(render(e, SR).l);
  }

  it('the notch output nulls the cutoff and passes the rest; the allpass passes everything; the peak output bumps the cutoff', () => {
    const ref = sineThrough('ap', 1000, { cutoff: 1000 });
    expect(sineThrough('notch', 1000, { cutoff: 1000 })).toBeLessThan(ref * 0.05);
    expect(sineThrough('notch', 8000, { cutoff: 1000 })).toBeGreaterThan(ref * 0.9);
    expect(sineThrough('notch', 125, { cutoff: 1000 })).toBeGreaterThan(ref * 0.9);
    // the allpass has a flat magnitude: a sine at the cutoff comes out as loud as far away from it (and as loud as it went in)
    expect(sineThrough('ap', 125, { cutoff: 1000 })).toBeCloseTo(ref, 2);
    expect(sineThrough('ap', 8000, { cutoff: 1000 })).toBeCloseTo(ref, 2);
    // the peak output: flat far from the cutoff, louder at it with resonance
    const far = sineThrough('peak', 125, { cutoff: 1000, res: 0.8 });
    expect(far).toBeCloseTo(ref, 1);
    expect(sineThrough('peak', 1000, { cutoff: 1000, res: 0.8 })).toBeGreaterThan(far * 3);
  });

  it('loads old patches whose cables leave the filter at "lp"', () => {
    const p = PRESETS['303 Acid']();
    const q = JSON.parse(JSON.stringify(p));
    const flt = q.modules.find((m: { type: string }) => m.type === 'filter').id;
    const cable = q.cables.find((c: { from: { module: number } }) => c.from.module === flt);
    cable.from.port = 'lp'; // what an old patch calls the 12 dB output
    expect(validatePatch(q, DEFS).cables.find((c) => c.from.module === flt)!.from.port).toBe('lp12');
  });
});

describe('macro ranges', () => {
  /** a constant into the filter's p1 (-> cutoff), noise through the filter's lp12; returns the effective cutoff the engine used */
  function rig(k: number, range: [number, number] | null, base = 1200, att = 1): number {
    const e = new Engine(SR);
    const p = emptyPatch();
    addModule(p, DEFS.fm1, 0, 0);
    const c = addModule(p, DEFS.const, 0, 0);
    c.params.value = k;
    const n = addModule(p, DEFS.noise, 0, 0);
    const f = addModule(p, DEFS.filter, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    f.params.cutoff = base;
    f.map!.p1 = ['cutoff'];
    f.att = [att, 1];
    if (range) f.range = { p1: { cutoff: range } };
    connect(p, DEFS, { module: c.id, port: 'out' }, { module: f.id, port: 'p1' });
    connect(p, DEFS, { module: n.id, port: 'out' }, { module: f.id, port: 'in' });
    connect(p, DEFS, { module: f.id, port: 'lp12' }, { module: out.id, port: 'l' });
    e.load(p);
    render(e, 256);
    return (e as unknown as { nodes: Map<number, { inst: { eff: Record<string, number> }[] }> }).nodes.get(f.id)!.inst[0].eff.cutoff;
  }
  const cutoff = DEFS.filter.params.find((q) => q.name === 'cutoff')!;

  it('the pin lands between the two ends in octave space instead of adding to the base', () => {
    expect(rig(0, null)).toBeCloseTo(1200, 6); // no range, no input: the base
    expect(rig(0.5, null)).toBeCloseTo(modulate(cutoff, 1200, 0.5), 3); // the old behaviour
    const lo = paramUnit(cutoff, 200), hi = paramUnit(cutoff, 8000);
    expect(rig(0, [lo, hi])).toBeCloseTo(200, 2);
    expect(rig(1, [lo, hi])).toBeCloseTo(8000, 1);
    expect(rig(0.5, [lo, hi])).toBeCloseTo(Math.sqrt(200 * 8000), 1); // the midpoint in octaves: 1265 Hz, not 4100
    expect(rig(0.5, [lo, hi], 20)).toBeCloseTo(Math.sqrt(200 * 8000), 1); // the base no longer matters
    expect(rig(1, [hi, lo])).toBeCloseTo(200, 2); // ends swapped: the knob goes down
    expect(rig(2, [lo, hi])).toBeCloseTo(8000, 1); // the pin is clamped to 0..1
    expect(rig(1, [lo, hi], 1200, 0.5)).toBeCloseTo(paramValue(cutoff, lo + 0.5 * (hi - lo)), 1); // the attenuverter scales the travel
  });

  it('is kept by validation only on parameters the pin controls, and encodes as the range section', () => {
    const p = emptyPatch();
    addModule(p, DEFS.fm1, 0, 0);
    const f = addModule(p, DEFS.filter, 0, 0);
    f.map!.p1 = ['cutoff'];
    f.range = { p1: { cutoff: [0.2, 0.9], res: [0, 1] }, p2: { cutoff: [0, 1] } };
    const v = validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
    expect(v.modules[1].range).toEqual({ p1: { cutoff: [0.2, 0.9] } }); // res is not a p1 destination, cutoff not a p2 one
    const plain = encodePatch(emptyPatch());
    expect(plain[6]).toBe(0);
    const b = encodePatch(v);
    expect(b[6] & 2).toBe(2);
    const n = b.length;
    expect(Array.from(b.subarray(n - 6))).toEqual([1, 1, 0, 0, Math.round(0.2 * 255), Math.round(0.9 * 255)]); // count, module 1, p1, cutoff (param 0), ends
    delete v.modules[1].range;
    expect(encodePatch(v).length).toBe(n - 6);
  });
});

describe('morph', () => {
  /** saw -> filter -> output, with the cutoff and the wave as the morphed parameters */
  function rig(): { p: Patch; osc: number; flt: number; kb: number } {
    const p = emptyPatch('A');
    const kb = addModule(p, DEFS.fm1, 0, 0);
    const o = addModule(p, DEFS.osc, 0, 0);
    const f = addModule(p, DEFS.filter, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    Object.assign(o.params, { wave: 2, level: 0.5 });
    Object.assign(f.params, { cutoff: 200, res: 0 });
    connect(p, DEFS, { module: kb.id, port: 'pitch' }, { module: o.id, port: 'pitch' });
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: f.id, port: 'in' });
    connect(p, DEFS, { module: f.id, port: 'lp12' }, { module: out.id, port: 'l' });
    return { p, osc: o.id, flt: f.id, kb: kb.id };
  }
  const bright = (a: Float32Array): number => {
    let s = 0;
    for (let i = 1; i < a.length; i++) s += (a[i] - a[i - 1]) ** 2;
    return Math.sqrt(s / a.length) / rms(a);
  };
  const play = (p: Patch): { e: Engine; out: Float32Array } => {
    const e = new Engine(SR);
    e.load(p);
    e.noteOn(48);
    render(e, 4800);
    return { e, out: render(e, SR / 4).l };
  };

  it('structure check, B side from another patch, and the unit-space value between A and B', () => {
    const a = rig();
    const b = rig();
    expect(sameStructure(a.p, b.p)).toBe(true);
    const c = rig();
    addModule(c.p, DEFS.lfo, 0, 0);
    expect(sameStructure(a.p, c.p)).toBe(false);
    b.p.modules.find((m) => m.id === b.flt)!.params.cutoff = 3200;
    b.p.name = 'B';
    setMorphTarget(a.p, b.p, DEFS);
    expect(hasMorph(a.p)).toBe(true);
    expect(a.p.morphName).toBe('B');
    expect(a.p.modules.find((m) => m.id === a.flt)!.paramsB!.cutoff).toBe(3200);
    expect(a.p.modules.find((m) => m.id === a.kb)!.paramsB).toBeUndefined(); // the Main module is not morphed
    const cutoff = DEFS.filter.params.find((q) => q.name === 'cutoff')!;
    expect(morphValue(cutoff, 200, 3200, 0.5)).toBeCloseTo(800, 3); // two octaves of four: in octaves, not Hz
    const wave = DEFS.osc.params.find((q) => q.name === 'wave')!;
    expect(morphValue(wave, 2, 0, 0.49)).toBe(2);
    expect(morphValue(wave, 2, 0, 0.5)).toBe(0);
    expect(() => setMorphTarget(a.p, c.p, DEFS)).toThrow();
    clearMorph(a.p);
    expect(hasMorph(a.p)).toBe(false);
    expect(a.p.morphName).toBeUndefined();
    // the B side survives validation and is dropped when it is not an object
    setMorphTarget(a.p, b.p, DEFS);
    const v = validatePatch(JSON.parse(JSON.stringify(a.p)), DEFS);
    expect(v.modules.find((m) => m.id === a.flt)!.paramsB!.cutoff).toBe(3200);
    (v.modules[2] as { paramsB?: unknown }).paramsB = 'junk';
    expect(validatePatch(JSON.parse(JSON.stringify(v)), DEFS).modules[2].paramsB).toBeUndefined();
  });

  it('the Main morph parameter fades the sound from A to B; the morph input adds to it one block late', () => {
    const a = rig();
    const b = rig();
    b.p.modules.find((m) => m.id === b.flt)!.params.cutoff = 3200;
    setMorphTarget(a.p, b.p, DEFS);
    const at = (t: number): Float32Array => {
      a.p.modules.find((m) => m.id === a.kb)!.params.morph = t;
      return play(a.p).out;
    };
    const b0 = bright(at(0)), b5 = bright(at(0.5)), b1 = bright(at(1));
    expect(b5).toBeGreaterThan(b0 * 1.3);
    expect(b1).toBeGreaterThan(b5 * 1.3);
    // the same patch without a B side ignores the morph parameter
    clearMorph(a.p);
    expect(bright(at(1))).toBeCloseTo(b0, 3);
    // a constant into the Main module's morph input: morph 0 + 1 from the cable = B
    setMorphTarget(a.p, b.p, DEFS);
    a.p.modules.find((m) => m.id === a.kb)!.params.morph = 0;
    const k = addModule(a.p, DEFS.const, 0, 0);
    k.params.value = 1;
    connect(a.p, DEFS, { module: k.id, port: 'out' }, { module: a.kb, port: 'morph' });
    const { e, out } = play(a.p);
    expect(bright(out)).toBeCloseTo(b1, 2);
    expect(e.morph).toBe(1);
    expect(copiesOf(withParts(a.p, 3)).has(a.kb)).toBe(false); // the Main module never runs per part
  });

  it('encodes the B side after the cables with the header flag', () => {
    const a = rig();
    const plain = encodePatch(a.p);
    expect(plain[6]).toBe(0);
    const b = rig();
    setMorphTarget(a.p, b.p, DEFS);
    const withB = encodePatch(a.p);
    expect(withB[6]).toBe(1);
    const npar = a.p.modules.reduce((s, m) => s + DEFS[m.type].params.length, 0);
    expect(withB.length).toBe(plain.length + 4 * npar);
    expect(Array.from(withB.subarray(0, plain.length)).slice(8)).toEqual(Array.from(plain).slice(8)); // the records and cables are untouched
  });
});

describe('reverb', () => {
  /** noise through a VCA (open for a second, then shut) into the reverb at mix 1; returns the rms of 0.25 s windows of the tail in dB */
  function tail(params: Record<string, number>, windows = 8): { level: number; tail: number[] } {
    const p = emptyPatch();
    const nz = addModule(p, DEFS.noise, 0, 0);
    nz.params.level = 0.5;
    const vca = addModule(p, DEFS.vca, 0, 0);
    const k = addModule(p, DEFS.const, 0, 0);
    k.params.value = 1;
    const rv = addModule(p, DEFS.reverb, 0, 0);
    Object.assign(rv.params, { mix: 1, ...params });
    const out = addModule(p, DEFS.output, 0, 0);
    out.params.level = 1;
    connect(p, DEFS, { module: nz.id, port: 'out' }, { module: vca.id, port: 'in' });
    connect(p, DEFS, { module: k.id, port: 'out' }, { module: vca.id, port: 'cv' });
    connect(p, DEFS, { module: vca.id, port: 'out' }, { module: rv.id, port: 'in' });
    connect(p, DEFS, { module: rv.id, port: 'out' }, { module: out.id, port: 'l' });
    const e = new Engine(SR);
    e.load(p);
    const level = rms(render(e, SR).l);
    e.setParam(k.id, 'value', 0);
    const t: number[] = [];
    for (let i = 0; i < windows; i++) t.push(20 * Math.log10(rms(render(e, SR / 4).l) + 1e-9));
    return { level, tail: t };
  }

  it('decays 60 dB in about 0.2 x 2^(5 size) seconds and sits well below the dry level', () => {
    const half = tail({ size: 0.5, damp: 0 }); // T = 1.13 s
    expect(half.level).toBeGreaterThan(0.1);
    expect(half.level).toBeLessThan(0.5);
    const slope = (t: number[], a: number, b: number): number => (t[a] - t[b]) / ((b - a) * 0.25); // dB per second
    expect(slope(half.tail, 1, 3)).toBeGreaterThan(40); // 60 dB / 1.13 s = 53 dB/s
    expect(slope(half.tail, 1, 3)).toBeLessThan(70);
    const long = tail({ size: 1, damp: 0 }); // 6.4 s: 9.4 dB/s
    expect(slope(long.tail, 1, 5)).toBeGreaterThan(6);
    expect(slope(long.tail, 1, 5)).toBeLessThan(14);
    const short = tail({ size: 0, damp: 0 }, 3); // 0.2 s: gone within the second window
    expect(short.tail[2]).toBeLessThan(-80);
  });

  it('damping darkens the tail, the pre-delay moves the onset', () => {
    const p = emptyPatch();
    const pl = addModule(p, DEFS.pulse, 0, 0);
    pl.params.time = 0.001;
    const lfo = addModule(p, DEFS.lfo, 0, 0);
    Object.assign(lfo.params, { wave: 3, rate: 0.5, depth: 1 }); // one trigger at sample 0
    const rv = addModule(p, DEFS.reverb, 0, 0);
    Object.assign(rv.params, { mix: 1, size: 0.5, damp: 0, pre: 0 });
    const out = addModule(p, DEFS.output, 0, 0);
    out.params.level = 1;
    connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: pl.id, port: 'trig' });
    connect(p, DEFS, { module: pl.id, port: 'out' }, { module: rv.id, port: 'in' });
    connect(p, DEFS, { module: rv.id, port: 'out' }, { module: out.id, port: 'l' });
    const first = (a: Float32Array): number => a.findIndex((v) => Math.abs(v) > 1e-4);
    const run = (params: Record<string, number>): Float32Array => {
      Object.assign(rv.params, params);
      const e = new Engine(SR);
      e.load(p);
      return render(e, SR).l;
    };
    const dry = run({ pre: 0 });
    const onset = first(dry);
    expect(onset).toBeGreaterThan(0); // the diffusers come first
    expect(first(run({ pre: 20 })) - onset).toBeCloseTo(0.02 * SR, -1); // 20 ms later, within 5 samples
    const bright = (a: Float32Array): number => {
      let s = 0;
      for (let i = 1; i < a.length; i++) s += (a[i] - a[i - 1]) ** 2;
      return Math.sqrt(s / a.length) / rms(a);
    };
    expect(bright(run({ damp: 1 }))).toBeLessThan(bright(run({ damp: 0 })) * 0.7);
  });
});

describe('unison', () => {
  function rig(params: Record<string, number>, frames = SR): Float32Array {
    const e = new Engine(SR);
    const p = emptyPatch();
    addModule(p, DEFS.fm1, 0, 0);
    const o = addModule(p, DEFS.osc, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    out.params.level = 0.7;
    Object.assign(o.params, { wave: 2, level: 1, ...params });
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: out.id, port: 'l' });
    e.load(p);
    return render(e, frames).l;
  }
  const windows = (a: Float32Array, w: number): number[] => {
    const r: number[] = [];
    for (let i = 0; i + w <= a.length; i += w) r.push(rms(a.subarray(i, i + w)));
    return r;
  };

  it('with no detune n copies sum to the single oscillator', () => {
    const one = rig({ unison: 1 });
    const three = rig({ unison: 3, detune: 0 });
    for (let i = 0; i < one.length; i += 97) expect(three[i]).toBeCloseTo(one[i], 5);
  });

  it('detuned copies beat: the level rises and falls, the peak stays at the level', () => {
    const two = rig({ unison: 2, detune: 30 }, SR * 2);
    const w = windows(two, 1200);
    expect(Math.max(...w) - Math.min(...w)).toBeGreaterThan(0.1);
    expect(Math.max(...two.map(Math.abs))).toBeLessThanOrEqual(1.0001);
    const one = windows(rig({ unison: 1 }, SR * 2), 1200);
    expect(Math.max(...one) - Math.min(...one)).toBeLessThan(0.05); // (the windows are not whole periods)
  });

  it('a sync edge restarts every copy', () => {
    const e = new Engine(SR);
    const p = emptyPatch();
    addModule(p, DEFS.fm1, 0, 0);
    const o = addModule(p, DEFS.osc, 0, 0);
    const l = addModule(p, DEFS.lfo, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    Object.assign(o.params, { wave: 2, level: 1, unison: 3, detune: 50 });
    Object.assign(l.params, { wave: 3, rate: 20, depth: 1 });
    connect(p, DEFS, { module: l.id, port: 'out' }, { module: o.id, port: 'sync' });
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: out.id, port: 'l' });
    e.load(p);
    const a = render(e, SR).l;
    const period = SR / 20;
    let same = 0;
    for (let k = 2; k < 18; k++) same += Math.abs(a[k * period + 5] - a[(k + 1) * period + 5]) < 0.02 ? 1 : 0; // every sync cycle starts alike
    expect(same).toBeGreaterThan(12);
  });
});

describe('compressor', () => {
  /** sine at `amp` -> dyn -> output left (or its env output); a silent sidechain when `side` */
  function rig(params: Record<string, number>, amp: number, port = 'out', side = false): Float32Array {
    const e = new Engine(SR);
    const p = emptyPatch();
    addModule(p, DEFS.fm1, 0, 0);
    const o = addModule(p, DEFS.osc, 0, 0);
    const d = addModule(p, DEFS.dyn, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    Object.assign(o.params, { wave: 0, level: amp });
    out.params.level = 1;
    Object.assign(d.params, { thresh: -20, ratio: 4, attack: 0.005, release: 0.05, gain: 0, ...params });
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: d.id, port: 'in' });
    if (side) {
      const k = addModule(p, DEFS.const, 0, 0);
      k.params.value = 0;
      connect(p, DEFS, { module: k.id, port: 'out' }, { module: d.id, port: 'side' });
    }
    connect(p, DEFS, { module: d.id, port }, { module: out.id, port: 'l' });
    e.load(p);
    render(e, 9600);
    return render(e, 4800).l;
  }
  const db = (x: number): number => 20 * Math.log10(x);

  it('leaves a signal below the threshold alone and compresses one above it by the ratio', () => {
    const quiet = rig({}, 0.05);
    expect(rms(quiet)).toBeCloseTo(0.05 / Math.SQRT2, 3);
    const loud = rig({}, 0.5); // -6 dB; the follower sits a little under the peak, so 11..13 dB over: 8..10 dB of reduction at 4:1
    expect(db(rms(loud) / (0.5 / Math.SQRT2))).toBeGreaterThan(-12);
    expect(db(rms(loud) / (0.5 / Math.SQRT2))).toBeLessThan(-6);
    expect(rms(rig({ ratio: 1 }, 0.5))).toBeCloseTo(0.5 / Math.SQRT2, 3);
  });

  it('the env output follows the peak, makeup gain raises the output, a silent sidechain stops the compression', () => {
    const env = rig({}, 0.5, 'env'); // a one-pole peak follower: it rides a little under the peak and ripples
    expect(Math.min(...env)).toBeGreaterThan(0.25);
    expect(Math.max(...env)).toBeLessThan(0.55);
    expect(env.reduce((a, b) => a + b, 0) / env.length).toBeGreaterThan(0.3);
    expect(rms(rig({ gain: 6 }, 0.05))).toBeCloseTo((0.05 / Math.SQRT2) * 2, 2);
    expect(rms(rig({}, 0.5, 'out', true))).toBeCloseTo(0.5 / Math.SQRT2, 3);
  });
});

describe('math and logic', () => {
  /** two constants into the module, one output to the left channel */
  function rig(type: 'math' | 'logic', a: number, b: number, port: string, params: Record<string, number> = {}): number {
    const e = new Engine(SR);
    const p = emptyPatch();
    addModule(p, DEFS.fm1, 0, 0);
    const ca = addModule(p, DEFS.const, 0, 0);
    const cb = addModule(p, DEFS.const, 0, 0);
    const m = addModule(p, DEFS[type], 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    ca.params.value = a;
    cb.params.value = b;
    out.params.level = 1;
    Object.assign(m.params, params);
    connect(p, DEFS, { module: ca.id, port: 'out' }, { module: m.id, port: 'a' });
    connect(p, DEFS, { module: cb.id, port: 'out' }, { module: m.id, port: 'b' });
    connect(p, DEFS, { module: m.id, port }, { module: out.id, port: 'l' });
    e.load(p);
    const l = render(e, 256).l;
    return l[200];
  }

  it('math: add, sub, mul, min, max, abs, cmp with the scales and the offset', () => {
    expect(rig('math', 0.3, 0.2, 'add')).toBeCloseTo(0.5, 5);
    expect(rig('math', 0.3, 0.2, 'sub')).toBeCloseTo(0.1, 5);
    expect(rig('math', 0.5, 0.5, 'mul')).toBeCloseTo(0.25, 5);
    expect(rig('math', -0.4, 0.2, 'min')).toBeCloseTo(-0.4, 5);
    expect(rig('math', -0.4, 0.2, 'max')).toBeCloseTo(0.2, 5);
    expect(rig('math', -0.4, 0.2, 'abs')).toBeCloseTo(0.4, 5);
    expect(rig('math', 0.3, 0.2, 'cmp')).toBe(1);
    expect(rig('math', 0.1, 0.2, 'cmp')).toBe(0);
    expect(rig('math', 0.1, 0.2, 'add', { ka: 2, kb: -1, off: 0.5 })).toBeCloseTo(0.5, 5); // 0.2 + 0.5 - 0.2
  });

  it('logic: and, or, xor, not at the threshold', () => {
    expect(rig('logic', 1, 1, 'and')).toBe(1);
    expect(rig('logic', 1, 0, 'and')).toBe(0);
    expect(rig('logic', 1, 0, 'or')).toBe(1);
    expect(rig('logic', 0, 0, 'or')).toBe(0);
    expect(rig('logic', 1, 1, 'xor')).toBe(0);
    expect(rig('logic', 0, 1, 'xor')).toBe(1);
    expect(rig('logic', 0, 0, 'not')).toBe(1);
    expect(rig('logic', 0.3, 0, 'not', { thresh: 0.2 })).toBe(0);
  });
});

describe('granular', () => {
  /** sine -> grain -> output; returns the engine and the grain module id */
  function rig(params: Record<string, number>, level = 0.5): { e: Engine; id: number; osc: number } {
    const e = new Engine(SR);
    const p = emptyPatch();
    addModule(p, DEFS.fm1, 0, 0);
    const o = addModule(p, DEFS.osc, 0, 0);
    const g = addModule(p, DEFS.grain, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    Object.assign(o.params, { wave: 0, level });
    out.params.level = 1;
    Object.assign(g.params, { mix: 1, density: 40, size: 0.1, spray: 0, position: 0.2, ...params });
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: g.id, port: 'in' });
    connect(p, DEFS, { module: g.id, port: 'out' }, { module: out.id, port: 'l' });
    e.load(p);
    return { e, id: g.id, osc: o.id };
  }

  it('plays grains of the recorded sine at its pitch, an octave up with pitch 12', () => {
    const { e } = rig({});
    render(e, SR);
    const a = render(e, SR).l;
    expect(rms(a)).toBeGreaterThan(0.05);
    expect(Math.abs(freq(a) - 261.6)).toBeLessThan(40);
    const { e: e2 } = rig({ pitch: 12 });
    render(e2, SR);
    expect(Math.abs(freq(render(e2, SR).l) - 523.2)).toBeLessThan(80);
  });

  it('is shared: it runs once inside a poly assembly', () => {
    const p = emptyPatch();
    const kb = addModule(p, DEFS.fm1, 0, 0);
    const o = addModule(p, DEFS.osc, 0, 0);
    const g = addModule(p, DEFS.grain, 0, 0);
    connect(p, DEFS, { module: kb.id, port: 'pitch' }, { module: o.id, port: 'pitch' });
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: g.id, port: 'in' });
    const q = withParts(p, 4);
    expect(copiesOf(q).get(o.id)).toBe(4);
    expect(copiesOf(q).get(g.id)).toBeUndefined();
  });

  it('freeze keeps playing the buffer after the input stops, mix 0 passes the input', () => {
    const { e, id, osc } = rig({ spray: 0.3 }); // (without spray the frozen grains all read the same segment and can cancel)
    render(e, SR);
    e.setParam(id, 'freeze', 1);
    e.setParam(osc, 'level', 0);
    render(e, SR);
    expect(rms(render(e, SR).l)).toBeGreaterThan(0.05);
    const { e: e2, osc: osc2 } = rig({});
    render(e2, SR);
    e2.setParam(osc2, 'level', 0);
    render(e2, SR * 2);
    expect(rms(render(e2, SR).l)).toBeLessThan(1e-4); // without freeze the silence has rolled through the buffer
    const { e: e3 } = rig({ mix: 0 });
    render(e3, SR);
    expect(rms(render(e3, SR).l)).toBeCloseTo(0.5 / Math.SQRT2, 3);
  });
});

describe('comb and modal', () => {
  it('comb: positive feedback rings at the pitch, mix 0 passes the input', () => {
    const run = (params: Record<string, number>): { out: Float32Array; inp: Float32Array } => {
      const e = new Engine(SR);
      const p = emptyPatch();
      addModule(p, DEFS.fm1, 0, 0);
      const nz = addModule(p, DEFS.noise, 0, 0);
      const cb = addModule(p, DEFS.comb, 0, 0);
      const out = addModule(p, DEFS.output, 0, 0);
      nz.params.level = 0.2;
      out.params.level = 1;
      Object.assign(cb.params, params);
      connect(p, DEFS, { module: nz.id, port: 'out' }, { module: cb.id, port: 'in' });
      connect(p, DEFS, { module: cb.id, port: 'out' }, { module: out.id, port: 'l' });
      connect(p, DEFS, { module: nz.id, port: 'out' }, { module: out.id, port: 'r' });
      e.load(p);
      render(e, 4800);
      const r = render(e, SR);
      return { out: r.l, inp: r.r };
    };
    const power = (a: Float32Array, f: number): number => {
      let re = 0, im = 0;
      for (let i = 0; i < a.length; i++) {
        re += a[i] * Math.cos((2 * Math.PI * f * i) / SR);
        im += a[i] * Math.sin((2 * Math.PI * f * i) / SR);
      }
      return re * re + im * im;
    };
    const ring = run({ fb: 0.95, damp: 0.3, mix: 1, coarse: 12 });
    expect(rms(ring.out)).toBeGreaterThan(rms(ring.inp) * 1.3);
    expect(power(ring.out, 523.2) / power(ring.out, 523.2 * 1.5)).toBeGreaterThan(5); // a peak at the pitch, a dip between its harmonics
    const dry = run({ fb: 0.95, mix: 0 });
    expect(rms(dry.out)).toBeCloseTo(rms(dry.inp), 6);
  });

  it('modal: a burst rings at the pitch and dies away in about the decay time', () => {
    const run = (params: Record<string, number>): Float32Array => {
      const e = new Engine(SR);
      const p = emptyPatch();
      const kb = addModule(p, DEFS.fm1, 0, 0);
      const pl = addModule(p, DEFS.pulse, 0, 0);
      const md = addModule(p, DEFS.modal, 0, 0);
      const out = addModule(p, DEFS.output, 0, 0);
      pl.params.time = 0.001;
      out.params.level = 1;
      Object.assign(md.params, { struct: 0, bright: 0, damp: 0.5, ...params });
      connect(p, DEFS, { module: kb.id, port: 'gate' }, { module: pl.id, port: 'trig' });
      connect(p, DEFS, { module: pl.id, port: 'out' }, { module: md.id, port: 'in' });
      connect(p, DEFS, { module: kb.id, port: 'pitch' }, { module: md.id, port: 'pitch' });
      connect(p, DEFS, { module: md.id, port: 'out' }, { module: out.id, port: 'l' });
      e.load(p);
      e.noteOn(69);
      return render(e, SR * 2).l;
    };
    const a = run({ decay: 1 });
    const first = a.subarray(2400, SR / 2), second = a.subarray(SR, SR + SR / 2);
    expect(rms(first)).toBeGreaterThan(0.01);
    expect(Math.abs(freq(first) - 440)).toBeLessThan(30);
    expect(rms(second)).toBeLessThan(rms(first) * 0.2);
    expect(rms(second)).toBeGreaterThan(rms(first) * 0.003);
    const b = run({ decay: 0.1 });
    expect(rms(b.subarray(SR, SR + SR / 2))).toBeLessThan(rms(second) * 0.01);
  });
});

describe('bend, mod wheel, aftertouch, cc', () => {
  function rig(port: string): { e: Engine; out: () => number; kb: number } {
    const e = new Engine(SR);
    const p = emptyPatch();
    const kb = addModule(p, DEFS.fm1, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    out.params.level = 1;
    connect(p, DEFS, { module: kb.id, port }, { module: out.id, port: 'l' });
    e.load(p);
    return { e, out: () => render(e, 128).l[100], kb: kb.id };
  }

  it('bend moves the pitch output by up to two semitones and shows on the bend output', () => {
    const { e, out } = rig('pitch'); // (middle C: the engine clamps its output to +-1, so a high note would hide the bend)
    e.noteOn(60);
    expect(out()).toBeCloseTo(0, 6);
    e.bend(1);
    expect(out()).toBeCloseTo(2 / 12, 6);
    e.bend(-0.5);
    expect(out()).toBeCloseTo(-1 / 12, 6);
    const b = rig('bend');
    b.e.bend(0.25);
    expect(b.out()).toBeCloseTo(0.25, 6);
  });

  it('cc 1 is the mod output, aftertouch the at output, cc 16..19 turn the knobs', () => {
    const m = rig('mod');
    m.e.cc(1, 127);
    expect(m.out()).toBeCloseTo(1, 6);
    const a = rig('at');
    a.e.aftertouch(0.5);
    expect(a.out()).toBeCloseTo(0.5, 6);
    const k = rig('k3');
    expect(k.out()).toBeCloseTo(0.5, 6);
    k.e.cc(18, 0);
    expect(k.out()).toBeCloseTo(0, 6);
    k.e.cc(74, 127); // an unmapped CC does nothing
    expect(k.out()).toBeCloseTo(0, 6);
  });
});

describe('frequency shifter', () => {
  function rig(params: Record<string, number>, port: 'up' | 'down'): Float32Array {
    const e = new Engine(SR);
    const p = emptyPatch();
    addModule(p, DEFS.fm1, 0, 0);
    const o = addModule(p, DEFS.osc, 0, 0);
    const sh = addModule(p, DEFS.shift, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    Object.assign(o.params, { wave: 0, level: 0.5, coarse: 9 }); // A4, 440 Hz
    out.params.level = 1;
    Object.assign(sh.params, params);
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: sh.id, port: 'in' });
    connect(p, DEFS, { module: sh.id, port }, { module: out.id, port: 'l' });
    e.load(p);
    render(e, 4800);
    return render(e, SR).l;
  }

  it('moves a 440 Hz sine up and down by the shift, with the level kept', () => {
    const up = rig({ shift: 100, mix: 1 }, 'up');
    const down = rig({ shift: 100, mix: 1 }, 'down');
    expect(Math.abs(freq(up) - 540)).toBeLessThan(12);
    expect(Math.abs(freq(down) - 340)).toBeLessThan(12);
    expect(rms(up)).toBeCloseTo(0.5 / Math.SQRT2, 2);
    expect(Math.abs(freq(rig({ shift: -100, mix: 1 }, 'up')) - 340)).toBeLessThan(12);
    expect(Math.abs(freq(rig({ shift: 0, mix: 0 }, 'up')) - 440)).toBeLessThan(5);
  });
});

describe('bypass', () => {
  /** osc (440 Hz saw) -> filter at 100 Hz -> output; the filter's bypass flag as given */
  function rig(bypass: boolean, live?: boolean): { e: Engine; p: Patch; f: number } {
    const e = new Engine(SR);
    const p = emptyPatch();
    addModule(p, DEFS.fm1, 0, 0);
    const o = addModule(p, DEFS.osc, 0, 0);
    const f = addModule(p, DEFS.filter, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    Object.assign(o.params, { wave: 2, level: 0.5, coarse: 9 });
    Object.assign(f.params, { cutoff: 100, res: 0 });
    out.params.level = 1;
    if (bypass && !live) f.bypass = true;
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: f.id, port: 'in' });
    connect(p, DEFS, { module: f.id, port: 'lp24' }, { module: out.id, port: 'l' });
    e.load(p);
    if (bypass && live) e.setBypass(f.id, true);
    return { e, p, f: f.id };
  }

  it('passes the input to every output of a bypassed processor and keeps its state', () => {
    const on = rig(false);
    render(on.e, 4800);
    expect(rms(render(on.e, SR).l)).toBeLessThan(0.1); // a 440 Hz saw through a 100 Hz low pass
    const off = rig(true);
    render(off.e, 4800);
    const dry = render(off.e, SR).l;
    expect(rms(dry)).toBeCloseTo(0.5 / Math.sqrt(3), 1); // the saw itself
    expect(Math.abs(freq(dry) - 440)).toBeLessThan(5);
    const live = rig(true, true); // the live switch does the same
    render(live.e, 4800);
    expect(rms(render(live.e, SR).l)).toBeCloseTo(0.5 / Math.sqrt(3), 1);
    live.e.setBypass(live.f, false); // back on: the filter resumes
    render(live.e, 4800);
    expect(rms(render(live.e, SR).l)).toBeLessThan(0.1);
  });

  it('mutes a bypassed source and copies the through input to both outputs of a pan', () => {
    const e = new Engine(SR);
    const p = emptyPatch();
    addModule(p, DEFS.fm1, 0, 0);
    const o = addModule(p, DEFS.osc, 0, 0);
    const lfo = addModule(p, DEFS.lfo, 0, 0);
    const pan = addModule(p, DEFS.pan, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    Object.assign(o.params, { wave: 0, level: 0.5 });
    Object.assign(lfo.params, { wave: 1, rate: 3, depth: 1 });
    pan.params.pan = 1; // hard right when it runs
    out.params.level = 1;
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: pan.id, port: 'in' });
    connect(p, DEFS, { module: lfo.id, port: 'out' }, { module: pan.id, port: 'pos' });
    connect(p, DEFS, { module: pan.id, port: 'l' }, { module: out.id, port: 'l' });
    connect(p, DEFS, { module: pan.id, port: 'r' }, { module: out.id, port: 'r' });
    e.load(p);
    render(e, 4800);
    const a = render(e, SR);
    expect(rms(a.l)).toBeLessThan(rms(a.r)); // panned right, swinging with the LFO
    lfo.bypass = true;
    pan.bypass = true;
    e.load(p);
    render(e, 4800);
    const b = render(e, SR);
    expect(rms(b.l)).toBeCloseTo(0.5 / Math.SQRT2, 2); // the sine on both sides, untouched
    expect(rms(b.r)).toBeCloseTo(0.5 / Math.SQRT2, 2);
    for (let i = 0; i < 100; i++) expect(b.l[i]).toBe(b.r[i]);
    pan.bypass = false; // the pan runs again, its pos input is silent: hard right
    e.load(p);
    render(e, 4800);
    const c = render(e, SR);
    expect(rms(c.l)).toBeLessThan(0.01);
    expect(rms(c.r)).toBeCloseTo(0.5 / Math.SQRT2, 2);
  });

  it('is validated, encoded in the type byte and refused on the panel and the output', () => {
    const { p } = rig(true);
    const mods = p.modules.map((m) => ({ ...m }));
    mods[0].bypass = true; // fm1
    mods[3].bypass = true; // output
    const v = validatePatch({ ...p, modules: mods }, DEFS);
    expect(v.modules.map((m) => !!m.bypass)).toEqual([false, false, true, false]);
    const b = encodePatch(v);
    const at = 8 + recordSize('fm1') + recordSize('osc');
    expect(b[at]).toBe(DEFS.filter ? (Object.keys(DEFS).indexOf('filter') | 0x80) : -1);
    expect(b[8] & 0x80).toBe(0);
  });
});

describe('ladder filter', () => {
  /** noise -> ladder -> output left, taken from the given output */
  function rig(port: string, params: Record<string, number>, note?: number, level = 0.3): Float32Array {
    const e = new Engine(SR);
    const p = emptyPatch();
    addModule(p, DEFS.fm1, 0, 0);
    const n = addModule(p, DEFS.noise, 0, 0);
    n.params.level = level;
    const f = addModule(p, DEFS.ladder, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    Object.assign(f.params, { res: 0, ...params });
    connect(p, DEFS, { module: n.id, port: 'out' }, { module: f.id, port: 'in' });
    connect(p, DEFS, { module: f.id, port: port }, { module: out.id, port: 'l' });
    e.load(p);
    if (note !== undefined) e.noteOn(note);
    render(e, 4800);
    return render(e, SR).l;
  }
  const highs = (a: Float32Array): number => rms(a.slice(2).map((v, i) => v - 2 * a[i + 1] + a[i]));

  it('is a 24 dB low pass at lp24 and a 12 dB one at lp12', () => {
    const lp12 = highs(rig('lp12', { cutoff: 500 }));
    const lp24 = highs(rig('lp24', { cutoff: 500 }));
    expect(lp12).toBeGreaterThan(1e-5);
    expect(lp24).toBeLessThan(lp12 * 0.3);
  });

  it('rings at the cutoff with full resonance and stays within +-1', () => {
    const flat = rig('lp24', { cutoff: 1000, res: 0 });
    const ring = rig('lp24', { cutoff: 1000, res: 1 });
    expect(rms(ring)).toBeGreaterThan(rms(flat) * 2);
    expect(Math.abs(freq(ring) - 1000)).toBeLessThan(250);
    expect(Math.max(...ring.map(Math.abs))).toBeLessThanOrEqual(1);
  });

  it('drive makes it louder and the saturator keeps the peak at 1', () => {
    const soft = rig('lp24', { cutoff: 2000, drive: 1 }, undefined, 0.6);
    const hot = rig('lp24', { cutoff: 2000, drive: 8 }, undefined, 0.6);
    expect(rms(hot)).toBeGreaterThan(rms(soft) * 1.5);
    expect(Math.max(...hot.map(Math.abs))).toBeLessThanOrEqual(1);
  });

  it('key tracking moves the cutoff with the pitch of the played note', () => {
    const off = rms(rig('lp24', { cutoff: 300, track: 0 }, 84));
    const on = rms(rig('lp24', { cutoff: 300, track: 1 }, 84));
    expect(on).toBeGreaterThan(off * 1.5);
    expect(rms(rig('lp24', { cutoff: 300, track: 1 }, 60))).toBeCloseTo(rms(rig('lp24', { cutoff: 300, track: 0 }, 60)), 6);
  });
});

describe('polyphony', () => {
  /** panel -> osc -> filter -> vca (adsr) -> delay -> output, plus a free LFO into the filter's p1 and an LFO driven by the envelope */
  function polyPatch(parts: number, cfg: Partial<PolyCfg> = {}): { p: Patch; ids: Record<string, number> } {
    const p = emptyPatch('poly');
    const kb = addModule(p, DEFS.fm1, 0, 0);
    const osc = addModule(p, DEFS.osc, 0, 0);
    const flt = addModule(p, DEFS.filter, 0, 0);
    const env = addModule(p, DEFS.adsr, 0, 0);
    const vca = addModule(p, DEFS.vca, 0, 0);
    const dly = addModule(p, DEFS.delay, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    const lfo = addModule(p, DEFS.lfo, 0, 0);
    const lfo2 = addModule(p, DEFS.lfo, 0, 0);
    Object.assign(env.params, { a: 0.001, d: 0.3, s: 0.5, r: 0.1 });
    Object.assign(flt.params, { cutoff: 800, res: 0.2 });
    Object.assign(dly.params, { mix: 0.3, time: 50, fb: 0.2 });
    const w = (a: number, ap: string, b: number, bp: string) => expect(connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })).toBe(true);
    w(kb.id, 'pitch', osc.id, 'pitch');
    w(kb.id, 'gate', env.id, 'gate');
    w(osc.id, 'out', flt.id, 'in');
    w(flt.id, 'lp12', vca.id, 'in');
    w(env.id, 'env', vca.id, 'cv');
    w(vca.id, 'out', dly.id, 'in');
    w(dly.id, 'out', out.id, 'l');
    w(lfo.id, 'out', flt.id, 'p1');
    w(env.id, 'env', lfo2.id, 'p1');
    const q = withParts(p, parts, cfg);
    const part = q.modules.find((m) => m.type === 'part');
    return { p: q, ids: { kb: kb.id, osc: osc.id, flt: flt.id, env: env.id, vca: vca.id, dly: dly.id, out: out.id, lfo: lfo.id, lfo2: lfo2.id, part: part?.id ?? -1 } };
  }

  it('converts an old patch with voices: what heard pitch / gate / vel goes into a poly assembly with a Part; delay / output and free modules stay outside', () => {
    const { p, ids } = polyPatch(4);
    const [g] = polyGroups(p);
    expect(g.cfg).toMatchObject({ parts: 4, assign: 2 });
    expect([...g.modules].sort()).toEqual([ids.osc, ids.flt, ids.env, ids.vca, ids.lfo2, ids.part].sort());
    expect(p.cables.some((c) => c.from.module === ids.part && c.from.port === 'pitch' && c.to.module === ids.osc)).toBe(true);
    expect(p.cables.some((c) => c.from.module === ids.kb && c.to.module === ids.osc)).toBe(false);
    expect('voices' in p).toBe(false);
    expect(polyGroups(polyPatch(1).p)).toHaveLength(0); // one voice: nothing to convert
  });

  it('a one-part poly assembly plays like the patch without one (mono, legato auto)', () => {
    const a = new Engine(SR);
    const b = new Engine(SR);
    const mono = polyPatch(1).p;
    const one = polyPatch(2).p;
    polyCfg(one).parts = 1;
    a.load(mono);
    b.load(one);
    for (const e of [a, b]) {
      e.noteOn(60);
      e.noteOn(67);
    }
    const x = render(a, 4096).l;
    const y = render(b, 4096).l;
    expect(rms(x)).toBeGreaterThan(0.01);
    expect(y).toEqual(x);
  });

  it('two parts sound both notes: the output is the sum of the two mono notes', () => {
    const build = (): Patch => {
      const p = emptyPatch();
      const kb = addModule(p, DEFS.fm1, 0, 0);
      const o = addModule(p, DEFS.osc, 0, 0);
      const out = addModule(p, DEFS.output, 0, 0);
      o.params.level = 0.3;
      connect(p, DEFS, { module: kb.id, port: 'pitch' }, { module: o.id, port: 'pitch' });
      connect(p, DEFS, { module: o.id, port: 'out' }, { module: out.id, port: 'l' });
      return p;
    };
    const mono = (note: number): Float32Array => {
      const e = new Engine(SR);
      e.load(build());
      e.noteOn(note);
      return render(e, 2048).l;
    };
    const e = new Engine(SR);
    e.load(withParts(build(), 2));
    e.noteOn(60);
    e.noteOn(67);
    const both = render(e, 2048).l;
    const a = mono(60);
    const b = mono(67);
    for (let i = 0; i < both.length; i += 7) expect(both[i]).toBeCloseTo(a[i] + b[i], 5);
    expect(rms(both)).toBeGreaterThan(rms(a));
  });

  it('assign reuse: a free part first (the one that played the key, else the longest free), then the oldest is taken over; note off frees', () => {
    const e = new Engine(SR);
    e.load(polyPatch(3).p);
    e.noteOn(60);
    e.noteOn(62);
    e.noteOn(64);
    expect(e.voiceNotes().map((v) => v.note)).toEqual([60, 62, 64]);
    e.noteOn(65); // all busy: the oldest (60) goes
    expect(e.voiceNotes().map((v) => v.note)).toEqual([65, 62, 64]);
    e.noteOff(64);
    e.noteOff(62);
    expect(e.voiceNotes().map((v) => v.on)).toEqual([true, false, false]);
    e.noteOn(67); // 64 was freed first: its part is taken first
    expect(e.voiceNotes().map((v) => v.note)).toEqual([65, 62, 67]);
    e.noteOn(65); // the same key again stays on its part
    expect(e.voiceNotes().map((v) => v.note)).toEqual([65, 62, 67]);
    e.noteOff(65);
    e.noteOn(62); // its key played on part 1, which is free
    expect(e.voiceNotes().map((v) => v.note)).toEqual([65, 62, 67]);
    e.allNotesOff();
    expect(e.voiceNotes().every((v) => !v.on)).toBe(true);
    expect(e.nvoices).toBe(3);
  });

  it('assign rotate takes the next part in turn, lowest the lowest free one', () => {
    const rot = new Engine(SR);
    rot.load(polyPatch(3, { assign: 0 }).p);
    for (const n of [60, 61, 62, 63]) {
      rot.noteOn(n);
      rot.noteOff(n);
    }
    expect(rot.voiceNotes().map((v) => v.note)).toEqual([63, 61, 62]); // 60 on part 0, 61 on 1, 62 on 2, 63 back on 0
    const low = new Engine(SR);
    low.load(polyPatch(3, { assign: 1 }).p);
    for (const n of [60, 61, 62]) {
      low.noteOn(n);
      low.noteOff(n);
    }
    expect(low.voiceNotes().map((v) => v.note)).toEqual([62, -1, -1]);
  });

  it('priority low / high: with every part busy a key only takes over a higher / lower note', () => {
    const lo = new Engine(SR);
    lo.load(polyPatch(2, { priority: 1 }).p);
    lo.noteOn(60);
    lo.noteOn(64);
    lo.noteOn(67); // higher than both: does not sound
    expect(lo.voiceNotes().map((v) => v.note)).toEqual([60, 64]);
    lo.noteOn(55); // lower: takes over the highest (64)
    expect(lo.voiceNotes().map((v) => v.note)).toEqual([60, 55]);
    const hi = new Engine(SR);
    hi.load(polyPatch(2, { priority: 2 }).p);
    hi.noteOn(60);
    hi.noteOn(64);
    hi.noteOn(55);
    expect(hi.voiceNotes().map((v) => v.note)).toEqual([60, 64]);
    hi.noteOn(67); // higher: takes over the lowest (60)
    expect(hi.voiceNotes().map((v) => v.note)).toEqual([67, 64]);
  });

  it('a chord through the shared delay and output is finite and louder than one note; released notes fade', () => {
    const e = new Engine(SR);
    e.load(polyPatch(4).p);
    e.noteOn(48);
    render(e, 4800);
    const one = rms(render(e, 4800).l);
    e.noteOn(55);
    e.noteOn(60);
    e.noteOn(64);
    render(e, 4800);
    const { l } = render(e, 4800);
    expect(l.every(Number.isFinite)).toBe(true);
    expect(rms(l)).toBeGreaterThan(one * 1.3);
    for (const n of [48, 55, 60, 64]) e.noteOff(n);
    render(e, SR * 2);
    expect(rms(render(e, 4800).l)).toBeLessThan(1e-3);
  });

  it('keeps the parts sounding when the patch is edited, and resets them when the part count changes', () => {
    const e = new Engine(SR);
    const { p, ids } = polyPatch(4);
    e.load(p);
    e.noteOn(60);
    e.noteOn(64);
    render(e, 4800);
    const before = rms(render(e, 1200).l);
    p.modules.find((m) => m.id === ids.osc)!.params.level = 0.6;
    e.load(p);
    expect(rms(render(e, 1200).l)).toBeGreaterThan(before * 0.3);
    expect(e.voiceNotes().filter((v) => v.on)).toHaveLength(2);
    polyCfg(p).parts = 2;
    e.load(p);
    expect(e.nvoices).toBe(2);
    expect(e.voiceNotes().every((v) => !v.on)).toBe(true);
  });

  it('a patch file carries the poly settings and they survive validation, clamped', () => {
    const { p } = polyPatch(6);
    const q = validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
    fixAssemblies(q, DEFS);
    expect(polyCfg(q)).toEqual(polyCfg(p));
    const raw = JSON.parse(JSON.stringify(p));
    raw.assemblies.find((a: { poly?: unknown }) => a.poly).poly = { parts: 99, assign: 7, legato: -1, priority: 'x', unit: 64 };
    const r = validatePatch(raw, DEFS);
    fixAssemblies(r, DEFS);
    expect(polyCfg(r)).toEqual({ parts: 8, assign: 2, legato: 0, priority: 0, unit: 63 });
  });

  it('two poly assemblies layer: each plays every note on its own parts; a cable out of one sums its parts', () => {
    const p = emptyPatch();
    const out = addModule(p, DEFS.output, 0, 0);
    out.params.level = 1;
    const voice = (level: number): number => {
      const part = addModule(p, DEFS.part, 0, 0);
      const o = addModule(p, DEFS.osc, 0, 0);
      o.params.level = level;
      connect(p, DEFS, { module: part.id, port: 'pitch' }, { module: o.id, port: 'pitch' });
      connect(p, DEFS, { module: o.id, port: 'out' }, { module: out.id, port: 'l' });
      makeAssembly(p, [part.id, o.id], 'v').poly = { ...POLY_DEFAULT, parts: 2 };
      return o.id;
    };
    voice(0.2);
    voice(0.1);
    expect(polyGroups(p).map((g) => g.cfg.parts)).toEqual([2, 2]);
    const e = new Engine(SR);
    e.load(p);
    e.noteOn(60);
    e.noteOn(67);
    const l = render(e, 2048).l;
    expect(Math.max(...l.map(Math.abs))).toBeGreaterThan(0.45); // two notes at 0.2 and two at 0.1 summed
    expect(Math.max(...l.map(Math.abs))).toBeLessThanOrEqual(0.6 + 1e-6);
  });
});

describe('Part and Random', () => {
  it('Part: index is -1..1 across the parts (0 with one), legato and jump per part', () => {
    const p = emptyPatch();
    const part = addModule(p, DEFS.part, 0, 0);
    makeAssembly(p, [part.id], 'v').poly = { ...POLY_DEFAULT, parts: 3, assign: 1 };
    const e = new Engine(SR);
    e.load(p);
    e.noteOn(60);
    e.noteOn(72);
    render(e, BLOCK);
    const out = (port: string, v: number): number => (e as unknown as { nodes: Map<number, { inst: { out: Record<string, Float32Array> }[] }> }).nodes.get(part.id)!.inst[v].out[port][0];
    expect([0, 1, 2].map((v) => out('index', v))).toEqual([-1, 0, 1]);
    expect(out('legato', 0)).toBe(0);
    expect(out('legato', 1)).toBe(1); // 72 began over the held 60
    expect(out('jump', 1)).toBeCloseTo(1, 6); // from C4 up an octave
    expect(out('pitch', 1)).toBeCloseTo(1, 6);
  });

  it('Random fixed: a value per part that differs between parts and units and never moves; walk wanders within -1..1', () => {
    const build = (mode: number, unit: number): { e: Engine; id: number } => {
      const p = emptyPatch();
      const r = addModule(p, DEFS.random, 0, 0);
      r.params.mode = mode;
      makeAssembly(p, [r.id], 'v').poly = { ...POLY_DEFAULT, parts: 2, unit };
      const e = new Engine(SR);
      e.load(p);
      return { e, id: r.id };
    };
    const vals = (x: { e: Engine; id: number }): number[] => {
      render(x.e, BLOCK);
      return (x.e as unknown as { nodes: Map<number, { inst: { out: Record<string, Float32Array> }[] }> }).nodes.get(x.id)!.inst.map((i) => i.out.out[0]);
    };
    const a = build(0, 3);
    const first = vals(a);
    render(a.e, SR);
    expect(vals(a)).toEqual(first);
    expect(first[0]).not.toBe(first[1]);
    expect(vals(build(0, 4))).not.toEqual(first);
    const w = build(1, 0);
    const seen: number[] = [];
    for (let i = 0; i < 400; i++) seen.push(vals(w)[0]);
    expect(seen.every((v) => v >= -1 && v <= 1)).toBe(true);
    expect(Math.max(...seen) - Math.min(...seen)).toBeGreaterThan(0.05);
    for (let i = 1; i < seen.length; i++) expect(Math.abs(seen[i] - seen[i - 1])).toBeLessThan(0.05); // smooth
  });
});

describe('FM oscillator', () => {
  /** panel -> sine carrier -> output; with ratio > 0 a sine modulator (coarse = ratio in semitones) into the carrier's pm */
  function fm(car: Record<string, number>, mod?: Record<string, number>): { p: Patch; osc: number } {
    const p = emptyPatch();
    const kb = addModule(p, DEFS.fm1, 0, 0);
    const o = addModule(p, DEFS.osc, 0, 0);
    Object.assign(o.params, { wave: 0, level: 1 }, car);
    const out = addModule(p, DEFS.output, 0, 0);
    out.params.level = 0.7;
    connect(p, DEFS, { module: kb.id, port: 'pitch' }, { module: o.id, port: 'pitch' });
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: out.id, port: 'l' });
    if (mod) {
      const m = addModule(p, DEFS.osc, 0, 0);
      Object.assign(m.params, { wave: 0, level: 1 }, mod);
      connect(p, DEFS, { module: kb.id, port: 'pitch' }, { module: m.id, port: 'pitch' });
      connect(p, DEFS, { module: m.id, port: 'out' }, { module: o.id, port: 'pm' });
    }
    return { p, osc: o.id };
  }
  const play = (p: Patch, note = 69): Float32Array => {
    const e = new Engine(SR);
    e.load(p);
    e.noteOn(note);
    render(e, SR / 4); // settle
    return render(e, SR).l;
  };
  /** high-frequency content: rms of the first difference over the rms */
  const bright = (a: Float32Array): number => {
    let s = 0;
    for (let i = 1; i < a.length; i++) s += (a[i] - a[i - 1]) ** 2;
    return Math.sqrt(s / a.length) / rms(a);
  };

  it('feedback brightens a sine without moving its pitch', () => {
    const plain = play(fm({}).p);
    const fed = play(fm({ fb: 0.6 }).p);
    expect(freq(plain)).toBeCloseTo(440, -1);
    expect(freq(fed)).toBeCloseTo(440, -1);
    expect(bright(fed)).toBeGreaterThan(bright(plain) * 1.5);
    expect(rms(fed)).toBeGreaterThan(0.3);
  });

  it('FM mode with no modulation matches the plain oscillator in pitch and level', () => {
    const plain = play(fm({}).p);
    const over = play(fm({ pm: 4 }, { level: 0 }).p); // pm connected, index 4, but the modulator is silent
    expect(Math.abs(freq(over) - freq(plain))).toBeLessThan(3);
    expect(rms(over)).toBeCloseTo(rms(plain), 2);
    const hi = play(fm({ pm: 4 }, { level: 0 }).p, 108); // C8: the decimator must still pass the fundamental
    expect(rms(hi)).toBeCloseTo(rms(play(fm({}).p, 108)), 1);
  });

  it('phase modulation adds sidebands, and the index is the pm parameter', () => {
    const plain = play(fm({}).p);
    const low = play(fm({ pm: 1 }, { coarse: 12 }).p);
    const high = play(fm({ pm: 4 }, { coarse: 12 }).p);
    expect(bright(low)).toBeGreaterThan(bright(plain) * 1.2);
    expect(bright(high)).toBeGreaterThan(bright(low) * 1.3);
  });

  it('keeps fb in JSON and writes it to the binary record', () => {
    const { p, osc } = fm({ fb: 0.25 });
    const r = validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
    expect(r.modules.find((m) => m.id === osc)!.params.fb).toBe(0.25);
    const b = encodePatch(p);
    const rec = 8 + recordSize('fm1'); // the oscillator's record follows the panel's
    const at = rec + 1 + 4 * DEFS.osc.params.findIndex((q) => q.name === 'fb');
    expect(new DataView(b.buffer).getInt32(at, true)).toBe(Math.round(0.25 * 65536));
  });
});

describe('sync, glide, shaper, spread', () => {
  const wire = (p: Patch, a: number, ap: string, b: number, bp: string): void => {
    expect(connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })).toBe(true);
  };

  it('sync restarts the oscillator phase on a rising edge: two oscillators started apart line up after a gate', () => {
    const p = emptyPatch();
    const kb = addModule(p, DEFS.fm1, 0, 0).id;
    const a = addModule(p, DEFS.osc, 0, 0);
    const b = addModule(p, DEFS.osc, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0).id;
    a.params.wave = b.params.wave = 0;
    wire(p, kb, 'pitch', a.id, 'pitch');
    wire(p, kb, 'pitch', b.id, 'pitch');
    wire(p, kb, 'gate', a.id, 'sync');
    wire(p, kb, 'gate', b.id, 'sync');
    wire(p, a.id, 'out', out, 'l');
    wire(p, b.id, 'out', out, 'r');
    const e = new Engine(SR);
    e.load(p);
    // put b out of phase: run a few blocks with a connected to pitch only, then detune b for a while
    b.params.fine = 50;
    e.setParam(b.id, 'fine', 50);
    render(e, 2000);
    e.setParam(b.id, 'fine', 0);
    let r = render(e, 1000);
    expect(Math.abs(r.l[999] - r.r[999])).toBeGreaterThan(0.05); // apart
    e.noteOn(69);
    r = render(e, 1000);
    for (let i = 10; i < 1000; i++) expect(r.l[i]).toBeCloseTo(r.r[i], 5); // together after the sync edge
  });

  it('glide reaches a step smoothly: 99 % after `time`, in both directions', () => {
    const p = emptyPatch();
    const kb = addModule(p, DEFS.fm1, 0, 0).id;
    const g = addModule(p, DEFS.glide, 0, 0);
    const outM = addModule(p, DEFS.output, 0, 0);
    const out = outM.id;
    outM.params.level = 1;
    g.params.time = 0.1;
    wire(p, kb, 'pitch', g.id, 'in');
    wire(p, g.id, 'out', out, 'l');
    const e = new Engine(SR);
    e.load(p);
    e.noteOn(72); // pitch 1 octave
    const r = render(e, Math.round(SR * 0.1));
    expect(r.l[0]).toBeLessThan(0.01);
    expect(r.l[Math.round(SR * 0.05)]).toBeGreaterThan(0.85);
    expect(r.l[r.l.length - 1]).toBeGreaterThan(0.985);
    expect(r.l[r.l.length - 1]).toBeLessThan(1);
    e.noteOn(60);
    const d = render(e, Math.round(SR * 0.1));
    expect(d.l[d.l.length - 1]).toBeLessThan(0.015);
  });

  it('shaper: hard clip bounds, soft clip brightens, fold stays within the level', () => {
    const run = (mode: number, drive: number): Float32Array => {
      const p = emptyPatch();
      const kb = addModule(p, DEFS.fm1, 0, 0).id;
      const o = addModule(p, DEFS.osc, 0, 0);
      const s = addModule(p, DEFS.shape, 0, 0);
      const outM = addModule(p, DEFS.output, 0, 0);
      const out = outM.id;
      outM.params.level = 1;
      o.params.wave = 0;
      o.params.level = 1;
      s.params.mode = mode;
      s.params.drive = drive;
      s.params.level = 1;
      wire(p, kb, 'pitch', o.id, 'pitch');
      wire(p, o.id, 'out', s.id, 'in');
      wire(p, s.id, 'out', out, 'l');
      const e = new Engine(SR);
      e.load(p);
      e.noteOn(57);
      return render(e, SR / 4).l;
    };
    const bright = (a: Float32Array): number => {
      let s = 0;
      for (let i = 1; i < a.length; i++) s += (a[i] - a[i - 1]) ** 2;
      return Math.sqrt(s / a.length) / rms(a);
    };
    const peak = (a: Float32Array): number => Math.max(...Array.from(a).map(Math.abs));
    const clean = run(0, 1);
    const soft = run(0, 6);
    const hard = run(1, 6);
    const fold = run(2, 6);
    expect(peak(clean)).toBeCloseTo(1, 1); // drive 1 through the cubic: the sine's peak maps to 1
    expect(bright(soft)).toBeGreaterThan(bright(clean) * 1.3);
    expect(peak(hard)).toBeLessThanOrEqual(1.0001);
    expect(rms(hard)).toBeGreaterThan(0.9); // nearly a square
    expect(peak(fold)).toBeLessThanOrEqual(1.0001);
    expect(bright(fold)).toBeGreaterThan(bright(hard)); // the fold's extra zero crossings
  });

  it('an old patch\'s Main spread becomes the Part index, -1..1 across the parts and 0 with one: through 0.2 s + 0.2 the parts sum to 0.2 each', () => {
    const build = (voices?: number): Engine => {
      const p = emptyPatch();
      const kb = addModule(p, DEFS.fm1, 0, 0).id;
      const sc = addModule(p, DEFS.scale, 0, 0);
      const out = addModule(p, DEFS.output, 0, 0);
      sc.params.gain = 0.2;
      sc.params.offset = 0.2;
      out.params.level = 1;
      p.cables.push({ from: { module: kb, port: 'spread' }, to: { module: sc.id, port: 'in' } }); // an old patch's cable
      wire(p, sc.id, 'out', out.id, 'l');
      const e = new Engine(SR);
      e.load(withParts(p, voices ?? 1));
      return e;
    };
    expect(render(build(), 256).l[100]).toBeCloseTo(0.2, 5);
    expect(render(build(4), 256).l[100]).toBeCloseTo(0.8, 4); // spreads -1, -1/3, 1/3, 1 -> 0, 2/15, 4/15, 2/5
    expect(render(build(2), 256).l[100]).toBeCloseTo(0.4, 4);
  });
});

describe('level/rate envelope, string, wavetable, chorus', () => {
  const wire = (p: Patch, a: number, ap: string, b: number, bp: string): void => {
    expect(connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })).toBe(true);
  };
  const peak = (a: Float32Array): number => Math.max(...Array.from(a).map(Math.abs));
  const bright = (a: Float32Array): number => {
    let s = 0;
    for (let i = 1; i < a.length; i++) s += (a[i] - a[i - 1]) ** 2;
    return Math.sqrt(s / a.length) / Math.max(rms(a), 1e-9);
  };
  /** pitch by autocorrelation with a parabolic peak (zero crossings miscount a bright pluck) */
  const pitchAC = (a: Float32Array): number => {
    const ac: number[] = [];
    for (let lag = 20; lag <= 600; lag++) {
      let s = 0;
      for (let i = lag; i < a.length; i++) s += a[i] * a[i - lag];
      ac.push(s);
    }
    let b = 1;
    for (let i = 2; i < ac.length - 1; i++) if (ac[i] > ac[b]) b = i;
    const d = (ac[b - 1] - ac[b + 1]) / (2 * (ac[b - 1] - 2 * ac[b] + ac[b + 1]));
    return SR / (20 + b + d);
  };
  /** magnitude of a frequency in a signal (Goertzel) */
  const mag = (a: Float32Array, f: number): number => {
    const w = (2 * Math.PI * f) / SR;
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    for (let i = 0; i < a.length; i++) {
      s0 = a[i] + 2 * Math.cos(w) * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return Math.sqrt(s1 * s1 + s2 * s2 - 2 * Math.cos(w) * s1 * s2) / a.length;
  };

  it('env runs l1 l2 l3 in r1 r2 r3, holds l3, releases to l4 in r4', () => {
    const p = emptyPatch();
    const kb = addModule(p, DEFS.fm1, 0, 0).id;
    const e = addModule(p, DEFS.env, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    out.params.level = 1;
    Object.assign(e.params, { l1: 1, r1: 0.01, l2: 0.25, r2: 0.1, l3: 0.75, r3: 0.1, l4: 0.1, r4: 0.1 });
    wire(p, kb, 'gate', e.id, 'gate');
    wire(p, e.id, 'env', out.id, 'l');
    const en = new Engine(SR);
    en.load(p);
    expect(render(en, 100).l[50]).toBeCloseTo(0.1, 5); // idle at l4
    en.noteOn(60);
    const a = render(en, Math.round(SR * 0.01)).l; // the attack: linear 0.1 -> 1 at the 0..1 rate, so it arrives at 90 % of r1
    expect(a[Math.round(SR * 0.005)]).toBeCloseTo(0.6, 1);
    expect(a[Math.round(SR * 0.0089)]).toBeCloseTo(0.99, 1);
    expect(Math.max(...Array.from(a))).toBeCloseTo(1, 4);
    const d = render(en, Math.round(SR * 0.1)).l; // down to l2 (exponential, 99 % in r2)
    expect(d[d.length - 1]).toBeCloseTo(0.25, 1);
    const u = render(en, Math.round(SR * 0.1)).l; // up to l3, linear: 0.5 of travel in 0.05 s
    expect(u[u.length - 1]).toBeCloseTo(0.75, 5);
    expect(render(en, Math.round(SR * 0.2)).l[1000]).toBeCloseTo(0.75, 5); // held
    en.noteOff(60);
    const r = render(en, Math.round(SR * 0.1)).l;
    expect(r[0]).toBeLessThan(0.75);
    expect(r[r.length - 1]).toBeCloseTo(0.1, 1);
    expect(render(en, 1000).l[999]).toBeCloseTo(0.1, 2);
  });

  const stringPatch = (params: Record<string, number>, exc = false) => {
    const p = emptyPatch();
    const kb = addModule(p, DEFS.fm1, 0, 0).id;
    const s = addModule(p, DEFS.string, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    out.params.level = 1;
    Object.assign(s.params, { level: 1 }, params);
    wire(p, kb, 'pitch', s.id, 'pitch');
    if (exc) {
      const o = addModule(p, DEFS.osc, 0, 0);
      o.params.wave = 3;
      o.params.coarse = -36;
      wire(p, kb, 'pitch', o.id, 'pitch');
      wire(p, o.id, 'out', s.id, 'exc');
    } else wire(p, kb, 'gate', s.id, 'gate');
    wire(p, s.id, 'out', out.id, 'l');
    return p;
  };

  it('string: a gate plucks a tone at the played pitch that decays to -60 dB in about `decay`', () => {
    const e = new Engine(SR);
    e.load(stringPatch({ decay: 0.5, damp: 0.2 }));
    e.noteOn(69);
    const a = render(e, SR).l;
    const seg = (t0: number, t1: number): Float32Array => a.subarray(Math.round(t0 * SR), Math.round(t1 * SR));
    expect(Math.abs(pitchAC(seg(0.1, 0.4)) - 440)).toBeLessThan(6);
    const early = rms(seg(0.05, 0.1));
    const late = rms(seg(0.5, 0.55));
    expect(20 * Math.log10(late / early)).toBeLessThan(-45); // 0.45 s later: most of the 60 dB gone
    expect(20 * Math.log10(late / early)).toBeGreaterThan(-75);
    expect(late).toBeGreaterThan(1e-5); // not dead yet
  });

  it('string: damp darkens the pluck; the exc input rings the string without a gate', () => {
    const run = (params: Record<string, number>): Float32Array => {
      const e = new Engine(SR);
      e.load(stringPatch(params));
      e.noteOn(57);
      return render(e, SR / 2).l.subarray(2000);
    };
    expect(bright(run({ damp: 0.8 }))).toBeLessThan(bright(run({ damp: 0 })) * 0.5);
    const ring = (decay: number): Float32Array => {
      const e = new Engine(SR);
      e.load(stringPatch({ decay, damp: 0.2 }, true));
      e.noteOn(69);
      return render(e, SR / 2).l.subarray(SR / 4);
    };
    const long = ring(3);
    const short = ring(0.05);
    expect(rms(long)).toBeGreaterThan(0.01);
    // the 55 Hz pulse train has every harmonic; the resonator at 440 Hz (its 8th) lifts that one far above its 7th
    expect(mag(long, 440) / mag(long, 385)).toBeGreaterThan(5 * (mag(short, 440) / mag(short, 385)));
  });

  it('wavetable: frame 0 of analog is a sine, pos sweeps to brighter frames, high notes take the smaller mip', () => {
    const run = (params: Record<string, number>, note = 60): Float32Array => {
      const p = emptyPatch();
      const kb = addModule(p, DEFS.fm1, 0, 0).id;
      const w = addModule(p, DEFS.wavetable, 0, 0);
      const out = addModule(p, DEFS.output, 0, 0);
      out.params.level = 1;
      Object.assign(w.params, { level: 1 }, params);
      wire(p, kb, 'pitch', w.id, 'pitch');
      wire(p, w.id, 'out', out.id, 'l');
      const e = new Engine(SR);
      e.load(p);
      e.noteOn(note);
      return render(e, SR / 4).l;
    };
    const sine = run({ bank: 0, pos: 0 });
    expect(Math.abs(freq(sine) - 261.63)).toBeLessThan(3);
    expect(rms(sine)).toBeCloseTo(Math.SQRT1_2, 2);
    expect(peak(sine)).toBeCloseTo(1, 2);
    const saw = run({ bank: 0, pos: 3 / 7 });
    const sq = run({ bank: 0, pos: 5 / 7 });
    expect(bright(saw)).toBeGreaterThan(bright(sine) * 2);
    expect(rms(sq)).toBeGreaterThan(rms(saw));
    const mid = run({ bank: 0, pos: 0.5 / 7 }); // half way between sine and triangle
    expect(bright(mid)).toBeGreaterThan(bright(sine));
    expect(bright(mid)).toBeLessThan(bright(run({ bank: 0, pos: 1 / 7 })));
    for (let b = 0; b < 4; b++) for (const pos of [0, 0.5, 1]) expect(peak(run({ bank: b, pos }))).toBeLessThanOrEqual(1.02);
    const hi = run({ bank: 0, pos: 3 / 7 }, 100); // 2.6 kHz: 8 harmonics only, the top one at 21 kHz
    expect(bright(hi)).toBeLessThan(bright(saw) * 20);
    expect(Math.abs(freq(hi) - 2637)).toBeLessThan(30);
  });

  it('chorus: mix 0 passes the input, mix 1 is a swept delay of equal loudness, l and r differ; it is shared across voices', () => {
    const build = (mix: number, voices = 1): Engine => {
      const p = emptyPatch();
      const kb = addModule(p, DEFS.fm1, 0, 0).id;
      const o = addModule(p, DEFS.osc, 0, 0);
      const ch = addModule(p, DEFS.chorus, 0, 0);
      const out = addModule(p, DEFS.output, 0, 0);
      out.params.level = 1;
      o.params.level = 0.5;
      Object.assign(ch.params, { mix, rate: 1, depth: 1 });
      wire(p, kb, 'pitch', o.id, 'pitch');
      wire(p, o.id, 'out', ch.id, 'in');
      wire(p, ch.id, 'l', out.id, 'l');
      wire(p, ch.id, 'r', out.id, 'r');
      const q = withParts(p, voices);
      expect(copiesOf(q).has(ch.id)).toBe(false);
      const e = new Engine(SR);
      e.load(q);
      e.noteOn(60);
      return e;
    };
    const dry = render(build(0), SR / 2);
    expect(rms(dry.l)).toBeCloseTo(0.5 * Math.SQRT1_2, 2);
    expect(dry.l[1000]).toBeCloseTo(dry.r[1000], 6);
    const wet = render(build(1), SR / 2);
    expect(rms(wet.l.subarray(2000))).toBeCloseTo(rms(dry.l), 1);
    let diff = 0;
    for (let i = 2000; i < wet.l.length; i++) diff += (wet.l[i] - wet.r[i]) ** 2;
    expect(Math.sqrt(diff / (wet.l.length - 2000))).toBeGreaterThan(0.05);
    expect(peak(render(build(0.5, 4), SR / 4).l)).toBeGreaterThan(0.1);
  });
});

describe('sequencer, clock divider, S&H, quantizer, pulse', () => {
  const wire = (p: Patch, a: number, ap: string, b: number, bp: string): void => {
    expect(connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })).toBe(true);
  };
  /** a patch with a 100 Hz square LFO as the clock (rising edges every 480 samples at 48 kHz, the first at sample 0) */
  const clocked = (): { p: Patch; clock: number; out: number } => {
    const p = emptyPatch();
    const clock = addModule(p, DEFS.lfo, 0, 0);
    Object.assign(clock.params, { wave: 3, rate: 100, depth: 1 });
    const out = addModule(p, DEFS.output, 0, 0);
    out.params.level = 1;
    return { p, clock: clock.id, out: out.id };
  };
  const edges = (a: Float32Array): number[] => {
    const r: number[] = [];
    for (let i = 1; i < a.length; i++) if (a[i - 1] < 0.5 && a[i] >= 0.5) r.push(i);
    return r;
  };
  const CLK = 480;

  it('sequencer steps on clock edges, rests on -1, resets, and walks the pendulum without repeating the ends', () => {
    const { p, clock, out } = clocked();
    const s = addModule(p, DEFS.seq, 0, 0);
    Object.assign(s.params, { s1: 0.1, s2: 0.2, s3: -1, s4: 0.4, len: 4 });
    const rst = addModule(p, DEFS.lfo, 0, 0);
    Object.assign(rst.params, { wave: 3, rate: 100 / 7, depth: 1 }); // a reset every 7 clocks
    wire(p, clock, 'out', s.id, 'clock');
    wire(p, s.id, 'out', out, 'l');
    wire(p, s.id, 'gate', out, 'r');
    const e = new Engine(SR);
    e.load(p);
    const r = render(e, CLK * 5);
    const at = (k: number): number => r.l[k * CLK + 10];
    // the square starts high: the first edge at sample 0 moves to step 2 straight away
    expect([at(0), at(1), at(2), at(3), at(4)].map((v) => Number(v.toFixed(2)))).toEqual([0.2, -1, 0.4, 0.1, 0.2]);
    expect(r.r[1 * CLK + 10]).toBe(0); // the rest has no gate
    expect(r.r[2 * CLK + 10]).toBe(1);
    expect(r.r[2 * CLK + CLK / 2 + 10]).toBe(0); // the gate follows the clock's width
    wire(p, rst.id, 'out', s.id, 'reset');
    const e2 = new Engine(SR);
    e2.load(p);
    const r2 = render(e2, CLK * 9);
    expect(r2.l[7 * CLK + 10]).toBeCloseTo(0.1, 5); // back on step 1 at the reset edge
    expect(r2.l[8 * CLK + 10]).toBeCloseTo(0.2, 5);
    s.params.dir = 2;
    s.params.s3 = 0.3;
    const e3 = new Engine(SR);
    e3.load(p);
    const r3 = render(e3, CLK * 7); // the reset edge at sample 0 wins over the clock edge: step 1 first
    expect([0, 1, 2, 3, 4, 5, 6].map((k) => Number(r3.l[k * CLK + 10].toFixed(2)))).toEqual([0.1, 0.2, 0.3, 0.4, 0.3, 0.2, 0.1]);
  });

  it('sequencer glide slews out over a fraction of the clock period, gate length holds the gate for a fraction of it', () => {
    const { p, clock, out } = clocked();
    const s = addModule(p, DEFS.seq, 0, 0);
    Object.assign(s.params, { s1: 0, s2: 1, len: 2, glide: 0.5, gate: 0.75 });
    wire(p, clock, 'out', s.id, 'clock');
    wire(p, s.id, 'out', out, 'l');
    wire(p, s.id, 'gate', out, 'r');
    const e = new Engine(SR);
    e.load(p);
    const r = render(e, CLK * 4);
    // edges at 0 (step 2), 480 (step 1), 960 (step 2): the period is known from the second edge on
    expect(r.l[10]).toBe(1); // no period yet: the step itself
    const t = 2 * CLK;
    expect(r.l[t + 120]).toBeCloseTo(1 - Math.exp(-4.6 * 0.5), 1); // half of the 99 % time
    expect(r.l[t + 239]).toBeCloseTo(0.99, 1);
    expect(r.l[t + CLK - 1]).toBeGreaterThan(0.999);
    expect(r.r[t + 300]).toBe(1); // the gate: 0.75 x 480 = 360 samples
    expect(r.r[t + 400]).toBe(0);
    s.params.gate = 1;
    const e2 = new Engine(SR);
    e2.load(p);
    const r2 = render(e2, CLK * 4);
    expect(r2.r[t + CLK - 1]).toBe(1); // legato: the gate ties into the next step
    expect(r2.r[t + CLK + 1]).toBe(1);
    s.params.s1 = -1; // a rest drops the gate at its edge
    const e3 = new Engine(SR);
    e3.load(p);
    const r3 = render(e3, CLK * 4);
    expect(r3.r[3 * CLK + 5]).toBe(0);
  });

  it('clock divider passes every div-th pulse and the fixed divisions, reset makes the next pulse a downbeat', () => {
    const { p, clock, out } = clocked();
    const d = addModule(p, DEFS.clkdiv, 0, 0);
    d.params.div = 3;
    wire(p, clock, 'out', d.id, 'clock');
    wire(p, d.id, 'out', out, 'l');
    wire(p, d.id, 'd4', out, 'r');
    const e = new Engine(SR);
    e.load(p);
    const r = render(e, CLK * 12 + 1);
    expect(edges(r.l).map((x) => Math.round(x / CLK))).toEqual([3, 6, 9, 12]);
    expect(r.l[CLK * 3 + 10]).toBe(1);
    expect(r.l[CLK * 3 + CLK / 2 + 10]).toBe(0);
    expect(edges(r.r).map((x) => Math.round(x / CLK))).toEqual([4, 8, 12]);
  });

  it('S&H holds the input at the clock edge and tracks it while the clock is up', () => {
    const run = (mode: number): Float32Array => {
      const { p, clock, out } = clocked();
      const s = addModule(p, DEFS.sh, 0, 0);
      const ramp = addModule(p, DEFS.lfo, 0, 0);
      Object.assign(ramp.params, { wave: 2, rate: 10, depth: 1 });
      s.params.mode = mode;
      wire(p, clock, 'out', s.id, 'clock');
      wire(p, ramp.id, 'out', s.id, 'in');
      wire(p, s.id, 'out', out, 'l');
      const e = new Engine(SR);
      e.load(p);
      return render(e, CLK * 4).l;
    };
    const hold = run(0);
    expect(hold[CLK + 5]).toBeCloseTo(hold[CLK + 200], 6); // flat between edges
    expect(hold[2 * CLK + 5]).toBeGreaterThan(hold[CLK + 5]); // the ramp has risen
    const track = run(1);
    expect(track[CLK + 100]).toBeGreaterThan(track[CLK + 5]); // following while high
    expect(track[CLK + 300]).toBeCloseTo(track[CLK + 400], 6); // held while low
  });

  it('quantizer snaps to the scale on the root, down on ties, in every octave', () => {
    const run = (scale: number, root: number, v: number): number => {
      const p = emptyPatch();
      const k = addModule(p, DEFS.const, 0, 0);
      const q = addModule(p, DEFS.quant, 0, 0);
      const sc = addModule(p, DEFS.scale, 0, 0);
      const out = addModule(p, DEFS.output, 0, 0);
      out.params.level = 1;
      k.params.value = v;
      q.params.scale = scale;
      q.params.root = root;
      sc.params.gain = 0.25; // keep +-4 octaves inside the output's clamp
      wire(p, k.id, 'out', q.id, 'in');
      wire(p, q.id, 'out', sc.id, 'in');
      wire(p, sc.id, 'out', out.id, 'l');
      const e = new Engine(SR);
      e.load(p);
      return render(e, 128).l[100] * 4 * 12;
    };
    expect(run(1, 0, 0.9 / 12)).toBeCloseTo(0, 5); // nearly C# -> C
    expect(run(1, 0, 1.1 / 12)).toBeCloseTo(2, 5); // -> D
    expect(run(1, 0, 2.5 / 12)).toBeCloseTo(2, 5); // D / E tie goes down
    expect(run(1, 0, 11.6 / 12)).toBeCloseTo(12, 5); // up to the next C
    expect(run(1, 0, -0.4 / 12)).toBeCloseTo(0, 5);
    expect(run(1, 0, -13.2 / 12)).toBeCloseTo(-13, 4); // B two octaves down
    expect(run(2, 9, 4 / 12)).toBeCloseTo(4, 5); // A minor has E
    expect(run(2, 9, 4.6 / 12)).toBeCloseTo(5, 5); // F
    expect(run(10, 0, 5 / 12)).toBeCloseTo(0, 5); // octaves only
    expect(run(10, 0, 7 / 12)).toBeCloseTo(12, 5);
    expect(run(0, 0, 3.4 / 12)).toBeCloseTo(3, 5); // chromatic
  });

  it('pulse raises a gate of `time` on a trigger edge and restarts on the next', () => {
    const { p, clock, out } = clocked();
    const pl = addModule(p, DEFS.pulse, 0, 0);
    pl.params.time = 0.005; // 240 samples: half the clock period
    wire(p, clock, 'out', pl.id, 'trig');
    wire(p, pl.id, 'out', out, 'l');
    const e = new Engine(SR);
    e.load(p);
    const r = render(e, CLK * 3).l;
    expect(r[1]).toBe(1);
    expect(r[239]).toBe(1);
    expect(r[240]).toBe(0);
    expect(r[CLK + 100]).toBe(1);
    pl.params.time = 0.015; // longer than the clock: retriggered before it ends, never falls
    const e2 = new Engine(SR);
    e2.load(p);
    expect(Math.min(...Array.from(render(e2, CLK * 3).l))).toBe(1);
  });
});

describe('pan, crossfade, vowel, phaser, digitizer, noise colour', () => {
  const wire = (p: Patch, a: number, ap: string, b: number, bp: string): void => {
    expect(connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })).toBe(true);
  };
  /** a patch with an Output at level 1; returns the helpers */
  const start = (): { p: Patch; out: number; add: (type: string, params?: Record<string, number>) => number } => {
    const p = emptyPatch();
    const outM = addModule(p, DEFS.output, 0, 0);
    outM.params.level = 1;
    return {
      p,
      out: outM.id,
      add: (type, params = {}) => {
        const m = addModule(p, DEFS[type], 0, 0);
        Object.assign(m.params, params);
        return m.id;
      },
    };
  };
  const hz = (f: number): number => Math.log2(f / 261.6255653);
  const play = (p: Patch, frames = SR / 4): { l: Float32Array; r: Float32Array } => {
    const e = new Engine(SR);
    e.load(p);
    render(e, SR / 8); // settle
    return render(e, frames);
  };

  it('pan: hard left is silent on the right, centre is cos(pi/4) on both', () => {
    const run = (pan: number): { l: Float32Array; r: Float32Array } => {
      const { p, out, add } = start();
      const o = add('osc', { wave: 0, level: 1 });
      const pn = add('pan', { pan });
      wire(p, o, 'out', pn, 'in');
      wire(p, pn, 'l', out, 'l');
      wire(p, pn, 'r', out, 'r');
      return play(p);
    };
    const left = run(-1);
    expect(rms(left.l)).toBeCloseTo(Math.SQRT1_2, 2);
    expect(rms(left.r)).toBeLessThan(1e-4);
    const mid = run(0);
    expect(rms(mid.l)).toBeCloseTo(0.5, 2);
    expect(rms(mid.r)).toBeCloseTo(0.5, 2);
  });

  it('crossfade: mix 0 is a, 1 is b, 0.5 the average', () => {
    const run = (mix: number): number => {
      const { p, out, add } = start();
      const a = add('const', { value: 0.4 });
      const b = add('const', { value: -0.2 });
      const x = add('xfade', { mix });
      wire(p, a, 'out', x, 'a');
      wire(p, b, 'out', x, 'b');
      wire(p, x, 'out', out, 'l');
      return play(p, 256).l[100];
    };
    expect(run(0)).toBeCloseTo(0.4, 5);
    expect(run(1)).toBeCloseTo(-0.2, 5);
    expect(run(0.5)).toBeCloseTo(0.1, 5);
  });

  it('vowel: the A vowel passes its first formant and not 3 kHz; finite at full resonance', () => {
    const run = (f: number, res: number): Float32Array => {
      const { p, out, add } = start();
      const c = add('const', { value: hz(f) });
      const o = add('osc', { wave: 0, level: 1 });
      const v = add('vowel', { vowel: 0, res, level: 1 });
      wire(p, c, 'out', o, 'pitch');
      wire(p, o, 'out', v, 'in');
      wire(p, v, 'out', out, 'l');
      return play(p).l;
    };
    expect(rms(run(730, 0.5))).toBeGreaterThan(rms(run(3000, 0.5)) * 3);
    const hot = run(730, 1);
    expect(hot.every(Number.isFinite)).toBe(true);
    expect(rms(hot)).toBeGreaterThan(0.3);
  });

  it('phaser: dry at mix 0, a notch at 0.414 center with mix 0.5, finite with full feedback', () => {
    const run = (f: number, params: Record<string, number>): Float32Array => {
      const { p, out, add } = start();
      const c = add('const', { value: hz(f) });
      const o = add('osc', { wave: 0, level: 0.5 });
      const ph = add('phaser', { rate: 0.02, depth: 0, center: 800, fb: 0, ...params });
      wire(p, c, 'out', o, 'pitch');
      wire(p, o, 'out', ph, 'in');
      wire(p, ph, 'out', out, 'l');
      return play(p).l;
    };
    expect(rms(run(440, { mix: 0 }))).toBeCloseTo(0.5 * Math.SQRT1_2, 3);
    const notch = run(800 * Math.tan(Math.PI / 8), { mix: 0.5 }); // the four stages turn the phase by pi there
    const peak = run(800, { mix: 0.5 }); // and by 2 pi at the center: wet = dry
    expect(rms(notch)).toBeLessThan(rms(peak) * 0.1);
    expect(rms(peak)).toBeCloseTo(0.5 * Math.SQRT1_2, 2);
    const swept = run(440, { mix: 0.5, depth: 1, rate: 3, fb: 0.9 });
    expect(swept.every(Number.isFinite)).toBe(true);
    expect(rms(swept)).toBeGreaterThan(0.05);
  });

  /** amplitude of a at frequency hz (Goertzel over a Hann window, so a strong neighbour does not leak into the bin) */
  const power = (a: Float32Array, hz: number): number => {
    const w = (2 * Math.PI * hz) / SR;
    let s1 = 0, s2 = 0;
    for (let i = 0; i < a.length; i++) {
      const s0 = a[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / a.length)) + 2 * Math.cos(w) * s1 - s2;
      s2 = s1;
      s1 = s0;
    }
    return Math.sqrt(s1 * s1 + s2 * s2 - 2 * Math.cos(w) * s1 * s2) / a.length;
  };

  it('oversampling: the shaper with os on keeps the harmonics in the band and loses the folded ones', () => {
    const run = (os: number): Float32Array => {
      const { p, out, add } = start();
      const o = add('osc', { wave: 0, level: 1, coarse: 51, fine: 7 }); // 5 kHz: the clipped sine's harmonics at 15, 25, 35, 45 kHz
      const s = add('shape', { mode: 1, drive: 4, level: 1, os });
      wire(p, o, 'out', s, 'in');
      wire(p, s, 'out', out, 'l');
      const e = new Engine(SR);
      e.load(p);
      render(e, 2048);
      return render(e, SR).l;
    };
    const plain = run(0), over = run(1);
    expect(rms(over)).toBeGreaterThan(rms(plain) * 0.8); // a little less: the energy above 22 kHz is gone instead of folded
    expect(rms(over)).toBeLessThan(rms(plain) * 1.05);
    const f0 = 261.6255653 * Math.pow(2, 51.07 / 12); // 4998 Hz
    const fold = (f: number): number => (f > SR / 2 ? SR - f : f); // where a harmonic lands without oversampling
    expect(power(over, f0)).toBeCloseTo(power(plain, f0), 1); // the fundamental
    expect(power(over, 3 * f0)).toBeGreaterThan(power(plain, 3 * f0) * 0.7); // the third harmonic (15 kHz) stays
    // the fifth (25 kHz) and the seventh (35 kHz) fold to 23 and 13 kHz without oversampling; with it they are filtered
    // out at the doubled rate (what remains at those bins is the folding of still higher harmonics, 10 dB down)
    expect(power(over, fold(5 * f0))).toBeLessThan(power(plain, fold(5 * f0)) * 0.4);
    expect(power(over, fold(7 * f0))).toBeLessThan(power(plain, fold(7 * f0)) * 0.4);
  });

  it('shaper: sym makes the fold asymmetric (even harmonics appear), stages fold the folds (brighter, still within 1)', () => {
    const run = (sym: number, stages: number): Float32Array => {
      const { p, out, add } = start();
      const o = add('osc', { wave: 0, level: 1, coarse: 12 }); // 523 Hz sine
      const s = add('shape', { mode: 2, drive: 2.5, level: 1, sym, stages });
      wire(p, o, 'out', s, 'in');
      wire(p, s, 'out', out, 'l');
      const e = new Engine(SR);
      e.load(p);
      render(e, 2048);
      return render(e, SR).l;
    };
    const f0 = 261.6255653 * 2;
    const bright = (a: Float32Array): number => {
      let q = 0;
      for (let i = 1; i < a.length; i++) q += (a[i] - a[i - 1]) ** 2;
      return Math.sqrt(q / a.length) / rms(a);
    };
    const peak = (a: Float32Array): number => Math.max(...Array.from(a).map(Math.abs));
    const even = run(0, 1), odd = run(0.3, 1), dense = run(0, 3);
    expect(power(even, 2 * f0)).toBeLessThan(power(even, f0) * 0.001); // a symmetric fold of a sine has no even harmonics
    expect(power(odd, 2 * f0)).toBeGreaterThan(power(odd, f0) * 0.02); // the offset puts them in
    expect(bright(dense)).toBeGreaterThan(bright(even) * 1.5); // three stages: more corners per cycle
    expect(peak(dense)).toBeLessThanOrEqual(1.0001);
    expect(peak(odd)).toBeLessThanOrEqual(1.0001);
  });

  it('oversampling: the digitizer with os on holds each value for rate input samples and quantizes the same', () => {
    const run = (os: number): Float32Array => {
      const { p, out, add } = start();
      const o = add('osc', { wave: 0, level: 1, coarse: -24 });
      const cr = add('crush', { bits: 4, rate: 4, os });
      wire(p, o, 'out', cr, 'in');
      wire(p, cr, 'out', out, 'l');
      const e = new Engine(SR);
      e.load(p);
      return render(e, 4096).l;
    };
    const plain = run(0), over = run(1);
    expect(rms(over)).toBeCloseTo(rms(plain), 1);
    const steps = (a: Float32Array): number => {
      let n = 0;
      for (let i = 1; i < a.length; i++) if (a[i] !== a[i - 1]) n++;
      return n;
    };
    expect(steps(plain)).toBeLessThan(4096 / 4 + 1); // held 4 samples
    expect(steps(over)).toBeGreaterThan(steps(plain)); // the decimator rounds the steps' corners
    expect(power(over, 65.4)).toBeCloseTo(power(plain, 65.4), 1);
  });

  it('digitizer: one bit leaves -1, 0, 1; rate 8 holds every value for 8 samples', () => {
    const run = (bits: number, rate: number): Float32Array => {
      const { p, out, add } = start();
      const nz = add('noise', { level: 1 });
      const cr = add('crush', { bits, rate });
      wire(p, nz, 'out', cr, 'in');
      wire(p, cr, 'out', out, 'l');
      const e = new Engine(SR);
      e.load(p);
      return render(e, 2048).l;
    };
    const one = run(1, 1);
    for (const v of one) expect([-1, 0, 1]).toContain(Math.round(v * 1e6) / 1e6);
    expect(new Set(Array.from(one)).size).toBe(3);
    const held = run(8, 8);
    for (let i = 0; i < held.length; i++) expect(held[i]).toBe(held[i - (i % 8)]);
    expect(new Set(Array.from(held)).size).toBeGreaterThan(50);
  });

  it('noise colour: 0 is the white noise as before, 1 is darker', () => {
    const run = (color: number): Float32Array => {
      const { p, out, add } = start();
      const nz = add('noise', { level: 0.5, color });
      wire(p, nz, 'out', out, 'l');
      const e = new Engine(SR);
      e.load(p);
      return render(e, 4096).l;
    };
    const white = run(0);
    let seed = 0x1234567;
    for (let i = 0; i < 64; i++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      expect(white[i]).toBeCloseTo((seed / 0x80000000 - 1) * 0.5, 6);
    }
    const dark = run(1);
    const hf = (a: Float32Array): number => {
      let s = 0;
      for (let i = 1; i < a.length; i++) s += (a[i] - a[i - 1]) ** 2;
      return Math.sqrt(s / a.length) / rms(a);
    };
    expect(hf(dark)).toBeLessThan(hf(white) * 0.3);
    expect(rms(dark)).toBeGreaterThan(0.01);
  });
});

describe('delay sync and ping-pong', () => {
  const run = (params: Record<string, number>, clockEvery: number | null) => {
    const p = emptyPatch();
    const kb = addModule(p, DEFS.fm1, 0, 0);
    const c1 = addModule(p, DEFS.const, 0, 0);
    c1.params.value = 1;
    const dly = addModule(p, DEFS.delay, 0, 0);
    Object.assign(dly.params, { fb: 0, mix: 1, ...params });
    const out = addModule(p, DEFS.output, 0, 0);
    out.params.level = 0.7;
    connect(p, DEFS, { module: c1.id, port: 'out' }, { module: dly.id, port: 'in' });
    if (clockEvery) connect(p, DEFS, { module: kb.id, port: 'clock' }, { module: dly.id, port: 'clk' });
    connect(p, DEFS, { module: dly.id, port: 'out' }, { module: out.id, port: 'l' });
    connect(p, DEFS, { module: dly.id, port: 'r' }, { module: out.id, port: 'r' });
    const e = new Engine(44100);
    e.load(p);
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    const first: number[] = [];
    let ticks = 0;
    for (let b = 0; b < 700; b++) {
      if (clockEvery) while (ticks < (b + 1) * 128) { if (ticks >= b * 128) e.clockTick(); ticks += clockEvery; }
      e.render(l, r);
      first.push(l[0]);
    }
    return { l, r, first };
  };
  it('a synced delay follows the clock: 1/4 is one beat', () => {
    // 24 ticks per beat, a tick every 460 samples = 11040 samples per beat; the delayed constant 1 appears after that
    const { first } = run({ sync: 1, time: DELAY_TIME_MIN + (6 / 10) * (DELAY_TIME_MAX - DELAY_TIME_MIN) }, 460);
    const at = first.findIndex((v) => v > 0.5);
    expect(at * 128).toBeGreaterThan(11040 - 400);
    expect(at * 128).toBeLessThan(11040 + 400);
  });
  it('ping-pong uses mix and fb on both sides', () => {
    const a = run({ pingpong: 1, time: 5, fb: 0.5, mix: 0.5 }, null);
    expect(a.l[127]).toBeGreaterThan(0.4);
    expect(a.r[127]).toBeGreaterThan(0.4);
  });
});

describe('live parameter displays', () => {
  it('reports modulation without changing the patch or sharing mutable state', () => {
    const p = emptyPatch();
    const source = addModule(p, DEFS.const, 0, 0);
    source.params.value = 0.25;
    const amp = addModule(p, DEFS.vca, 0, 0);
    amp.params.gain = 0.5;
    amp.map!.p1 = ['gain'];
    connect(p, DEFS, { module: source.id, port: 'out' }, { module: amp.id, port: 'p1' });
    const open = addModule(p, DEFS.const, 0, 0); // an unplugged cv is closed: hold it open to read the gain
    open.params.value = 1;
    connect(p, DEFS, { module: open.id, port: 'out' }, { module: amp.id, port: 'cv' });
    const original = JSON.stringify(p);
    const e = new Engine(SR);
    e.load(p);
    render(e, 128);
    const snapshot = e.parameterValues();
    expect(snapshot.find((m) => m.id === amp.id)!.params.gain).toBeCloseTo(1);
    expect(JSON.stringify(p)).toBe(original);
    snapshot.find((m) => m.id === amp.id)!.params.gain = 99;
    expect(e.parameterValues().find((m) => m.id === amp.id)!.params.gain).toBeCloseTo(1);
    e.setBypass(amp.id, true);
    expect(e.parameterValues().find((m) => m.id === amp.id)!.params.gain).toBe(0.5);
    e.load(emptyPatch());
    expect(e.parameterValues()).toEqual([]);
  });

  it('reports logarithmic macro ranges, morph values, and MIDI-controlled Main knobs', () => {
    const p = emptyPatch();
    const main = addModule(p, DEFS.fm1, 0, 0);
    main.params.morph = 0.5;
    const source = addModule(p, DEFS.const, 0, 0);
    source.params.value = 0.5;
    const filter = addModule(p, DEFS.filter, 0, 0);
    filter.map!.p1 = ['cutoff'];
    filter.range = { p1: { cutoff: [0, 1] } };
    filter.params.res = 0;
    filter.paramsB = { ...filter.params, res: 1 };
    connect(p, DEFS, { module: source.id, port: 'out' }, { module: filter.id, port: 'p1' });
    const e = new Engine(SR);
    e.load(p);
    e.cc(16, 127);
    render(e, 128);
    const values = new Map(e.parameterValues().map((m) => [m.id, m.params]));
    expect(values.get(filter.id)!.cutoff).toBeCloseTo(Math.sqrt(20 * 16000));
    expect(values.get(filter.id)!.res).toBeCloseTo(0.5);
    expect(values.get(main.id)!.k1).toBe(1);
    expect(values.get(main.id)!.morph).toBe(0.5);
  });

  it('follows the newest held polyphonic voice, then a remaining held note', () => {
    const p = emptyPatch();
    const main = addModule(p, DEFS.fm1, 0, 0);
    const amp = addModule(p, DEFS.vca, 0, 0);
    amp.params.gain = 0;
    amp.map!.p1 = ['gain'];
    connect(p, DEFS, { module: main.id, port: 'vel' }, { module: amp.id, port: 'p1' });
    const open = addModule(p, DEFS.const, 0, 0);
    open.params.value = 1;
    connect(p, DEFS, { module: open.id, port: 'out' }, { module: amp.id, port: 'cv' });
    const e = new Engine(SR);
    e.load(withParts(p, 2));
    e.noteOn(60, 0.2);
    e.noteOn(64, 0.7);
    render(e, 128);
    expect(e.parameterValues().find((m) => m.id === amp.id)!.params.gain).toBeCloseTo(1.4);
    e.noteOff(64);
    render(e, 128);
    expect(e.parameterValues().find((m) => m.id === amp.id)!.params.gain).toBeCloseTo(0.4);
  });
});

describe('dedicated CV parameter displays', () => {
  it.each([
    ['filter', 'cv', 'cutoff', 1000, 2000],
    ['ladder', 'cv', 'cutoff', 1000, 2000],
    ['vca', 'cv', 'gain', 1.5, 0.75],
    ['pan', 'pos', 'pan', 0, 0.5],
    ['xfade', 'pos', 'mix', 0.2, 0.7],
    ['vowel', 'vowel', 'vowel', 1, 1.5],
    ['shift', 'cv', 'shift', 100, 150],
    ['filter', 'morph', 'morph', 0.2, 0.7],
  ] as const)('%s %s moves the %s display after DSP modulation', (type, port, param, base, expected) => {
    const p = emptyPatch();
    const source = addModule(p, DEFS.const, 0, 0);
    source.params.value = 0.5;
    const target = addModule(p, DEFS[type], 0, 0);
    target.params[param] = base;
    if (type === 'filter' || type === 'ladder') target.params.cvamt = 2;
    if (type === 'shift') target.params.cvamt = 100;
    connect(p, DEFS, { module: source.id, port: 'out' }, { module: target.id, port });
    const e = new Engine(SR);
    e.load(p);
    render(e, 128);
    expect(e.parameterValues().find((m) => m.id === target.id)!.params[param]).toBeCloseTo(expected);
    expect(target.params[param]).toBe(base);
    e.setParam(source.id, 'value', 0);
    render(e, 128);
    expect(e.parameterValues().find((m) => m.id === target.id)!.params[param]).toBeCloseTo(type === 'vca' ? 0 : base);
  });
});

it('animates the Wobble 2 factory filter and VCA displays through their dedicated CV jacks', () => {
  const p = PRESETS['Wobble 2']();
  const original = JSON.stringify(p);
  const filter = p.modules.find((m) => m.type === 'filter')!;
  const amp = p.modules.find((m) => m.type === 'vca')!;
  const e = new Engine(SR);
  e.load(p);
  e.noteOn(48);
  const cutoff: number[] = [];
  for (let i = 0; i < 60; i++) {
    render(e, 800);
    cutoff.push(e.parameterValues().find((m) => m.id === filter.id)!.params.cutoff);
  }
  expect(Math.max(...cutoff) - Math.min(...cutoff)).toBeGreaterThan(10);
  expect(e.parameterValues().find((m) => m.id === amp.id)!.params.gain).toBeGreaterThan(0.5);
  e.noteOff(48);
  render(e, SR);
  expect(e.parameterValues().find((m) => m.id === amp.id)!.params.gain).toBeLessThan(0.001);
  expect(JSON.stringify(p)).toBe(original);
});

it('adds the Main morph input to the morph parameter', () => {
  const p = emptyPatch();
  const main = addModule(p, DEFS.fm1, 0, 0); main.params.morph = .1;
  const source = addModule(p, DEFS.const, 0, 0); source.params.value = .5;
  const amp = addModule(p, DEFS.vca, 0, 0); amp.paramsB = { ...amp.params, gain: .2 };
  connect(p, DEFS, { module: source.id, port: 'out' }, { module: main.id, port: 'morph' });
  const engine = new Engine(SR);
  engine.load(p); render(engine, 512); expect(engine.morph).toBeCloseTo(.6);
  expect(p.cables).toHaveLength(1);
});

it('fans a CV jack into several parameters on top of its built-in link', () => {
  const p = emptyPatch();
  const source = addModule(p, DEFS.const, 0, 0); source.params.value = .125;
  const target = addModule(p, DEFS.filter, 0, 0);
  target.params = { ...target.params, cutoff: 1000, res: .1, cvamt: 2 };
  target.inputMap = { cv: ['res', 'cvamt'], in: ['track'] };
  for (const port of ['cv', 'in']) connect(p, DEFS, { module: source.id, port: 'out' }, { module: target.id, port });
  const e = new Engine(SR);
  const value = (name: string) => e.parameterValues().find((m) => m.id === target.id)!.params[name];
  e.load(p); render(e, 128);
  expect(value('cutoff')).toBeGreaterThan(1000);
  for (const name of ['res', 'cvamt', 'track']) expect(value(name)).toBeCloseTo(modulate(DEFS.filter.params.find((pd) => pd.name === name)!, target.params[name], .125));
  target.inputMap.cv = ['cvamt'];
  e.load(p); render(e, 128);
  expect(value('res')).toBeCloseTo(.1);
  expect(value('cvamt')).toBeGreaterThan(2);
  expect(p.cables).toHaveLength(2);
});
