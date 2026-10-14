// SPDX-License-Identifier: GPL-3.0-only
// Assemblies: a group of prewired modules shown as one card with the ports and parameters it exposes.
//
// The patch stays flat. `Patch.assemblies` is an overlay: each entry names its member modules (ids in `patch.modules`),
// the inner ports it exposes and the inner parameters it promotes. Cables always run between inner ports, so the engine,
// the voice split, the binary format and the FM-1 never see assemblies; an editor that does not know the overlay loads
// the same patch and only loses the grouping. An assembly holds plain modules and, nested, other assemblies (`children`,
// up to MAX_DEPTH levels), never the FM-1 panel or an Output. A container input may fan out to several inner inputs
// (`PortRef.also`: one "gate" jack for two envelopes). A saved assembly (`AssemblyDef`, one JSON file) is a small patch of
// its own: every module inside with local ids, the cables between them, the nested assemblies, the exposed ports and
// promoted parameters.
import {
  addModule,
  defaultParams,
  fixMatrix,
  fixInputRoutes,
  MAX_MODULES,
  removeModule,
  sameEnd,
  type Cable,
  type Endpoint,
  type ModuleDef,
  type ModuleInst,
  type Patch,
} from './patch';

export type Target = Endpoint;

export interface PortRef {
  module: number;
  port: string;
  label: string;
  /** further inner inputs this container input also feeds (merged ports; inputs only). A cable to the port goes to all of them. */
  also?: Target[];
}
export interface ParamRef {
  module: number;
  param: string;
  label: string;
}

export interface AssemblyLayout {
  /** Legacy collapsed-card size, retained for file compatibility but ignored by the editor. */
  size?: { width: number; height: number };
  /** User-sized expanded frame, in unscaled canvas pixels. */
  frameSize?: { width: number; height: number };
}

/** Accept bounded layout metadata; it never changes audio or firmware data. */
export function assemblyLayout(raw: AssemblyLayout): AssemblyLayout {
  const result: AssemblyLayout = {};
  for (const key of ['size', 'frameSize'] as const) {
    const value = raw[key];
    if (value && Number.isFinite(value.width) && Number.isFinite(value.height) && value.width > 0 && value.height > 0)
      result[key] = { width: Math.min(4000, Math.max(236, value.width)), height: Math.min(4000, Math.max(80, value.height)) };
  }
  return result;
}

/** an assembly in a patch: the overlay entry */
export interface AssemblyInst extends AssemblyLayout {
  v: 1;
  id: number;
  /** the library name it was made from or saved as */
  name: string;
  /** this instance's label on the canvas ("operator 2") */
  label: string;
  /** the collapsed card's position */
  x: number;
  y: number;
  /** open: the member cards are shown inside a frame; collapsed: one card with the exposed ports */
  open: boolean;
  /** the direct member modules */
  modules: number[];
  /** nested assemblies (ids in `patch.assemblies`); their modules are members too */
  children?: number[];
  inputs: PortRef[];
  outputs: PortRef[];
  params: ParamRef[];
  /** the group switch is off: every member module is bypassed (editor only, like the rest of the overlay) */
  bypass?: boolean;
  /** with `bypass`: the members that were bypassed on their own before the group went off; they stay off when it comes back */
  kept?: number[];
}

/** a nested assembly inside a saved definition: local module ids and local assembly ids, positions relative like the modules */
export interface NestedDef extends AssemblyLayout {
  id: number;
  name: string;
  label: string;
  x: number;
  y: number;
  open: boolean;
  modules: number[];
  children?: number[];
  inputs: PortRef[];
  outputs: PortRef[];
  params: ParamRef[];
}

/** a saved assembly: the file format, the library entry and the factory set. Module ids are local (1..n), positions relative. */
export interface AssemblyDef extends AssemblyLayout {
  format: 'modular-1-assembly';
  version: 1;
  name: string;
  /** a factory assembly's shelf in the browser (CATEGORIES in assemblies.ts); the user's own have none */
  category?: string;
  /** saved by the tutorial under this tag ("my-voice"); later chapters find it by the tag whatever its name */
  tutorial?: string;
  /** every module inside, the nested ones included */
  modules: ModuleInst[];
  cables: Cable[];
  inputs: PortRef[];
  outputs: PortRef[];
  params: ParamRef[];
  /** the top level's direct children (ids in `assemblies`); modules not claimed by a nested assembly are its direct members */
  children?: number[];
  assemblies?: NestedDef[];
}

export const ASSEMBLY_FORMAT = 'modular-1-assembly';
/** module types that cannot be members: the one panel and the output are the patch's own */
export const EXCLUDED_TYPES = new Set(['fm1', 'output']);
/** how deep assemblies nest: a top-level assembly is level 1 */
export const MAX_DEPTH = 3;
const KNOBS = ['k1', 'k2', 'k3', 'k4'] as const;

export const assembliesOf = (p: Patch): AssemblyInst[] => p.assemblies ?? [];
export const assemblyById = (p: Patch, id: number): AssemblyInst | undefined => assembliesOf(p).find((a) => a.id === id);

/** the assembly a module is a direct member of */
export function assemblyOf(p: Patch, moduleId: number): AssemblyInst | undefined {
  return assembliesOf(p).find((a) => a.modules.includes(moduleId));
}

/** the assembly an assembly is nested in */
export function parentOf(p: Patch, asmId: number): AssemblyInst | undefined {
  return assembliesOf(p).find((a) => a.children?.includes(asmId));
}

export const childrenOf = (p: Patch, a: AssemblyInst): AssemblyInst[] => (a.children ?? []).map((id) => assemblyById(p, id)).filter((x): x is AssemblyInst => !!x);

/** every assembly nested in `a`, parents before their children */
export function descendants(p: Patch, a: AssemblyInst): AssemblyInst[] {
  const out: AssemblyInst[] = [];
  const seen = new Set<number>([a.id]);
  const walk = (x: AssemblyInst): void => {
    for (const c of childrenOf(p, x)) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push(c);
      walk(c);
    }
  };
  walk(a);
  return out;
}

/** the modules of an assembly, the nested ones included */
export function allModules(p: Patch, a: AssemblyInst): number[] {
  const ids = [...a.modules];
  for (const d of descendants(p, a)) ids.push(...d.modules);
  return ids;
}

/**
 * The group switch: off bypasses every member (nested ones too) and remembers which were already off; on restores exactly
 * that, so a member you switched off yourself stays off. Returns the ids of the modules whose flag changed.
 */
export function bypassAssembly(p: Patch, a: AssemblyInst, off: boolean): number[] {
  const changed: number[] = [];
  const members = allModules(p, a);
  const mods = members.map((id) => p.modules.find((m) => m.id === id)!);
  if (off) {
    a.kept = mods.filter((m) => m.bypass).map((m) => m.id);
    for (const m of mods) if (!m.bypass) {
      m.bypass = true;
      changed.push(m.id);
    }
    a.bypass = true;
    for (const d of descendants(p, a)) if (d.bypass) delete d.kept; // a nested group's own switch is superseded: it comes back with this one
  } else {
    const keep = new Set(a.kept ?? []);
    for (const m of mods) if (m.bypass && !keep.has(m.id)) {
      delete m.bypass;
      changed.push(m.id);
    }
    delete a.bypass;
    delete a.kept;
    for (const d of descendants(p, a)) {
      delete d.bypass;
      delete d.kept;
    }
  }
  return changed;
}

/** 1 for a top-level assembly, 2 inside one, ... */
export function depthOf(p: Patch, a: AssemblyInst): number {
  let d = 1;
  for (let x = parentOf(p, a.id); x && d <= MAX_DEPTH + 1; x = parentOf(p, x.id)) d++;
  return d;
}

/** the levels an assembly spans: 1 without children */
export function heightOf(p: Patch, a: AssemblyInst): number {
  return 1 + Math.max(0, ...childrenOf(p, a).map((c) => heightOf(p, c)));
}

/** the ids of modules inside collapsed assemblies (nested ones included): not drawn as cards */
export function hiddenModules(p: Patch): Set<number> {
  const h = new Set<number>();
  for (const a of assembliesOf(p)) if (!a.open) for (const id of allModules(p, a)) h.add(id);
  return h;
}

/** the ids of assemblies nested in a collapsed one: neither their card nor their frame is drawn */
export function hiddenAssemblies(p: Patch): Set<number> {
  const h = new Set<number>();
  for (const a of assembliesOf(p)) if (!a.open) for (const d of descendants(p, a)) h.add(d.id);
  return h;
}

/** the inner inputs a container input feeds: its primary and the merged ones */
export const targetsOf = (r: PortRef): Target[] => [{ module: r.module, port: r.port }, ...(r.also ?? [])];

/** the exposed port that carries this inner port (as its primary or merged into it) */
export function findRef(a: AssemblyInst, dir: 'in' | 'out', module: number, port: string): PortRef | undefined {
  return (dir === 'in' ? a.inputs : a.outputs).find((r) => targetsOf(r).some((t) => t.module === module && t.port === port));
}

export function isExposed(a: AssemblyInst, dir: 'in' | 'out', module: number, port: string): boolean {
  return !!findRef(a, dir, module, port);
}

export function isPromoted(a: AssemblyInst, module: number, param: string): boolean {
  return a.params.some((r) => r.module === module && r.param === param);
}

/** the cables that cross the assembly's boundary */
export function outsideCables(p: Patch, a: AssemblyInst): Cable[] {
  const m = new Set(allModules(p, a));
  return p.cables.filter((c) => m.has(c.from.module) !== m.has(c.to.module));
}

function uniqueLabel(taken: Iterable<string>, want: string): string {
  const set = new Set(taken);
  if (!set.has(want)) return want;
  for (let n = 2; ; n++) if (!set.has(`${want} ${n}`)) return `${want} ${n}`;
}

/** the inner ports with a cable to or from outside: the ports an assembly must expose */
export function boundary(p: Patch, members: Iterable<number>): { inputs: Target[]; outputs: Target[] } {
  const m = new Set(members);
  const inputs: Target[] = [];
  const outputs: Target[] = [];
  for (const c of p.cables) {
    if (m.has(c.to.module) && !m.has(c.from.module) && !inputs.some((r) => sameEnd(r, c.to))) inputs.push({ module: c.to.module, port: c.to.port });
    if (m.has(c.from.module) && !m.has(c.to.module) && !outputs.some((r) => sameEnd(r, c.from))) outputs.push({ module: c.from.module, port: c.from.port });
  }
  return { inputs, outputs };
}

/** why a module cannot join an assembly, or null */
export function memberProblem(p: Patch, moduleId: number, a?: AssemblyInst): string | null {
  const m = p.modules.find((x) => x.id === moduleId);
  if (!m) return `no module ${moduleId}`;
  if (EXCLUDED_TYPES.has(m.type)) return 'the Main panel and the Output cannot be part of an assembly';
  const other = assemblyOf(p, moduleId);
  if (other && other !== a) return `${describe(p, m)} is already in "${other.label}"`;
  return null;
}

/** why an assembly cannot be nested in `parent`, or null */
export function childProblem(p: Patch, parent: AssemblyInst, childId: number): string | null {
  const c = assemblyById(p, childId);
  if (!c) return `no assembly ${childId}`;
  if (c.id === parent.id) return `"${c.label}" cannot contain itself`;
  if (descendants(p, c).some((d) => d.id === parent.id)) return `"${parent.label}" is already inside "${c.label}"`;
  const other = parentOf(p, c.id);
  if (other && other.id !== parent.id) return `"${c.label}" is already in "${other.label}"`;
  if (depthOf(p, parent) + heightOf(p, c) > MAX_DEPTH) return `assemblies nest at most ${MAX_DEPTH} deep`;
  return null;
}

function describe(p: Patch, m: ModuleInst): string {
  const same = p.modules.filter((x) => x.type === m.type);
  return same.length > 1 ? `${m.type} ${same.indexOf(m) + 1}` : m.type;
}

/** is this inner port on a direct member, or exposed by the child that holds it (what a parent may show) */
function reachable(p: Patch, a: AssemblyInst, dir: 'in' | 'out', module: number, port: string): boolean {
  if (a.modules.includes(module)) return true;
  const c = childrenOf(p, a).find((x) => allModules(p, x).includes(module));
  return !!c && isExposed(c, dir, module, port);
}

function reachableParam(p: Patch, a: AssemblyInst, module: number, param: string): boolean {
  if (a.modules.includes(module)) return true;
  const c = childrenOf(p, a).find((x) => allModules(p, x).includes(module));
  return !!c && isPromoted(c, module, param);
}

/**
 * Keep an assembly consistent with the patch: members that are gone leave, exposures and promotions of departed modules
 * go, a parent only shows what its children expose, and every inner port with an outside cable is exposed (labels of
 * ports that stay are kept). Children must be reconciled first (reconcileAll does). Returns false when nothing is left.
 */
export function reconcile(p: Patch, a: AssemblyInst, defs?: Record<string, ModuleDef>): boolean {
  const ids = new Set(p.modules.map((m) => m.id));
  a.modules = a.modules.filter((id) => ids.has(id));
  if (a.children) {
    a.children = a.children.filter((id) => id !== a.id && assemblyById(p, id));
    if (!a.children.length) delete a.children;
  }
  const members = allModules(p, a);
  if (!members.length) return false;
  const member = new Set(members);
  if (a.kept) {
    a.kept = a.kept.filter((id) => member.has(id));
    if (!a.bypass) delete a.kept;
  }
  const typeOf = (id: number): string => p.modules.find((m) => m.id === id)!.type;
  const portOk = (dir: 'in' | 'out', t: Target): boolean => {
    if (!member.has(t.module)) return false;
    const def = defs?.[typeOf(t.module)];
    if (def && !(dir === 'in' ? def.inputs : def.outputs).some((q) => q.name === t.port)) return false;
    return reachable(p, a, dir, t.module, t.port);
  };
  const clean = (dir: 'in' | 'out', list: PortRef[]): PortRef[] => {
    const out: PortRef[] = [];
    const seen = new Set<string>();
    for (const r of list) {
      const ts = targetsOf(r).filter((t) => {
        const k = `${t.module}:${t.port}`;
        if (seen.has(k) || !portOk(dir, t)) return false;
        seen.add(k);
        return true;
      });
      if (!ts.length) continue;
      const next: PortRef = { module: ts[0].module, port: ts[0].port, label: r.label };
      if (dir === 'in' && ts.length > 1) next.also = ts.slice(1);
      out.push(next);
    }
    return out;
  };
  a.inputs = clean('in', a.inputs);
  a.outputs = clean('out', a.outputs);
  a.params = a.params.filter((r) => member.has(r.module) && (!defs || defs[typeOf(r.module)].params.some((q) => q.name === r.param)) && reachableParam(p, a, r.module, r.param));
  const b = boundary(p, members);
  for (const r of b.inputs) if (!isExposed(a, 'in', r.module, r.port)) a.inputs.push({ ...r, label: uniqueLabel(a.inputs.map((x) => x.label), r.port) });
  for (const r of b.outputs) if (!isExposed(a, 'out', r.module, r.port)) a.outputs.push({ ...r, label: uniqueLabel(a.outputs.map((x) => x.label), r.port) });
  return true;
}

/** reconcile every assembly, children before parents; empty ones are dropped. Returns the labels of the dropped ones. */
export function reconcileAll(p: Patch, defs?: Record<string, ModuleDef>): string[] {
  if (!p.assemblies) return [];
  const dropped: string[] = [];
  for (let pass = 0; pass < 8; pass++) {
    const list = [...assembliesOf(p)].sort((u, v) => depthOf(p, v) - depthOf(p, u));
    let changed = false;
    for (const a of list) {
      if (reconcile(p, a, defs)) continue;
      dropped.push(a.label);
      detach(p, a.id);
      p.assemblies = assembliesOf(p).filter((x) => x.id !== a.id);
      changed = true;
    }
    if (!changed) break;
  }
  if (!p.assemblies?.length) delete p.assemblies;
  return dropped;
}

/** take an assembly out of its parent's children (it becomes top level) */
function detach(p: Patch, asmId: number): void {
  const parent = parentOf(p, asmId);
  if (!parent) return;
  parent.children = parent.children!.filter((id) => id !== asmId);
  if (!parent.children.length) delete parent.children;
}

const nextAssemblyId = (p: Patch): number => assembliesOf(p).reduce((m, a) => Math.max(m, a.id), 0) + 1;
const instanceLabel = (p: Patch, name: string): string => uniqueLabel(assembliesOf(p).map((a) => a.label), name);

/**
 * Group the given modules into a new, collapsed assembly: the ports with outside cables are exposed. Modules that are all
 * direct members of one assembly form a child of it (nesting).
 */
export function makeAssembly(p: Patch, memberIds: number[], name = 'assembly'): AssemblyInst {
  const ids = [...new Set(memberIds)];
  if (!ids.length) throw new Error('select the modules first (shift-click, or drag a box on the canvas)');
  const parent = assemblyOf(p, ids[0]);
  for (const id of ids) {
    const why = memberProblem(p, id, parent);
    if (why) throw new Error(why);
    if (parent && !parent.modules.includes(id)) throw new Error(`${describe(p, p.modules.find((m) => m.id === ids[0])!)} is already in "${parent.label}": to nest, select modules inside it only`);
  }
  if (parent && depthOf(p, parent) + 1 > MAX_DEPTH) throw new Error(`assemblies nest at most ${MAX_DEPTH} deep`);
  const ms = ids.map((id) => p.modules.find((m) => m.id === id)!);
  const a: AssemblyInst = {
    v: 1,
    id: nextAssemblyId(p),
    name,
    label: instanceLabel(p, name),
    x: Math.min(...ms.map((m) => m.x)),
    y: Math.min(...ms.map((m) => m.y)),
    open: false,
    modules: ids,
    inputs: [],
    outputs: [],
    params: [],
  };
  p.assemblies = [...assembliesOf(p), a];
  if (parent) {
    parent.modules = parent.modules.filter((id) => !ids.includes(id));
    parent.children = [...(parent.children ?? []), a.id];
  }
  reconcile(p, a);
  if (parent) reconcile(p, parent);
  return a;
}

/** dissolve one level: the direct members and children stay, as plain modules / assemblies (or as members of the parent) */
export function ungroup(p: Patch, id: number): void {
  const a = assemblyById(p, id);
  if (!a) return;
  const parent = parentOf(p, id);
  if (parent) {
    parent.modules.push(...a.modules);
    if (a.children) parent.children = [...(parent.children ?? []), ...a.children];
    detach(p, id);
  }
  p.assemblies = assembliesOf(p).filter((x) => x.id !== id);
  if (!p.assemblies.length) delete p.assemblies;
  if (parent) reconcile(p, parent);
}

/** delete the assembly with its direct modules and their cables; nested assemblies survive (one level up) */
export function deleteAssembly(p: Patch, id: number): void {
  const a = assemblyById(p, id);
  if (!a) return;
  for (const m of a.modules) removeModule(p, m);
  ungroup(p, id);
}

/** ports that were exposed only for cables to or from the newcomers become inner wiring again */
function retract(p: Patch, a: AssemblyInst, newIds: number[]): void {
  const mine = new Set(allModules(p, a));
  const inner = (m: number): boolean => mine.has(m) || newIds.includes(m);
  const fed = (t: Target): boolean => p.cables.some((c) => sameEnd(c.to, t) && newIds.includes(c.from.module)) && !p.cables.some((c) => sameEnd(c.to, t) && !inner(c.from.module));
  a.inputs = a.inputs.flatMap((r) => {
    const ts = targetsOf(r).filter((t) => !fed(t));
    if (!ts.length) return [];
    const next: PortRef = { module: ts[0].module, port: ts[0].port, label: r.label };
    if (ts.length > 1) next.also = ts.slice(1);
    return [next];
  });
  a.outputs = a.outputs.filter((r) => !(p.cables.some((c) => sameEnd(c.from, r) && newIds.includes(c.to.module)) && !p.cables.some((c) => sameEnd(c.from, r) && !inner(c.to.module))));
}

/** a module joins */
export function addMember(p: Patch, a: AssemblyInst, moduleId: number): void {
  const why = memberProblem(p, moduleId, a);
  if (why) throw new Error(why);
  if (a.modules.includes(moduleId)) return;
  retract(p, a, [moduleId]);
  a.modules.push(moduleId);
  reconcile(p, a);
}

export function removeMember(p: Patch, a: AssemblyInst, moduleId: number): void {
  a.modules = a.modules.filter((id) => id !== moduleId);
  if (reconcile(p, a)) return;
  ungroup(p, a.id);
}

/** an assembly joins as a nested one (moving out of its previous parent, if any) */
export function addChild(p: Patch, parent: AssemblyInst, childId: number): void {
  if (parent.children?.includes(childId)) return;
  const prev = parentOf(p, childId);
  detach(p, childId);
  const why = childProblem(p, parent, childId);
  if (why) {
    if (prev) prev.children = [...(prev.children ?? []), childId];
    throw new Error(why);
  }
  const c = assemblyById(p, childId)!;
  retract(p, parent, allModules(p, c));
  parent.children = [...(parent.children ?? []), childId];
  reconcile(p, parent);
}

export function removeChild(p: Patch, parent: AssemblyInst, childId: number): void {
  if (!parent.children?.includes(childId)) return;
  detach(p, childId);
  if (reconcile(p, parent)) return;
  ungroup(p, parent.id);
}

/** show an inner port on the card; `also` merges further inner inputs into the same jack */
export function exposePort(a: AssemblyInst, dir: 'in' | 'out', module: number, port: string, also?: Target[]): void {
  if (isExposed(a, dir, module, port)) return;
  const list = dir === 'in' ? a.inputs : a.outputs;
  const r: PortRef = { module, port, label: uniqueLabel(list.map((x) => x.label), port) };
  const extra = dir === 'in' ? (also ?? []).filter((t) => !isExposed(a, 'in', t.module, t.port) && !(t.module === module && t.port === port)) : [];
  if (extra.length) r.also = extra;
  list.push(r);
}

/** hide an exposed port (a merged one as a whole); refused while an outside cable uses any of its inner ports */
export function hidePort(p: Patch, a: AssemblyInst, dir: 'in' | 'out', module: number, port: string): void {
  const ref = findRef(a, dir, module, port);
  if (!ref) return;
  const ts = targetsOf(ref);
  const wired = outsideCables(p, a).some((c) => ts.some((t) => (dir === 'in' ? sameEnd(c.to, t) : sameEnd(c.from, t))));
  if (wired) throw new Error(`${ref.label} still has a cable from outside: remove it first`);
  if (dir === 'in') a.inputs = a.inputs.filter((r) => r !== ref);
  else a.outputs = a.outputs.filter((r) => r !== ref);
}

/** merge the container input that carries `from` into the one that carries `into`: one jack feeding both (and whatever each already fed) */
export function mergePorts(p: Patch, a: AssemblyInst, defs: Record<string, ModuleDef>, into: Target, from: Target): void {
  const r1 = findRef(a, 'in', into.module, into.port);
  const r2 = findRef(a, 'in', from.module, from.port);
  if (!r1 || !r2) throw new Error('both ports must be exposed');
  if (r1 === r2) return;
  const kind = (t: Target): string => defs[p.modules.find((m) => m.id === t.module)!.type].inputs.find((q) => q.name === t.port)!.kind;
  if (kind(into) !== kind(from)) throw new Error(`cannot merge a ${kind(from)} port into a ${kind(into)} port`);
  r1.also = [...(r1.also ?? []), ...targetsOf(r2)];
  a.inputs = a.inputs.filter((r) => r !== r2);
}

/** split a merged port: every inner input it fed gets its own jack again */
export function unmergePort(a: AssemblyInst, module: number, port: string): void {
  const ref = findRef(a, 'in', module, port);
  if (!ref?.also?.length) return;
  const at = a.inputs.indexOf(ref);
  const extra: PortRef[] = ref.also.map((t) => ({ ...t, label: '' }));
  delete ref.also;
  const list = [...a.inputs.slice(0, at + 1), ...extra, ...a.inputs.slice(at + 1)];
  for (const r of extra) r.label = uniqueLabel(list.filter((x) => x.label).map((x) => x.label), r.port);
  a.inputs = list;
}

export function promote(a: AssemblyInst, module: number, param: string): void {
  if (!isPromoted(a, module, param)) a.params.push({ module, param, label: uniqueLabel(a.params.map((r) => r.label), param) });
}

export function demote(a: AssemblyInst, module: number, param: string): void {
  a.params = a.params.filter((r) => !(r.module === module && r.param === param));
}

/** move the collapsed card, every member and every nested assembly by (dx, dy) */
export function moveAssembly(p: Patch, a: AssemblyInst, dx: number, dy: number): void {
  const asms = [a, ...descendants(p, a)];
  const ids = new Set(asms.flatMap((x) => x.modules));
  for (const x of asms) {
    x.x = Math.max(0, x.x + dx);
    x.y = Math.max(0, x.y + dy);
  }
  for (const m of p.modules) if (ids.has(m.id)) {
    m.x = Math.max(0, m.x + dx);
    m.y = Math.max(0, m.y + dy);
  }
}

/** the editor's card grid: columns 270 px apart, rows 560 px (what "Add module" uses), a 20 px margin */
export const GRID = { x: 270, y: 560, cols: 4, margin: 20 };

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const overlaps = (a: Rect, b: Rect): boolean => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

/**
 * The first grid cell, in reading order, where a card of w x h would not touch any of the occupied rectangles. The scan
 * never ends on a row: a canvas can always grow downwards.
 */
export function freeSpot(occupied: Rect[], w: number, h: number): { x: number; y: number } {
  for (let row = 0; ; row++)
    for (let col = 0; col < GRID.cols; col++) {
      const r = { x: GRID.margin + col * GRID.x, y: GRID.margin + row * GRID.y, w, h };
      if (!occupied.some((o) => overlaps(o, r))) return { x: r.x, y: r.y };
    }
}

const memberModules = (p: Patch, a: AssemblyInst): ModuleInst[] => a.modules.map((id) => p.modules.find((m) => m.id === id)!).filter(Boolean);

/** whether two member cards sit on top of each other (closer than most of a card in both directions) */
export function overlapping(p: Patch, a: AssemblyInst): boolean {
  const ms = memberModules(p, a);
  for (let i = 0; i < ms.length; i++)
    for (let j = i + 1; j < ms.length; j++) if (Math.abs(ms[i].x - ms[j].x) < 200 && Math.abs(ms[i].y - ms[j].y) < 120) return true;
  return false;
}

/** lay the members out on the grid from their top left corner, in their current reading order */
export function tileMembers(p: Patch, a: AssemblyInst): void {
  const ms = memberModules(p, a).sort((u, v) => u.y - v.y || u.x - v.x);
  const x0 = Math.min(...ms.map((m) => m.x));
  const y0 = Math.min(...ms.map((m) => m.y));
  ms.forEach((m, i) => {
    m.x = x0 + (i % GRID.cols) * GRID.x;
    m.y = y0 + Math.floor(i / GRID.cols) * GRID.y;
  });
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function stripKnobs(m: ModuleInst): void {
  if (m.map) for (const k of KNOBS) m.map[k] = [];
}

/** the saved form of an assembly: every module with local ids 1..n, nested assemblies with local ids, positions from the top left member, no knob assignments */
export function toDef(p: Patch, a: AssemblyInst): AssemblyDef {
  const nested = descendants(p, a);
  const order = [...a.modules, ...nested.flatMap((d) => d.modules)];
  const ms = order.map((id) => clone(p.modules.find((m) => m.id === id)!));
  const local = new Map(order.map((id, i) => [id, i + 1]));
  const localAsm = new Map(nested.map((d, i) => [d.id, i + 1]));
  const x0 = Math.min(...ms.map((m) => m.x));
  const y0 = Math.min(...ms.map((m) => m.y));
  const kept = a.bypass ? new Set(a.kept ?? []) : null; // a group that is off: the definition gets the members' own switches
  for (const m of ms) {
    if (kept) {
      if (kept.has(m.id)) m.bypass = true;
      else delete m.bypass;
    }
    m.id = local.get(m.id)!;
    m.x -= x0;
    m.y -= y0;
    stripKnobs(m);
  }
  const remap = <T extends { module: number }>(r: T): T => ({ ...r, module: local.get(r.module)! });
  const port = (r: PortRef): PortRef => {
    const n = remap(r);
    if (r.also) n.also = r.also.map(remap);
    return n;
  };
  const def: AssemblyDef = {
    format: ASSEMBLY_FORMAT,
    version: 1,
    name: a.name,
    ...assemblyLayout(a),
    modules: ms,
    cables: p.cables.filter((c) => local.has(c.from.module) && local.has(c.to.module)).map((c) => ({ from: remap(c.from), to: remap(c.to) })),
    inputs: a.inputs.map(port),
    outputs: a.outputs.map(port),
    params: a.params.map(remap),
  };
  if (nested.length) {
    def.children = (a.children ?? []).map((id) => localAsm.get(id)!);
    def.assemblies = nested.map((d) => {
      const n: NestedDef = {
        id: localAsm.get(d.id)!,
        name: d.name,
        label: d.label,
        x: d.x - x0,
        y: d.y - y0,
        open: d.open,
        ...assemblyLayout(d),
        modules: d.modules.map((id) => local.get(id)!),
        inputs: d.inputs.map(port),
        outputs: d.outputs.map(port),
        params: d.params.map(remap),
      };
      if (d.children?.length) n.children = d.children.map((id) => localAsm.get(id)!);
      return n;
    });
  }
  return def;
}

/** put a saved assembly into the patch, collapsed at (x, y), with fresh module and assembly ids */
export function insertAssembly(p: Patch, defs: Record<string, ModuleDef>, def: AssemblyDef, x: number, y: number): AssemblyInst {
  if (p.modules.length + def.modules.length > MAX_MODULES) throw new Error(`"${def.name}" does not fit: a patch holds at most ${MAX_MODULES} modules`);
  const fresh = new Map<number, number>();
  for (const src of def.modules) {
    const m = addModule(p, defs[src.type], x + src.x, y + src.y);
    m.params = { ...m.params, ...clone(src.params) };
    if (src.att) m.att = [...src.att];
    if (src.map) m.map = clone(src.map);
    if (src.inputMap) m.inputMap = structuredClone(src.inputMap);
    fixInputRoutes(m, defs[src.type]);
    fixMatrix(m, defs[src.type]);
    stripKnobs(m);
    fresh.set(src.id, m.id);
  }
  const remap = <T extends { module: number }>(r: T): T => ({ ...r, module: fresh.get(r.module)! });
  const port = (r: PortRef): PortRef => {
    const n = remap(r);
    if (r.also) n.also = r.also.map(remap);
    return n;
  };
  for (const c of def.cables) p.cables.push({ from: remap(c.from), to: remap(c.to) });
  const nested = def.assemblies ?? [];
  let nextId = nextAssemblyId(p);
  const freshAsm = new Map(nested.map((d) => [d.id, nextId++]));
  const claimed = new Set(nested.flatMap((d) => d.modules));
  const taken = assembliesOf(p).map((o) => o.label);
  const made: AssemblyInst[] = nested.map((d) => {
    const n: AssemblyInst = {
      v: 1,
      id: freshAsm.get(d.id)!,
      name: d.name,
      label: uniqueLabel(taken, d.label || d.name),
      x: Math.max(0, x + d.x),
      y: Math.max(0, y + d.y),
      open: d.open,
      ...assemblyLayout(d),
      modules: d.modules.map((id) => fresh.get(id)!),
      inputs: d.inputs.map(port),
      outputs: d.outputs.map(port),
      params: d.params.map(remap),
    };
    taken.push(n.label);
    if (d.children?.length) n.children = d.children.map((id) => freshAsm.get(id)!);
    return n;
  });
  const a: AssemblyInst = {
    v: 1,
    id: nextId,
    name: def.name,
    ...assemblyLayout(def),
    label: uniqueLabel(taken, def.name),
    x,
    y,
    open: false,
    modules: def.modules.filter((src) => !claimed.has(src.id)).map((src) => fresh.get(src.id)!),
    inputs: def.inputs.map(port),
    outputs: def.outputs.map(port),
    params: def.params.map(remap),
  };
  if (def.children?.length) a.children = def.children.map((id) => freshAsm.get(id)!);
  p.assemblies = [...assembliesOf(p), ...made, a];
  for (const n of [...made].reverse()) reconcile(p, n, defs);
  reconcile(p, a, defs);
  return a;
}

const isRec = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object';

/** structural check of a saved assembly (a file, a library entry, a factory file). Throws with a readable message. */
/**
 * Drop the Main panel and the Output from a definition (a file or library entry made by hand, or by an older editor):
 * their cables, exposed ports and promoted parameters go with them. Returns how many modules went.
 */
export function stripPatchIO(d: AssemblyDef): number {
  const gone = new Set(d.modules.filter((m) => isRec(m) && EXCLUDED_TYPES.has(String(m.type))).map((m) => m.id));
  if (!gone.size) return 0;
  d.modules = d.modules.filter((m) => !gone.has(m.id));
  d.cables = d.cables.filter((c) => isRec(c) && isRec(c.from) && isRec(c.to) && !gone.has(c.from.module) && !gone.has(c.to.module));
  const keep = (r: unknown): boolean => isRec(r) && !gone.has(r.module as number) && !(Array.isArray(r.also) && r.also.some((a) => isRec(a) && gone.has(a.module as number)));
  if (Array.isArray(d.inputs)) d.inputs = d.inputs.filter(keep);
  if (Array.isArray(d.outputs)) d.outputs = d.outputs.filter(keep);
  if (Array.isArray(d.params)) d.params = d.params.filter(keep);
  if (Array.isArray(d.assemblies)) for (const n of d.assemblies) if (isRec(n) && Array.isArray(n.modules)) n.modules = n.modules.filter((id) => !gone.has(id as number));
  return gone.size;
}

export function validateAssemblyDef(raw: unknown, defs: Record<string, ModuleDef>): AssemblyDef {
  if (!isRec(raw) || raw.format !== ASSEMBLY_FORMAT || !Array.isArray(raw.modules) || !Array.isArray(raw.cables)) throw new Error('not a Matryoshka assembly');
  const d = raw as unknown as AssemblyDef;
  const layout = assemblyLayout(d);
  delete d.size; delete d.frameSize;
  Object.assign(d, layout);
  stripPatchIO(d); // a patch's own modules never belong to a building block
  if (d.modules.length > MAX_MODULES || !d.modules.length) throw new Error('an assembly holds 1 to 32 modules');
  if (d.category !== undefined && typeof d.category !== 'string') delete d.category;
  if (d.tutorial !== undefined && typeof d.tutorial !== 'string') delete d.tutorial;
  const seen = new Set<number>();
  for (const m of d.modules) {
    const def = defs[m.type];
    if (!def) throw new Error(`unknown module type "${m.type}"`);
    if (!Number.isInteger(m.id) || seen.has(m.id)) throw new Error(`bad or duplicate module id ${m.id}`);
    seen.add(m.id);
    m.params = { ...defaultParams(def), ...(m.params ?? {}) };
    m.x = Number(m.x) || 0;
    m.y = Number(m.y) || 0;
    fixMatrix(m, def);
    fixInputRoutes(m, def);
    stripKnobs(m);
  }
  const typeOf = (id: number): string | undefined => d.modules.find((m) => m.id === id)?.type;
  for (const c of d.cables) {
    const tf = typeOf(c.from?.module);
    const tt = typeOf(c.to?.module);
    if (!tf || !tt) throw new Error('cable to a module outside the assembly');
    if (!defs[tf].outputs.some((o) => o.name === c.from.port)) throw new Error(`no output "${c.from.port}" on ${tf}`);
    if (!defs[tt].inputs.some((i) => i.name === c.to.port)) throw new Error(`no input "${c.to.port}" on ${tt}`);
  }
  const target = (r: unknown, dir: 'in' | 'out'): Target => {
    if (!isRec(r)) throw new Error('bad port');
    const t = typeOf(Number(r.module));
    if (!t || !(dir === 'in' ? defs[t].inputs : defs[t].outputs).some((q) => q.name === r.port)) throw new Error(`exposed ${dir === 'in' ? 'input' : 'output'} "${String(r.port)}" does not exist`);
    return { module: Number(r.module), port: String(r.port) };
  };
  const ports = (list: unknown, dir: 'in' | 'out'): PortRef[] =>
    (Array.isArray(list) ? list : []).flatMap((r: unknown) => {
      if (!isRec(r)) return [];
      const t = target(r, dir);
      const ref: PortRef = { ...t, label: String(r.label ?? r.port) };
      if (dir === 'in' && Array.isArray(r.also) && r.also.length) ref.also = r.also.map((x) => target(x, 'in'));
      return [ref];
    });
  const params = (list: unknown): ParamRef[] =>
    (Array.isArray(list) ? list : []).flatMap((r: unknown) => {
      if (!isRec(r)) return [];
      const t = typeOf(Number(r.module));
      if (!t || !defs[t].params.some((q) => q.name === r.param)) throw new Error(`promoted parameter "${String(r.param)}" does not exist`);
      return [{ module: Number(r.module), param: String(r.param), label: String(r.label ?? r.param) }];
    });
  d.inputs = ports(d.inputs, 'in');
  d.outputs = ports(d.outputs, 'out');
  d.params = params(d.params);
  // nested assemblies: local ids, disjoint direct members, a tree of at most MAX_DEPTH levels
  const rawNested = (raw as { assemblies?: unknown }).assemblies;
  if (Array.isArray(rawNested) && rawNested.length) {
    const asmIds = new Set<number>();
    const claimed = new Set<number>();
    d.assemblies = rawNested.map((e: unknown): NestedDef => {
      if (!isRec(e) || !Number.isInteger(e.id) || !Array.isArray(e.modules)) throw new Error('bad nested assembly');
      if (asmIds.has(Number(e.id))) throw new Error(`duplicate nested assembly id ${String(e.id)}`);
      asmIds.add(Number(e.id));
      const mods = e.modules.map(Number);
      for (const id of mods) {
        if (!typeOf(id)) throw new Error(`nested assembly: module ${id} is not in the file`);
        if (claimed.has(id)) throw new Error(`nested assembly: module ${id} is in two assemblies`);
        claimed.add(id);
      }
      const n: NestedDef = {
        id: Number(e.id),
        name: String(e.name ?? 'assembly'),
        label: String(e.label ?? e.name ?? 'assembly'),
        x: Number(e.x) || 0,
        y: Number(e.y) || 0,
        open: !!e.open,
        ...assemblyLayout(e),
        modules: mods,
        inputs: ports(e.inputs, 'in'),
        outputs: ports(e.outputs, 'out'),
        params: params(e.params),
      };
      if (Array.isArray(e.children) && e.children.length) n.children = e.children.map(Number);
      return n;
    });
    const byId = new Map(d.assemblies.map((n) => [n.id, n]));
    const parent = new Map<number, number>();
    const link = (from: number, kids: number[] | undefined): void => {
      for (const k of kids ?? []) {
        if (!byId.has(k)) throw new Error(`nested assembly ${k} does not exist`);
        if (parent.has(k) || k === from) throw new Error(`nested assembly ${k} has two parents`);
        parent.set(k, from);
      }
    };
    const rawKids = (raw as { children?: unknown }).children;
    d.children = Array.isArray(rawKids) ? rawKids.map(Number) : [];
    link(0, d.children);
    for (const n of d.assemblies) link(n.id, n.children);
    for (const n of d.assemblies) if (!parent.has(n.id)) throw new Error(`nested assembly "${n.label}" is in no assembly`);
    const depth = (id: number, guard = 0): number => (id === 0 ? 1 : guard > MAX_DEPTH ? guard : 1 + depth(parent.get(id)!, guard + 1));
    for (const n of d.assemblies) if (depth(n.id) > MAX_DEPTH) throw new Error(`assemblies nest at most ${MAX_DEPTH} deep`);
    for (const n of d.assemblies) if (!n.modules.length && !n.children?.length) throw new Error(`nested assembly "${n.label}" is empty`);
    if (!d.children.length) delete d.children;
  } else {
    delete d.assemblies;
    delete d.children;
  }
  d.version = 1;
  d.name = String(d.name ?? 'assembly').trim() || 'assembly';
  return d;
}

/**
 * Check the overlay of a loaded patch: an entry that does not fit the modules is dropped and its modules stay plain; a
 * nesting that does not form a tree of at most MAX_DEPTH levels is undone. Returns one message per repair. Call after
 * validatePatch.
 */
export function fixAssemblies(p: Patch, defs: Record<string, ModuleDef>): string[] {
  const msgs: string[] = [];
  const raw = (p as { assemblies?: unknown }).assemblies;
  if (raw === undefined || raw === null) {
    delete p.assemblies;
    return msgs;
  }
  if (!Array.isArray(raw)) {
    delete p.assemblies;
    return ['assemblies dropped: not a list'];
  }
  const ids = new Set<number>();
  const used = new Set<number>();
  const ok: AssemblyInst[] = [];
  const wantKids = new Map<number, number[]>();
  raw.forEach((e: unknown, i: number) => {
    const label = isRec(e) && typeof e.label === 'string' ? e.label : `#${i + 1}`;
    const drop = (why: string): void => {
      msgs.push(`assembly "${label}" dropped: ${why}`);
    };
    if (!isRec(e) || !Array.isArray(e.modules)) return drop('bad entry');
    const members = e.modules.map(Number);
    const kids = Array.isArray(e.children) ? e.children.map(Number).filter((k) => Number.isInteger(k)) : [];
    if ((!members.length && !kids.length) || members.some((id) => !Number.isInteger(id))) return drop('no members');
    for (const id of members) {
      const m = p.modules.find((x) => x.id === id);
      if (!m) return drop(`module ${id} is missing`);
      if (EXCLUDED_TYPES.has(m.type)) return drop('it contains the Main panel or the Output');
      if (used.has(id)) return drop(`module ${id} is in two assemblies`);
    }
    const id = Number.isInteger(e.id) && !ids.has(Number(e.id)) ? Number(e.id) : ok.reduce((m, a) => Math.max(m, a.id), 0) + 1;
    const a: AssemblyInst = {
      v: 1,
      id,
      name: String(e.name ?? 'assembly'),
      label: typeof e.label === 'string' && e.label ? e.label : String(e.name ?? 'assembly'),
      x: Number(e.x) || 0,
      y: Number(e.y) || 0,
      open: !!e.open,
      ...assemblyLayout(e),
      modules: [...new Set(members)],
      inputs: refs(e.inputs, 'port'),
      outputs: refs(e.outputs, 'port').map((r) => ({ module: r.module, port: r.port, label: r.label })),
      params: refs(e.params, 'param') as unknown as ParamRef[],
    };
    for (const m of a.modules) used.add(m);
    ids.add(a.id);
    if (kids.length) wantKids.set(a.id, kids);
    ok.push(a);
  });
  p.assemblies = ok;
  // nesting: a child exists, has one parent, no cycles, at most MAX_DEPTH levels
  const parentOfId = new Map<number, number>();
  for (const a of ok) {
    const kids: number[] = [];
    for (const k of wantKids.get(a.id) ?? []) {
      const c = ok.find((x) => x.id === k);
      if (!c || k === a.id) msgs.push(`assembly "${a.label}": nested assembly ${k} is missing`);
      else if (parentOfId.has(k)) msgs.push(`assembly "${c.label}" is in two assemblies: kept in "${ok.find((x) => x.id === parentOfId.get(k))!.label}"`);
      else {
        parentOfId.set(k, a.id);
        kids.push(k);
      }
    }
    if (kids.length) a.children = kids;
  }
  for (const a of ok) {
    const seen = new Set<number>([a.id]);
    for (let x = parentOfId.get(a.id); x !== undefined; x = parentOfId.get(x)) {
      if (seen.has(x)) {
        msgs.push(`assembly "${a.label}": nesting loop undone`);
        const par = ok.find((q) => q.id === parentOfId.get(a.id))!;
        par.children = par.children!.filter((k) => k !== a.id);
        if (!par.children.length) delete par.children;
        parentOfId.delete(a.id);
        break;
      }
      seen.add(x);
    }
  }
  for (const a of ok)
    if (depthOf(p, a) > MAX_DEPTH) {
      const par = parentOf(p, a.id)!;
      msgs.push(`assembly "${a.label}" is nested too deep (more than ${MAX_DEPTH}): taken out of "${par.label}"`);
      par.children = par.children!.filter((k) => k !== a.id);
      if (!par.children.length) delete par.children;
    }
  reconcileAll(p, defs);
  return msgs;
}

function refs(list: unknown, key: 'port' | 'param'): PortRef[] {
  return (Array.isArray(list) ? list : []).flatMap((r: unknown) => {
    if (!isRec(r) || !Number.isInteger(Number(r.module)) || typeof r[key] !== 'string') return [];
    const ref = { module: Number(r.module), [key]: r[key], label: String(r.label ?? r[key]) } as unknown as PortRef;
    if (key === 'port' && Array.isArray(r.also)) {
      const also = r.also.flatMap((t: unknown) => (isRec(t) && Number.isInteger(Number(t.module)) && typeof t.port === 'string' ? [{ module: Number(t.module), port: t.port }] : []));
      if (also.length) ref.also = also;
    }
    return [ref];
  });
}
