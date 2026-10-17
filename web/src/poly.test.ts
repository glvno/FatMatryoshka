// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { addChild, fixAssemblies, makeAssembly, memberProblem, toDef, insertAssembly, validateAssemblyDef } from './assembly';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, validatePatch, type Patch } from './patch';
import { allocatorOf, deviceView, makeRoom, MAX_POLY, polyGroups, POLY_TOP, setPoly } from './poly';
import { addAlloc } from './test-poly';
import { Engine } from './engine';
import { deviceBudget } from './patchbin';

/** Main pitch / gate -> osc / adsr -> vca -> output, the voice grouped as an assembly */
function rig(): { p: Patch; ids: Record<string, number> } {
  const p = emptyPatch();
  const kb = addModule(p, DEFS.fm1, 20, 20);
  const osc = addModule(p, DEFS.osc, 290, 20);
  const env = addModule(p, DEFS.adsr, 560, 20);
  const vca = addModule(p, DEFS.vca, 830, 20);
  const out = addModule(p, DEFS.output, 1100, 20);
  const w = (a: number, ap: string, b: number, bp: string) => expect(connect(p, DEFS, { module: a, port: ap }, { module: b, port: bp })).toBe(true);
  w(kb.id, 'pitch', osc.id, 'pitch');
  w(kb.id, 'gate', env.id, 'gate');
  w(osc.id, 'out', vca.id, 'in');
  w(env.id, 'env', vca.id, 'cv');
  w(vca.id, 'out', out.id, 'l');
  const a = makeAssembly(p, [osc.id, env.id, vca.id], 'voice');
  return { p, ids: { kb: kb.id, osc: osc.id, env: env.id, vca: vca.id, out: out.id, asm: a.id } };
}
const asm = (p: Patch, id: number) => p.assemblies!.find((a) => a.id === id)!;

describe('the Poly switch', () => {
  it('on: a Voice allocator inside (Main keys in), Main pitch / gate into it come from the allocator, room above for the frame', () => {
    const { p, ids } = rig();
    setPoly(p, DEFS, asm(p, ids.asm), true);
    const a = asm(p, ids.asm);
    expect(a.poly).toEqual({});
    const alloc = p.modules.find((m) => m.type === 'alloc')!;
    expect(a.modules).toContain(alloc.id);
    expect(allocatorOf(p, a)).toBe(alloc);
    expect(p.cables.filter((c) => c.from.module === ids.kb).map((c) => `${c.from.port}>${c.to.module}.${c.to.port}`)).toEqual([`keys>${alloc.id}.keys`]);
    expect(p.cables.filter((c) => c.from.module === alloc.id).map((c) => c.from.port).sort()).toEqual(['gate', 'pitch']);
    expect(Math.min(...a.modules.map((id) => p.modules.find((m) => m.id === id)!.y))).toBeGreaterThanOrEqual(POLY_TOP);
    expect(polyGroups(p)[0].modules.size).toBe(3); // the cards; the allocator runs once
    expect(polyGroups(p)[0].cfg.parts).toBe(4);
  });

  it('off: the allocator cables go back to Main and the allocator goes', () => {
    const { p, ids } = rig();
    const before = JSON.stringify(p.cables);
    setPoly(p, DEFS, asm(p, ids.asm), true);
    setPoly(p, DEFS, asm(p, ids.asm), false);
    expect(asm(p, ids.asm).poly).toBeUndefined();
    expect(p.modules.some((m) => m.type === 'alloc')).toBe(false);
    expect(JSON.stringify(p.cables)).toBe(before);
  });

  it('the inputs the allocator inside now feeds stop being exposed (its keys jack shows), and come back when Poly goes off', () => {
    const { p, ids } = rig();
    const ins = (): string[] => asm(p, ids.asm).inputs.map((r) => `${r.module}.${r.port}`).sort();
    const before = ins();
    expect(before).toEqual([`${ids.env}.gate`, `${ids.osc}.pitch`].sort());
    setPoly(p, DEFS, asm(p, ids.asm), true);
    expect(ins()).toEqual([`${p.modules.find((m) => m.type === 'alloc')!.id}.keys`]);
    setPoly(p, DEFS, asm(p, ids.asm), false);
    expect(ins()).toEqual(before);
  });

  it('a saved poly assembly that still exposes inputs its allocator feeds loses those jacks on load', () => {
    const { p, ids } = rig();
    setPoly(p, DEFS, asm(p, ids.asm), true);
    asm(p, ids.asm).inputs.push({ module: ids.osc, port: 'pitch', label: 'pitch' }, { module: ids.env, port: 'gate', label: 'gate' });
    const q = validatePatch(JSON.parse(JSON.stringify(p)), DEFS);
    fixAssemblies(q, DEFS);
    expect(q.assemblies!.find((a) => a.id === ids.asm)!.inputs.map((r) => r.port)).toEqual(['keys']);
  });

  it('an allocator with other cables stays when Poly goes off', () => {
    const { p, ids } = rig();
    setPoly(p, DEFS, asm(p, ids.asm), true);
    const part = p.modules.find((m) => m.type === 'alloc')!;
    const lfo = addModule(p, DEFS.lfo, 0, 0);
    connect(p, DEFS, { module: part.id, port: 'index' }, { module: lfo.id, port: 'p1' });
    setPoly(p, DEFS, asm(p, ids.asm), false);
    expect(p.modules.some((m) => m.id === part.id)).toBe(true);
  });

  it('refuses nesting a poly assembly in another; more than MAX_POLY is allowed (over the FM-1 budget)', () => {
    const { p, ids } = rig();
    const inner = makeAssembly(p, [ids.osc], 'inner');
    setPoly(p, DEFS, asm(p, ids.asm), true);
    expect(() => setPoly(p, DEFS, inner, true)).toThrow(/inside a poly assembly/);
    const outer = asm(p, ids.asm);
    const free = makeAssembly(p, [addModule(p, DEFS.lfo, 0, 0).id], 'lfo');
    setPoly(p, DEFS, free, true);
    expect(() => addChild(p, outer, free.id)).toThrow(/do not nest/);
    for (let i = 0; i < MAX_POLY - 2; i++) setPoly(p, DEFS, makeAssembly(p, [addModule(p, DEFS.noise, 0, 0).id], `n${i}`), true);
    expect(polyGroups(p)).toHaveLength(MAX_POLY);
    setPoly(p, DEFS, makeAssembly(p, [addModule(p, DEFS.noise, 0, 0).id], 'one more'), true);
    expect(polyGroups(p)).toHaveLength(MAX_POLY + 1);
    expect(deviceBudget(p).over.map((i) => i.key)).toContain('poly');
  });

  it('makeRoom moves a poly assembly down only when its top member is too high', () => {
    const { p, ids } = rig();
    const a = asm(p, ids.asm);
    a.poly = {};
    makeRoom(p, a);
    expect(p.modules.find((m) => m.id === ids.osc)!.y).toBe(POLY_TOP);
    makeRoom(p, a);
    expect(p.modules.find((m) => m.id === ids.osc)!.y).toBe(POLY_TOP);
  });

  it('a saved poly assembly keeps its allocator and its settings through the library and back into a patch', () => {
    const { p, ids } = rig();
    setPoly(p, DEFS, asm(p, ids.asm), true);
    p.modules.find((m) => m.type === 'alloc')!.params.voices = 6;
    asm(p, ids.asm).poly!.flaws = [{ detune: 5, drift: 0, bright: 0, env: 0, level: 100 }];
    const def = validateAssemblyDef(JSON.parse(JSON.stringify(toDef(p, asm(p, ids.asm)))), DEFS);
    expect(def.poly?.flaws?.[0].detune).toBe(5);
    expect(def.inputs.map((r) => r.label)).toEqual(['keys']);
    const q = emptyPatch();
    const a = insertAssembly(q, DEFS, def, 0, 0);
    expect(polyGroups(q)[0].modules.size).toBe(3);
    expect(polyGroups(q)[0].cfg).toMatchObject({ parts: 6, flaws: [{ detune: 5 }] });
    expect(a.inputs.map((r) => r.label)).toEqual(['keys']);
  });
});

describe('Voice allocator', () => {
  /** Main keys -> allocator pitch / gate -> osc (level 0.2) -> VCA in a poly assembly -> output l */
  function rack(voices: number, unison = false): { p: Patch; alloc: number; osc: number } {
    const p = emptyPatch();
    const out = addModule(p, DEFS.output, 0, 0);
    out.params.level = 1;
    const al = addAlloc(p, { parts: voices, unison });
    const osc = addModule(p, DEFS.osc, 0, 0);
    const vca = addModule(p, DEFS.vca, 0, 0);
    osc.params.level = 0.2;
    connect(p, DEFS, { module: al.id, port: 'pitch' }, { module: osc.id, port: 'pitch' });
    connect(p, DEFS, { module: al.id, port: 'gate' }, { module: vca.id, port: 'cv' });
    connect(p, DEFS, { module: osc.id, port: 'out' }, { module: vca.id, port: 'in' });
    connect(p, DEFS, { module: vca.id, port: 'out' }, { module: out.id, port: 'l' });
    makeAssembly(p, [osc.id, vca.id], 'cards').poly = {};
    return { p, alloc: al.id, osc: osc.id };
  }
  const peak = (p: Patch, notes: number[]): number => {
    const e = new Engine(48000);
    e.load(p);
    for (const n of notes) e.noteOn(n);
    const l = new Float32Array(4096);
    e.render(l, new Float32Array(4096));
    return Math.max(...l.map(Math.abs));
  };

  it('a poly assembly fed by an allocator outside runs once per voice; one with none runs once', () => {
    const { p, alloc, osc } = rack(3);
    expect(polyGroups(p)[0].cfg.parts).toBe(3);
    expect(polyGroups(p)[0].modules.has(osc)).toBe(true);
    p.cables = p.cables.filter((c) => c.from.module !== alloc);
    expect(polyGroups(p)).toEqual([]);
  });

  it('keys: without Main keys an allocator plays nothing; a keys output goes only into a keys input', () => {
    const { p, alloc } = rack(2);
    expect(peak(p, [60, 64])).toBeGreaterThan(0.3);
    const main = p.modules.find((m) => m.type === 'fm1')!;
    p.cables = p.cables.filter((c) => c.from.port !== 'keys');
    expect(peak(p, [60, 64])).toBe(0);
    expect(connect(p, DEFS, { module: main.id, port: 'keys' }, { module: alloc, port: 'keys' })).toBe(true);
    expect(connect(p, DEFS, { module: main.id, port: 'pitch' }, { module: alloc, port: 'keys' })).toBe(false);
    expect(connect(p, DEFS, { module: main.id, port: 'keys' }, { module: p.modules.find((m) => m.type === 'osc')!.id, port: 'pitch' })).toBe(false);
  });

  it('unison: every voice plays the one note (the FM-1 too: golden kit alloc-unison)', () => {
    const { p } = rack(4, true);
    expect(polyGroups(p)[0].cfg.unison).toBe(true);
    expect(peak(p, [60])).toBeCloseTo(0.8, 2); // four voices on one key, in phase
    expect(deviceBudget(p).fits).toBe(true);
    const { p: q } = rack(4);
    expect(peak(q, [60])).toBeCloseTo(0.2, 2);
  });

  it('device form: the allocator is a Part in its place in every group it drives; voices into a module that runs once sum there', () => {
    const { p, alloc, osc } = rack(2);
    const second = addModule(p, DEFS.osc, 0, 0);
    connect(p, DEFS, { module: alloc, port: 'pitch' }, { module: second.id, port: 'pitch' });
    makeAssembly(p, [second.id], 'layer').poly = {};
    const free = addModule(p, DEFS.vca, 0, 0);
    connect(p, DEFS, { module: alloc, port: 'gate' }, { module: free.id, port: 'cv' });
    const d = deviceView(p);
    expect(d.groups.map((g) => g.cfg.parts)).toEqual([2, 2]);
    const idx = p.modules.findIndex((m) => m.id === alloc);
    expect(d.patch.modules[idx]).toMatchObject({ id: alloc, type: 'part' });
    const parts = d.patch.modules.filter((m) => m.type === 'part').map((m) => m.id);
    expect(parts).toHaveLength(2);
    expect(d.groups[0].modules.has(osc) && d.groups[0].modules.has(parts[0])).toBe(true);
    expect(d.groups[1].modules).toEqual(new Set([second.id, parts[1]]));
    expect(d.patch.cables.some((c) => c.from.port === 'keys')).toBe(false);
    expect(d.patch.cables.find((c) => c.to.module === free.id)!.from.module).toBe(parts[0]);
  });

  it('an allocator of one voice played the keyboard way, feeding no poly assembly, is the shared keyboard', () => {
    const p = emptyPatch();
    const al = addAlloc(p, { parts: 1 });
    const osc = addModule(p, DEFS.osc, 0, 0);
    connect(p, DEFS, { module: al.id, port: 'pitch' }, { module: osc.id, port: 'pitch' });
    expect(deviceView(p).groups).toEqual([]);
    al.params.priority = 1;
    expect(deviceView(p).groups.map((g) => g.cfg.parts)).toEqual([1]);
  });
});
