// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  addMember,
  boundary,
  deleteAssembly,
  exposePort,
  fixAssemblies,
  hiddenModules,
  hidePort,
  insertAssembly,
  makeAssembly,
  promote,
  reconcileAll,
  removeMember,
  toDef,
  ungroup,
  validateAssemblyDef,
} from './assembly';
import { FACTORY } from './assemblies';
import { Engine } from './engine';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, removeModule, validatePatch, type Patch } from './patch';
import { encodePatch } from './patchbin';
import { PRESETS } from './presets';

/** panel -> osc -> vca -> output, with an envelope on the vca: the modules of a 1-operator voice */
function voice(): { p: Patch; kb: number; osc: number; env: number; vca: number; out: number } {
  const p = emptyPatch('v');
  const kb = addModule(p, DEFS.fm1, 0, 0).id;
  const osc = addModule(p, DEFS.osc, 100, 0).id;
  const env = addModule(p, DEFS.adsr, 100, 300).id;
  const vca = addModule(p, DEFS.vca, 400, 0).id;
  const out = addModule(p, DEFS.output, 700, 0).id;
  const c = (a: number, ap: string, b: number, bp: string): void => {
    expect(connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })).toBe(true);
  };
  c(kb, 'pitch', osc, 'pitch');
  c(kb, 'gate', env, 'gate');
  c(osc, 'out', vca, 'in');
  c(env, 'env', vca, 'cv');
  c(vca, 'out', out, 'l');
  return { p, kb, osc, env, vca, out };
}

const render = (p: Patch, frames = 4096): Float32Array => {
  const e = new Engine(48000);
  e.load(p);
  e.noteOn(60);
  const l = new Float32Array(frames);
  e.render(l, new Float32Array(frames));
  return l;
};

describe('assemblies', () => {
  it('groups a selection, exposing the ports with outside cables, and hides the members', () => {
    const { p, osc, env, vca } = voice();
    const a = makeAssembly(p, [osc, env, vca], 'operator');
    expect(a.label).toBe('operator');
    expect(a.inputs.map((r) => `${r.module}.${r.port}=${r.label}`)).toEqual([`${osc}.pitch=pitch`, `${env}.gate=gate`]);
    expect(a.outputs).toEqual([{ module: vca, port: 'out', label: 'out' }]);
    expect(hiddenModules(p)).toEqual(new Set([osc, env, vca]));
    expect(p.modules).toHaveLength(5); // the patch is still flat
    expect(p.cables).toHaveLength(5);
    const b = makeAssembly(voice().p, [2, 3, 4], 'operator');
    expect(b.label).toBe('operator'); // labels are unique per patch, not globally
  });

  it('refuses the panel, the output, modules already grouped and an empty selection', () => {
    const { p, kb, osc, env, vca, out } = voice();
    expect(() => makeAssembly(p, [kb, osc])).toThrow(/Main panel/);
    expect(() => makeAssembly(p, [vca, out])).toThrow(/Output/);
    expect(() => makeAssembly(p, [])).toThrow(/select/);
    makeAssembly(p, [osc]);
    expect(() => makeAssembly(p, [osc, env])).toThrow(/already in/);
  });

  it('does not change the sound or the binary: engine and FM-1 see the flat patch', () => {
    const { p, osc, env, vca } = voice();
    const before = render(p);
    const bin = encodePatch(p);
    makeAssembly(p, [osc, env, vca], 'operator');
    expect(render(p)).toEqual(before);
    expect(encodePatch(p)).toEqual(bin);
    const json = JSON.parse(JSON.stringify(p)) as Patch;
    expect(json.assemblies).toHaveLength(1);
    // an editor without assemblies: validatePatch keeps the field, the modules are plain
    expect(validatePatch(json, DEFS).modules).toHaveLength(5);
  });

  it('exposes and hides ports, promotes parameters, and keeps labels unique', () => {
    const { p, osc, env, vca } = voice();
    const a = makeAssembly(p, [osc, env, vca], 'operator');
    exposePort(a, 'in', osc, 'pm');
    exposePort(a, 'in', osc, 'pm'); // twice is once
    expect(a.inputs.map((r) => r.label)).toEqual(['pitch', 'gate', 'pm']);
    expect(() => hidePort(p, a, 'in', osc, 'pitch')).toThrow(/cable from outside/);
    hidePort(p, a, 'in', osc, 'pm');
    expect(a.inputs).toHaveLength(2);
    promote(a, osc, 'level');
    promote(a, vca, 'gain');
    a.params[1].label = 'level';
    reconcileAll(p, DEFS);
    expect(a.params.map((r) => r.label)).toEqual(['level', 'level']); // labels are the user's: not renamed behind their back
    promote(a, env, 'a');
    expect(a.params[2].label).toBe('a');
  });

  it('follows the patch: a new outside cable exposes its port, a removed member leaves, an empty assembly goes', () => {
    const { p, kb, osc, env, vca } = voice();
    const a = makeAssembly(p, [osc, env, vca], 'operator');
    connect(p, DEFS, { module: kb, port: 'vel' }, { module: vca, port: 'p1' });
    reconcileAll(p, DEFS);
    expect(a.inputs.at(-1)).toEqual({ module: vca, port: 'p1', label: 'p1' });
    removeModule(p, vca);
    reconcileAll(p, DEFS);
    expect(a.modules).toEqual([osc, env]);
    expect(a.outputs).toEqual([]); // the vca's out is gone; the osc's out now leaves the assembly? no: the cable went with the vca
    removeModule(p, osc);
    removeModule(p, env);
    expect(reconcileAll(p, DEFS)).toEqual(['operator']);
    expect(p.assemblies).toBeUndefined();
  });

  it('adds and removes members, recomputing the boundary', () => {
    const { p, osc, env, vca } = voice();
    const a = makeAssembly(p, [osc, env], 'pair');
    expect(a.outputs.map((r) => r.port)).toEqual(['out', 'env']);
    addMember(p, a, vca);
    expect(a.outputs).toEqual([{ module: vca, port: 'out', label: 'out' }]); // osc.out and env.env are inside now
    removeMember(p, a, env);
    expect(a.inputs.map((r) => `${r.module}.${r.port}`)).toEqual([`${osc}.pitch`, `${vca}.cv`]);
    expect(boundary(p, [osc, vca]).outputs).toEqual([{ module: vca, port: 'out' }]);
    removeMember(p, a, osc);
    removeMember(p, a, vca);
    expect(p.assemblies).toBeUndefined();
  });

  it('ungroup keeps the modules, delete removes them with their cables', () => {
    const { p, osc, env, vca } = voice();
    const a = makeAssembly(p, [osc, env, vca], 'operator');
    ungroup(p, a.id);
    expect(p.assemblies).toBeUndefined();
    expect(p.modules).toHaveLength(5);
    const b = makeAssembly(p, [osc, env, vca], 'operator');
    deleteAssembly(p, b.id);
    expect(p.modules.map((m) => m.type)).toEqual(['fm1', 'output']);
    expect(p.cables).toEqual([]);
  });

  it('saves to a definition with local ids and no knob assignments, and inserts it with fresh ids', () => {
    const { p, kb, osc, env, vca, out } = voice();
    const a = makeAssembly(p, [osc, env, vca], 'operator');
    exposePort(a, 'in', osc, 'pm');
    promote(a, osc, 'coarse');
    a.params[0].label = 'ratio';
    p.modules.find((m) => m.id === osc)!.map!.k1 = ['coarse'];
    p.modules.find((m) => m.id === osc)!.params.coarse = 12;
    const def = validateAssemblyDef(JSON.parse(JSON.stringify(toDef(p, a))), DEFS);
    expect(def.modules.map((m) => m.id)).toEqual([1, 2, 3]);
    expect(def.modules[0].map!.k1).toEqual([]);
    expect(def.modules[0].map!.p1).toEqual(['wave']); // p1 / p2 are kept
    expect(Math.min(...def.modules.map((m) => m.x))).toBe(0);
    expect(def.cables).toHaveLength(2); // osc->vca, env->vca; the outside ones are not part of it
    expect(def.inputs.map((r) => r.label)).toEqual(['pitch', 'gate', 'pm']);
    expect(def.params).toEqual([{ module: 1, param: 'coarse', label: 'ratio' }]);

    const q = emptyPatch('q');
    const kb2 = addModule(q, DEFS.fm1, 0, 0).id;
    const b = insertAssembly(q, DEFS, def, 300, 40);
    expect(q.modules).toHaveLength(4);
    expect(b.modules.every((id) => id > kb2)).toBe(true);
    expect(q.modules.find((m) => m.type === 'osc')!.params.coarse).toBe(12);
    expect(q.modules.find((m) => m.type === 'osc')!.x).toBe(300);
    expect(b.inputs.map((r) => r.label)).toEqual(['pitch', 'gate', 'pm']);
    expect(b.open).toBe(false);
    // wiring the container: cables go to the inner ports
    expect(connect(q, DEFS, { module: kb2, port: 'pitch' }, { module: b.inputs[0].module, port: b.inputs[0].port })).toBe(true);
    const c = insertAssembly(q, DEFS, def, 600, 40);
    expect(c.label).toBe('operator 2');
    expect(q.modules).toHaveLength(7);
    void kb;
    void out;
  });

  it('refuses an insert past the module cap', () => {
    const def = FACTORY.find((d) => d.name === 'voice')!;
    const p = emptyPatch();
    for (let i = 0; i < 6; i++) insertAssembly(p, DEFS, def, 0, 0); // 30 modules
    expect(() => insertAssembly(p, DEFS, def, 0, 0)).toThrow(/at most 32/);
    expect(p.modules).toHaveLength(30);
  });

  it('ships factory assemblies that load, insert and play', () => {
    expect(FACTORY.map((d) => d.name)).toEqual(['echo', 'operator', 'voice']);
    const p = emptyPatch('f');
    const kb = addModule(p, DEFS.fm1, 0, 0).id;
    const out = addModule(p, DEFS.output, 0, 0).id;
    const op = insertAssembly(p, DEFS, FACTORY.find((d) => d.name === 'operator')!, 0, 0);
    const port = (a: typeof op, label: string, dir: 'inputs' | 'outputs') => a[dir].find((r) => r.label === label)!;
    connect(p, DEFS, { module: kb, port: 'pitch' }, port(op, 'pitch', 'inputs'));
    connect(p, DEFS, { module: kb, port: 'gate' }, port(op, 'gate', 'inputs'));
    const o = port(op, 'out', 'outputs');
    expect(connect(p, DEFS, o, { module: out, port: 'l' })).toBe(true);
    const l = render(p, 48000);
    expect(Math.max(...l)).toBeGreaterThan(0.1);
    for (const d of FACTORY) {
      expect(d.modules.every((m) => m.map === undefined || ['k1', 'k2', 'k3', 'k4'].every((k) => m.map![k as 'k1'].length === 0))).toBe(true);
      expect(d.inputs.length + d.outputs.length).toBeGreaterThan(0);
      expect(d.params.length).toBeGreaterThan(0);
    }
  });

  it('rejects bad definitions', () => {
    expect(() => validateAssemblyDef({ format: 'x' }, DEFS)).toThrow(/not a Modular-1 assembly/);
    const base = FACTORY[0];
    expect(() => validateAssemblyDef({ ...base, modules: [{ id: 1, type: 'fm1', x: 0, y: 0, params: {} }], cables: [] }, DEFS)).toThrow(/Main panel/);
    expect(() => validateAssemblyDef({ ...base, inputs: [{ module: 1, port: 'nope' }] }, DEFS)).toThrow(/does not exist/);
    expect(() => validateAssemblyDef({ ...base, params: [{ module: 1, param: 'nope' }] }, DEFS)).toThrow(/does not exist/);
  });

  it('drops an inconsistent overlay on load and keeps the modules', () => {
    const { p, osc, env, vca } = voice();
    makeAssembly(p, [osc, env, vca], 'operator');
    const raw = JSON.parse(JSON.stringify(p)) as Patch;
    raw.assemblies!.push({ ...raw.assemblies![0], id: 2, label: 'ghost', modules: [99] });
    raw.assemblies!.push({ ...raw.assemblies![0], id: 3, label: 'twice', modules: [osc] });
    const q = validatePatch(raw, DEFS);
    const msgs = fixAssemblies(q, DEFS);
    expect(msgs).toEqual(['assembly "ghost" dropped: module 99 is missing', `assembly "twice" dropped: module ${osc} is in two assemblies`]);
    expect(q.assemblies).toHaveLength(1);
    expect(q.modules).toHaveLength(5);
    // no overlay at all is fine, and so is every factory preset
    for (const make of Object.values(PRESETS)) expect(fixAssemblies(make(), DEFS)).toEqual([]);
  });
});
