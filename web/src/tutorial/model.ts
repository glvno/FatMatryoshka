// SPDX-License-Identifier: GPL-3.0-only
// The tutorial's model: chapters of steps with a structural check and a "do it for me" apply, the state the checks can
// see, the actions an apply may take, and a headless session that runs the course without a DOM (canned chapter starts
// and ends, bundled copies of the assemblies the course saves, tests). The design is in docs/TUTORIAL.md.
import { DEFS } from '../modules';
import { addModule, connect, disconnect, sameEnd, type ModuleInst, type Patch } from '../patch';
import { allModules, assembliesOf, freeSpot, hiddenModules, reconcileAll, type AssemblyDef, type AssemblyInst, type Rect } from '../assembly';

/** events counted since the current step was entered */
export interface Seen {
  notes: number;
  undos: number;
  redos: number;
  zooms: number;
  flips: number;
  shares: number;
  bypasses: number;
}
export const noSeen = (): Seen => ({ notes: 0, undos: 0, redos: 0, zooms: 0, flips: 0, shares: 0, bypasses: 0 });

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
  snapshots: { A: string | null; B: string | null };
  seen: Seen;
}

/** what "do it for me" may do; the host wires these to the editor, the headless session to its own state */
export interface Actions {
  patch(): Patch;
  /** a structural change (undoable in the editor) */
  edit(fn: (p: Patch) => void): void;
  /** replace the patch */
  load(p: Patch): void;
  setZoom(z: number): void;
  zoomToFit(): void;
  probe(moduleId: number, port: string): void;
  arpPlay(on: boolean): void;
  select(ids: number[]): void;
  undo(): void;
  redo(): void;
  /** play a C for a moment */
  note(): void;
  startAudio(): void;
  /** put a definition into the library, tagged for later chapters (replaces one with the same tag or name) */
  saveAssembly(def: AssemblyDef, tag: string): void;
  library(): AssemblyDef[];
  snapshot(side: 'A' | 'B'): void;
  flipAB(): void;
  share(): void;
  bypass(moduleId: number, on: boolean): void;
}

export type Target =
  | { kind: 'module'; id: number }
  | { kind: 'asm'; id: number }
  | { kind: 'port'; id: number; port: string; dir: 'in' | 'out' }
  | { kind: 'param'; id: number; param: string }
  | { kind: 'ui'; id: string };

export interface Step {
  id: string;
  title: string;
  /** one action, two or three sentences; the key first, the button in the same sentence */
  text: string;
  /** the idea behind the step, collapsed by default */
  why?: string;
  /** the check looks at editor state or counters, not the patch: skipped when judging whether a patch continues a chapter */
  transient?: boolean;
  /** a later step of the same chapter undoes this one's state (a cable replaced): not re-checked afterwards */
  superseded?: boolean;
  check(s: TutorialState): boolean;
  /** the unmet parts of the check, as the panel lists them ("a cable Main gate → VCA cv") */
  todo?(s: TutorialState): string[];
  /** the elements of the first unmet part: what the highlight points at next */
  focus?(s: TutorialState): Target[];
  apply(a: Actions, s: TutorialState): void;
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
  /** the canned start: a fresh patch, or null to continue with the previous chapter's end (its canned end when the open
   * patch does not continue it) */
  start(): Patch | null;
  /** true: the runtime loads nothing at the start, the user keeps the open patch (the headless run uses `start()`) */
  keep?: boolean;
  steps: Step[];
}

// ---- helpers for checks and applies

export const CARD = { w: 250, h: 540 };
export const mods = (p: Patch, type: string): ModuleInst[] => p.modules.filter((m) => m.type === type);
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

export const T = {
  module: (id: number | undefined): Target[] => (id === undefined ? [] : [{ kind: 'module', id }]),
  asm: (id: number | undefined): Target[] => (id === undefined ? [] : [{ kind: 'asm', id }]),
  port: (m: ModuleInst | undefined, port: string, dir: 'in' | 'out'): Target[] => (m ? [{ kind: 'port', id: m.id, port, dir }] : []),
  param: (m: ModuleInst | undefined, param: string): Target[] => (m ? [{ kind: 'param', id: m.id, param }] : []),
  ui: (id: string): Target[] => [{ kind: 'ui', id }],
};

/** the checks a patch must pass to count as this chapter's result (the editor-state ones are skipped) */
export function completes(ch: Chapter, patch: Patch, library: AssemblyDef[]): boolean {
  const s = headlessState(patch, library);
  return ch.steps.filter((st) => !st.transient && !st.superseded).every((st) => st.check(s));
}

export function headlessState(patch: Patch, library: AssemblyDef[] = []): TutorialState {
  return { patch, entry: patch, zoom: 1, probes: new Set(), arpPlay: false, audio: false, selected: new Set(), library, snapshots: { A: null, B: null }, seen: noSeen() };
}

// ---- a session without a DOM: the course run by "do it for me" alone

export class HeadlessSession implements Actions {
  state: TutorialState;
  private history: string[] = [];
  private future: string[] = [];
  constructor(patch: Patch, library: AssemblyDef[] = []) {
    this.state = headlessState(patch, library);
  }
  patch(): Patch { return this.state.patch; }
  edit(fn: (p: Patch) => void): void {
    const before = JSON.stringify(this.state.patch);
    fn(this.state.patch);
    reconcileAll(this.state.patch, DEFS);
    if (JSON.stringify(this.state.patch) !== before) { this.history.push(before); this.future = []; }
  }
  load(p: Patch): void { this.state.patch = p; this.state.entry = p; this.state.probes.clear(); this.state.selected.clear(); }
  setZoom(z: number): void { this.state.zoom = z; this.state.seen.zooms++; }
  zoomToFit(): void { this.setZoom(0.8); }
  probe(moduleId: number, port: string): void { this.state.probes.add(`${moduleId}:${port}`); }
  arpPlay(on: boolean): void { this.state.arpPlay = on; }
  select(ids: number[]): void { this.state.selected = new Set(ids); }
  undo(): void {
    const s = this.history.pop();
    if (s !== undefined) { this.future.push(JSON.stringify(this.state.patch)); this.state.patch = JSON.parse(s) as Patch; }
    this.state.seen.undos++;
  }
  redo(): void {
    const s = this.future.pop();
    if (s !== undefined) { this.history.push(JSON.stringify(this.state.patch)); this.state.patch = JSON.parse(s) as Patch; }
    this.state.seen.redos++;
  }
  note(): void { this.state.seen.notes++; }
  startAudio(): void { this.state.audio = true; }
  saveAssembly(def: AssemblyDef, tag: string): void {
    const d = { ...def, tutorial: tag };
    const lib = this.state.library.filter((x) => x.tutorial !== tag && x.name !== def.name);
    this.state.library = [...lib, d];
  }
  library(): AssemblyDef[] { return this.state.library; }
  snapshot(side: 'A' | 'B'): void { this.state.snapshots[side] = JSON.stringify(this.state.patch); }
  flipAB(): void { this.state.seen.flips++; }
  share(): void { this.state.seen.shares++; }
  bypass(moduleId: number, on: boolean): void {
    const m = byId(this.state.patch, moduleId);
    if (!m) return;
    if (on) m.bypass = true;
    else delete m.bypass;
    this.state.seen.bypasses++;
  }
  /** run every step of a chapter: a step whose check already passes is left alone */
  run(ch: Chapter): void {
    for (const st of ch.steps) {
      this.state.entry = JSON.parse(JSON.stringify(this.state.patch)) as Patch;
      this.state.seen = noSeen();
      if (!st.check(this.state)) st.apply(this, this.state);
    }
  }
}

export interface CourseRun {
  starts: Patch[];
  ends: Patch[];
  library: AssemblyDef[];
}

/** the whole course by "do it for me": canned starts and ends of every chapter and the assemblies it saves */
export function runCourse(chapters: Chapter[], fallbackStart: () => Patch): CourseRun {
  const starts: Patch[] = [];
  const ends: Patch[] = [];
  let library: AssemblyDef[] = [];
  let prev: Patch | null = null;
  for (const ch of chapters) {
    const fresh = ch.start();
    const start: Patch = fresh ? fresh : prev ? (JSON.parse(JSON.stringify(prev)) as Patch) : fallbackStart();
    starts.push(JSON.parse(JSON.stringify(start)) as Patch);
    const s = new HeadlessSession(start, library);
    s.run(ch);
    library = s.library();
    prev = s.patch();
    ends.push(JSON.parse(JSON.stringify(prev)) as Patch);
  }
  return { starts, ends, library };
}
