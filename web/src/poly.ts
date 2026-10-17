// SPDX-License-Identifier: GPL-3.0-only
// Polyphony the way a polysynth does it: a Voice allocator module (the CPU) takes the keys held on its `keys` input
// (Main's keys, the keyboard's ribbon cable) and hands them to its voices; its outputs are per voice. A poly assembly is a
// rack of voice cards: its member modules run once per voice of the allocator that feeds it (a cable from an allocator
// into a member), voice i on card i. Everything outside a poly assembly runs once. A cable from inside a poly assembly to a
// module outside carries the sum of its cards; a cable from outside reaches every card, as a polysynth's panel reaches
// every voice; an allocator's output into a module that runs once is the sum of its voices. SHARED_TYPES and allocators
// run once even inside one. Poly assemblies do not nest in each other; one allocator may feed several (they play the same
// voices, layered), and several allocators may share Main's keys.
//
// deviceView turns a patch into the form the engines and the FM-1 run: every allocator becomes a Part module in each poly
// group it drives (each group allocates the same notes the same way). migrateParts converts patches from before
// allocators (a Part module inside each poly assembly, the voice settings on the assembly); migrateVoicing the ones from
// before poly assemblies (Patch.voices, the Main module's voicing, the oscillator's drift).
import {
  allModules,
  assembliesOf,
  assemblyOf,
  descendants,
  freeSpot,
  moveAssembly,
  parentOf,
  reconcile,
  targetsOf,
  type AssemblyInst,
  type Rect,
} from './assembly';
import {
  addModule,
  defaultParams,
  fixCards,
  fixMatrix,
  fixPoly,
  polyCfg,
  sameEnd,
  SHARED_TYPES,
  type Cable,
  type ModuleDef,
  type ModuleInst,
  type Patch,
  type PolyCfg,
} from './patch';

/** the FM-1's poly assembly limit (POLY_MAX_GROUPS in defs.h): the budget meter counts against it, the editor does not stop at it */
export const MAX_POLY = 4;
/** the allocator module's type */
export const ALLOC = 'alloc';

export interface PolyGroup {
  asm: AssemblyInst;
  /** the allocator that feeds it */
  alloc: ModuleInst;
  cfg: PolyCfg;
  /** the modules that run once per voice (members, nested ones too, without the SHARED_TYPES and allocators) */
  modules: Set<number>;
}

/** the members of a poly assembly that run once per voice */
function copied(p: Patch, a: AssemblyInst): Set<number> {
  const types = new Map(p.modules.map((m) => [m.id, m.type]));
  return new Set(allModules(p, a).filter((id) => { const t = types.get(id) ?? ''; return !SHARED_TYPES.has(t) && t !== ALLOC; }));
}

/** the allocator that drives a poly assembly: the first one (in module order) with a cable into a member that runs per voice,
 * else the first one inside it */
export function allocatorOf(p: Patch, a: AssemblyInst): ModuleInst | undefined {
  const inside = copied(p, a);
  const feeding = new Set(p.cables.filter((c) => inside.has(c.to.module)).map((c) => c.from.module));
  const members = new Set(allModules(p, a));
  return p.modules.find((m) => m.type === ALLOC && feeding.has(m.id)) ?? p.modules.find((m) => m.type === ALLOC && members.has(m.id));
}

/** the outermost poly assemblies of a patch, in overlay order */
const polyRoots = (p: Patch): AssemblyInst[] => assembliesOf(p).filter((a) => a.poly && !polyAncestor(p, a));

/** the poly assemblies of a patch that an allocator drives, outermost only, in overlay order (one without an allocator runs once) */
export function polyGroups(p: Patch): PolyGroup[] {
  const out: PolyGroup[] = [];
  for (const a of polyRoots(p)) {
    const alloc = allocatorOf(p, a);
    if (alloc) out.push({ asm: a, alloc, cfg: polyCfg(alloc, a.poly), modules: copied(p, a) });
  }
  return out;
}

/** module id -> index in polyGroups (absent: runs once) */
export function groupIndex(groups: PolyGroup[]): Map<number, number> {
  const g = new Map<number, number>();
  groups.forEach((x, i) => x.modules.forEach((id) => g.set(id, i)));
  return g;
}

/** how many times each module runs (its poly assembly's voice count, else 1); an allocator counts its voices (its outputs) */
export function copiesOf(p: Patch): Map<number, number> {
  const out = new Map<number, number>();
  polyGroups(p).forEach((x) => x.modules.forEach((id) => out.set(id, x.cfg.parts)));
  for (const m of p.modules) if (m.type === ALLOC) out.set(m.id, polyCfg(m).parts);
  return out;
}

/** the most voices any allocator of the patch has (1 without one) */
export const maxParts = (p: Patch): number => Math.max(1, ...p.modules.filter((m) => m.type === ALLOC).map((m) => polyCfg(m).parts));

/** a poly assembly that no allocator feeds: it runs once */
export const unfed = (p: Patch, a: AssemblyInst): boolean => !!a.poly && !polyAncestor(p, a) && !allocatorOf(p, a);

/** does an allocator take keys: a cable from a Main module's keys output into it */
export const keyed = (p: Patch, alloc: ModuleInst): boolean =>
  p.cables.some((c) => c.to.module === alloc.id && c.to.port === 'keys' && p.modules.find((m) => m.id === c.from.module)?.type === 'fm1');

/** a poly group as the engines and the binary take it */
export interface DeviceGroup {
  /** the engine keeps a group's notes across reloads while this stays */
  key: string;
  cfg: PolyCfg;
  modules: Set<number>;
}

/**
 * The form the engines and the FM-1 run (format 21): no allocators and no keys cables. Every allocator becomes a Part
 * module in each poly group it drives (the first takes its id and place in the module list, so module indices stay; the
 * others are appended), its cables into that group come from that group's Part. Its cables into modules outside its
 * groups come from the first group's Part (a group's per-part outputs sum there); an allocator that drives no group gets
 * a group of its own for them, or, with one voice played the keyboard's way (legato auto, last note), a Part outside any
 * group (the shared keyboard). An allocator without keys plays nothing: its cables go (one with neither cables nor cards is
 * left out). Group order: the poly assemblies in
 * overlay order, then the allocators' own groups.
 */
export function deviceView(p: Patch): { patch: Patch; groups: DeviceGroup[] } {
  const groups = polyGroups(p);
  const out: DeviceGroup[] = groups.map((g) => ({ key: `${g.asm.id}:${g.cfg.parts}`, cfg: g.cfg, modules: new Set(g.modules) }));
  const modules = p.modules.map((m) => m);
  let cables: Cable[] = p.cables.filter((c) => p.modules.find((m) => m.id === c.from.module)?.type !== 'fm1' || c.from.port !== 'keys');
  let next = p.modules.reduce((m, x) => Math.max(m, x.id), 0) + 1;
  const partAt = (alloc: ModuleInst, id: number): ModuleInst => ({ id, type: 'part', x: alloc.x, y: alloc.y, params: {} });
  for (const alloc of p.modules.filter((m) => m.type === ALLOC)) {
    const slot = modules.indexOf(alloc);
    const mine = groups.map((g, i) => (g.alloc === alloc ? i : -1)).filter((i) => i >= 0);
    const from = cables.filter((c) => c.from.module === alloc.id);
    if (!keyed(p, alloc) || (!from.length && !mine.length)) {
      modules.splice(slot, 1);
      cables = cables.filter((c) => c.from.module !== alloc.id && c.to.module !== alloc.id);
      continue;
    }
    cables = cables.filter((c) => c.to.module !== alloc.id);
    const parts = new Map<number, number>(); // group index -> its Part's id
    mine.forEach((g, k) => {
      const id = k === 0 ? alloc.id : next++;
      parts.set(g, id);
      out[g].modules.add(id);
      if (k === 0) modules[slot] = partAt(alloc, id);
      else modules.push(partAt(alloc, id));
    });
    const spare = mine.length ? parts.get(mine[0])! : alloc.id;
    if (!mine.length) {
      modules[slot] = partAt(alloc, alloc.id);
      const cfg = polyCfg(alloc);
      if (cfg.parts > 1 || cfg.legato || cfg.priority) out.push({ key: `a${alloc.id}:${cfg.parts}`, cfg, modules: new Set([alloc.id]) });
    }
    cables = cables.map((c) => {
      if (c.from.module !== alloc.id) return c;
      const g = mine.find((i) => out[i].modules.has(c.to.module));
      return { from: { module: g === undefined ? spare : parts.get(g)!, port: c.from.port }, to: c.to };
    });
  }
  return { patch: { ...p, modules, cables, assemblies: undefined }, groups: out };
}

/** the poly assembly above `a` (not `a` itself), if any */
function polyAncestor(p: Patch, a: AssemblyInst): AssemblyInst | undefined {
  for (let x = parentOf(p, a.id); x; x = parentOf(p, x.id)) if (x.poly) return x;
  return undefined;
}

/** the poly assembly a module runs in (the outermost poly assembly that holds it) */
export function polyOfModule(p: Patch, moduleId: number): AssemblyInst | undefined {
  let found: AssemblyInst | undefined;
  for (let x = assemblyOf(p, moduleId); x; x = parentOf(p, x.id)) if (x.poly) found = x;
  return found;
}

/** why `a` cannot become a poly assembly, or null */
export function polyProblem(p: Patch, a: AssemblyInst): string | null {
  if (polyAncestor(p, a)) return `"${a.label}" is inside a poly assembly already: its modules run once per voice there`;
  const inner = descendants(p, a).find((d) => d.poly);
  if (inner) return `"${inner.label}" inside it is a poly assembly: poly assemblies do not nest`;
  return null;
}

/** pitch / gate / vel of the Main module and of an allocator, by name */
const KEY_PORTS = ['pitch', 'gate', 'vel'];

/** a card-sized spot next to `near` (left, right, below), clear of other cards (collapsed assemblies too), else the first free grid cell */
function spotNear(p: Patch, near: ModuleInst[], w = 300, h = 220): { x: number; y: number } {
  const rects: Rect[] = [
    ...p.modules.map((m) => ({ x: m.x, y: m.y, w: 300, h: 300 })),
    ...(Array.isArray(p.assemblies) ? p.assemblies : []).filter((a) => a && !a.open && Number.isFinite(a.x)).map((a) => ({ x: a.x, y: a.y, w: 300, h: 400 })),
  ];
  const x0 = Math.min(...near.map((m) => m.x));
  const y0 = Math.min(...near.map((m) => m.y));
  const x1 = Math.max(...near.map((m) => m.x));
  const y1 = Math.max(...near.map((m) => m.y));
  for (const c of [{ x: x0 - 270, y: y0 }, { x: x1 + 270, y: y0 }, { x: x0, y: y1 + 320 }]) {
    const r = { ...c, w, h };
    if (c.x >= 0 && c.y >= 0 && !rects.some((o) => r.x < o.x + o.w && r.x + r.w > o.x && r.y < o.y + o.h && r.y + r.h > o.y)) return c;
  }
  return freeSpot(rects, w, h);
}

/** how far below the canvas top a poly assembly's top member must sit: room for its frame's header (editor.ts FRAME_PAD +
 * FRAME_HEAD + 8; voice control sits in the header) */
export const POLY_TOP = 50;

/** move a poly assembly down so its expanded frame's header and settings fit above its members */
export function makeRoom(p: Patch, a: AssemblyInst): void {
  const ys = allModules(p, a).map((id) => p.modules.find((m) => m.id === id)?.y ?? POLY_TOP);
  const top = Math.min(...ys, ...descendants(p, a).filter((d) => !d.open).map((d) => d.y));
  if (top < POLY_TOP) moveAssembly(p, a, 0, POLY_TOP - top);
}

/**
 * Turn the Poly switch of an assembly on or off. On: it becomes a rack of voice cards; unless an allocator feeds it already,
 * a Voice allocator goes inside (it runs once there, and travels with the assembly into the library), Main's keys go
 * into it (a keys jack on the card), and the Main module's pitch / gate / vel cables into the assembly come from the
 * allocator instead. Off: the reverse (the allocator's other outputs into it are dropped), and an allocator left feeding
 * nothing goes.
 */
export function setPoly(p: Patch, defs: Record<string, ModuleDef>, a: AssemblyInst, on: boolean): void {
  const main = p.modules.find((m) => m.type === 'fm1');
  const inside = new Set(allModules(p, a));
  if (on) {
    const why = polyProblem(p, a);
    if (why) throw new Error(why);
    a.poly = {};
    if (!allocatorOf(p, a)) {
      const members = [...inside].map((id) => p.modules.find((m) => m.id === id)!).filter(Boolean);
      const at = spotNear(p, members);
      const alloc = addModule(p, defs[ALLOC], at.x, at.y);
      a.modules.push(alloc.id);
      if (main) {
        p.cables.push({ from: { module: main.id, port: 'keys' }, to: { module: alloc.id, port: 'keys' } });
        for (const c of p.cables)
          if (c.from.module === main.id && KEY_PORTS.includes(c.from.port) && inside.has(c.to.module)) c.from = { module: alloc.id, port: c.from.port };
      }
    }
    makeRoom(p, a);
  } else {
    const alloc = allocatorOf(p, a);
    delete a.poly;
    if (alloc) {
      for (const c of p.cables)
        if (c.from.module === alloc.id && inside.has(c.to.module) && KEY_PORTS.includes(c.from.port) && main) c.from = { module: main.id, port: c.from.port };
      p.cables = p.cables.filter((c) => !(c.from.module === alloc.id && inside.has(c.to.module)));
      dedupe(p);
      if (!p.cables.some((c) => c.from.module === alloc.id)) {
        p.cables = p.cables.filter((c) => c.to.module !== alloc.id);
        p.modules = p.modules.filter((m) => m.id !== alloc.id);
        for (const x of assembliesOf(p)) x.modules = x.modules.filter((id) => id !== alloc.id);
      }
    }
  }
  reconcile(p, a, defs);
}

/** drop duplicate cables (two rewired ones that now join the same ports) */
function dedupe(p: Patch): void {
  p.cables = p.cables.filter((c, i) => p.cables.findIndex((d) => sameEnd(c.from, d.from) && sameEnd(c.to, d.to)) === i);
}

// ---------------------------------------------------------------------------------------------------------------------
// Patches from before poly assemblies

/** the Main module's outputs that were per voice */
const LEGACY_VOICE_PORTS = new Set(['pitch', 'gate', 'vel', 'spread', 'legato', 'jump', 'tol', 'drift']);
/** what each moved to on the Part module */
const PART_PORT: Record<string, string> = { pitch: 'pitch', gate: 'gate', vel: 'vel', spread: 'index', legato: 'legato', jump: 'jump' };

interface RawAsm {
  id: number;
  modules: number[];
  children?: number[];
  [k: string]: unknown;
}

/** the old voice split: every module that hears the Main module's per-voice outputs, through any chain, except SHARED_TYPES */
function legacySplit(p: Patch, mainId: number): Set<number> {
  const set = new Set<number>();
  const types = new Map(p.modules.map((m) => [m.id, m.type]));
  for (;;) {
    let grew = false;
    for (const c of p.cables) {
      const t = types.get(c.to.module);
      if (!t || t === 'fm1' || SHARED_TYPES.has(t) || set.has(c.to.module)) continue;
      if (c.from.module === mainId ? LEGACY_VOICE_PORTS.has(c.from.port) : set.has(c.from.module)) {
        set.add(c.to.module);
        grew = true;
      }
    }
    if (!grew) return set;
  }
}

/**
 * Convert the old voicing (see the top of this file). Runs on a patch whose modules are validated and whose cables name
 * existing modules, before the cables' ports are checked (the Main module's old outputs are still named) and before the
 * assembly overlay is checked (it is read defensively and rebuilt by fixAssemblies). Returns one note per change.
 */
export function migrateVoicing(p: Patch, defs: Record<string, ModuleDef>): string[] {
  const notes: string[] = [];
  const raw = p as Patch & { voices?: unknown };
  const voices = Math.max(1, Math.min(8, Math.round(Number(raw.voices)) || 1));
  delete raw.voices;
  const main = p.modules.find((m) => m.type === 'fm1');
  const old = { legato: 0, priority: 0, unit: 0 };
  for (const m of p.modules.filter((x) => x.type === 'fm1'))
    for (const k of ['legato', 'priority', 'unit'] as const) {
      if (m === main && Number.isFinite(Number(m.params[k]))) old[k] = Math.round(Number(m.params[k]));
      delete m.params[k];
    }
  const drifted = takeDrift(p.modules);
  const asms: RawAsm[] = (Array.isArray(p.assemblies) ? (p.assemblies as unknown[]) : []).filter(
    (a): a is RawAsm => !!a && typeof a === 'object' && Array.isArray((a as RawAsm).modules),
  );
  const parentRaw = (id: number): RawAsm | undefined => asms.find((a) => Array.isArray(a.children) && a.children.includes(id));
  const directRaw = (moduleId: number): RawAsm | undefined => asms.find((a) => a.modules.includes(moduleId));
  const topOf = (moduleId: number): RawAsm | undefined => {
    let a = directRaw(moduleId);
    for (let up = a && parentRaw(a.id), guard = 0; up && guard < 8; up = parentRaw(up.id), guard++) a = up;
    return a;
  };
  const rawMembers = (a: RawAsm, guard = 0): number[] =>
    guard > 8 ? [] : [...a.modules, ...(a.children ?? []).flatMap((k) => { const c = asms.find((x) => x.id === k); return c ? rawMembers(c, guard + 1) : []; })];
  const fromMain = (port: string) => (c: Patch['cables'][number]): boolean => !!main && c.from.module === main.id && c.from.port === port;
  const usesVoicePorts = !!main && p.cables.some((c) => c.from.module === main.id && ['spread', 'legato', 'jump'].includes(c.from.port));
  let group: RawAsm | null = null;
  let groupSet = new Set<number>();

  if (main && (voices > 1 || old.legato || old.priority || usesVoicePorts)) {
    const split = legacySplit(p, main.id);
    if (split.size) {
      const loose: number[] = [];
      const kids = new Set<number>();
      for (const id of split) {
        const top = topOf(id);
        if (top) kids.add(top.id);
        else loose.push(id);
      }
      for (const k of kids) for (const id of rawMembers(asms.find((a) => a.id === k)!)) groupSet.add(id);
      for (const id of loose) groupSet.add(id);
      const members = [...groupSet].map((id) => p.modules.find((m) => m.id === id)!).filter(Boolean);
      const at = spotNear(p, members);
      const part = addModule(p, defs.part, at.x, at.y);
      groupSet.add(part.id);
      for (const c of p.cables) if (c.from.module === main.id && PART_PORT[c.from.port] && groupSet.has(c.to.module)) c.from = { module: part.id, port: PART_PORT[c.from.port] };
      const id = asms.reduce((m, a) => Math.max(m, a.id), 0) + 1;
      group = {
        v: 1, id, name: 'poly voice', label: 'poly voice', open: true,
        x: Math.min(...members.map((m) => m.x), at.x), y: Math.min(...members.map((m) => m.y), at.y),
        modules: [...loose, part.id], inputs: [], outputs: [], params: [],
        poly: { parts: voices, assign: 2, legato: old.legato, priority: old.priority },
      };
      if (kids.size) group.children = [...kids];
      // room above for the expanded frame's header and settings
      const top = Math.min(...[...groupSet].map((mid) => p.modules.find((m) => m.id === mid)?.y ?? POLY_TOP));
      if (top < POLY_TOP) {
        const dy = POLY_TOP - top;
        for (const mid of groupSet) { const m = p.modules.find((x) => x.id === mid); if (m) m.y += dy; }
        const shift = (id: number, guard = 0): void => {
          const a = asms.find((x) => x.id === id);
          if (!a || guard > 8) return;
          if (Number.isFinite(Number(a.y))) a.y = Number(a.y) + dy;
          for (const k of a.children ?? []) shift(k, guard + 1);
        };
        for (const k of kids) shift(k);
        group.y = Number(group.y) + dy;
      }
      asms.push(group);
      p.assemblies = asms as unknown as AssemblyInst[];
      notes.push(`the ${voices > 1 ? `${voices} voices` : 'voicing'} became the poly assembly "poly voice"`);
    }
  }
  if (main) {
    // the Main module's tolerance and drift: a Random module per region (the poly assembly, or the rest of the patch)
    const randoms = new Map<string, ModuleInst>();
    for (const [port, mode] of [['tol', 0], ['drift', 1]] as const)
      for (const c of p.cables.filter(fromMain(port))) {
        const inGroup = groupSet.has(c.to.module);
        const key = `${port}:${inGroup}`;
        let r = randoms.get(key);
        const dest = p.modules.find((m) => m.id === c.to.module);
        if (!dest) continue;
        if (!r) {
          const at = spotNear(p, [dest]);
          r = addModule(p, defs.random, at.x, at.y);
          r.params.mode = mode;
          if (inGroup && group) group.modules.push(r.id);
          randoms.set(key, r);
        }
        c.from = { module: r.id, port: 'out' };
        notes.push(`Main ${port} became a Random module (${mode ? 'walk' : 'fixed'})`);
      }
    // per-note outputs into modules that run once: the sum over the voices (spread sums to 0); dropped
    const left = p.cables.filter((c) => c.from.module === main.id && ['spread', 'legato', 'jump'].includes(c.from.port));
    if (left.length) {
      p.cables = p.cables.filter((c) => !left.includes(c));
      notes.push(`${left.length} cable(s) from Main spread / legato / jump into shared modules removed`);
    }
  }
  // the oscillator's drift: a Random (walk) into its fine tune
  oscDrift(p.modules, p.cables, defs, drifted, notes, (osc) => {
    const at = spotNear(p, [osc]);
    const r = addModule(p, defs.random, at.x, at.y);
    const host = directRaw(osc.id) ?? (groupSet.has(osc.id) ? group : null);
    if (host) host.modules.push(r.id);
    return r;
  });
  dedupe(p);
  return notes;
}


/** an assembly entry as a file holds it (a patch's overlay or a definition's nested list) */
interface RawPolyAsm {
  id: number;
  modules: number[];
  children?: number[];
  poly?: unknown;
  inputs?: unknown;
}

/**
 * Patches and definitions from before allocators: each Part module becomes a Voice allocator in its place. Inside a poly
 * assembly it takes the assembly's old voice settings (parts, assign, legato, priority; the assembly keeps its flaws),
 * elsewhere it gets one voice played the keyboard's way (the shared keyboard a Part outside played). Every poly assembly's
 * settings shrink to its flaws. `top` is a definition's own poly setting (a definition is a poly assembly itself) and
 * `topMembers` its direct members. Returns the allocators made, each with the old poly assemblies around it (innermost
 * first): the caller wires its keys.
 */
export function migrateParts(
  modules: ModuleInst[],
  asms: RawPolyAsm[],
  defs: Record<string, ModuleDef>,
  top?: { poly?: unknown },
): { alloc: ModuleInst; around: RawPolyAsm[] }[] {
  const made: { alloc: ModuleInst; around: RawPolyAsm[] }[] = [];
  const parentOfRaw = (id: number): RawPolyAsm | undefined => asms.find((a) => Array.isArray(a.children) && a.children.includes(id));
  const old = (raw: unknown): boolean => !!raw && typeof raw === 'object' && 'parts' in (raw as object);
  for (const m of modules.filter((x) => x.type === 'part')) {
    const around: RawPolyAsm[] = [];
    for (let a = asms.find((x) => Array.isArray(x.modules) && x.modules.includes(m.id)), guard = 0; a && guard < 64; a = parentOfRaw(a.id), guard++) around.push(a);
    const host = [...around].reverse().find((a) => a.poly) ?? (top?.poly ? top : undefined);
    const cfg = host && old(host.poly) ? fixPoly(host.poly) : { parts: 1, assign: 0, legato: 0, priority: 0 };
    m.type = ALLOC;
    m.params = { ...defaultParams(defs[ALLOC]), voices: cfg.parts, assign: cfg.assign, legato: cfg.legato, priority: cfg.priority };
    fixMatrix(m, defs[ALLOC]);
    made.push({ alloc: m, around });
  }
  for (const a of [...asms, ...(top ? [top] : [])]) if (a.poly) a.poly = fixCards(a.poly);
  return made;
}

/** migrateParts on a patch: Main's keys go into every allocator it made */
export function migratePatchParts(p: Patch, defs: Record<string, ModuleDef>): void {
  const asms = (Array.isArray(p.assemblies) ? (p.assemblies as unknown[]) : []).filter(
    (a): a is RawPolyAsm => !!a && typeof a === 'object' && Array.isArray((a as RawPolyAsm).modules),
  );
  const made = migrateParts(p.modules, asms, defs);
  const main = p.modules.find((m) => m.type === 'fm1');
  if (main) for (const { alloc } of made) p.cables.push({ from: { module: main.id, port: 'keys' }, to: { module: alloc.id, port: 'keys' } });
}

/** the oscillators' old drift settings (cents, the ones above 0), removed from their params */
export function takeDrift(modules: ModuleInst[]): Map<number, number> {
  const drifted = new Map<number, number>();
  for (const m of modules.filter((x) => x.type === 'osc')) {
    const cents = Number(m.params.drift);
    if (cents > 0) drifted.set(m.id, cents);
    delete m.params.drift;
  }
  return drifted;
}

/**
 * An oscillator's old drift: a Random module (walk) into its fine tune through a free pin, drift / 2 cents at full swing
 * (the old wander; the fixed mistuning per unison copy has no equivalent). `add` makes the Random module.
 */
export function oscDrift(modules: ModuleInst[], cables: Patch['cables'], defs: Record<string, ModuleDef>, drifted: Map<number, number>, notes: string[], add: (osc: ModuleInst) => ModuleInst): void {
  const fine = defs.osc.params.find((q) => q.name === 'fine')!;
  for (const [id, cents] of drifted) {
    const osc = modules.find((m) => m.id === id);
    const pin = (['p2', 'p1'] as const).find((q) => !cables.some((c) => c.to.module === id && c.to.port === q));
    if (!osc || !pin || !osc.map || !osc.att) {
      notes.push(`oscillator ${id}: drift of ${cents} ct dropped (both modulation inputs are in use)`);
      continue;
    }
    const r = add(osc);
    r.params.mode = 1;
    osc.map[pin] = ['fine'];
    osc.att[pin === 'p1' ? 0 : 1] = Math.min(1, cents / 2 / (fine.max - fine.min));
    if (osc.range) delete osc.range[pin];
    cables.push({ from: { module: r.id, port: 'out' }, to: { module: id, port: pin } });
    notes.push(`oscillator ${id}: drift became a Random module (walk) into fine tune`);
  }
}
