import { describe, expect, it } from 'vitest';
import { knobRests } from './knob-rest';
import { DEFS } from './modules';
import { addModule, connect, newPatch, type Patch } from './patch';

const wire = (p: Patch, a: number, ap: string, b: number, bp: string): void => {
  if (!connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })) throw new Error(`cannot wire ${a}.${ap} -> ${b}.${bp}`);
};

function rig(): { patch: Patch; kb: number; filter: number; vca: number } {
  const patch = newPatch(DEFS);
  const kb = patch.modules.find((m) => m.type === 'fm1')!.id;
  const f = addModule(patch, DEFS.filter, 0, 0);
  f.params.cutoff = 200;
  f.params.cvamt = 2;
  const v = addModule(patch, DEFS.vca, 0, 0);
  v.params.gain = 1;
  const filter = f.id, vca = v.id;
  return { patch, kb, filter, vca };
}

describe('knob rests', () => {
  it('lists nothing without knob cables', () => {
    expect(knobRests(rig().patch).size).toBe(0);
  });

  it('follows a pin through the attenuverter and the matrix', () => {
    const { patch, kb, filter } = rig();
    const f = patch.modules.find((m) => m.id === filter)!;
    f.map!.p1 = ['res'];
    f.att = [0.5, 1];
    patch.modules.find((m) => m.id === kb)!.params.k1 = 0.4;
    wire(patch, kb, 'k1', filter, 'p1');
    const rests = knobRests(patch);
    expect(rests.get(`${filter}:res`)).toEqual([{ knob: 'k1', value: f.params.res + 0.2 }]);
    expect(rests.has(`${filter}:cutoff`)).toBe(false);
  });

  it('lands a macro range between its ends', () => {
    const { patch, kb, filter } = rig();
    const f = patch.modules.find((m) => m.id === filter)!;
    f.map!.p2 = ['res'];
    f.range = { p2: { res: [0.2, 0.6] } };
    patch.modules.find((m) => m.id === kb)!.params.k2 = 0.5;
    wire(patch, kb, 'k2', filter, 'p2');
    expect(knobRests(patch).get(`${filter}:res`)![0].value).toBeCloseTo(0.4);
  });

  it('uses the dedicated input formula and skips a neutral knob', () => {
    const { patch, kb, filter, vca } = rig();
    const main = patch.modules.find((m) => m.id === kb)!;
    main.params.k2 = 1;
    main.params.k3 = 1;
    wire(patch, kb, 'k2', filter, 'cv');
    wire(patch, kb, 'k3', vca, 'cv');
    const rests = knobRests(patch);
    expect(rests.get(`${filter}:cutoff`)).toEqual([{ knob: 'k2', value: 800 }]); // 200 Hz, 2 octaves per unit
    expect(rests.has(`${vca}:gain`)).toBe(false); // gain x 1 = gain
    main.params.k3 = 0.25;
    expect(knobRests(patch).get(`${vca}:gain`)).toEqual([{ knob: 'k3', value: 0.25 }]);
  });

  it('ignores a bypassed module and a disabled input', () => {
    const { patch, kb, filter } = rig();
    const f = patch.modules.find((m) => m.id === filter)!;
    patch.modules.find((m) => m.id === kb)!.params.k1 = 1;
    wire(patch, kb, 'k1', filter, 'cv');
    f.disabledInputs = ['cv'];
    expect(knobRests(patch).size).toBe(0);
    delete f.disabledInputs;
    f.bypass = true;
    expect(knobRests(patch).size).toBe(0);
  });
});
