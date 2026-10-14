// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Engine } from '../engine';
import { DEFS } from '../modules';
import { validatePatch, type Patch } from '../patch';
import { validateAssemblyDef } from '../assembly';
import { CHAPTERS, chapterEnd, chapterStart, courseRun, tutorialDef } from './chapters';
import { completes, HeadlessSession, headlessState, noSeen, runCourse } from './model';

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

describe('tutorial course', () => {
  const run = courseRun();

  it('has eleven chapters with 6 to 11 steps each, every step with a title, text, check and apply', () => {
    expect(CHAPTERS).toHaveLength(11);
    for (const ch of CHAPTERS) {
      expect(ch.steps.length).toBeGreaterThanOrEqual(6);
      expect(ch.steps.length).toBeLessThanOrEqual(11);
      expect(ch.intro.length).toBeGreaterThan(80);
      for (const st of ch.steps) {
        expect(st.title).toBeTruthy();
        expect(st.text.length).toBeGreaterThan(40);
      }
      expect(new Set(ch.steps.map((s) => s.id)).size).toBe(ch.steps.length);
    }
  });

  it.each(CHAPTERS.map((c, i) => [i + 1, c.title] as const))('chapter %i (%s): every step fails before its turn and passes after "do it for me"', (n) => {
    const i = n - 1;
    const ch = CHAPTERS[i];
    const s = new HeadlessSession(chapterStart(i), runCourse(CHAPTERS.slice(0, i), () => chapterStart(0)).library);
    for (const st of ch.steps) {
      s.state.entry = JSON.parse(JSON.stringify(s.state.patch)) as Patch;
      s.state.seen = noSeen();
      expect(st.check(s.state), `${ch.id}/${st.id} already passes`).toBe(false);
      expect(st.todo!(s.state).length, `${ch.id}/${st.id} says nothing about what is missing`).toBeGreaterThan(0);
      expect(st.focus!(s.state).length, `${ch.id}/${st.id} points at nothing`).toBeGreaterThan(0);
      st.apply(s, s.state);
      expect(st.check(s.state), `${ch.id}/${st.id} fails after apply`).toBe(true);
      expect(st.todo!(s.state)).toEqual([]);
    }
    // applying again changes nothing
    const after = JSON.stringify(s.state.patch);
    for (const st of ch.steps) if (!st.superseded && !st.check(s.state)) st.apply(s, s.state);
    expect(JSON.stringify(s.state.patch)).toBe(after);
    expect(completes(ch, s.state.patch, s.library())).toBe(true);
    expect(JSON.stringify(validatePatch(JSON.parse(after), DEFS))).toBe(after);
  });

  it('ends where the next chapter starts, and the Examples copies are the ends', () => {
    for (let i = 1; i < CHAPTERS.length; i++) {
      if (CHAPTERS[i].start()) continue;
      expect(JSON.stringify(chapterStart(i))).toBe(JSON.stringify(chapterEnd(i - 1)));
      expect(completes(CHAPTERS[i - 1], chapterStart(i), run.library)).toBe(true);
    }
    for (let i = 0; i < CHAPTERS.length; i++) expect(chapterEnd(i).modules.length).toBeGreaterThan(2);
  });

  it('chapter 1 never lets an uncontrolled note through: silent without a key after every step', () => {
    const s = new HeadlessSession(chapterStart(0), []);
    for (const st of CHAPTERS[0].steps) {
      s.state.entry = JSON.parse(JSON.stringify(s.state.patch)) as Patch;
      s.state.seen = noSeen();
      if (!st.check(s.state)) st.apply(s, s.state);
      expect(peak(s.state.patch, false), `${st.id}: sound without a key`).toBeLessThan(1e-4);
    }
    expect(peak(s.state.patch)).toBeGreaterThan(0.01);
  });

  it.each(CHAPTERS.map((c, i) => [i + 1, c.title] as const))('chapter %i (%s): the result makes sound', (n) => {
    expect(peak(chapterEnd(n - 1))).toBeGreaterThan(0.01);
  });

  it('saves five tagged assemblies that validate, and falls back to them when the library has none', () => {
    const tags = ['my-voice', 'my-space', 'fm-keys', 'pluck', 'hat'];
    expect(run.library.map((d) => d.tutorial)).toEqual(tags);
    for (const d of run.library) expect(() => validateAssemblyDef(JSON.parse(JSON.stringify(d)), DEFS)).not.toThrow();
    expect(tutorialDef('my-voice', 'My voice', []).which).toBe('bundled');
    const renamed = { ...run.library[0], name: 'Lead' };
    expect(tutorialDef('my-voice', 'My voice', [renamed])).toEqual({ def: renamed, which: 'yours' });
    const named = { ...run.library[0], name: 'my voice', tutorial: undefined };
    expect(tutorialDef('my-voice', 'My voice', [named]).which).toBe('yours');
  });

  it('judges whether a patch continues a chapter by its structure only', () => {
    expect(completes(CHAPTERS[0], chapterEnd(0), [])).toBe(true);
    expect(completes(CHAPTERS[0], chapterStart(0), [])).toBe(false);
    const s = headlessState(chapterEnd(0));
    expect(CHAPTERS[0].steps.find((st) => st.id === 'note')!.check(s)).toBe(false); // transient: not part of the judgement
  });
});
