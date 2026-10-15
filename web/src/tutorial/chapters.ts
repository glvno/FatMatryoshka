// SPDX-License-Identifier: GPL-3.0-only
// The tutorial course, compiled from its data (course.json, written by the lesson editor): each step's check is its parts
// (parts.ts), the panel lists the unmet ones and highlights the first, so a locked Next always says why and points where.
// Canned patches come from the reference patches stored with the steps: a chapter's start is its start rule, a step's
// beginning state is the previous task step's reference, a chapter's end is its last reference. The design is in
// docs/TUTORIAL.md; the data's shape in course-schema.ts.
import content from './course.json';
import { DEFS } from '../modules';
import { newPatch, type Patch } from '../patch';
import { PRESETS } from '../presets';
import type { AssemblyDef } from '../assembly';
import { findDef, type Chapter, type Step, type TutorialState } from './model';
import { momentary, partCheck, partLabel, partTargets, pointerTargets, type Roles } from './parts';
import { refKey, type ChapterData, type CourseData, type StepData } from './course-schema';

export const COURSE = content as unknown as CourseData;

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function compileStep(st: StepData, roles: Roles): Step {
  const parts = st.kind === 'continue' ? [] : st.parts ?? [];
  const ok = (s: TutorialState) => parts.map((p) => partCheck(p, s, roles));
  return {
    id: st.id, kind: st.kind, title: st.title, text: st.text, why: st.why || undefined,
    listen: st.kind === 'continue' || !!st.listen, optional: !!st.optional, superseded: !!st.superseded,
    transient: st.kind === 'continue' || parts.some(momentary), playback: st.kind === 'continue' ? !!st.playback : true,
    check: (s) => ok(s).every(Boolean),
    todo: (s) => { const r = ok(s); return parts.filter((_, i) => !r[i]).map((p) => partLabel(p, roles)); },
    // a done step keeps pointing at its last part, so the panel stays anchored while it says "moving on"
    focus: (s) => {
      if (st.kind === 'continue') return pointerTargets(st.pointer, s, roles);
      const r = ok(s);
      const p = parts[r.findIndex((x) => !x)] ?? parts[parts.length - 1];
      return p ? partTargets(p, s, roles) : [];
    },
  };
}

export function compileChapter(ch: ChapterData, roles: Roles): Chapter {
  return { id: ch.id, title: ch.title, intro: ch.intro, payoff: ch.payoff, challenge: ch.challenge, patchName: ch.patchName, steps: ch.steps.map((st) => compileStep(st, roles)) };
}

export const compileCourse = (course: CourseData): Chapter[] => course.chapters.map((ch) => compileChapter(ch, course.roles));

export const CHAPTERS: Chapter[] = compileCourse(COURSE);

/** the reference of a task step, if it has one */
export const referenceOf = (course: CourseData, chapter: string, step: string) => course.references[refKey(chapter, step)];

/** the last reference patch of a chapter up to (not including) step `before`, else undefined */
function lastReference(course: CourseData, ci: number, before: number): Patch | undefined {
  const ch = course.chapters[ci];
  for (let k = Math.min(before, ch.steps.length) - 1; k >= 0; k--) {
    const r = ch.steps[k].kind === 'task' ? referenceOf(course, ch.id, ch.steps[k].id) : undefined;
    if (r) return r.patch;
  }
  return undefined;
}

/** a chapter's canned start, from its start rule */
export function chapterStart(i: number, course: CourseData = COURSE): Patch {
  const ch = course.chapters[i];
  const fresh = (): Patch => newPatch(DEFS, ch.patchName);
  switch (ch.start.kind) {
    case 'new': { const p = fresh(); if (ch.start.voices && ch.start.voices > 1) p.voices = ch.start.voices; return p; }
    case 'preset': { const make = PRESETS[ch.start.name]; return make ? { ...make(), name: ch.patchName } : fresh(); }
    case 'patch': return clone(ch.start.patch);
    case 'continue': return i > 0 ? clone(chapterEnd(i - 1, course)) : fresh();
  }
}

/** the patch a step begins from: the previous task step's reference, else the chapter's start */
export function stepStart(ci: number, si: number, course: CourseData = COURSE): Patch {
  const r = lastReference(course, ci, si);
  return r ? clone(r) : chapterStart(ci, course);
}

/** a chapter's canned end: its last reference patch (the Examples entries, the intro's preview, the next chapter's start) */
export function chapterEnd(i: number, course: CourseData = COURSE): Patch {
  return stepStart(i, course.chapters[i].steps.length, course);
}

/** the assemblies the course saves, as the bundled copies, in course order */
export function bundledLibrary(course: CourseData = COURSE): AssemblyDef[] {
  const out: AssemblyDef[] = [];
  for (const ch of course.chapters) for (const st of ch.steps) {
    const saved = referenceOf(course, ch.id, st.id)?.saved;
    if (saved) out.push(clone(saved));
  }
  return out;
}

/** the user's saved assembly, else the bundled copy; `which` says what was used */
export function tutorialDef(tag: string, name: string, library: AssemblyDef[]): { def: AssemblyDef; which: 'yours' | 'bundled' } {
  const mine = findDef(library, tag, name);
  if (mine) return { def: mine, which: 'yours' };
  const bundled = findDef(bundledLibrary(), tag, name);
  if (!bundled) throw new Error(`no bundled assembly "${name}"`);
  return { def: bundled, which: 'bundled' };
}

export type { Step, TutorialState };
