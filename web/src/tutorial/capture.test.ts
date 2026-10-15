// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { capture, type Recorded } from './capture';
import { COURSE, CHAPTERS, referenceOf, stepStart } from './chapters';
import { headlessState, noSeen } from './model';
import { partCheck } from './parts';
import type { Patch } from '../patch';

const at = (chapter: number, step: string) => CHAPTERS[chapter].steps.findIndex((s) => s.id === step);
function recorded(chapter: number, step: string, extra: Partial<Recorded> = {}): Recorded {
  return {
    before: stepStart(chapter, at(chapter, step)),
    after: referenceOf(COURSE, COURSE.chapters[chapter].id, step)!.patch,
    seen: noSeen(), probes: [], selected: [], arpPlay: false, audio: false, snapshots: { A: false, B: false }, ...extra,
  };
}
/** every proposal holds on the patch it was captured from */
function holds(rec: Recorded): void {
  const { proposals } = capture(rec, COURSE.roles);
  const s = { ...headlessState(rec.after as Patch), entry: rec.before };
  for (const p of proposals) if (p.part.kind !== 'event') expect(partCheck(p.part, s, COURSE.roles), JSON.stringify(p.part)).toBe(true);
}

describe('capture', () => {
  it('turns putting a VCA between the Oscillator and the Output into the step’s parts', () => {
    const { proposals } = capture(recorded(0, 'vca'), COURSE.roles);
    expect(proposals.map((p) => p.part)).toEqual([
      { kind: 'module', type: 'vca' },
      { kind: 'cable', from: { type: 'osc' }, fromPort: 'out', to: { type: 'vca' }, toPort: 'in' },
      { kind: 'cable', from: { type: 'vca' }, fromPort: 'out', to: { type: 'output' }, toPort: 'l' },
      { kind: 'noCable', from: { type: 'osc' }, fromPort: 'out', to: { type: 'output' }, toPort: 'l' },
    ]);
  });

  it('proposes direction-aware slider checks and names choice values exactly', () => {
    const parts = capture(recorded(1, 'pluck'), COURSE.roles).proposals.map((p) => p.part);
    expect(parts).toContainEqual({ kind: 'slider', ref: { type: 'adsr' }, param: 's', op: 'le', value: 0 });
    const thumb = capture(recorded(1, 'thumb'), COURSE.roles).proposals.map((p) => p.part);
    expect(thumb).toContainEqual({ kind: 'slider', ref: { type: 'osc' }, param: 'wave', op: 'eq', value: 3 });
    expect(thumb).toContainEqual({ kind: 'routed', from: { type: 'adsr' }, fromPort: 'env', to: { type: 'osc' }, param: 'pw' });
  });

  it('names modules inside assemblies through roles', () => {
    const parts = capture(recorded(4, 'delay'), COURSE.roles).proposals.map((p) => p.part);
    expect(parts).toContainEqual({ kind: 'cable', from: { role: 'myVoiceOut' }, fromPort: 'out', to: { type: 'delay' }, toPort: 'in' });
    const grouped = capture(recorded(3, 'group'), COURSE.roles).proposals.map((p) => p.part);
    expect(grouped).toContainEqual({ kind: 'assembly', role: 'myVoice', fact: 'exists' });
  });

  it.each([[0, 'gate'], [2, 'knob'], [3, 'promote'], [5, 'env'], [5, 'nest'], [8, 'macro'], [10, 'mix']] as const)('every proposal for %i/%s holds on the recorded patch', (chapter, step) => {
    holds(recorded(chapter, step));
  });

  it('offers events, unticked when the step also changed the patch', () => {
    const quiet = capture(recorded(0, 'note', { seen: { ...noSeen(), notes: 3 } }), COURSE.roles).proposals;
    expect(quiet).toEqual([{ part: { kind: 'event', event: 'notes' }, keep: true }]);
    const busy = capture(recorded(0, 'vca', { seen: { ...noSeen(), notes: 1 } }), COURSE.roles).proposals;
    expect(busy.find((p) => p.part.kind === 'event')).toEqual({ part: { kind: 'event', event: 'notes' }, keep: false });
  });
});
