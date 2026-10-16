// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import {
  stripPatchIO,
  bypassAssembly,
  addChild,
  addMember,
  allModules,
  boundary,
  childProblem,
  depthOf,
  freeSpot,
  hiddenAssemblies,
  mergePorts,
  moveAssembly,
  parentOf,
  removeChild,
  targetsOf,
  unmergePort,
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
  overlapping,
  tileMembers,
  validateAssemblyDef,
} from './assembly';
import { CATEGORIES, categoryOf, FACTORY } from './assemblies';
import { newPatch } from './patch';
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

  it('the group switch bypasses every member and restores their own switches', () => {
    const p = emptyPatch();
    addModule(p, DEFS.fm1, 0, 0);
    const osc = addModule(p, DEFS.osc, 0, 0);
    const flt = addModule(p, DEFS.filter, 0, 0);
    const dly = addModule(p, DEFS.delay, 0, 0);
    connect(p, DEFS, { module: osc.id, port: 'out' }, { module: flt.id, port: 'in' });
    connect(p, DEFS, { module: flt.id, port: 'lp24' }, { module: dly.id, port: 'in' });
    const a = makeAssembly(p, [flt.id, dly.id], 'fx');
    dly.bypass = true; // off on its own
    expect(bypassAssembly(p, a, true).sort()).toEqual([flt.id]);
    expect(a.bypass).toBe(true);
    expect(a.kept).toEqual([dly.id]);
    expect(flt.bypass).toBe(true);
    expect(dly.bypass).toBe(true);
    const def = toDef(p, a); // a saved definition carries the members' own switches, not the group's
    expect(def.modules.map((m) => !!m.bypass)).toEqual([false, true]);
    expect(bypassAssembly(p, a, false)).toEqual([flt.id]);
    expect(a.bypass).toBeUndefined();
    expect(a.kept).toBeUndefined();
    expect(flt.bypass).toBeUndefined();
    expect(dly.bypass).toBe(true);
    expect(validatePatch(JSON.parse(JSON.stringify(p)), DEFS).modules.filter((m) => m.bypass).length).toBe(1);
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

  it('a new patch is Main and Output, unwired, on the grid; the model still allows a bare patch', () => {
    const p = newPatch(DEFS);
    expect(p.modules.map((m) => m.type)).toEqual(['fm1', 'output']);
    expect(p.cables).toEqual([]);
    expect(p.modules[1].x).toBeGreaterThan(p.modules[0].x + 500);
    expect(emptyPatch().modules).toEqual([]);
  });

  it('a definition with the Main panel or the Output loses them on load (their cables, ports and parameters too)', () => {
    const { p, kb, osc, env, vca, out } = voice();
    const raw = {
      format: 'modular-1-assembly',
      version: 1,
      name: 'with io',
      modules: p.modules.map((m) => ({ ...m })),
      cables: p.cables.map((c) => ({ ...c })),
      inputs: [{ label: 'gate', module: env, port: 'gate' }, { label: 'pitch', module: kb, port: 'pitch' }],
      outputs: [{ label: 'out', module: vca, port: 'out' }, { label: 'l', module: out, port: 'l' }],
      params: [{ label: 'cut', module: osc, param: 'level' }, { label: 'vol', module: out, param: 'level' }],
    };
    expect(stripPatchIO(JSON.parse(JSON.stringify(raw))) as number).toBe(2);
    const d = validateAssemblyDef(JSON.parse(JSON.stringify(raw)), DEFS);
    expect(d.modules.map((m) => m.type)).not.toContain('fm1');
    expect(d.modules.map((m) => m.type)).not.toContain('output');
    expect(d.cables.every((c) => c.from.module !== kb && c.to.module !== out)).toBe(true);
    expect(d.inputs.map((r) => r.label)).toEqual(['gate']);
    expect(d.outputs.map((r) => r.label)).toEqual(['out']);
    expect(d.params.map((r) => r.label)).toEqual(['cut']);
    expect(() => validateAssemblyDef({ format: 'modular-1-assembly', version: 1, name: 'io only', modules: [{ id: 1, type: 'fm1', x: 0, y: 0, params: {} }], cables: [], inputs: [], outputs: [], params: [] }, DEFS)).toThrow(/1 to 32/);
  });

  it('every factory assembly sits on one of the browser shelves', () => {
    for (const d of FACTORY) expect((CATEGORIES as readonly string[]).includes(d.category ?? ''), d.name).toBe(true);
    expect(categoryOf({ ...FACTORY[0], category: undefined })).toBe(CATEGORIES[CATEGORIES.length - 1]);
    expect(FACTORY.filter((d) => categoryOf(d) === 'Drums').map((d) => d.name)).toContain('kick');
  });

  it('ships factory assemblies that load, insert and play', () => {
    expect(FACTORY.map((d) => d.name)).toEqual([
      'adsr operator', 'analog voice', 'auto pan', 'barber pole', 'bowed glass', 'bowed string', 'clap', 'clock', 'cloud', 'cowbell', 'echo', 'filter voice', 'fm pair', 'gamelan', 'glass bell', 'hats', 'hihat', 'kalimba', 'kick', 'marimba', 'mono lead', 'noise voice', 'operator', 'pluck', 'rain', 'random melody', 'resonator bank', 'reverse pad', 'rim', 'shimmer', 'sidechain pump', 'slicer', 'snare', 'stack voice', 'step sequencer', 'stutter', 'sub bass', 'supersaw stack', 'tabla', 'talking filter', 'time smear', 'tom', 'vibrato', 'voice', 'vowel voice', 'wavetable pad',
    ]);
    for (const d of FACTORY) {
      expect(d.modules.every((m) => m.map === undefined || ['k1', 'k2', 'k3', 'k4'].every((k) => m.map![k as 'k1'].length === 0)), d.name).toBe(true);
      expect(d.inputs.length + d.outputs.length, d.name).toBeGreaterThan(0);
      expect(d.params.length, d.name).toBeGreaterThan(0);
      expect(new Set(d.inputs.map((r) => r.label)).size, d.name).toBe(d.inputs.length); // no duplicate jack labels: the gates are merged
    }
    // every assembly with a pitch or gate input and an audio output plays from the panel; the others put out a moving signal
    for (const d of FACTORY) {
      const p = emptyPatch('f');
      const kb = addModule(p, DEFS.fm1, 0, 0).id;
      const out = addModule(p, DEFS.output, 0, 0).id;
      p.modules[1].params.level = 1;
      const a = insertAssembly(p, DEFS, d, 0, 0);
      const inp = (label: string) => a.inputs.find((r) => r.label === label);
      const feed = (from: string, label: string): void => {
        const r = inp(label);
        if (r) for (const t of targetsOf(r)) expect(connect(p, DEFS, { module: kb, port: from }, t), `${d.name} ${label}`).toBe(true);
      };
      feed('pitch', 'pitch');
      feed('gate', 'gate');
      if (inp('in')) {
        // a held key is a steady signal to pan / smear / shift: at a quarter, so a dense granular cloud of it stays below the clamp
        const sc = addModule(p, DEFS.scale, 0, 0);
        sc.params.gain = 0.25;
        connect(p, DEFS, { module: kb, port: 'gate' }, { module: sc.id, port: 'in' });
        for (const t of targetsOf(inp('in')!)) expect(connect(p, DEFS, { module: sc.id, port: 'out' }, t), `${d.name} in`).toBe(true);
      }
      const o = a.outputs.find((r) => ['out', 'l', 'pitch', 'clock'].includes(r.label))!;
      expect(connect(p, DEFS, o, { module: out, port: 'l' }), d.name).toBe(true);
      const l = render(p, 24000);
      if (inp('gate') || o.label !== 'out') expect(Math.max(...Array.from(l).map(Math.abs)), d.name).toBeGreaterThan(0.05);
      // all of them: a finite output, nothing stuck at the clamp
      expect(l.every((v) => Number.isFinite(v)), d.name).toBe(true);
      if (o.label === 'out' || o.label === 'l') expect(l.filter((v) => Math.abs(v) >= 1).length, d.name).toBeLessThan(l.length / 20); // a clock is a square at +-1 by design
    }
  });

  it('rejects bad definitions', () => {
    expect(() => validateAssemblyDef({ format: 'x' }, DEFS)).toThrow(/not a Matryoshka assembly/);
    const base = FACTORY[0];
    expect(() => validateAssemblyDef({ ...base, modules: [{ id: 1, type: 'fm1', x: 0, y: 0, params: {} }], cables: [] }, DEFS)).toThrow(/1 to 32/) /* the Main panel is stripped, nothing is left */;
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

  it('tiles stacked members when they would open on top of each other; factory assemblies are laid out', () => {
    const { p, osc, env, vca } = voice();
    const a = makeAssembly(p, [osc, env, vca], 'operator');
    expect(overlapping(p, a)).toBe(false);
    for (const m of p.modules) if (a.modules.includes(m.id)) m.x = m.y = 50;
    expect(overlapping(p, a)).toBe(true);
    tileMembers(p, a);
    expect(overlapping(p, a)).toBe(false);
    expect(p.modules.filter((m) => a.modules.includes(m.id)).map((m) => [m.x, m.y])).toEqual([[50, 50], [320, 50], [590, 50]]);
    for (const d of FACTORY) {
      const q = emptyPatch();
      expect(overlapping(q, insertAssembly(q, DEFS, d, 0, 0))).toBe(false);
    }
  });

  // ---- merged ports, placement, nesting

  /** panel, two envelopes on one VCA, output */
  function twoEnv(): { p: Patch; kb: number; e1: number; e2: number; vca: number; osc: number } {
    const p = emptyPatch('t');
    const kb = addModule(p, DEFS.fm1, 0, 0).id;
    const osc = addModule(p, DEFS.osc, 300, 0).id;
    const e1 = addModule(p, DEFS.adsr, 300, 300).id;
    const e2 = addModule(p, DEFS.adsr, 600, 300).id;
    const vca = addModule(p, DEFS.vca, 600, 0).id;
    const c = (a: number, ap: string, b: number, bp: string): void => {
      expect(connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })).toBe(true);
    };
    c(kb, 'pitch', osc, 'pitch');
    c(osc, 'out', vca, 'in');
    c(e1, 'env', vca, 'cv');
    c(e2, 'env', vca, 'p1');
    return { p, kb, e1, e2, vca, osc };
  }

  it('merges two exposed inputs into one jack, keeps it through save / insert, and splits it again', () => {
    const { p, kb, e1, e2, vca, osc } = twoEnv();
    const a = makeAssembly(p, [osc, e1, e2, vca], 'voice');
    exposePort(a, 'in', e1, 'gate');
    exposePort(a, 'in', e2, 'gate');
    expect(a.inputs.map((r) => r.label)).toEqual(['pitch', 'gate', 'gate 2']);
    mergePorts(p, a, DEFS, { module: e1, port: 'gate' }, { module: e2, port: 'gate' });
    expect(a.inputs.map((r) => r.label)).toEqual(['pitch', 'gate']);
    expect(targetsOf(a.inputs[1])).toEqual([{ module: e1, port: 'gate' }, { module: e2, port: 'gate' }]);
    // a different kind cannot merge
    expect(() => mergePorts(p, a, DEFS, { module: osc, port: 'pitch' }, { module: e1, port: 'gate' })).toThrow(/cannot merge/);
    // a cable to every target: the group stays one port, and it cannot be hidden while wired
    for (const t of targetsOf(a.inputs[1])) connect(p, DEFS, { module: kb, port: 'gate' }, t);
    reconcileAll(p, DEFS);
    expect(a.inputs).toHaveLength(2);
    expect(() => hidePort(p, a, 'in', e2, 'gate')).toThrow(/cable from outside/);
    // save and insert carry the merge, with remapped ids
    const def = validateAssemblyDef(JSON.parse(JSON.stringify(toDef(p, a))), DEFS);
    expect(def.inputs[1].also).toEqual([{ module: 3, port: 'gate' }]);
    const q = emptyPatch('q');
    const b = insertAssembly(q, DEFS, def, 0, 0);
    const ts = targetsOf(b.inputs[1]);
    expect(ts).toHaveLength(2);
    expect(ts.every((t) => q.modules.some((m) => m.id === t.module && m.type === 'adsr'))).toBe(true);
    // split
    unmergePort(b, ts[0].module, 'gate');
    expect(b.inputs.map((r) => r.label)).toEqual(['pitch', 'gate', 'gate 2']);
    expect(b.inputs[1].also).toBeUndefined();
    // a member leaving takes its target out of the group; the group survives
    mergePorts(q, b, DEFS, ts[0], ts[1]);
    removeMember(q, b, ts[1].module);
    expect(b.inputs.find((r) => r.label === 'gate')!.also).toBeUndefined();
    // the factory voice has one merged gate
    const voiceDef = FACTORY.find((d) => d.name === 'voice')!;
    expect(voiceDef.inputs.map((r) => r.label)).toEqual(['pitch', 'gate', 'cutoff cv']);
    expect(voiceDef.inputs[1].also).toHaveLength(1);
  });

  it('finds the first free grid cell for an inserted card', () => {
    expect(freeSpot([], 250, 540)).toEqual({ x: 20, y: 20 });
    const row = [0, 1, 2, 3].map((i) => ({ x: 20 + 270 * i, y: 20, w: 250, h: 300 }));
    expect(freeSpot(row, 250, 540)).toEqual({ x: 20, y: 580 });
    expect(freeSpot(row.slice(0, 2), 250, 540)).toEqual({ x: 560, y: 20 });
    // a card sitting off the grid blocks the cells it touches
    expect(freeSpot([{ x: 100, y: 100, w: 250, h: 300 }], 250, 540)).toEqual({ x: 560, y: 20 });
  });

  it('nests: a selection inside an expanded assembly becomes a child, with members, boundary and hiding through the levels', () => {
    const { p, kb, e1, e2, vca, osc } = twoEnv();
    const outer = makeAssembly(p, [osc, e1, e2, vca], 'voice');
    outer.open = true;
    const inner = makeAssembly(p, [e1, e2], 'envs');
    expect(parentOf(p, inner.id)).toBe(outer);
    expect(outer.modules).toEqual([osc, vca]);
    expect(outer.children).toEqual([inner.id]);
    expect(allModules(p, outer).sort()).toEqual([osc, e1, e2, vca].sort());
    expect(depthOf(p, inner)).toBe(2);
    // the child's boundary: both env outputs leave it (into the vca); the outer's boundary is unchanged
    expect(inner.outputs.map((r) => `${r.module}.${r.port}`)).toEqual([`${e1}.env`, `${e2}.env`]);
    expect(outer.outputs).toEqual([]);
    expect(outer.inputs.map((r) => r.port)).toEqual(['pitch']);
    // the parent may only show what the child exposes
    exposePort(outer, 'in', e1, 'gate');
    reconcileAll(p, DEFS);
    expect(outer.inputs.map((r) => r.port)).toEqual(['pitch']);
    exposePort(inner, 'in', e1, 'gate');
    exposePort(outer, 'in', e1, 'gate');
    reconcileAll(p, DEFS);
    expect(outer.inputs.map((r) => r.port)).toEqual(['pitch', 'gate']);
    // an outside cable to a deep module exposes it on both levels
    connect(p, DEFS, { module: kb, port: 'gate' }, { module: e2, port: 'gate' });
    reconcileAll(p, DEFS);
    expect(outer.inputs.map((r) => `${r.module}.${r.port}`)).toContain(`${e2}.gate`);
    expect(inner.inputs.map((r) => `${r.module}.${r.port}`)).toContain(`${e2}.gate`);
    // hiding: a collapsed parent hides everything, an expanded parent with a collapsed child hides the child's modules
    outer.open = false;
    expect(hiddenModules(p)).toEqual(new Set([osc, e1, e2, vca]));
    expect(hiddenAssemblies(p)).toEqual(new Set([inner.id]));
    outer.open = true;
    expect(hiddenModules(p)).toEqual(new Set([e1, e2]));
    expect(hiddenAssemblies(p).size).toBe(0);
    // cycles, double parents and the depth cap are refused
    expect(childProblem(p, inner, outer.id)).toMatch(/already inside/);
    expect(childProblem(p, outer, outer.id)).toMatch(/itself/);
    const third = makeAssembly(p, [vca], 'amp');
    expect(parentOf(p, third.id)).toBe(outer);
    expect(() => makeAssembly(p, [e1], 'deep')).not.toThrow(); // level 3
    expect(() => makeAssembly(p, [e1], 'deeper')).toThrow(/at most 3/);
    expect(() => addChild(p, third, inner.id)).toThrow(/at most 3/); // inner spans two levels, under "amp" that would be four
  });

  it('nests by addChild / removeChild, moves, saves and inserts the tree, and ungroup / delete keep the children', () => {
    const { p, kb, e1, e2, vca, osc } = twoEnv();
    const envs = makeAssembly(p, [e1, e2], 'envs');
    const voice = makeAssembly(p, [osc, vca], 'voice');
    expect(voice.inputs.map((r) => r.port)).toEqual(['pitch', 'cv', 'p1']);
    addChild(p, voice, envs.id);
    expect(voice.children).toEqual([envs.id]);
    expect(voice.inputs.map((r) => r.port)).toEqual(['pitch']); // cv and p1 are fed from inside now
    expect(() => addChild(p, envs, voice.id)).toThrow(/already inside/);
    // moving the parent moves the child and its modules
    const before = p.modules.map((m) => [m.x, m.y]);
    moveAssembly(p, voice, 10, 20);
    expect([envs.x, envs.y]).toEqual([310, 320]);
    p.modules.forEach((m, i) => {
      if (m.id !== kb) expect([m.x, m.y]).toEqual([before[i][0] + 10, before[i][1] + 20]);
    });
    // save: nested assemblies with local ids
    exposePort(envs, 'in', e1, 'gate', [{ module: e2, port: 'gate' }]);
    exposePort(voice, 'in', e1, 'gate', envs.inputs[0].also);
    promote(envs, e1, 'a');
    promote(voice, e1, 'a');
    const def = validateAssemblyDef(JSON.parse(JSON.stringify(toDef(p, voice))), DEFS);
    expect(def.modules).toHaveLength(4);
    expect(def.assemblies).toHaveLength(1);
    expect(def.children).toEqual([1]);
    expect(def.assemblies![0].modules.sort()).toEqual([3, 4]);
    expect(def.inputs.find((r) => r.port === 'gate')!.also).toEqual([{ module: 4, port: 'gate' }]);
    expect(def.params).toEqual([{ module: 3, param: 'a', label: 'a' }]);
    // insert: fresh ids, the tree rebuilt
    const q = emptyPatch('q');
    addModule(q, DEFS.fm1, 0, 0);
    const v2 = insertAssembly(q, DEFS, def, 300, 0);
    expect(q.assemblies).toHaveLength(2);
    const child = parentOf(q, q.assemblies!.find((a) => a.name === 'envs')!.id);
    expect(child).toBe(v2);
    expect(v2.inputs.map((r) => r.port)).toEqual(['pitch', 'gate']);
    expect(v2.params).toHaveLength(1);
    expect(hiddenModules(q).size).toBe(4);
    // a second insert gets unique labels for the nested one too
    insertAssembly(q, DEFS, def, 600, 0);
    expect(q.assemblies!.map((a) => a.label).sort()).toEqual(['envs', 'envs 2', 'voice', 'voice 2']);
    // a bad tree is refused
    expect(() => validateAssemblyDef({ ...def, children: [7] }, DEFS)).toThrow(/does not exist/);
    expect(() => validateAssemblyDef({ ...def, children: [] }, DEFS)).toThrow(/in no assembly/);
    // removeChild frees the child; ungroup of a parent hands its members to the grandparent; delete keeps children
    removeChild(p, voice, envs.id);
    expect(parentOf(p, envs.id)).toBeUndefined();
    expect(voice.inputs.map((r) => r.port)).toEqual(['pitch', 'cv', 'p1']);
    addChild(p, voice, envs.id);
    const amp = makeAssembly(p, [vca], 'amp'); // child of voice
    ungroup(p, voice.id);
    expect(p.assemblies!.map((a) => a.name).sort()).toEqual(['amp', 'envs']);
    expect(parentOf(p, amp.id)).toBeUndefined();
    const v3 = makeAssembly(p, [osc], 'voice');
    addChild(p, v3, envs.id);
    deleteAssembly(p, v3.id);
    expect(p.modules.some((m) => m.id === osc)).toBe(false);
    expect(p.assemblies!.some((a) => a.id === envs.id)).toBe(true);
    expect(allModules(p, envs)).toEqual([e1, e2]);
  });

  it('repairs a bad nesting on load: missing children, two parents, loops and depth', () => {
    const { p, e1, e2, vca, osc } = twoEnv();
    const envs = makeAssembly(p, [e1, e2], 'envs');
    const voice = makeAssembly(p, [osc, vca], 'voice');
    addChild(p, voice, envs.id);
    const raw = JSON.parse(JSON.stringify(p)) as Patch;
    const ok = validatePatch(JSON.parse(JSON.stringify(raw)), DEFS);
    expect(fixAssemblies(ok, DEFS)).toEqual([]);
    expect(parentOf(ok, envs.id)!.id).toBe(voice.id);
    const loop = JSON.parse(JSON.stringify(raw)) as Patch;
    loop.assemblies!.find((a) => a.id === envs.id)!.children = [voice.id];
    const msgs = fixAssemblies(validatePatch(loop, DEFS), DEFS);
    expect(msgs.join(' ')).toMatch(/loop undone/);
    const missing = JSON.parse(JSON.stringify(raw)) as Patch;
    missing.assemblies!.find((a) => a.id === voice.id)!.children = [99];
    expect(fixAssemblies(validatePatch(missing, DEFS), DEFS).join(' ')).toMatch(/missing/);
  });
});

describe('assembly layout metadata', () => {
  it('round-trips collapsed and expanded sizes through patch and nested library files without changing firmware bytes', () => {
    const { p, osc, env, vca } = voice();
    const root = makeAssembly(p, [osc, env, vca], 'Voice');
    const child = makeAssembly(p, [osc], 'Source');
    const before = encodePatch(p);
    root.size = { width: 360, height: 240 }; root.frameSize = { width: 980, height: 720 };
    child.size = { width: 280, height: 180 }; child.frameSize = { width: 360, height: 640 };
    const restored = validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
    fixAssemblies(restored, DEFS);
    expect(restored.assemblies?.map(a => [a.size, a.frameSize])).toEqual(p.assemblies?.map(a => [a.size, a.frameSize]));
    expect(encodePatch(p)).toEqual(before);
    const def = validateAssemblyDef(JSON.parse(JSON.stringify(toDef(p, root))), DEFS);
    const next = emptyPatch(); const inserted = insertAssembly(next, DEFS, def, 0, 0);
    expect(inserted.size).toEqual(root.size); expect(inserted.frameSize).toEqual(root.frameSize);
    expect(next.assemblies?.find(a => a.id !== inserted.id)?.size).toEqual(child.size);
  });
  it('drops invalid dimensions and bounds extreme imports', () => {
    const { p, osc } = voice(); const a = makeAssembly(p, [osc], 'Source');
    a.size = { width: -1, height: 90 }; a.frameSize = { width: 1e9, height: 1 };
    const restored = validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
    fixAssemblies(restored, DEFS);
    expect(restored.assemblies?.[0].size).toBeUndefined();
    expect(restored.assemblies?.[0].frameSize).toEqual({ width: 4000, height: 80 });
  });
});
