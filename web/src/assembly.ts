// SPDX-License-Identifier: GPL-3.0-only
// Assemblies: a group of prewired modules shown as one card with the ports and parameters it exposes.
//
// The patch stays flat. `Patch.assemblies` is an overlay: each entry names its member modules (ids in `patch.modules`),
// the inner ports it exposes and the inner parameters it promotes. Cables always run between inner ports, so the engine,
// the voice split, the binary format and the FM-1 never see assemblies; an editor that does not know the overlay loads
// the same patch and only loses the grouping. An assembly holds plain modules (no nesting yet, `v` is there for that),
// never the FM-1 panel or an Output. A saved assembly (`AssemblyDef`, one JSON file) is a small patch of its own: member
// modules with local ids, the cables between them, the exposed ports and promoted parameters.
import {
  addModule,
  defaultParams,
  fixMatrix,
  MAX_MODULES,
  nextId,
  removeModule,
  sameEnd,
  type Cable,
  type ModuleDef,
  type ModuleInst,
  type Patch,
} from './patch';

export interface PortRef {
  module: number;
  port: string;
  label: string;
}
export interface ParamRef {
  module: number;
  param: string;
  label: string;
}

/** an assembly in a patch: the overlay entry */
export interface AssemblyInst {
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
  modules: number[];
  inputs: PortRef[];
  outputs: PortRef[];
  params: ParamRef[];
}

/** a saved assembly: the file format, the library entry and the factory set. Module ids are local (1..n), positions relative. */
export interface AssemblyDef {
  format: 'modular-1-assembly';
  version: 1;
  name: string;
  modules: ModuleInst[];
  cables: Cable[];
  inputs: PortRef[];
  outputs: PortRef[];
  params: ParamRef[];
}

export const ASSEMBLY_FORMAT = 'modular-1-assembly';
/** module types that cannot be members: the one panel and the output are the patch's own */
export const EXCLUDED_TYPES = new Set(['fm1', 'output']);
const KNOBS = ['k1', 'k2', 'k3', 'k4'] as const;

export const assembliesOf = (p: Patch): AssemblyInst[] => p.assemblies ?? [];

export function assemblyOf(p: Patch, moduleId: number): AssemblyInst | undefined {
  return assembliesOf(p).find((a) => a.modules.includes(moduleId));
}

/** the ids of modules inside collapsed assemblies: not drawn as cards */
export function hiddenModules(p: Patch): Set<number> {
  const h = new Set<number>();
  for (const a of assembliesOf(p)) if (!a.open) for (const id of a.modules) h.add(id);
  return h;
}

export function isExposed(a: AssemblyInst, dir: 'in' | 'out', module: number, port: string): boolean {
  return (dir === 'in' ? a.inputs : a.outputs).some((r) => r.module === module && r.port === port);
}

export function isPromoted(a: AssemblyInst, module: number, param: string): boolean {
  return a.params.some((r) => r.module === module && r.param === param);
}

/** the cables that cross the assembly's boundary */
export function outsideCables(p: Patch, a: AssemblyInst): Cable[] {
  const m = new Set(a.modules);
  return p.cables.filter((c) => m.has(c.from.module) !== m.has(c.to.module));
}

function uniqueLabel(taken: Iterable<string>, want: string): string {
  const set = new Set(taken);
  if (!set.has(want)) return want;
  for (let n = 2; ; n++) if (!set.has(`${want} ${n}`)) return `${want} ${n}`;
}

/** the inner ports with a cable to or from outside: the ports an assembly must expose */
export function boundary(p: Patch, members: Iterable<number>): { inputs: Omit<PortRef, 'label'>[]; outputs: Omit<PortRef, 'label'>[] } {
  const m = new Set(members);
  const inputs: Omit<PortRef, 'label'>[] = [];
  const outputs: Omit<PortRef, 'label'>[] = [];
  for (const c of p.cables) {
    if (m.has(c.to.module) && !m.has(c.from.module) && !inputs.some((r) => r.module === c.to.module && r.port === c.to.port)) inputs.push({ module: c.to.module, port: c.to.port });
    if (m.has(c.from.module) && !m.has(c.to.module) && !outputs.some((r) => r.module === c.from.module && r.port === c.from.port)) outputs.push({ module: c.from.module, port: c.from.port });
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

function describe(p: Patch, m: ModuleInst): string {
  const same = p.modules.filter((x) => x.type === m.type);
  return same.length > 1 ? `${m.type} ${same.indexOf(m) + 1}` : m.type;
}

/**
 * Keep an assembly consistent with the patch: members that are gone leave, exposures and promotions of departed modules
 * go, and every inner port with an outside cable is exposed (labels of ports that stay are kept). Returns false when
 * nothing is left of it.
 */
export function reconcile(p: Patch, a: AssemblyInst, defs?: Record<string, ModuleDef>): boolean {
  const ids = new Set(p.modules.map((m) => m.id));
  a.modules = a.modules.filter((id) => ids.has(id));
  if (!a.modules.length) return false;
  const member = new Set(a.modules);
  const typeOf = (id: number): string => p.modules.find((m) => m.id === id)!.type;
  const portOk = (dir: 'in' | 'out', r: PortRef): boolean => {
    if (!member.has(r.module)) return false;
    const def = defs?.[typeOf(r.module)];
    return def ? (dir === 'in' ? def.inputs : def.outputs).some((q) => q.name === r.port) : true;
  };
  a.inputs = a.inputs.filter((r) => portOk('in', r));
  a.outputs = a.outputs.filter((r) => portOk('out', r));
  a.params = a.params.filter((r) => member.has(r.module) && (!defs || defs[typeOf(r.module)].params.some((q) => q.name === r.param)));
  const b = boundary(p, a.modules);
  for (const r of b.inputs) if (!isExposed(a, 'in', r.module, r.port)) a.inputs.push({ ...r, label: uniqueLabel(a.inputs.map((x) => x.label), r.port) });
  for (const r of b.outputs) if (!isExposed(a, 'out', r.module, r.port)) a.outputs.push({ ...r, label: uniqueLabel(a.outputs.map((x) => x.label), r.port) });
  return true;
}

/** reconcile every assembly; empty ones are dropped. Returns the labels of the dropped ones. */
export function reconcileAll(p: Patch, defs?: Record<string, ModuleDef>): string[] {
  if (!p.assemblies) return [];
  const dropped: string[] = [];
  p.assemblies = p.assemblies.filter((a) => {
    const keep = reconcile(p, a, defs);
    if (!keep) dropped.push(a.label);
    return keep;
  });
  if (!p.assemblies.length) delete p.assemblies;
  return dropped;
}

const nextAssemblyId = (p: Patch): number => assembliesOf(p).reduce((m, a) => Math.max(m, a.id), 0) + 1;
const instanceLabel = (p: Patch, name: string): string => uniqueLabel(assembliesOf(p).map((a) => a.label), name);

/** group the given modules into a new, collapsed assembly: the ports with outside cables are exposed */
export function makeAssembly(p: Patch, memberIds: number[], name = 'assembly'): AssemblyInst {
  const ids = [...new Set(memberIds)];
  if (!ids.length) throw new Error('select the modules first (shift-click, or drag a box on the canvas)');
  for (const id of ids) {
    const why = memberProblem(p, id);
    if (why) throw new Error(why);
  }
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
  reconcile(p, a);
  p.assemblies = [...assembliesOf(p), a];
  return a;
}

/** dissolve: the members stay as plain modules */
export function ungroup(p: Patch, id: number): void {
  p.assemblies = assembliesOf(p).filter((a) => a.id !== id);
  if (!p.assemblies.length) delete p.assemblies;
}

/** delete the assembly with its modules and their cables */
export function deleteAssembly(p: Patch, id: number): void {
  const a = assembliesOf(p).find((x) => x.id === id);
  if (a) for (const m of a.modules) removeModule(p, m);
  ungroup(p, id);
}

/** a module joins: the ports that were exposed only for cables to or from it become inner wiring again */
export function addMember(p: Patch, a: AssemblyInst, moduleId: number): void {
  const why = memberProblem(p, moduleId, a);
  if (why) throw new Error(why);
  if (a.modules.includes(moduleId)) return;
  const toIt = p.cables.filter((c) => c.to.module === moduleId && a.modules.includes(c.from.module));
  const fromIt = p.cables.filter((c) => c.from.module === moduleId && a.modules.includes(c.to.module));
  a.outputs = a.outputs.filter((r) => !toIt.some((c) => sameEnd(c.from, r)));
  a.inputs = a.inputs.filter((r) => !fromIt.some((c) => sameEnd(c.to, r)));
  a.modules.push(moduleId);
  reconcile(p, a);
}

export function removeMember(p: Patch, a: AssemblyInst, moduleId: number): void {
  a.modules = a.modules.filter((id) => id !== moduleId);
  if (reconcile(p, a)) return;
  ungroup(p, a.id);
}

export function exposePort(a: AssemblyInst, dir: 'in' | 'out', module: number, port: string): void {
  if (isExposed(a, dir, module, port)) return;
  const list = dir === 'in' ? a.inputs : a.outputs;
  list.push({ module, port, label: uniqueLabel(list.map((r) => r.label), port) });
}

/** hide an exposed port; refused while an outside cable uses it */
export function hidePort(p: Patch, a: AssemblyInst, dir: 'in' | 'out', module: number, port: string): void {
  const wired = outsideCables(p, a).some((c) => (dir === 'in' ? sameEnd(c.to, { module, port }) : sameEnd(c.from, { module, port })));
  if (wired) throw new Error(`${port} still has a cable from outside: remove it first`);
  if (dir === 'in') a.inputs = a.inputs.filter((r) => !(r.module === module && r.port === port));
  else a.outputs = a.outputs.filter((r) => !(r.module === module && r.port === port));
}

export function promote(a: AssemblyInst, module: number, param: string): void {
  if (!isPromoted(a, module, param)) a.params.push({ module, param, label: uniqueLabel(a.params.map((r) => r.label), param) });
}

export function demote(a: AssemblyInst, module: number, param: string): void {
  a.params = a.params.filter((r) => !(r.module === module && r.param === param));
}

/** move the collapsed card and every member by (dx, dy) */
export function moveAssembly(p: Patch, a: AssemblyInst, dx: number, dy: number): void {
  a.x = Math.max(0, a.x + dx);
  a.y = Math.max(0, a.y + dy);
  for (const m of p.modules) if (a.modules.includes(m.id)) {
    m.x = Math.max(0, m.x + dx);
    m.y = Math.max(0, m.y + dy);
  }
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;

function stripKnobs(m: ModuleInst): void {
  if (m.map) for (const k of KNOBS) m.map[k] = [];
}

/** the saved form of an assembly: members with local ids 1..n, positions from the top left member, no knob assignments */
export function toDef(p: Patch, a: AssemblyInst): AssemblyDef {
  const ms = a.modules.map((id) => clone(p.modules.find((m) => m.id === id)!));
  const local = new Map(a.modules.map((id, i) => [id, i + 1]));
  const x0 = Math.min(...ms.map((m) => m.x));
  const y0 = Math.min(...ms.map((m) => m.y));
  for (const m of ms) {
    m.id = local.get(m.id)!;
    m.x -= x0;
    m.y -= y0;
    stripKnobs(m);
  }
  const remap = <T extends { module: number }>(r: T): T => ({ ...r, module: local.get(r.module)! });
  return {
    format: ASSEMBLY_FORMAT,
    version: 1,
    name: a.name,
    modules: ms,
    cables: p.cables.filter((c) => local.has(c.from.module) && local.has(c.to.module)).map((c) => ({ from: remap(c.from), to: remap(c.to) })),
    inputs: a.inputs.map(remap),
    outputs: a.outputs.map(remap),
    params: a.params.map(remap),
  };
}

/** put a saved assembly into the patch, collapsed at (x, y), with fresh module ids */
export function insertAssembly(p: Patch, defs: Record<string, ModuleDef>, def: AssemblyDef, x: number, y: number): AssemblyInst {
  if (p.modules.length + def.modules.length > MAX_MODULES) throw new Error(`"${def.name}" does not fit: a patch holds at most ${MAX_MODULES} modules`);
  const fresh = new Map<number, number>();
  const added: ModuleInst[] = [];
  for (const src of def.modules) {
    const m = addModule(p, defs[src.type], x + src.x, y + src.y);
    m.params = { ...m.params, ...clone(src.params) };
    if (src.att) m.att = [...src.att];
    if (src.map) m.map = clone(src.map);
    fixMatrix(m, defs[src.type]);
    stripKnobs(m);
    fresh.set(src.id, m.id);
    added.push(m);
  }
  const remap = <T extends { module: number }>(r: T): T => ({ ...r, module: fresh.get(r.module)! });
  for (const c of def.cables) p.cables.push({ from: remap(c.from), to: remap(c.to) });
  const a: AssemblyInst = {
    v: 1,
    id: nextAssemblyId(p),
    name: def.name,
    label: instanceLabel(p, def.name),
    x,
    y,
    open: false,
    modules: added.map((m) => m.id),
    inputs: def.inputs.map(remap),
    outputs: def.outputs.map(remap),
    params: def.params.map(remap),
  };
  reconcile(p, a, defs);
  p.assemblies = [...assembliesOf(p), a];
  return a;
}

const isRec = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object';

/** structural check of a saved assembly (a file, a library entry, a factory file). Throws with a readable message. */
export function validateAssemblyDef(raw: unknown, defs: Record<string, ModuleDef>): AssemblyDef {
  if (!isRec(raw) || raw.format !== ASSEMBLY_FORMAT || !Array.isArray(raw.modules) || !Array.isArray(raw.cables)) throw new Error('not a Modular-1 assembly');
  const d = raw as unknown as AssemblyDef;
  if (d.modules.length > MAX_MODULES || !d.modules.length) throw new Error('an assembly holds 1 to 32 modules');
  const seen = new Set<number>();
  for (const m of d.modules) {
    const def = defs[m.type];
    if (!def) throw new Error(`unknown module type "${m.type}"`);
    if (EXCLUDED_TYPES.has(m.type)) throw new Error('the Main panel and the Output cannot be part of an assembly');
    if (!Number.isInteger(m.id) || seen.has(m.id)) throw new Error(`bad or duplicate module id ${m.id}`);
    seen.add(m.id);
    m.params = { ...defaultParams(def), ...(m.params ?? {}) };
    m.x = Number(m.x) || 0;
    m.y = Number(m.y) || 0;
    fixMatrix(m, def);
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
  const ports = (list: unknown, dir: 'in' | 'out'): PortRef[] =>
    (Array.isArray(list) ? list : []).flatMap((r: unknown) => {
      if (!isRec(r)) return [];
      const t = typeOf(Number(r.module));
      if (!t || !(dir === 'in' ? defs[t].inputs : defs[t].outputs).some((q) => q.name === r.port)) throw new Error(`exposed ${dir === 'in' ? 'input' : 'output'} "${String(r.port)}" does not exist`);
      return [{ module: Number(r.module), port: String(r.port), label: String(r.label ?? r.port) }];
    });
  d.inputs = ports(d.inputs, 'in');
  d.outputs = ports(d.outputs, 'out');
  d.params = (Array.isArray(d.params) ? d.params : []).flatMap((r: unknown) => {
    if (!isRec(r)) return [];
    const t = typeOf(Number(r.module));
    if (!t || !defs[t].params.some((q) => q.name === r.param)) throw new Error(`promoted parameter "${String(r.param)}" does not exist`);
    return [{ module: Number(r.module), param: String(r.param), label: String(r.label ?? r.param) }];
  });
  d.version = 1;
  d.name = String(d.name ?? 'assembly').trim() || 'assembly';
  return d;
}

/**
 * Check the overlay of a loaded patch: an entry that does not fit the modules is dropped and its modules stay plain.
 * Returns one message per dropped entry. Call after validatePatch.
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
  raw.forEach((e: unknown, i: number) => {
    const label = isRec(e) && typeof e.label === 'string' ? e.label : `#${i + 1}`;
    const drop = (why: string): void => {
      msgs.push(`assembly "${label}" dropped: ${why}`);
    };
    if (!isRec(e) || !Array.isArray(e.modules)) return drop('bad entry');
    const members = e.modules.map(Number);
    if (!members.length || members.some((id) => !Number.isInteger(id))) return drop('no members');
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
      modules: [...new Set(members)],
      inputs: refs(e.inputs, 'port'),
      outputs: refs(e.outputs, 'port'),
      params: refs(e.params, 'param') as unknown as ParamRef[],
    };
    for (const m of a.modules) used.add(m);
    ids.add(a.id);
    ok.push(a);
  });
  p.assemblies = ok;
  reconcileAll(p, defs);
  return msgs;
}

function refs(list: unknown, key: 'port' | 'param'): PortRef[] {
  return (Array.isArray(list) ? list : []).flatMap((r: unknown) =>
    isRec(r) && Number.isInteger(Number(r.module)) && typeof r[key] === 'string' ? [{ module: Number(r.module), [key]: r[key], label: String(r.label ?? r[key]) } as unknown as PortRef] : [],
  );
}
