// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { addChild, makeAssembly, memberProblem, toDef, insertAssembly, validateAssemblyDef } from './assembly';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, POLY_DEFAULT, type Patch } from './patch';
import { makeRoom, MAX_POLY, polyGroups, POLY_TOP, setPoly } from './poly';
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
  it('on: default settings, a Part inside, Main pitch / gate into it come from the Part, room above for the frame', () => {
    const { p, ids } = rig();
    setPoly(p, DEFS, asm(p, ids.asm), true);
    const a = asm(p, ids.asm);
    expect(a.poly).toEqual(POLY_DEFAULT);
    const part = p.modules.find((m) => m.type === 'part')!;
    expect(a.modules).toContain(part.id);
    expect(p.cables.filter((c) => c.from.module === ids.kb)).toEqual([]);
    expect(p.cables.filter((c) => c.from.module === part.id).map((c) => c.from.port).sort()).toEqual(['gate', 'pitch']);
    expect(Math.min(...a.modules.map((id) => p.modules.find((m) => m.id === id)!.y))).toBeGreaterThanOrEqual(POLY_TOP);
    expect(polyGroups(p)[0].modules.size).toBe(4);
  });

  it('off: the Part cables go back to Main and the Part goes', () => {
    const { p, ids } = rig();
    const before = JSON.stringify(p.cables);
    setPoly(p, DEFS, asm(p, ids.asm), true);
    setPoly(p, DEFS, asm(p, ids.asm), false);
    expect(asm(p, ids.asm).poly).toBeUndefined();
    expect(p.modules.some((m) => m.type === 'part')).toBe(false);
    expect(JSON.stringify(p.cables)).toBe(before);
  });

  it('a Part with other cables stays when Poly goes off', () => {
    const { p, ids } = rig();
    setPoly(p, DEFS, asm(p, ids.asm), true);
    const part = p.modules.find((m) => m.type === 'part')!;
    connect(p, DEFS, { module: part.id, port: 'index' }, { module: ids.osc, port: 'p1' });
    setPoly(p, DEFS, asm(p, ids.asm), false);
    expect(p.modules.some((m) => m.id === part.id)).toBe(true);
  });

  it('refuses nesting a poly assembly in another and a second Part; more than MAX_POLY is allowed (over the FM-1 budget)', () => {
    const { p, ids } = rig();
    const inner = makeAssembly(p, [ids.osc], 'inner');
    setPoly(p, DEFS, asm(p, ids.asm), true);
    expect(() => setPoly(p, DEFS, inner, true)).toThrow(/inside a poly assembly/);
    const outer = asm(p, ids.asm);
    const part2 = addModule(p, DEFS.part, 0, 0);
    expect(memberProblem(p, part2.id, outer)).toMatch(/Part module already/);
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
    a.poly = { ...POLY_DEFAULT };
    makeRoom(p, a);
    expect(p.modules.find((m) => m.id === ids.osc)!.y).toBe(POLY_TOP);
    makeRoom(p, a);
    expect(p.modules.find((m) => m.id === ids.osc)!.y).toBe(POLY_TOP);
  });

  it('a saved poly assembly keeps its settings through the library and back into a patch', () => {
    const { p, ids } = rig();
    setPoly(p, DEFS, asm(p, ids.asm), true);
    asm(p, ids.asm).poly!.parts = 6;
    const def = validateAssemblyDef(JSON.parse(JSON.stringify(toDef(p, asm(p, ids.asm)))), DEFS);
    expect(def.poly?.parts).toBe(6);
    const q = emptyPatch();
    const a = insertAssembly(q, DEFS, def, 0, 0);
    expect(a.poly?.parts).toBe(6);
    expect(polyGroups(q)[0].modules.size).toBe(4);
  });
});
