// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { diffCount, diffLines, diffPatches } from './diff';
import { DEFS } from './modules';
import { PRESETS } from './presets';
import { addModule, connect, removeModule } from './patch';

describe('patch diff', () => {
  it('lists changed parameters, added / removed modules and cables, and the rest as lines', () => {
    const a = PRESETS['303 Acid']();
    const b = PRESETS['303 Acid']();
    expect(diffCount(diffPatches(a, b, DEFS))).toBe(0);
    const flt = b.modules.find((m) => m.type === 'filter')!;
    flt.params.cutoff = 999;
    flt.bypass = true;
    const lfo = addModule(b, DEFS.lfo, 0, 0);
    connect(b, DEFS, { module: lfo.id, port: 'out' }, { module: flt.id, port: 'cv' });
    const dly = b.modules.find((m) => m.type === 'delay')!;
    removeModule(b, dly.id);
    b.voices = 4;
    b.arp = { ...(a.arp ?? { mode: 0, scale: 5, root: 60, octaves: 1, chaos: 0, vchaos: 0, rchaos: 0, steps: 16, pulses: 16, rot: 0, rate: 6, bpm: 120 }), bpm: 140 };
    const d = diffPatches(a, b, DEFS);
    expect(d.params).toHaveLength(1);
    expect(d.params[0]).toMatchObject({ module: flt.id, name: 'cutoff', to: 999 });
    expect(d.added).toEqual([`LFO #${lfo.id}`]);
    expect(d.removed).toEqual([`Delay #${dly.id}`]);
    expect(d.cablesAdded).toHaveLength(1);
    expect(d.cablesRemoved.length).toBeGreaterThan(0); // the delay's cables went with it
    expect(d.other).toContain(`Filter #${flt.id}: bypassed`);
    expect(d.other).toContain('voices 1 → 4');
    expect(d.other.some((s) => s.startsWith('arpeggiator'))).toBe(true);
    const lines = diffLines(d);
    expect(lines[0]).toBe(`Filter #${flt.id} cutoff: ${Number(a.modules.find((m) => m.id === flt.id)!.params.cutoff.toFixed(4))} → 999`);
    expect(lines).toHaveLength(diffCount(d));
  });
});
