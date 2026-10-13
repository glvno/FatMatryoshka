// SPDX-License-Identifier: GPL-3.0-only
// The TypeScript arpeggiator against the checks of firmware/test/arp_test.c (the same settings, timing and modes).
import { describe, expect, it } from 'vitest';
import { Arp, ARP_DEFAULT, ARP_SCALES, euclidGate, fixArp, packArp, unpackArp, type ArpCfg, type ArpTarget } from './arp';
import { DEFS } from './modules';
import { emptyPatch, validatePatch } from './patch';

const SR = 44100;
/** C major, 1/16 at 120 bpm: a step every 125 ms = 5512.5 frames = 43 blocks of 128 */
const BASE: ArpCfg = { mode: 0, scale: 1, root: 60, octaves: 1, chaos: 0, vchaos: 0, rchaos: 0, steps: 16, pulses: 16, rot: 0, rate: 6, bpm: 120 };

class Rec implements ArpTarget {
  notes: number[] = [];
  vels: number[] = [];
  on = new Set<number>();
  ticks = 0;
  noteOn(note: number, vel: number): void {
    this.notes.push(note);
    this.vels.push(vel);
    this.on.add(note);
  }
  noteOff(note: number): void {
    this.on.delete(note);
  }
  clockTick(): void {
    this.ticks++;
  }
}

function run(cfg: Partial<ArpCfg>, blocks: number, play = true): { arp: Arp; rec: Rec } {
  const arp = new Arp(SR);
  arp.set({ ...BASE, ...cfg });
  arp.play = play;
  const rec = new Rec();
  for (let i = 0; i < blocks; i++) arp.run(128, rec);
  return { arp, rec };
}

describe('arpeggiator', () => {
  it('UP walks the scale at the rate, wraps to the root, default velocity 100', () => {
    const { rec } = run({}, 43 * 10 + 5);
    expect(rec.notes.length === 10 || rec.notes.length === 11).toBe(true);
    for (let i = 0; i < 8; i++) expect(rec.notes[i]).toBe(60 + ARP_SCALES[1].notes[i % 8]);
    expect(rec.notes[8]).toBe(60);
    expect(rec.vels[0]).toBeCloseTo(100 / 127, 9);
    expect(rec.ticks).toBeGreaterThan(10 * 6 - 1); // 24 ppqn: six ticks per 1/16
  });

  it('DOWN, INCLUDE (ends twice) and EXCLUDE (ends once)', () => {
    expect(run({ mode: 1 }, 43 * 4 + 5).rec.notes.slice(0, 3)).toEqual([72, 71, 69]);
    const inc = run({ mode: 2, scale: 40 }, 43 * 8 + 5).rec.notes; // a major triad: 3 notes
    expect(inc.slice(0, 8)).toEqual([60, 64, 67, 67, 64, 60, 60, 64]);
    const exc = run({ mode: 3, scale: 40 }, 43 * 8 + 5).rec.notes;
    expect(exc.slice(0, 8)).toEqual([60, 64, 67, 64, 60, 64, 67, 64]);
  });

  it('the Euclidean rhythm leaves rests, rotation shifts it, the gate ends at 65 % of the step', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7].map((i) => euclidGate(8, 3, i))).toEqual([false, false, true, false, false, true, false, true]);
    const { rec } = run({ steps: 8, pulses: 3 }, 43 * 8 + 5);
    expect(rec.notes.length).toBe(3);
    const rot = run({ steps: 8, pulses: 3, rot: 2 }, 43 * 8 - 5); // eight steps: the rotated pattern x..x.x.. has its three hits at 0, 3, 5
    expect(rot.rec.notes.length).toBe(3);
    expect(rot.rec.notes).toEqual([60, 65, 69]);
    // the gate: a note on at the first block, off before 65 % of 43 blocks (28) + 1
    const arp = new Arp(SR);
    arp.set(BASE);
    arp.play = true;
    const rec2 = new Rec();
    arp.run(128, rec2);
    expect(rec2.on.size).toBe(1);
    for (let i = 0; i < 26; i++) arp.run(128, rec2);
    expect(rec2.on.size).toBe(1);
    for (let i = 0; i < 3; i++) arp.run(128, rec2);
    expect(rec2.on.size).toBe(0);
  });

  it('a slower rate halves the steps; stop ends the note; octaves widen the pool', () => {
    expect(run({ rate: 4 }, 43 * 10 + 5).rec.notes.length).toBeLessThanOrEqual(6); // 1/8
    const arp = new Arp(SR);
    arp.set(BASE);
    arp.play = true;
    const rec = new Rec();
    arp.run(128, rec);
    expect(rec.on.size).toBe(1);
    arp.play = false;
    arp.run(128, rec);
    expect(rec.on.size).toBe(0);
    expect(arp.stepUi).toBe(0);
    const wide = run({ octaves: 3 }, 43 * 24 + 5).rec.notes;
    expect(Math.max(...wide)).toBeGreaterThanOrEqual(84);
  });

  it('random modes stay in the pool and chaos changes notes', () => {
    for (const mode of [4, 5, 6]) {
      const { rec } = run({ mode, chaos: 50, vchaos: 50, rchaos: 20 }, 43 * 32 + 5);
      expect(rec.notes.length).toBeGreaterThan(10);
      for (const n of rec.notes) expect(ARP_SCALES[1].notes.map((x) => 60 + x)).toContain(n);
    }
    const a = run({ mode: 0, chaos: 100 }, 43 * 16 + 5).rec.notes;
    expect(a).not.toEqual(run({ mode: 0 }, 43 * 16 + 5).rec.notes);
  });

  it('settings: fixArp clamps and keeps pulses / rotation inside the steps; pack / unpack round trip; a patch carries them', () => {
    expect(fixArp({ steps: 40, pulses: 99, rot: 50, bpm: 1000, mode: 9, octaves: 0, root: -3 })).toEqual({ ...ARP_DEFAULT, steps: 32, pulses: 32, rot: 31, bpm: 300, mode: 6, octaves: 1, root: 0 });
    expect(fixArp('junk')).toEqual(ARP_DEFAULT);
    const c: ArpCfg = { ...BASE, bpm: 275, rot: 5 };
    expect(packArp(c)).toHaveLength(13);
    expect(unpackArp(packArp(c))).toEqual(c);
    const p = emptyPatch();
    p.arp = { ...c, steps: 200 } as ArpCfg;
    expect(validatePatch(JSON.parse(JSON.stringify(p)), DEFS).arp).toEqual({ ...c, steps: 32 });
    delete p.arp;
    expect(validatePatch(JSON.parse(JSON.stringify(p)), DEFS).arp).toBeUndefined();
  });
});
