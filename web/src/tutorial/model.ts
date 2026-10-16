// SPDX-License-Identifier: GPL-3.0-only
// The tutorial's model: chapters of steps with a structural check, the state the checks can see, and the helpers checks
// use to find modules by shape. The course itself is data (course.json, compiled by chapters.ts). The design is in
// docs/TUTORIAL.md.
import { DEFS } from '../modules';
import { addModule, connect, disconnect, newPatch, sameEnd, type ModuleInst, type Patch } from '../patch';
import { allModules, assembliesOf, freeSpot, hiddenModules, reconcileAll, toDef, type AssemblyDef, type AssemblyInst, type Rect } from '../assembly';
import type { Riff } from './riff';

/** events counted since the current step was entered */
export interface Seen {
  notes: number;
  undos: number;
  redos: number;
  zooms: number;
  flips: number;
  shares: number;
  bypasses: number;
  /** New patch presses */
  news: number;
  saves: number;
}
export const noSeen = (): Seen => ({ notes: 0, undos: 0, redos: 0, zooms: 0, flips: 0, shares: 0, bypasses: 0, news: 0, saves: 0 });

/** what a step's check can look at */
export interface TutorialState {
  patch: Patch;
  /** the patch as it was when the step was entered */
  entry: Patch;
  zoom: number;
  /** scope probes, as probeKey: `${id}:${port}` */
  probes: Set<string>;
  arpPlay: boolean;
  audio: boolean;
  selected: Set<number>;
  /** the user's assembly library */
  library: AssemblyDef[];
  lastSaved?: AssemblyDef;
  snapshots: { A: string | null; B: string | null };
  seen: Seen;
}

export type Target =
  | { kind: 'module'; id: number }
  | { kind: 'asm'; id: number }
  | { kind: 'port'; id: number; port: string; dir: 'in' | 'out' }
  | { kind: 'param'; id: number; param: string }
  /** the ◎ scope-probe button beside an output */
  | { kind: 'probe'; id: number; port: string }
  | { kind: 'ui'; id: string };

export interface Step {
  id: string;
  /** `task`: a check made of parts; `continue`: no requirements, waits for Continue (reading or listening) */
  kind: 'task' | 'continue';
  title: string;
  /** Listening and exploration wait for Continue instead of advancing on a timer. */
  listen?: boolean;
  optional?: boolean;
  /** one action, two or three sentences; the key first, the button in the same sentence */
  text: string;
  /** the idea behind the step, collapsed by default */
  why?: string;
  /** the check looks at editor state or counters, not the patch: skipped when judging whether a patch completes a chapter */
  transient?: boolean;
  /** a later step of the same chapter undoes this one's state (a cable replaced): not re-checked afterwards */
  superseded?: boolean;
  check(s: TutorialState): boolean;
  /** the unmet parts of the check as generated lines ("Cable Main gate → VCA cv"), for messages */
  todo?(s: TutorialState): string[];
  /** whether each requirement is met, by id (the text's checkboxes) */
  met?(s: TutorialState): Record<string, boolean>;
  /** the elements of these requirements (a checkbox the learner clicked) */
  targetsOf?(ids: string[], s: TutorialState): Target[];
  /** the elements of the first unmet part: what the highlight points at next */
  focus?(s: TutorialState): Target[];
  /** a Continue step shows the playback buttons */
  playback?: boolean;
  /** what the Riff button loops; absent = the built-in riff */
  riff?: Riff;
  /** fallback highlight when `focus` gives nothing */
  target?(s: TutorialState): Target[];
}

export interface Chapter {
  id: string;
  title: string;
  /** the synthesis idea of the chapter, shown before the first step */
  intro: string;
  /** the name the chapter's patch gets */
  patchName: string;
  /** learners see it; the dev server lists unpublished chapters too */
  published: boolean;
  /** the tour, outside the numbered chapters */
  tour: boolean;
  steps: Step[];
  payoff?: string;
  challenge?: string;
}

// ---- helpers for checks and applies

export const CARD = { w: 250, h: 540 };
export const mods = (p: Patch, type: string): ModuleInst[] => p.modules.filter((m) => m.type === type);
/** A module on the canvas, outside every assembly. */
export const loose = (p: Patch, type: string): ModuleInst | undefined => p.modules.find((m) => m.type === type && !assembliesOf(p).some((a) => allModules(p, a).includes(m.id)));
export const mod = (p: Patch, type: string, i = 0): ModuleInst | undefined => mods(p, type)[i];
export const has = (p: Patch, type: string, n = 1): boolean => mods(p, type).length >= n;
export const byId = (p: Patch, id: number): ModuleInst | undefined => p.modules.find((m) => m.id === id);
export function cabled(p: Patch, a: ModuleInst | undefined, ap: string, b: ModuleInst | undefined, bp: string): boolean {
  return !!a && !!b && p.cables.some((c) => sameEnd(c.from, { module: a.id, port: ap }) && sameEnd(c.to, { module: b.id, port: bp }));
}
export function wire(p: Patch, a: ModuleInst | undefined, ap: string, b: ModuleInst | undefined, bp: string): void {
  if (!a || !b) throw new Error('a module of this step is missing');
  connect(p, DEFS, { module: a.id, port: ap }, { module: b.id, port: bp });
}
export function unwire(p: Patch, a: ModuleInst | undefined, ap: string, b: ModuleInst | undefined, bp: string): void {
  if (a && b) disconnect(p, { from: { module: a.id, port: ap }, to: { module: b.id, port: bp } });
}
/** any cable into this input */
export const fed = (p: Patch, m: ModuleInst | undefined, port: string): boolean => !!m && p.cables.some((c) => sameEnd(c.to, { module: m.id, port }));
/** the module feeding this input, if one cable does */
export const feeder = (p: Patch, m: ModuleInst | undefined, port: string): ModuleInst | undefined => {
  const c = m && p.cables.find((c) => sameEnd(c.to, { module: m.id, port }));
  return c && byId(p, c.from.module);
};

/** the footprint of every visible card; a new one goes to the first free grid cell */
export function place(p: Patch, type: string): ModuleInst {
  const hidden = hiddenModules(p);
  const occupied: Rect[] = p.modules.filter((m) => !hidden.has(m.id)).map((m) => ({ x: m.x, y: m.y, w: CARD.w, h: CARD.h }));
  for (const a of assembliesOf(p)) {
    if (!a.open) occupied.push({ x: a.x, y: a.y, w: CARD.w, h: CARD.h });
    else {
      const ms = allModules(p, a).map((id) => byId(p, id)!).filter(Boolean);
      if (!ms.length) continue;
      const x = Math.min(...ms.map((m) => m.x)) - 12;
      const y = Math.min(...ms.map((m) => m.y)) - 42;
      occupied.push({ x, y, w: Math.max(...ms.map((m) => m.x)) + CARD.w + 12 - x, h: Math.max(...ms.map((m) => m.y)) + CARD.h + 12 - y });
    }
  }
  const at = freeSpot(occupied, CARD.w, CARD.h);
  return addModule(p, DEFS[type], at.x, at.y);
}

/** the assembly whose member modules (nested ones included) are at least these types */
export function asmLike(p: Patch, types: string[]): AssemblyInst | undefined {
  const fits = assembliesOf(p).filter((a) => {
    const inside = allModules(p, a).map((id) => byId(p, id)?.type);
    const left = [...types];
    for (const t of inside) {
      const i = left.indexOf(t ?? '');
      if (i >= 0) left.splice(i, 1);
    }
    return !left.length;
  });
  // the smallest one: a parent that holds a matching child is not the match
  return fits.sort((a, b) => allModules(p, a).length - allModules(p, b).length)[0];
}
/** the member of this assembly with this type */
export const member = (p: Patch, a: AssemblyInst | undefined, type: string, i = 0): ModuleInst | undefined =>
  a && allModules(p, a).map((id) => byId(p, id)!).filter((m) => m?.type === type)[i];
export const asmOf = (p: Patch, m: ModuleInst | undefined): AssemblyInst | undefined => m && assembliesOf(p).find((a) => allModules(p, a).includes(m.id));

/** a saved tutorial assembly: by tag, then by name */
export const findDef = (lib: AssemblyDef[], tag: string, name: string): AssemblyDef | undefined =>
  lib.find((d) => d.tutorial === tag) ?? lib.find((d) => d.name.trim().toLowerCase() === name.toLowerCase());

/** The current instrument itself must have been saved during this step, not an unrelated library item. */
export function savedAssembly(s: TutorialState, a: AssemblyInst | undefined): boolean {
  if (!a || !s.lastSaved || !s.seen.saves) return false;
  const content = (d: AssemblyDef): string => JSON.stringify([d.name, d.modules, d.cables, d.inputs, d.outputs, d.params, d.children, d.assemblies]);
  const expected = content(toDef(s.patch, a));
  return content(s.lastSaved) === expected && s.library.some((d) => content(d) === expected);
}

export const T = {
  module: (id: number | undefined): Target[] => (id === undefined ? [] : [{ kind: 'module', id }]),
  asm: (id: number | undefined): Target[] => (id === undefined ? [] : [{ kind: 'asm', id }]),
  port: (m: ModuleInst | undefined, port: string, dir: 'in' | 'out'): Target[] => (m ? [{ kind: 'port', id: m.id, port, dir }] : []),
  param: (m: ModuleInst | undefined, param: string): Target[] => (m ? [{ kind: 'param', id: m.id, param }] : []),
  probe: (m: ModuleInst | undefined, port: string): Target[] => (m ? [{ kind: 'probe', id: m.id, port }] : []),
  ui: (id: string): Target[] => [{ kind: 'ui', id }],
};

/** the checks a patch must pass to count as this chapter's result (the editor-state ones are skipped) */
export function completes(ch: Chapter, patch: Patch, library: AssemblyDef[]): boolean {
  const s = headlessState(patch, library);
  return ch.steps.filter((st) => !st.transient && !st.superseded).every((st) => st.check(s));
}

/** Only work observed for this step counts. A later default state must never skip a prerequisite. */
export function stepDone(ch: Chapter, i: number, s: TutorialState): { met: boolean; moot: boolean } {
  const st = ch.steps[i];
  const met = st.check(s);
  // A later default (for example, a newly grouped assembly is collapsed) is not evidence of work.
  const moot = false;
  return { met, moot };
}

export function headlessState(patch: Patch, library: AssemblyDef[] = []): TutorialState {
  return { patch, entry: patch, zoom: 1, probes: new Set(), arpPlay: false, audio: false, selected: new Set(), library, snapshots: { A: null, B: null }, seen: noSeen() };
}
