// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { capture, type Recorded } from './capture';
import { COURSE, CHAPTERS, referenceOf, stepStart } from './chapters';
import { headlessState, mod, noSeen, place, unwire, wire } from './model';
import { partCheck } from './parts';
import { DEFS } from '../modules';
import { newPatch, type Patch } from '../patch';

const at = (chapter: number, step: string) => CHAPTERS[chapter].steps.findIndex((s) => s.id === step);
function recorded(chapter: number, step: string, extra: Partial<Recorded> = {}): Recorded {
  return {
    before: stepStart(chapter, at(chapter, step)),
    after: referenceOf(COURSE, COURSE.chapters[chapter].id, step)!.patch,
    seen: noSeen(), probes: [], selected: [], arpPlay: false, audio: false, snapshots: { A: false, B: false }, ...extra,
  };
}
const idle = { probes: [], selected: [], arpPlay: false, audio: false, snapshots: { A: false, B: false } };
/** Main, Output and an Oscillator droning into the Output: built here, so these tests do not follow the course's wording */
function drone(): Patch {
  const p = newPatch(DEFS);
  const osc = place(p, 'osc');
  wire(p, mod(p, 'fm1'), 'pitch', osc, 'pitch');
  wire(p, osc, 'out', mod(p, 'output'), 'l');
  return p;
}
/** the drone with a gated VCA put between the Oscillator and the Output */
function gated(): Patch {
  const p = drone();
  const vca = place(p, 'vca');
  unwire(p, mod(p, 'osc'), 'out', mod(p, 'output'), 'l');
  wire(p, mod(p, 'osc'), 'out', vca, 'in');
  wire(p, mod(p, 'fm1'), 'gate', vca, 'cv');
  wire(p, vca, 'out', mod(p, 'output'), 'l');
  return p;
}

/** every proposal holds on the patch it was captured from */
function holds(rec: Recorded): void {
  const { proposals } = capture(rec, COURSE.roles);
  const s = { ...headlessState(rec.after as Patch), entry: rec.before };
  for (const p of proposals) if (p.part.kind !== 'event') expect(partCheck(p.part, s, COURSE.roles), JSON.stringify(p.part)).toBe(true);
}

describe('capture', () => {
  it('turns putting a VCA between the Oscillator and the Output into the step’s parts', () => {
    const { proposals } = capture({ before: drone(), after: gated(), seen: noSeen(), ...idle }, COURSE.roles);
    expect(proposals.map((p) => p.part)).toEqual([
      { kind: 'module', type: 'vca' },
      { kind: 'cable', from: { type: 'osc' }, fromPort: 'out', to: { type: 'vca' }, toPort: 'in' },
      { kind: 'cable', from: { type: 'fm1' }, fromPort: 'gate', to: { type: 'vca' }, toPort: 'cv' },
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

  // every recorded structural step of the course, whatever the lesson editor has made of it since
  const structural = CHAPTERS.flatMap((ch, i) => ch.steps.filter((st) => st.kind === 'task' && !st.transient && referenceOf(COURSE, ch.id, st.id)).map((st) => [i, st.id] as const));
  it.each(structural)('every proposal for %i/%s holds on the recorded patch', (chapter, step) => {
    holds(recorded(chapter, step));
  });

  it('offers events, unticked when the step also changed the patch', () => {
    const quiet = capture({ before: drone(), after: drone(), seen: { ...noSeen(), notes: 3 }, ...idle }, COURSE.roles).proposals;
    expect(quiet).toEqual([{ part: { kind: 'event', event: 'notes' }, keep: true }]);
    const busy = capture({ before: drone(), after: gated(), seen: { ...noSeen(), notes: 1 }, ...idle }, COURSE.roles).proposals;
    expect(busy.find((p) => p.part.kind === 'event')).toEqual({ part: { kind: 'event', event: 'notes' }, keep: false });
  });
});
