// SPDX-License-Identifier: GPL-3.0-only
// The tutorial course as data (course.json): chapters, steps, their prose, the parts a step's check is made of, course-wide
// roles and the reference patches. The lesson editor writes it; chapters.ts compiles it into the runtime's Chapter objects.
// This module has no DOM and no module definitions, so the dev server can check a draft's shape with it. The checks that
// need the definitions and the engine are in validate.ts. The design is in docs/TUTORIAL.md.
import type { Patch } from '../patch.ts';
import type { AssemblyDef } from '../assembly.ts';
import { riffProblem, type Riff } from './riff.ts';

export const COURSE_VERSION = 2;

/**
 * Which module a part is about. Checks never use ids: the learner adds modules in any order.
 * - `{ type, index }`: the index-th module of the type (0 = the first)
 * - `{ type, loose: true }`: the first module of the type outside every assembly
 * - `{ role }`: a module role (data or code)
 * - `{ role, type, index }`: the index-th member of that type of an assembly role
 * `every: true` (with a type) means every such module: a cable part then needs a cable to each of them.
 */
export interface Ref {
  role?: string;
  type?: string;
  index?: number;
  loose?: boolean;
  every?: boolean;
}

/** a course-wide role, defined once and used by every chapter */
export type RoleDef =
  /** the smallest assembly whose modules (nested ones included) are at least these types */
  | { kind: 'assembly'; label: string; types: string[] }
  /** the assembly with this library name (the factory drums) */
  | { kind: 'named'; label: string; name: string }
  /** the index-th member of a type of an assembly role */
  | { kind: 'member'; label: string; role: string; type: string; index?: number };

export type SliderOp = 'le' | 'ge' | 'eq' | 'ne' | 'between' | 'changed';
export type Pin = 'p1' | 'p2';
export type AssemblyFact = 'exists' | 'open' | 'collapsed' | 'promoted' | 'exposed' | 'merged' | 'contains' | 'resized' | 'saved';
/** editor events and states a step can wait for; counts are since the step was entered */
export type EventName =
  | 'notes' | 'undos' | 'redos' | 'zooms' | 'flips' | 'shares' | 'bypasses' | 'news' | 'saves'
  | 'audio' | 'arpPlay' | 'snapshotA' | 'snapshotB' | 'probe' | 'selected' | 'bypassed';

/** what a requirement checks; its generated line (parts.ts partLabel) is the default wording the lesson editor inserts */
export type PartSpec =
  | { kind: 'module'; type: string; count?: number; loose?: boolean }
  | { kind: 'cable'; from: Ref; fromPort: string; to: Ref; toPort: string }
  | { kind: 'noCable'; from: Ref; fromPort: string; to: Ref; toPort: string }
  /** a slider in the parameter's units; `changed` compares with the value when the step was entered */
  | { kind: 'slider'; ref: Ref; param: string; op: SliderOp; value?: number; max?: number; tolerance?: number }
  /** a signal dropped on a parameter's thumb: cabled to p1 or p2, with that pin mapped to the parameter */
  | { kind: 'routed'; from: Ref; fromPort: string; to: Ref; param: string }
  | { kind: 'pinMap'; ref: Ref; pin: Pin; param: string }
  | { kind: 'att'; ref: Ref; pin: Pin; op: SliderOp; value: number; max?: number; tolerance?: number }
  /** a macro range of `pin` on `param`, from `min` to `max` in the parameter's units; `depth` also requires that attenuverter */
  | { kind: 'macroRange'; ref: Ref; pin: Pin; param: string; min: number; max: number; depth?: number }
  /** a fact about an assembly role; `type` + `param` / `port` name a member's control, `child` a nested role, `tag` + `name` a save */
  /** `type` + `index` (0-based, absent = the first) name the member module of a promoted / exposed fact */
  | { kind: 'assembly'; role: string; fact: AssemblyFact; type?: string; index?: number; param?: string; port?: string; child?: string; tag?: string; name?: string }
  | { kind: 'voices'; min: number }
  /** `count` (default 1) for counters; `ref` + `port` for a probe; `types` for a selection; `ref` + `on` for a bypass state */
  | { kind: 'event'; event: EventName; count?: number; ref?: Ref; port?: string; types?: string[]; on?: boolean }
  /** the patch rendered offline: `held` = it sounds with a key held, `silent` = nothing without a key */
  | { kind: 'sound'; mode: 'held' | 'silent'; threshold?: number }
  /** a check from the code registry (registry.ts) */
  | { kind: 'custom'; name: string; args?: Record<string, string | number> };

/**
 * A step's requirement: what it checks, plus a permanent `id` (the step's text places it as a checkbox with a link
 * `[the learner's instruction](req:id)`, several ids comma-separated) and `hidden` for a guard the text does not show.
 */
export type Part = PartSpec & { id: string; hidden?: boolean };

export type PartKind = Part['kind'];

/** what a Continue step points at */
export type Pointer =
  | { kind: 'module'; ref: Ref }
  | { kind: 'port'; ref: Ref; port: string; dir: 'in' | 'out' }
  | { kind: 'param'; ref: Ref; param: string }
  | { kind: 'ui'; id: string };

export interface StepData {
  /** permanent: progress and references are keyed by it */
  id: string;
  /** `task`: parts the learner must meet; `continue`: no parts, waits for Continue (reading or listening) */
  kind: 'task' | 'continue';
  title: string;
  text: string;
  why: string;
  /** a task step waits for Continue instead of advancing by itself */
  listen?: boolean;
  optional?: boolean;
  /** a later step of the chapter undoes this one's state: not re-checked afterwards */
  superseded?: boolean;
  parts?: Part[];
  /** a Continue step shows Note / Chord / Riff */
  playback?: boolean;
  /** a Continue step's highlight */
  pointer?: Pointer;
  /** what the Riff button loops on this step (from a MIDI file); absent = the built-in riff */
  riff?: Riff;
}

export type StartRule =
  | { kind: 'new'; voices?: number }
  /** an empty canvas: no modules, not even Main and Output */
  | { kind: 'empty' }
  | { kind: 'continue' }
  | { kind: 'preset'; name: string }
  | { kind: 'patch'; patch: Patch };

export interface ChapterData {
  id: string;
  title: string;
  /** hidden from learners in the built site (the dev server still lists it, marked); absent = published */
  unpublished?: boolean;
  intro: string;
  payoff: string;
  challenge: string;
  /** the name the chapter's patch gets */
  patchName: string;
  start: StartRule;
  steps: StepData[];
}

/** the patch after doing a task step (the step's reference), and the assembly it saved, if any */
export interface Reference {
  patch: Patch;
  saved?: AssemblyDef;
}

export interface CourseData {
  version: typeof COURSE_VERSION;
  roles: Record<string, RoleDef>;
  chapters: ChapterData[];
  /** keyed `chapter/step` */
  references: Record<string, Reference>;
}

export const refKey = (chapter: string, step: string): string => `${chapter}/${step}`;

export const SLIDER_OPS: SliderOp[] = ['le', 'ge', 'eq', 'ne', 'between', 'changed'];
export const ASSEMBLY_FACTS: AssemblyFact[] = ['exists', 'open', 'collapsed', 'promoted', 'exposed', 'merged', 'contains', 'resized', 'saved'];
export const EVENT_NAMES: EventName[] = ['notes', 'undos', 'redos', 'zooms', 'flips', 'shares', 'bypasses', 'news', 'saves', 'audio', 'arpPlay', 'snapshotA', 'snapshotB', 'probe', 'selected', 'bypassed'];
export const PART_KINDS: PartKind[] = ['module', 'cable', 'noCable', 'slider', 'routed', 'pinMap', 'att', 'macroRange', 'assembly', 'voices', 'event', 'sound', 'custom'];

/** a permanent id from a title, unique among `taken` */
export function slugId(title: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = title.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'step';
  let id = base;
  for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
  return id;
}

function fail(path: string, what: string): never { throw new Error(`${path}: ${what}`); }
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const TEXT_MAX = 20000;

/**
 * The shape of a course: what the dev server checks before writing a draft (the full check is validate.ts). Throws with a
 * path on the first problem. `allowEmpty` accepts empty prose (a draft being written).
 */
export function validateShape(value: unknown, allowEmpty = false): asserts value is CourseData {
  const text = (v: unknown, path: string, required: boolean): void => {
    if (typeof v !== 'string' || v.length > TEXT_MAX) fail(path, 'expected text of at most 20,000 characters');
    if (required && !allowEmpty && !(v as string).trim()) fail(path, 'text cannot be empty');
  };
  const id = (v: unknown, path: string): void => { if (typeof v !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(v)) fail(path, 'expected an id of lower-case letters, digits and dashes'); };
  if (!isObj(value)) fail('Course', 'expected an object');
  const c = value as Record<string, unknown>;
  if (c.version !== COURSE_VERSION) fail('Course', 'unsupported course version');
  if (!isObj(c.roles)) fail('Course.roles', 'expected an object');
  for (const [name, r] of Object.entries(c.roles as object)) {
    if (!isObj(r) || !['assembly', 'named', 'member'].includes(String(r.kind))) fail(`Roles.${name}`, 'expected an assembly, named or member role');
    text((r as Record<string, unknown>).label, `Roles.${name}.label`, true);
  }
  if (!Array.isArray(c.chapters)) fail('Course.chapters', 'expected a list');
  if (!isObj(c.references)) fail('Course.references', 'expected an object');
  const chapterIds = new Set<string>();
  (c.chapters as unknown[]).forEach((ch, i) => {
    const path = `Chapter ${i + 1}`;
    if (!isObj(ch)) fail(path, 'expected an object');
    id(ch.id, `${path}.id`);
    if (chapterIds.has(ch.id as string)) fail(`${path}.id`, `"${ch.id}" is used twice`);
    chapterIds.add(ch.id as string);
    text(ch.title, `${path}.title`, true);
    if (ch.unpublished !== undefined && typeof ch.unpublished !== 'boolean') fail(`${path}.unpublished`, 'expected true or false');
    text(ch.intro, `${path}.intro`, true);
    text(ch.payoff, `${path}.payoff`, true);
    text(ch.challenge, `${path}.challenge`, true);
    text(ch.patchName, `${path}.patchName`, true);
    if (!isObj(ch.start) || !['new', 'empty', 'continue', 'preset', 'patch'].includes(String(ch.start.kind))) fail(`${path}.start`, 'expected new, empty, continue, preset or patch');
    if (!Array.isArray(ch.steps)) fail(`${path}.steps`, 'expected a list');
    const stepIds = new Set<string>();
    (ch.steps as unknown[]).forEach((st, k) => {
      const sp = `${path}, step ${k + 1}`;
      if (!isObj(st)) fail(sp, 'expected an object');
      id(st.id, `${sp}.id`);
      if (stepIds.has(st.id as string)) fail(`${sp}.id`, `"${st.id}" is used twice in the chapter`);
      stepIds.add(st.id as string);
      if (st.kind !== 'task' && st.kind !== 'continue') fail(`${sp}.kind`, 'expected task or continue');
      text(st.title, `${sp}.title`, true);
      text(st.text, `${sp}.text`, true);
      text(st.why, `${sp}.why`, false);
      if (st.parts !== undefined && !Array.isArray(st.parts)) fail(`${sp}.parts`, 'expected a list');
      if (st.riff !== undefined && riffProblem(st.riff)) fail(`${sp}.riff`, riffProblem(st.riff));
      const partIds = new Set<string>();
      for (const [j, p] of ((st.parts as unknown[]) ?? []).entries()) {
        if (!isObj(p) || !PART_KINDS.includes(p.kind as PartKind)) fail(`${sp}, part ${j + 1}`, 'unknown requirement kind');
        const pp = `${sp}, part ${j + 1}`;
        id((p as Record<string, unknown>).id, `${pp}.id`);
        if (partIds.has((p as Record<string, unknown>).id as string)) fail(`${pp}.id`, `"${(p as Record<string, unknown>).id}" is used twice in the step`);
        partIds.add((p as Record<string, unknown>).id as string);
        if ((p as Record<string, unknown>).hidden !== undefined && typeof (p as Record<string, unknown>).hidden !== 'boolean') fail(`${pp}.hidden`, 'expected true or false');
      }
    });
  });
  for (const [key, r] of Object.entries(c.references as object)) {
    if (!isObj(r) || !isObj(r.patch) || !Array.isArray(r.patch.modules)) fail(`References.${key}`, 'expected a patch');
  }
}

/**
 * The file's text: two-space JSON, except that every reference patch, stored patch and riff is on one line, so the prose
 * and the requirements stay readable and a re-recorded step is a one-line diff.
 */
export function formatCourse(course: CourseData): string {
  const compact = new Map<string, string>();
  let n = 0;
  const mark = (v: unknown): string => { const key = `\u0000${n++}\u0000`; compact.set(key, JSON.stringify(v)); return key; };
  const copy: CourseData = {
    ...course,
    chapters: course.chapters.map((ch) => ({
      ...ch,
      start: ch.start.kind === 'patch' ? { kind: 'patch', patch: mark(ch.start.patch) as unknown as Patch } : ch.start,
      steps: ch.steps.map((st) => (st.riff ? { ...st, riff: mark(st.riff) as unknown as Riff } : st)),
    })),
    references: Object.fromEntries(Object.entries(course.references).map(([k, r]) => [k, mark(r) as unknown as Reference])),
  };
  const prim = String.raw`(?:"(?:[^"\\\n]|\\.)*"|-?[\d.eE+-]+|true|false|null)`;
  const field = String.raw`"(?:[^"\\\n]|\\.)*": ${prim}`;
  const text = JSON.stringify(copy, null, 2)
    // short lists of plain values and small objects of plain values on one line
    .replace(new RegExp(String.raw`\[\n\s+(${prim}(?:,\n\s+${prim})*)\n\s+\]`, 'g'), (m, body: string) => { const one = `[${body.split(/,\n\s+/).join(', ')}]`; return one.length <= 100 ? one : m; })
    .replace(new RegExp(String.raw`\{\n\s+(${field}(?:,\n\s+${field})*)\n\s+\}`, 'g'), (m, body: string) => { const one = `{ ${body.split(/,\n\s+/).join(', ')} }`; return one.length <= 100 ? one : m; });
  return text.replace(/"\\u0000(\d+)\\u0000"/g, (_, i: string) => compact.get(`\u0000${i}\u0000`)!) + '\n';
}
