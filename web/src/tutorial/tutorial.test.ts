// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Engine } from '../engine';
import { DEFS } from '../modules';
import { validatePatch, type Patch } from '../patch';
import { validateAssemblyDef } from '../assembly';
import { COURSE, CHAPTERS, bundledLibrary, listedChapters, chapterEnd, chapterStart, referenceOf, stepStart, tutorialDef } from './chapters';
import { completes, headlessState, stepDone } from './model';
import { validateCourse } from './validate';
import { formatCourse, slugId, validateShape } from './course-schema';
import { partLabel } from './parts';

const SR = 48000;
/** peak of a second of audio with a C held */
function peak(p: Patch, key = true): number {
  const e = new Engine(SR);
  e.load(validatePatch(JSON.parse(JSON.stringify(p)), DEFS));
  if (key) e.noteOn(60, 0.8);
  e.clockRun(true);
  const l = new Float32Array(128);
  const r = new Float32Array(128);
  let max = 0;
  for (let i = 0; i < SR / 128; i++) {
    if (i % 8 === 0) e.clockTick(); // 24 ppqn at about 120 bpm
    e.render(l, r);
    for (let k = 0; k < 128; k++) max = Math.max(max, Math.abs(l[k]), Math.abs(r[k]));
  }
  return max;
}
const ref = (chapter: number, step: string): Patch => referenceOf(COURSE, COURSE.chapters[chapter].id, step)!.patch;

describe('tutorial course', () => {
  it('has eleven chapters with deliberate listening breaks, every step with a title and text', () => {
    expect(CHAPTERS).toHaveLength(11);
    for (const ch of CHAPTERS) {
      expect(ch.steps.length).toBeGreaterThanOrEqual(6);
      expect(ch.steps.some((st) => st.listen)).toBe(true);
      expect(ch.payoff).toBeTruthy();
      expect(ch.challenge).toBeTruthy();
      expect(ch.intro.trim()).toBeTruthy();
      for (const st of ch.steps) {
        expect(st.title).toBeTruthy();
        expect(st.text.trim()).toBeTruthy();
      }
      expect(new Set(ch.steps.map((s) => s.id)).size).toBe(ch.steps.length);
    }
  });

  it('validates: every reference patch passes its step and the steps before it, every chapter end completes its chapter', () => {
    const report = validateCourse(COURSE);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it.each(CHAPTERS.map((c, i) => [i + 1, c.title] as const))('chapter %i (%s): an unmet step says what is missing and points somewhere', (n) => {
    const i = n - 1;
    for (const [k, st] of CHAPTERS[i].steps.entries()) {
      const s = { ...headlessState(stepStart(i, k), bundledLibrary()), entry: stepStart(i, k) };
      if (!st.check(s)) expect(st.todo!(s).length, `${CHAPTERS[i].id}/${st.id} says nothing about what is missing`).toBeGreaterThan(0);
      if (st.kind === 'task') expect(st.focus!(s).length, `${CHAPTERS[i].id}/${st.id} points at nothing`).toBeGreaterThan(0);
      const r = referenceOf(COURSE, CHAPTERS[i].id, st.id);
      if (r && !st.transient) {
        const done = { ...headlessState(r.patch, bundledLibrary()), entry: stepStart(i, k) };
        expect(st.check(done), `${CHAPTERS[i].id}/${st.id} fails on its reference`).toBe(true);
        expect(st.focus!(done).length, `${CHAPTERS[i].id}/${st.id} loses its anchor once done`).toBeGreaterThan(0);
      }
    }
    expect(JSON.stringify(validatePatch(chapterEnd(i), DEFS))).toBe(JSON.stringify(chapterEnd(i)));
  });

  it('ends where the next chapter starts, and the Examples copies are the ends', () => {
    for (let i = 1; i < CHAPTERS.length; i++) {
      if (COURSE.chapters[i].start.kind !== 'continue') continue;
      expect(JSON.stringify(chapterStart(i))).toBe(JSON.stringify(chapterEnd(i - 1)));
      expect(completes(CHAPTERS[i - 1], chapterStart(i), bundledLibrary())).toBe(true);
    }
    for (let i = 0; i < CHAPTERS.length; i++) expect(chapterEnd(i).modules.length).toBeGreaterThan(2);
  });

  it('chapter 1 drones once the Oscillator reaches the Output, and the VCA silences it until a key opens it', () => {
    expect(peak(ref(0, 'out'), false), 'out: the bare Oscillator drones').toBeGreaterThan(0.01);
    for (const st of ['vca', 'gate', 'note', 'scope', 'wave']) expect(peak(stepStart(0, CHAPTERS[0].steps.findIndex((x) => x.id === st) + 1), false), `${st}: sound without a key`).toBeLessThan(1e-4);
    expect(peak(chapterEnd(0))).toBeGreaterThan(0.01);
  });

  it.each(CHAPTERS.map((c, i) => [i + 1, c.title] as const))('chapter %i (%s): the result makes sound', (n) => {
    expect(peak(chapterEnd(n - 1))).toBeGreaterThan(0.01);
  });

  it('bundles five tagged assemblies that validate, and falls back to them when the library has none', () => {
    const lib = bundledLibrary();
    expect(lib.map((d) => d.tutorial)).toEqual(['my-voice', 'my-space', 'fm-keys', 'pluck', 'hat']);
    for (const d of lib) expect(() => validateAssemblyDef(JSON.parse(JSON.stringify(d)), DEFS)).not.toThrow();
    expect(tutorialDef('my-voice', 'My voice', []).which).toBe('bundled');
    const renamed = { ...lib[0], name: 'Lead' };
    expect(tutorialDef('my-voice', 'My voice', [renamed])).toEqual({ def: renamed, which: 'yours' });
    const named = { ...lib[0], name: 'my voice', tutorial: undefined };
    expect(tutorialDef('my-voice', 'My voice', [named]).which).toBe('yours');
  });

  it('never skips expansion because grouping created an already-collapsed card', () => {
    const ch = CHAPTERS[3];
    const k = ch.steps.findIndex((s) => s.id === 'expand');
    expect(stepDone(ch, k, headlessState(stepStart(3, k)))).toEqual({ met: false, moot: false });
    expect(stepDone(ch, k, headlessState(ref(3, 'expand'))).met).toBe(true);
  });

  it('judges whether a patch continues a chapter by its structure only', () => {
    expect(completes(CHAPTERS[0], chapterEnd(0), [])).toBe(true);
    expect(completes(CHAPTERS[0], chapterStart(0), [])).toBe(false);
    const s = headlessState(chapterEnd(0));
    expect(CHAPTERS[0].steps.find((st) => st.id === 'note')!.check(s)).toBe(false); // transient: not part of the judgement
  });
});

describe('course data', () => {
  it('keeps every patch on one line, and reads back what it wrote', () => {
    const text = formatCourse(COURSE);
    expect(JSON.parse(text)).toEqual(COURSE);
    const line = text.split('\n').find((l) => l.includes('"hello-sound/out"'))!;
    expect(JSON.parse(line.slice(line.indexOf(':') + 1).replace(/,$/, '')).patch.modules.length).toBeGreaterThan(2);
  });

  it('refuses a draft with a duplicate step id or an unknown requirement', () => {
    const dup = structuredClone(COURSE);
    dup.chapters[0].steps[1].id = dup.chapters[0].steps[0].id;
    expect(() => validateShape(dup)).toThrow(/used twice/);
    const odd = structuredClone(COURSE) as unknown as { chapters: { steps: { parts?: unknown[] }[] }[] };
    odd.chapters[0].steps[0].parts = [{ kind: 'telepathy' }];
    expect(() => validateShape(odd)).toThrow(/unknown requirement/);
  });

  it('makes permanent ids from titles', () => {
    expect(slugId('Add a VCA!', [])).toBe('add-a-vca');
    expect(slugId('Add a VCA', ['add-a-vca'])).toBe('add-a-vca-2');
    expect(slugId('', [])).toBe('step');
  });

  it('writes checklist lines the learner can act on', () => {
    const r = COURSE.roles;
    expect(partLabel({ kind: 'cable', from: { type: 'fm1' }, fromPort: 'gate', to: { type: 'vca' }, toPort: 'cv' }, r)).toBe('Cable Main gate → VCA cv');
    expect(partLabel({ kind: 'module', type: 'osc' }, r)).toBe('Add an Oscillator');
    expect(partLabel({ kind: 'slider', ref: { type: 'filter' }, param: 'cutoff', op: 'le', value: 800 }, r)).toBe('Set Filter’s cutoff to 800 Hz or below');
    expect(partLabel({ kind: 'slider', ref: { type: 'osc' }, param: 'wave', op: 'eq', value: 2 }, r)).toBe('Set Oscillator’s wave to saw');
    expect(partLabel({ kind: 'assembly', role: 'myVoice', fact: 'collapsed' }, r)).toBe('Collapse My voice');
  });

  it('catches a reference patch that no longer passes its step', () => {
    const broken = structuredClone(COURSE);
    const out = broken.references['hello-sound/out'].patch;
    out.cables = [];
    const report = validateCourse(broken);
    expect(report.errors.some((e) => e.step === 'out' && /fails its own requirement/.test(e.message))).toBe(true);
  });

  it('catches a requirement that names a port the module does not have', () => {
    const broken = structuredClone(COURSE);
    broken.chapters[0].steps.find((s) => s.id === 'pitch')!.parts = [{ kind: 'cable', from: { type: 'fm1' }, fromPort: 'pitch', to: { type: 'osc' }, toPort: 'nose' }];
    expect(validateCourse(broken).errors[0].message).toMatch(/Oscillator has no input "nose"/);
  });
});

describe('publishing', () => {
  it('offers only published chapters in the built site, and every chapter on the dev server', () => {
    expect(CHAPTERS.map((c) => c.published)).toEqual(CHAPTERS.map((_, i) => i === 0));
    expect(listedChapters(CHAPTERS, false)).toEqual([0]);
    expect(listedChapters(CHAPTERS, true)).toEqual(CHAPTERS.map((_, i) => i));
  });
  it('keeps the flag a boolean, after the title, and absent when published', () => {
    const course = structuredClone(COURSE);
    expect(Object.keys(course.chapters[1]).slice(0, 3)).toEqual(['id', 'title', 'unpublished']);
    expect('unpublished' in course.chapters[0]).toBe(false);
    (course.chapters[1] as unknown as Record<string, unknown>).unpublished = 'yes';
    expect(() => validateShape(course)).toThrow('unpublished');
  });
});
