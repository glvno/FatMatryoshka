// SPDX-License-Identifier: GPL-3.0-only
// Poly assemblies: polyphony as a visible part of the patch. An assembly with `poly` set runs its member modules once per
// part (the same modules N times, each copy with its own state); its allocator hands the keyboard's notes to the parts,
// and its Part module outputs each part's note. Everything outside a poly assembly runs once. A cable from inside a poly
// assembly to a module outside carries the sum of its parts; a cable from outside reaches every part. SHARED_TYPES run
// once even inside one (their inputs sum the parts). Poly assemblies do not nest in each other; a patch may have
// any number of them (the FM-1 plays MAX_POLY), and each gets every note (they layer).
//
// migrateVoicing converts patches from before (Patch.voices, the Main module's legato / priority / unit and its per-note
// outputs spread / legato / jump / tol / drift, the oscillator's drift setting) into poly assemblies, Part and Random modules.
import {
  allModules,
  assembliesOf,
  assemblyOf,
  descendants,
  freeSpot,
  moveAssembly,
  parentOf,
  reconcile,
  type AssemblyInst,
  type Rect,
} from './assembly';
import { addModule, fixPoly, POLY_DEFAULT, sameEnd, SHARED_TYPES, type ModuleDef, type ModuleInst, type Patch, type PolyCfg } from './patch';

/** the FM-1's poly assembly limit (POLY_MAX_GROUPS in defs.h): the budget meter counts against it, the editor does not stop at it */
export const MAX_POLY = 4;

export interface PolyGroup {
  asm: AssemblyInst;
  cfg: PolyCfg;
  /** the modules that run once per part (members, nested ones too, without the SHARED_TYPES) */
  modules: Set<number>;
}

/** the poly assemblies of a patch, outermost only, in overlay order */
export function polyGroups(p: Patch): PolyGroup[] {
  const out: PolyGroup[] = [];
  const types = new Map(p.modules.map((m) => [m.id, m.type]));
  for (const a of assembliesOf(p)) {
    if (!a.poly || polyAncestor(p, a)) continue;
    const modules = new Set(allModules(p, a).filter((id) => !SHARED_TYPES.has(types.get(id) ?? '')));
    out.push({ asm: a, cfg: fixPoly(a.poly), modules });
  }
  return out;
}

/** module id -> index in polyGroups (absent: runs once) */
export function groupIndex(groups: PolyGroup[]): Map<number, number> {
  const g = new Map<number, number>();
  groups.forEach((x, i) => x.modules.forEach((id) => g.set(id, i)));
  return g;
}

/** how many times each module runs: its poly assembly's part count, else 1 */
export function copiesOf(p: Patch): Map<number, number> {
  const groups = polyGroups(p);
  const out = new Map<number, number>();
  groups.forEach((x) => x.modules.forEach((id) => out.set(id, x.cfg.parts)));
  return out;
}

/** the most parts any poly assembly of the patch has (1 without one) */
export const maxParts = (p: Patch): number => Math.max(1, ...polyGroups(p).map((g) => g.cfg.parts));

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
  if (polyAncestor(p, a)) return `"${a.label}" is inside a poly assembly already: its modules run once per part there`;
  const inner = descendants(p, a).find((d) => d.poly);
  if (inner) return `"${inner.label}" inside it is a poly assembly: poly assemblies do not nest`;
  return null;
}

/** pitch / gate / vel of the Main module and of a Part, by name */
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

/** how far below the canvas top a poly assembly's top member must sit: room for its frame's header and settings strip (editor.ts) */
export const POLY_TOP = 112;

/** move a poly assembly down so its expanded frame's header and settings fit above its members */
export function makeRoom(p: Patch, a: AssemblyInst): void {
  const ys = allModules(p, a).map((id) => p.modules.find((m) => m.id === id)?.y ?? POLY_TOP);
  const top = Math.min(...ys, ...descendants(p, a).filter((d) => !d.open).map((d) => d.y));
  if (top < POLY_TOP) moveAssembly(p, a, 0, POLY_TOP - top);
}

/**
 * Turn the Poly switch of an assembly on or off. On: it gets the default settings and a Part module (unless one is inside
 * already), and the Main module's pitch / gate / vel cables into it come from the Part instead. Off: the reverse, and a
 * Part left without cables goes.
 */
export function setPoly(p: Patch, defs: Record<string, ModuleDef>, a: AssemblyInst, on: boolean): void {
  const main = p.modules.find((m) => m.type === 'fm1');
  const inside = new Set(allModules(p, a));
  if (on) {
    const why = polyProblem(p, a);
    if (why) throw new Error(why);
    a.poly = { ...POLY_DEFAULT };
    let part = p.modules.find((m) => m.type === 'part' && inside.has(m.id));
    if (!part) {
      const members = [...inside].map((id) => p.modules.find((m) => m.id === id)!).filter(Boolean);
      const at = spotNear(p, members);
      part = addModule(p, defs.part, at.x, at.y);
      a.modules.push(part.id);
    }
    if (main)
      for (const c of p.cables)
        if (c.from.module === main.id && KEY_PORTS.includes(c.from.port) && inside.has(c.to.module)) c.from = { module: part.id, port: c.from.port };
    makeRoom(p, a);
  } else {
    delete a.poly;
    const part = p.modules.find((m) => m.type === 'part' && inside.has(m.id));
    if (part && main) {
      for (const c of p.cables) if (c.from.module === part.id && KEY_PORTS.includes(c.from.port)) c.from = { module: main.id, port: c.from.port };
      dedupe(p);
      if (!p.cables.some((c) => c.from.module === part.id)) {
        p.modules = p.modules.filter((m) => m.id !== part.id);
        for (const x of assembliesOf(p)) x.modules = x.modules.filter((id) => id !== part.id);
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

  if (main && (voices > 1 || old.legato || old.priority || old.unit || usesVoicePorts)) {
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
        poly: { parts: voices, assign: 2, legato: old.legato, priority: old.priority, unit: old.unit },
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
