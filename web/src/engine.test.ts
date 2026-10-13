// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, disconnect, emptyPatch, fromUnit, modulate, processingOrder, removeModule, toUnit, validatePatch, voiceSplit, type Patch } from './patch';
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
      if (['fm1', 'output'].includes(d.type)) expect(has, d.type).toEqual([]);
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
        { id: 3, type: 'output', x: 0, y: 0, params: {} },
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
    expect(toUnit(cutoff, 4000)).toBeCloseTo(1, 6);
    expect(cutoff.bend).toBe(true); // inverse logarithmic: the position is the square root of the octave fraction
    expect(fromUnit(cutoff, 0.5)).toBeCloseTo(20 * Math.pow(200, 0.25), 3);
    expect(toUnit(cutoff, fromUnit(cutoff, 0.3))).toBeCloseTo(0.3, 9);
    expect(modulate(cutoff, 200, 5)).toBeCloseTo(4000, 6);
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

  it('loads old patches whose cables leave the filter at "lp"', () => {
    const p = PRESETS['303 Acid']();
    const q = JSON.parse(JSON.stringify(p));
    const flt = q.modules.find((m: { type: string }) => m.type === 'filter').id;
    const cable = q.cables.find((c: { from: { module: number } }) => c.from.module === flt);
    cable.from.port = 'lp'; // what an old patch calls the 12 dB output
    expect(validatePatch(q, DEFS).cables.find((c) => c.from.module === flt)!.from.port).toBe('lp12');
  });
});

describe('polyphony', () => {
  /** panel -> osc -> filter -> vca (adsr) -> delay -> output, plus a free LFO into the filter's p1 and an LFO driven by the envelope */
  function polyPatch(voices: number): { p: Patch; ids: Record<string, number> } {
    const p = emptyPatch('poly');
    p.voices = voices;
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
    return { p, ids: { kb: kb.id, osc: osc.id, flt: flt.id, env: env.id, vca: vca.id, dly: dly.id, out: out.id, lfo: lfo.id, lfo2: lfo2.id } };
  }

  it('splits the patch: what hears pitch / gate / vel runs per voice, delay / reverb / output and free modules once', () => {
    const { p, ids } = polyPatch(4);
    const poly = voiceSplit(p);
    expect([...poly].sort()).toEqual([ids.osc, ids.flt, ids.env, ids.vca, ids.lfo2].sort());
    expect(poly.has(ids.kb)).toBe(false);
    expect(poly.has(ids.lfo)).toBe(false); // nothing per voice reaches it: one LFO for all voices
    p.voices = 1;
    expect(voiceSplit(p).size).toBe(0);
    delete p.voices;
    expect(voiceSplit(p).size).toBe(0);
  });

  it('one voice is the mono engine as it was: voices 1 and no voices field render the same', () => {
    const a = new Engine(SR);
    const b = new Engine(SR);
    const { p } = polyPatch(1);
    a.load(p);
    delete p.voices;
    b.load(p);
    for (const e of [a, b]) {
      e.noteOn(60);
      e.noteOn(67);
    }
    const x = render(a, 4096).l;
    const y = render(b, 4096).l;
    expect(rms(x)).toBeGreaterThan(0.01);
    expect(x).toEqual(y);
  });

  it('two voices sound both notes: the output is the sum of the two mono notes', () => {
    const mono = (note: number): Float32Array => {
      const p = emptyPatch();
      const kb = addModule(p, DEFS.fm1, 0, 0);
      const o = addModule(p, DEFS.osc, 0, 0);
      const out = addModule(p, DEFS.output, 0, 0);
      o.params.level = 0.3;
      connect(p, DEFS, { module: kb.id, port: 'pitch' }, { module: o.id, port: 'pitch' });
      connect(p, DEFS, { module: o.id, port: 'out' }, { module: out.id, port: 'l' });
      const e = new Engine(SR);
      e.load(p);
      e.noteOn(note);
      return render(e, 2048).l;
    };
    const p = emptyPatch();
    p.voices = 2;
    const kb = addModule(p, DEFS.fm1, 0, 0);
    const o = addModule(p, DEFS.osc, 0, 0);
    const out = addModule(p, DEFS.output, 0, 0);
    o.params.level = 0.3;
    connect(p, DEFS, { module: kb.id, port: 'pitch' }, { module: o.id, port: 'pitch' });
    connect(p, DEFS, { module: o.id, port: 'out' }, { module: out.id, port: 'l' });
    const e = new Engine(SR);
    e.load(p);
    e.noteOn(60);
    e.noteOn(67);
    const both = render(e, 2048).l;
    const a = mono(60);
    const b = mono(67);
    for (let i = 0; i < both.length; i += 7) expect(both[i]).toBeCloseTo(a[i] + b[i], 5);
    expect(rms(both)).toBeGreaterThan(rms(a));
  });

  it('allocates voices: a free one first (the longest free), then the oldest is stolen; note off frees', () => {
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
    e.noteOn(67); // 64 was freed first: its voice is taken first
    expect(e.voiceNotes().map((v) => v.note)).toEqual([65, 62, 67]);
    e.noteOn(65); // the same key again stays on its voice
    expect(e.voiceNotes().map((v) => v.note)).toEqual([65, 62, 67]);
    e.allNotesOff();
    expect(e.voiceNotes().every((v) => !v.on)).toBe(true);
    expect(e.nvoices).toBe(3);
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

  it('keeps the voices sounding when the patch is edited, and resets them when the voice count changes', () => {
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
    p.voices = 2;
    e.load(p);
    expect(e.nvoices).toBe(2);
    expect(e.voiceNotes().every((v) => !v.on)).toBe(true);
  });

  it('a patch file carries the voice count and it survives validation', () => {
    const { p } = polyPatch(6);
    const q = validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
    expect(q.voices).toBe(6);
    const r = validatePatch(JSON.parse(JSON.stringify({ ...p, voices: 99 })), DEFS);
    expect(r.voices).toBe(8);
    const m = validatePatch(JSON.parse(JSON.stringify({ ...p, voices: undefined })), DEFS);
    expect(m.voices).toBeUndefined();
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

  it('spread is -1..1 across the voices and 0 in mono: through 0.2 s + 0.2 the voices sum to 0.2 per voice', () => {
    const build = (voices?: number): Engine => {
      const p = emptyPatch();
      const kb = addModule(p, DEFS.fm1, 0, 0).id;
      const sc = addModule(p, DEFS.scale, 0, 0);
      const out = addModule(p, DEFS.output, 0, 0);
      sc.params.gain = 0.2;
      sc.params.offset = 0.2;
      out.params.level = 1;
      wire(p, kb, 'spread', sc.id, 'in');
      wire(p, sc.id, 'out', out.id, 'l');
      if (voices) p.voices = voices;
      const e = new Engine(SR);
      e.load(p);
      return e;
    };
    expect(render(build(), 256).l[100]).toBeCloseTo(0.2, 5);
    expect(render(build(4), 256).l[100]).toBeCloseTo(0.8, 4); // spreads -1, -1/3, 1/3, 1 -> 0, 2/15, 4/15, 2/5
    expect(render(build(2), 256).l[100]).toBeCloseTo(0.4, 4);
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
