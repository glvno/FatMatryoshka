// SPDX-License-Identifier: GPL-3.0-only
// Record a step in the synth: the lesson editor loads the step's beginning state, the author does the step, and capture()
// turns the difference (modules, cables, sliders, routes, assemblies, events) into proposed parts. Modules are named the
// way a check finds them: by a module role, by type inside an assembly role, else as the n-th module of its type.
import { DEFS } from '../modules';
import { defaultMap, paramValue, sameEnd, type ModuleInst, type Patch } from '../patch';
import { allModules, assembliesOf, type AssemblyDef, type AssemblyInst } from '../assembly';
import { headlessState, member, mods, type Seen } from './model';
import { resolve, roleAssembly, type Roles } from './parts';
import type { EventName, Part, Ref } from './course-schema';

export interface Recorded {
  /** the patch when recording started (the step's beginning state) */
  before: Patch;
  /** the patch at Stop */
  after: Patch;
  /** editor events counted while recording */
  seen: Seen;
  probes: string[];
  selected: number[];
  arpPlay: boolean;
  audio: boolean;
  snapshots: { A: boolean; B: boolean };
  /** the assembly saved while recording, if any */
  saved?: AssemblyDef;
}

export interface Proposal {
  part: Part;
  /** ticked by default */
  keep: boolean;
}

export interface Capture {
  proposals: Proposal[];
  /** things capture saw but cannot turn into a part (a new assembly no role describes) */
  notes: string[];
}

const byId = (p: Patch, id: number) => p.modules.find((m) => m.id === id);
/** a module's pin map before: its own, or a new module's default */
const mapOf = (before: Patch, m: ModuleInst): Record<'p1' | 'p2', string[]> => byId(before, m.id)?.map ?? (DEFS[m.type] ? defaultMap(DEFS[m.type]) : { p1: [], p2: [] });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** how a part names this module of the patch so that resolving the name finds it again */
export function refFor(p: Patch, roles: Roles, m: ModuleInst): Ref {
  const s = headlessState(p);
  for (const [name, r] of Object.entries(roles)) if (r.kind === 'member' && resolve(s, roles, { role: name })?.id === m.id) return { role: name };
  for (const [name, r] of Object.entries(roles)) {
    if (r.kind === 'member') continue;
    const a = roleAssembly(p, roles, name);
    if (!a || !allModules(p, a).includes(m.id)) continue;
    const index = allModules(p, a).map((id) => byId(p, id)).filter((x) => x?.type === m.type).findIndex((x) => x?.id === m.id);
    if (member(p, a, m.type, index)?.id === m.id) return index ? { role: name, type: m.type, index } : { role: name, type: m.type };
  }
  const index = mods(p, m.type).findIndex((x) => x.id === m.id);
  return index ? { type: m.type, index } : { type: m.type };
}

/** the assembly roles that name this assembly in the patch */
/** a member module as an assembly part names it: its type, and which of that type (as `member` counts them) after the first */
function memberOf(p: Patch, a: AssemblyInst, m: ModuleInst): { type: string; index?: number } {
  const index = allModules(p, a).map((id) => byId(p, id)).filter((x) => x?.type === m.type).findIndex((x) => x?.id === m.id);
  return index > 0 ? { type: m.type, index } : { type: m.type };
}
const rolesOf = (p: Patch, roles: Roles, a: AssemblyInst): string[] => Object.keys(roles).filter((name) => roles[name].kind !== 'member' && roleAssembly(p, roles, name)?.id === a.id);

export function capture(rec: Recorded, roles: Roles): Capture {
  const { before, after } = rec;
  const out: Proposal[] = [];
  const notes: string[] = [];
  const add = (part: Part, keep = true) => { if (!out.some((x) => same(x.part, part))) out.push({ part, keep }); };
  const ref = (m: ModuleInst) => refFor(after, roles, m);

  // modules added
  const types = new Set(after.modules.map((m) => m.type));
  for (const type of types) {
    const n = mods(after, type).length;
    if (n > mods(before, type).length) add(n > 1 ? { kind: 'module', type, count: n } : { kind: 'module', type });
  }

  // cables: a new cable into p1 / p2 whose pin also gained a mapped parameter is a thumb drop (routed)
  const routedPins = new Set<string>();
  const added = after.cables.filter((c) => !before.cables.some((d) => sameEnd(c.from, d.from) && sameEnd(c.to, d.to)));
  for (const c of added) {
    const from = byId(after, c.from.module), to = byId(after, c.to.module);
    if (!from || !to) continue;
    const pin = c.to.port as 'p1' | 'p2';
    if (pin === 'p1' || pin === 'p2') {
      const was = mapOf(before, to)[pin];
      const now = to.map?.[pin] ?? [];
      // a drop on a pin that already drives just this parameter only adds the cable
      const fresh = now.filter((x) => !was.includes(x)).length ? now.filter((x) => !was.includes(x)) : now.length === 1 ? now : [];
      if (fresh.length) {
        for (const param of fresh) add({ kind: 'routed', from: ref(from), fromPort: c.from.port, to: ref(to), param });
        routedPins.add(`${to.id}:${pin}`);
        continue;
      }
    }
    add({ kind: 'cable', from: ref(from), fromPort: c.from.port, to: ref(to), toPort: c.to.port });
  }
  for (const c of before.cables.filter((c) => !after.cables.some((d) => sameEnd(c.from, d.from) && sameEnd(c.to, d.to)))) {
    const from = byId(after, c.from.module), to = byId(after, c.to.module);
    if (from && to) add({ kind: 'noCable', from: ref(from), fromPort: c.from.port, to: ref(to), toPort: c.to.port });
  }

  // controls of modules that were there before and after
  for (const m of after.modules) {
    const was = byId(before, m.id);
    const def = DEFS[m.type];
    if (!def) continue;
    for (const pd of def.params) {
      const v = m.params[pd.name];
      const w = was ? was.params[pd.name] : pd.default;
      if (v === undefined || v === w) continue;
      const exact = !!pd.choices || !!pd.toggle || Number.isInteger(pd.step) && pd.step! >= 1;
      add({ kind: 'slider', ref: ref(m), param: pd.name, op: exact ? 'eq' : v > (w ?? pd.default) ? 'ge' : 'le', value: v });
    }
    for (const pin of ['p1', 'p2'] as const) {
      const fresh = (m.map?.[pin] ?? []).filter((x) => !mapOf(before, m)[pin].includes(x));
      if (!routedPins.has(`${m.id}:${pin}`)) for (const param of fresh) add({ kind: 'pinMap', ref: ref(m), pin, param });
      const i = pin === 'p1' ? 0 : 1;
      const a = m.att?.[i] ?? 1, b = was?.att?.[i] ?? 1;
      if (a !== b) add({ kind: 'att', ref: ref(m), pin, op: 'eq', value: a, tolerance: 0.05 });
      for (const [param, r] of Object.entries(m.range?.[pin] ?? {})) {
        if (same(r, was?.range?.[pin]?.[param])) continue;
        const pd = def.params.find((x) => x.name === param);
        if (!pd) continue;
        const round = (x: number) => Number(x.toPrecision(3));
        add({ kind: 'macroRange', ref: ref(m), pin, param, min: round(paramValue(pd, r[0])), max: round(paramValue(pd, r[1])), depth: a });
      }
    }
  }
  if ((after.voices ?? 1) !== (before.voices ?? 1) && (after.voices ?? 1) > 1) add({ kind: 'voices', min: after.voices ?? 1 });

  // assemblies, through the roles that name them
  for (const a of assembliesOf(after)) {
    const was = assembliesOf(before).find((x) => x.id === a.id);
    const names = rolesOf(after, roles, a);
    if (!names.length) {
      if (!was) notes.push(`New assembly "${a.name}": no role describes it. Add one on the Roles page to check it.`);
      continue;
    }
    const role = names[0];
    if (!was) add({ kind: 'assembly', role, fact: 'exists' });
    if (was && was.open !== a.open) add({ kind: 'assembly', role, fact: a.open ? 'open' : 'collapsed' });
    else if (!was && !a.open) add({ kind: 'assembly', role, fact: 'collapsed' }, false);
    for (const r of a.params) if (!was?.params.some((x) => x.module === r.module && x.param === r.param)) {
      const m = byId(after, r.module); if (m) add({ kind: 'assembly', role, fact: 'promoted', ...memberOf(after, a, m), param: r.param });
    }
    for (const r of a.outputs) if (!was?.outputs.some((x) => x.module === r.module && x.port === r.port)) {
      const m = byId(after, r.module); if (m) add({ kind: 'assembly', role, fact: 'exposed', ...memberOf(after, a, m), port: r.port });
    }
    for (const r of a.inputs) if (r.also?.length && !was?.inputs.some((x) => x.port === r.port && x.module === r.module && x.also?.length)) add({ kind: 'assembly', role, fact: 'merged', port: r.port });
    for (const c of a.children ?? []) if (!was?.children?.includes(c)) {
      const child = assembliesOf(after).find((x) => x.id === c);
      const childRole = child && rolesOf(after, roles, child)[0];
      if (childRole) add({ kind: 'assembly', role, fact: 'contains', child: childRole });
    }
    if (was && a.frameSize && !same(a.frameSize, was.frameSize)) add({ kind: 'assembly', role, fact: 'resized' }, false);
    if (rec.saved && rec.saved.name === a.name) add({ kind: 'assembly', role, fact: 'saved', tag: rec.saved.tutorial ?? role.replace(/[A-Z]/g, (x) => `-${x.toLowerCase()}`), name: a.name });
  }

  // events: offered, unticked unless the step changed nothing else
  const quiet = out.length === 0;
  const ev = (event: EventName, extra: Partial<Extract<Part, { kind: 'event' }>> = {}) => add({ kind: 'event', event, ...extra } as Part, quiet);
  for (const name of ['notes', 'undos', 'redos', 'zooms', 'flips', 'shares', 'bypasses', 'news'] as const) {
    const n = rec.seen[name];
    if (n > 0) ev(name, name === 'bypasses' && n > 1 ? { count: n } : {});
  }
  // audio is on in a normal session, so it is not offered; add an Enable audio requirement by hand
  if (rec.arpPlay) ev('arpPlay');
  if (rec.snapshots.A) ev('snapshotA');
  if (rec.snapshots.B) ev('snapshotB');
  for (const key of rec.probes) {
    const [id, port] = key.split(':');
    const m = byId(after, Number(id));
    if (m) ev('probe', { ref: ref(m), port });
  }
  const sel = [...new Set(rec.selected.map((id) => byId(after, id)?.type).filter((t): t is string => !!t))];
  if (sel.length) ev('selected', { types: sel });
  return { proposals: out, notes };
}
