// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DEFS } from './modules';
import { addModule } from './patch';
import { GROUP_REC, deviceBudget, DEVICE, encodePatch, MAX_CABLES, recordSize, TYPE_ORDER, VERSION } from './patchbin';
import { PRESETS } from './presets';
import { polyGroups } from './poly';
import { polyCfg, withParts } from './test-poly';

describe('binary patch format', () => {
  it('the assembly overlay of the factory patches never reaches the binary (it is editor-only)', () => {
    let grouped = 0;
    for (const [name, make] of Object.entries(PRESETS)) {
      const p = make();
      const flat = { ...p, assemblies: undefined };
      delete flat.assemblies;
      expect(Array.from(encodePatch(p)), name).toEqual(Array.from(encodePatch(flat)));
      if (p.assemblies?.length) grouped++;
    }
    expect(grouped).toBeGreaterThanOrEqual(25); // 29 of 33 open as a few cards; subtractive saw, snare, organ and drone stay flat
  });

  it('never writes the legacy disabled-input masks (format 17) and keeps macro ranges last', () => {
    const p = PRESETS['Wobble 2']();
    const filter = p.modules.find((m) => m.type === 'filter')!;
    const before = encodePatch(p);
    const cables = structuredClone(p.cables);
    (filter as { disabledInputs?: string[] }).disabledInputs = ['cv']; // what an older editor may have saved
    filter.range = { p1: { cutoff: [.2, .8] } };
    filter.map!.p1 = ['cutoff'];
    const b = encodePatch(p);
    expect(b[1]).toBe(21); // no unison: still format 21
    expect(b[6]).toBe(2);
    expect(b.length).toBe(before.length + 6);
    expect(b[before.length]).toBe(1); // macro range count
    expect(p.cables).toEqual(cables);
  });

  it('encodes side-input fan-out after morph, before macro ranges', () => {
    const p = PRESETS['Wobble 2']();
    const filter = p.modules.find((m) => m.type === 'filter')!;
    filter.paramsB = { ...filter.params, cutoff: 4000 };
    const before = encodePatch(p);
    filter.inputMap = { cv: ['res', 'cvamt'], in: ['track'] };
    filter.range = { p1: { cutoff: [.2, .8] } }; filter.map!.p1 = ['cutoff'];
    const b = encodePatch(p);
    expect(b[1]).toBe(21); // no unison: still format 21 expect(b[6]).toBe(11);
    expect(b.length).toBe(before.length + 9 + 6);
    expect(b[before.length]).toBe(2);
    const dv = new DataView(b.buffer);
    for (const [i, port] of ['in', 'cv'].entries()) {
      const at = before.length + 1 + i * 4;
      expect(b[at]).toBe(p.modules.indexOf(filter));
      expect(b[at + 1]).toBe(DEFS.filter.inputs.findIndex((pd) => pd.name === port));
      expect(dv.getUint16(at + 2, true)).toBe(DEFS.filter.params.reduce((mask, pd, j) => mask | (filter.inputMap![port].includes(pd.name) ? 1 << j : 0), 0));
    }
    expect(b[before.length + 9]).toBe(1);
  });

  it('counts a summing buffer for an input with two sources, routes or not', () => {
    const p = PRESETS['Wobble 2']();
    const filter = p.modules.find((m) => m.type === 'filter')!;
    const cable = p.cables.find((c) => c.to.module === filter.id && c.to.port === 'cv')!;
    const one = deviceBudget(p);
    p.cables.push(structuredClone(cable));
    expect(deviceBudget(p).buffers).toBe(one.buffers + 1);
    filter.inputMap = { cv: ['res'] };
    expect(deviceBudget(p).buffers).toBe(one.buffers + 1);
  });

  it('encodes every preset with the documented layout', () => {
    for (const [name, make] of Object.entries(PRESETS)) {
      const p = make();
      const b = encodePatch(p);
      const dv = new DataView(b.buffer);
      expect(b[0], name).toBe(0xa1);
      expect(b[1], name).toBe(21);
      expect(b[2], name).toBe(p.modules.length);
      expect(b[3], name).toBe(0); // poly groups: the factory presets have none
      expect(dv.getUint16(4, true), name).toBe(p.cables.length);
      const size = 8 + p.modules.reduce((s, m) => s + 1 + 4 * DEFS[m.type].params.length + (DEFS[m.type].paramInputs ? 20 : 0), 0) + 4 * p.cables.length;
      expect(b.length, name).toBe(size);
      expect(p.cables.length).toBeLessThanOrEqual(MAX_CABLES);
    }
  });

  it('counts what a patch costs on the device: every factory preset fits, and voices multiply the per-voice part', () => {
    for (const [name, make] of Object.entries(PRESETS)) expect(deviceBudget(make()).fits, name).toBe(true);
    const mono = deviceBudget(PRESETS['Subtractive saw']());
    const p = withParts(PRESETS['Subtractive saw'](), 4);
    const poly = deviceBudget(p);
    expect(poly.instances).toBeGreaterThan(mono.instances);
    expect(poly.buffers).toBeGreaterThan(mono.buffers);
    expect(poly.fits).toBe(true);
    polyCfg(p).parts = 8;
    expect(deviceBudget(p).instances).toBeLessThanOrEqual(DEVICE.instances);
  });

  it('unison: bit 7 of the group\'s legato byte, and only then format 22', () => {
    const p = withParts(PRESETS['Subtractive saw'](), 4, { legato: 1 });
    expect(encodePatch(p)[1]).toBe(21);
    polyCfg(p).unison = true;
    const b = encodePatch(p);
    expect(b[1]).toBe(VERSION);
    expect(b[10]).toBe(0x80 | 1);
  });

  it('writes the poly groups after the header: their settings, then every module\'s group', () => {
    const p = withParts(PRESETS['Subtractive saw'](), 4, { assign: 1, legato: 2, priority: 1, flaws: [{ detune: -7, drift: 40, bright: 5, env: -20, level: 80 }] });
    const b = encodePatch(p);
    expect(b[3]).toBe(1);
    expect(Array.from(b.slice(8, 12))).toEqual([4, 1, 2, 1]);
    expect(Array.from(b.slice(12, 22))).toEqual([256 - 7, 40, 5, 256 - 20, 80, 0, 0, 0, 0, 100]); // part 1's flaws, part 2 has none
    const at = 8 + GROUP_REC;
    const members = polyGroups(p)[0].modules;
    // the allocator is written in its place as the group's Part (poly.ts deviceView)
    expect(Array.from(b.slice(at, at + p.modules.length))).toEqual(p.modules.map((m) => (members.has(m.id) || m.type === 'alloc' ? 1 : 0)));
    expect(b[at + p.modules.length + p.modules.slice(0, p.modules.findIndex((m) => m.type === 'alloc')).reduce((n, m) => n + recordSize(m.type), 0)]).toBe(TYPE_ORDER.indexOf('part'));
    expect(b.slice(at, at + p.modules.length).some((g) => g === 0)).toBe(true); // Main and Output run once
    expect(b[at + p.modules.length]).toBe(TYPE_ORDER.indexOf(p.modules[0].type)); // the module records follow
  });

  it('writes parameters as Q16.16 and cables as indices', () => {
    const p = PRESETS['Subtractive saw']();
    const b = encodePatch(p);
    // module 0 is the FM-1 panel (type byte + 4 parameters); module 1 osc starts right after
    const osc = 8 + 1 + 4 * DEFS.fm1.params.length;
    expect(b[8]).toBe(TYPE_ORDER.indexOf('fm1'));
    expect(b[osc]).toBe(TYPE_ORDER.indexOf('osc'));
    const dv = new DataView(b.buffer);
    expect(dv.getInt32(osc + 1, true)).toBe(2 * 65536); // wave = saw (2)
    const att = osc + 1 + 4 * DEFS.osc.params.length; // osc: att1, att2, then the masks p1 p2 k1 k2 k3 k4
    expect(dv.getInt32(att, true)).toBe(65536);
    expect(dv.getInt32(att + 4, true)).toBe(65536);
    expect(Array.from(b.slice(att + 8, att + 20))).toEqual([1, 0, 2, 0, 1, 0, 2, 0, 4, 0, 8, 0]); // the default matrix, u16 LE
    const cab = b.length - 4 * p.cables.length;
    expect([b[cab], b[cab + 1], b[cab + 2], b[cab + 3]]).toEqual([0, DEFS.fm1.outputs.findIndex((o) => o.name === 'pitch'), 1, DEFS.osc.inputs.findIndex((i) => i.name === 'pitch')]);
  });

  it('lists every FM-1 limit, and a patch over one plays in the browser but is never encoded', () => {
    const p = PRESETS['Subtractive saw']();
    const b = deviceBudget(p);
    expect(b.items.map((i) => i.key)).toEqual(Object.keys(DEVICE));
    expect(b.items.find((i) => i.key === 'bytes')!.used).toBe(encodePatch(p).length);
    expect(b.use).toBeGreaterThan(0);
    expect(b.use).toBeLessThanOrEqual(1);
    while (p.modules.length <= DEVICE.modules) addModule(p, DEFS.const, 0, 0);
    const over = deviceBudget(p);
    expect(over.fits).toBe(false);
    expect(over.over.map((i) => i.key)).toContain('modules');
    expect(() => encodePatch(p)).toThrow(/over the FM-1 budget: modules/);
    const two = PRESETS['Subtractive saw']();
    for (let i = 0; i < 2; i++) addModule(two, DEFS.reverb, 0, 0);
    expect(deviceBudget(two).over.map((i) => i.key)).toEqual(['reverbs']);
  });
});
