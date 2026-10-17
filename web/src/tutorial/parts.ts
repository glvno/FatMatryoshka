// SPDX-License-Identifier: GPL-3.0-only
// What a step's parts mean: resolving a module reference, the check, the checklist line (an imperative addressed to the
// learner, "Cable Main gate → VCA cv") and the elements the highlight points at. Pure functions of the tutorial state.
import { ASSIGN_MODES, DEFS, LEGATO_MODES, PRIORITIES } from '../modules';
import { Engine } from '../engine';
import { paramUnit, validatePatch, type ModuleInst, type ParamDef, type Patch } from '../patch';
import type { AssemblyInst } from '../assembly';
import { allModules, assembliesOf } from '../assembly';
import { asmLike, cabled, findDef, loose, member, mod, mods, savedAssembly, T, type Target, type TutorialState } from './model';
import { CUSTOM, ROLES } from './registry';
import { slugId, type EventName, type Part, type PartSpec, type Pointer, type Ref, type RoleDef, type SliderOp } from './course-schema';
import { polyGroups, polyOfModule } from '../poly';

type S = TutorialState;
type M = ModuleInst | undefined;
export type Roles = Record<string, RoleDef>;

// ---- references

/** the assembly a role names, if the role is an assembly role */
export function roleAssembly(p: Patch, roles: Roles, name: string): AssemblyInst | undefined {
  const r = roles[name];
  if (r?.kind === 'assembly') return asmLike(p, r.types);
  if (r?.kind === 'named') return assembliesOf(p).find((a) => a.name.toLowerCase() === r.name.toLowerCase());
  return undefined;
}

/** every module a reference names, in order (one for a plain reference, all of them for `every`) */
export function resolveAll(s: S, roles: Roles, ref: Ref): ModuleInst[] {
  const p = s.patch;
  if (ref.role) {
    const code = ROLES[ref.role];
    if (code) { if (code.modules) return code.modules(s); const m = code.module(s); return m ? [m] : []; }
    const r = roles[ref.role];
    if (r?.kind === 'member') return resolveAll(s, roles, { role: r.role, type: r.type, index: r.index });
    const a = roleAssembly(p, roles, ref.role);
    if (!a || !ref.type) return [];
    const inside = allModules(p, a).map((id) => p.modules.find((m) => m.id === id)!).filter((m) => m?.type === ref.type);
    if (ref.every) return inside;
    const m = member(p, a, ref.type, ref.index ?? 0);
    return m ? [m] : [];
  }
  if (!ref.type) return [];
  if (ref.every) return mods(p, ref.type);
  const m = ref.loose ? loose(p, ref.type) : mod(p, ref.type, ref.index ?? 0);
  return m ? [m] : [];
}
export const resolve = (s: S, roles: Roles, ref: Ref): M => resolveAll(s, roles, ref)[0];

/** the module type a reference is about, when it can be known without a patch */
export function refType(roles: Roles, ref: Ref): string | undefined {
  if (ref.type) return ref.type;
  if (!ref.role) return undefined;
  if (ref.role === 'carrier' || ref.role === 'modulator') return 'osc';
  const r = roles[ref.role];
  return r?.kind === 'member' ? r.type : undefined;
}

const typeLabel = (type: string): string => DEFS[type]?.label ?? type;
const ORDINAL = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth'];
export function roleLabel(roles: Roles, name: string): string { return roles[name]?.label ?? ROLES[name]?.label ?? name; }

/** "second " for a member module after the first of its type, else nothing */
const memberOrdinal = (index?: number): string => (index ? `${ORDINAL[index] ?? `#${index + 1}`} ` : '');
/** how a checklist line names a module: "VCA", "the second Oscillator", "My voice’s Filter", "every Oscillator" */
export function refName(roles: Roles, ref: Ref): string {
  if (ref.role && !ref.type) return roleLabel(roles, ref.role);
  const t = typeLabel(ref.type ?? '?');
  const nth = ref.index ? `the ${ORDINAL[ref.index] ?? `#${ref.index + 1}`} ${t}` : t;
  if (ref.role) return ref.every ? `every ${t} in ${roleLabel(roles, ref.role)}` : `${roleLabel(roles, ref.role)}’s ${nth}`;
  if (ref.every) return `every ${t}`;
  return ref.loose ? `${nth} outside the assemblies` : nth;
}

// ---- values

export const paramDef = (type: string | undefined, param: string): ParamDef | undefined => (type ? DEFS[type]?.params.find((p) => p.name === param) : undefined);

/** a value as the learner sees it: a choice name, or the number with its unit */
export function valueText(pd: ParamDef | undefined, v: number): string {
  if (pd?.choices?.[v] !== undefined && Number.isInteger(v)) return pd.toggle ? (v ? 'on' : 'off') : pd.choices[v];
  const n = Math.abs(v) >= 100 ? String(Math.round(v)) : String(Number(v.toPrecision(3)));
  return pd?.unit ? `${n} ${pd.unit}` : n;
}

export function compare(op: SliderOp, v: number, value = 0, max = value, tolerance = 0, entry?: number): boolean {
  if (!Number.isFinite(v)) return false;
  switch (op) {
    case 'le': return v <= value + tolerance;
    case 'ge': return v >= value - tolerance;
    case 'eq': return Math.abs(v - value) <= tolerance;
    case 'ne': return Math.abs(v - value) > tolerance;
    case 'between': return v >= value && v <= max;
    case 'changed': return entry !== undefined && Math.abs(v - entry) > tolerance;
  }
}

function opText(op: SliderOp, pd: ParamDef | undefined, value = 0, max = value): string {
  const t = (x: number) => valueText(pd, x);
  switch (op) {
    case 'le': return `to ${t(value)} or ${pd?.unit === 'Hz' || pd?.unit === 's' || pd?.unit === 'ms' ? 'below' : 'less'}`;
    case 'ge': return `to ${t(value)} or more`;
    case 'eq': return `to ${t(value)}`;
    case 'ne': return `off ${t(value)}`;
    case 'between': return `between ${t(value)} and ${t(max)}`;
    case 'changed': return '';
  }
}

// ---- sound

const SR = 24000;
const soundCache = new Map<string, number>();
/** the peak of half a second of the patch, with a C held or without a key (cached per patch) */
export function soundPeak(p: Patch, key: boolean): number {
  const k = `${key ? 1 : 0}${JSON.stringify([p.modules, p.cables, (p.assemblies ?? []).map((a) => a.poly ? [a.modules, a.children, a.poly] : 0)])}`;
  const hit = soundCache.get(k);
  if (hit !== undefined) return hit;
  let max = 0;
  try {
    const e = new Engine(SR);
    e.load(validatePatch(JSON.parse(JSON.stringify(p)), DEFS));
    if (key) e.noteOn(60, 0.8);
    e.clockRun(true);
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    for (let i = 0; i < SR / 2 / 128; i++) {
      if (i % 4 === 0) e.clockTick();
      e.render(l, r);
      for (let j = 0; j < 128; j++) max = Math.max(max, Math.abs(l[j]), Math.abs(r[j]));
    }
  } catch { max = NaN; }
  if (soundCache.size > 200) soundCache.clear();
  soundCache.set(k, max);
  return max;
}
export const SOUND_DEFAULT = { held: 0.01, silent: 1e-4 };

// ---- parts

const PINS = ['p1', 'p2'] as const;
const pinned = (p: Patch, from: M, port: string, to: M, param: string): boolean =>
  !!from && !!to && PINS.some((pin) => cabled(p, from, port, to, pin) && !!to.map?.[pin].includes(param));
/** the pins a depth / range part looks at: the named one, else the pins routed to its parameter */
const pinsOf = (m: M, part: { pin?: 'p1' | 'p2'; param?: string }): ('p1' | 'p2')[] =>
  part.pin ? [part.pin] : PINS.filter((pin) => !!part.param && !!m?.map?.[pin].includes(part.param));

const EVENT_LABEL: Record<EventName, string> = {
  notes: 'Play a note', undos: 'Press Ctrl+Z to undo', redos: 'Press Shift+Ctrl+Z to redo', zooms: 'Zoom the canvas (Ctrl+wheel, or Fit patch to screen)',
  flips: 'Press Alt+B', shares: 'Copy a share link (Commands → Share patch link)', bypasses: 'Bypass a module (B)', news: 'Press New patch', saves: 'Save an assembly',
  audio: 'Enable audio', arpPlay: 'Start the arpeggiator (Space)', snapshotA: 'Set snapshot A (Commands)', snapshotB: 'Set snapshot B (Commands)',
  probe: 'Shift-click a jack', selected: 'Select the modules', bypassed: 'Switch the module back on',
};
const COUNTERS: EventName[] = ['notes', 'undos', 'redos', 'zooms', 'flips', 'shares', 'bypasses', 'news', 'saves'];

/** the part looks at something that happens during the step, so a finished patch cannot show it */
export function momentary(part: PartSpec): boolean {
  switch (part.kind) {
    case 'event': return true;
    case 'slider': case 'att': return part.op === 'changed';
    case 'assembly': return part.fact === 'resized' || part.fact === 'saved';
    case 'custom': return !!CUSTOM[part.name]?.momentary;
    default: return false;
  }
}

/** a short name for what the part checks, the base of its id: `osc-out-vca-in`, `adsr-a`, `add-vca`, `my-voice-collapsed` */
export function partSlug(spec: PartSpec): string {
  const kebab = (v: string) => v.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  const type = (t: string) => (t === 'fm1' ? 'main' : t);
  const r = (x: Ref): string => {
    const t = x.type ? `${type(x.type)}${x.index ? x.index + 1 : ''}` : '';
    return x.role ? [kebab(x.role), t].filter(Boolean).join('-') : t;
  };
  switch (spec.kind) {
    case 'module': return `add-${type(spec.type)}${(spec.count ?? 1) > 1 ? `-${spec.count}` : ''}`;
    case 'cable': return `${r(spec.from)}-${spec.fromPort}-${r(spec.to)}-${spec.toPort}`;
    case 'noCable': return `unplug-${r(spec.from)}-${spec.fromPort}-${r(spec.to)}-${spec.toPort}`;
    case 'slider': return `${r(spec.ref)}-${spec.param}`;
    case 'routed': return `${r(spec.from)}-${spec.fromPort}-${r(spec.to)}-${spec.param}`;
    case 'pinMap': return `${r(spec.ref)}-${spec.pin}-${spec.param}`;
    case 'att': return `${r(spec.ref)}-${spec.pin ?? spec.param}-${spec.pin ? 'att' : 'depth'}`;
    case 'macroRange': return `${r(spec.ref)}${spec.pin ? `-${spec.pin}` : ''}-${spec.param}-range`;
    case 'assembly': return [kebab(spec.role), spec.fact, spec.type && type(spec.type), spec.param ?? spec.port, spec.child && kebab(spec.child)].filter(Boolean).join('-');
    case 'poly': return `poly-${spec.setting}`;
    case 'event': return [kebab(spec.event), spec.ref && r(spec.ref), spec.port, spec.on === undefined ? '' : spec.on ? 'on' : 'off'].filter(Boolean).join('-');
    case 'sound': return `sound-${spec.mode}`;
    case 'custom': return [kebab(spec.name), ...Object.values(spec.args ?? {}).map(String)].join('-');
  }
}

/** a requirement with a new id, from `partSlug` and unique among `taken` */
export function withId(spec: PartSpec, taken: Iterable<string>): Part {
  return { ...spec, id: slugId(partSlug(spec), taken) } as Part;
}

/** the checklist line */
export function partLabel(part: PartSpec, roles: Roles): string {
  const n = (r: Ref) => refName(roles, r);
  switch (part.kind) {
    case 'module': {
      const t = typeLabel(part.type);
      const where = part.loose ? ' outside the assemblies' : '';
      if ((part.count ?? 1) > 1) return `Add ${part.count === 2 ? 'a second' : `${part.count} of`} ${t}${where}`;
      return `Add ${/^[AEIOU]/.test(t) ? 'an' : 'a'} ${t}${where}`;
    }
    case 'cable': return `Cable ${n(part.from)} ${part.fromPort} → ${n(part.to)} ${part.toPort}`;
    case 'noCable': return `Remove the old cable ${n(part.from)} ${part.fromPort} → ${n(part.to)} ${part.toPort} (click it)`;
    case 'slider': {
      const pd = paramDef(refType(roles, part.ref), part.param);
      if (part.op === 'changed') return `Move ${n(part.ref)}’s ${part.param} slider`;
      if (pd?.toggle && part.op === 'eq') return `Tick ${part.param}${part.value ? '' : ' off'}`;
      return `Set ${n(part.ref)}’s ${part.param} ${opText(part.op, pd, part.value, part.max)}`;
    }
    case 'routed': return `Drop ${n(part.from)}’s ${part.fromPort} on ${n(part.to)}’s ${part.param} thumb`;
    case 'pinMap': return `Tick ${part.pin.toUpperCase()} in the ⋮ menu of ${part.param}`;
    case 'att': {
      const what = part.pin ? `the ${part.pin} attenuverter` : `the depth on ${part.param}`;
      return part.op === 'changed' ? `Move ${what}` : `Set ${what} ${opText(part.op, undefined, part.value, part.max)}`;
    }
    case 'macroRange': {
      const pd = paramDef(refType(roles, part.ref), part.param);
      return `Map ${part.param} from ${valueText(pd, part.min)} to ${valueText(pd, part.max)}${part.depth !== undefined ? ` with depth ${part.depth}` : ''}`;
    }
    case 'assembly': {
      const a = roleLabel(roles, part.role);
      switch (part.fact) {
        case 'exists': return `Group or insert ${a}`;
        case 'open': return `Expand ${a}`;
        case 'collapsed': return `Collapse ${a}`;
        case 'promoted': return `Promote the ${memberOrdinal(part.index)}${typeLabel(part.type ?? '')}’s ${part.param} (card button on the frame, or Cmd / Ctrl-click it)`;
        case 'exposed': return `Expose the ${memberOrdinal(part.index)}${typeLabel(part.type ?? '')}’s ${part.port} (card button on the frame, or Cmd / Ctrl-click it)`;
        case 'merged': return `Merge the ${part.port} inputs of ${a} (merge into…)`;
        case 'contains': return `Drag the ${roleLabel(roles, part.child ?? '')} card into the ${a} frame`;
        case 'resized': return 'Resize the frame (drag ◢)';
        case 'saved': return `Save it as "${part.name ?? a}" (⋯ menu → Save to library)`;
      }
      break;
    }
    case 'poly': {
      const names: Record<string, string[] | undefined> = { assign: ASSIGN_MODES, legato: LEGATO_MODES, priority: PRIORITIES };
      const t = (v = 0) => names[part.setting]?.[v] ?? String(v);
      const name = part.setting === 'parts' ? 'voices' : part.setting;
      if (part.setting === 'parts' && part.op === 'ge') return `Make an assembly poly with ${part.value ?? 2} voices or more`;
      if (part.op === 'changed') return `Change the Voice allocator’s ${name}`;
      const op = { le: `to ${t(part.value)} or less`, ge: `to ${t(part.value)} or more`, eq: `to ${t(part.value)}`, ne: `off ${t(part.value)}`, between: `between ${t(part.value)} and ${t(part.max)}` }[part.op];
      return `Set the Voice allocator’s ${name} ${op}`;
    }
    case 'event': {
      if (part.event === 'probe' && part.ref) return `Shift-click ${n(part.ref)}’s ${part.port ?? 'out'} jack`;
      if (part.event === 'selected' && part.types) return `Select the ${part.types.map(typeLabel).join(', ')}`;
      if (part.event === 'bypassed' && part.ref) return part.on ? `Bypass ${n(part.ref)}` : `Switch ${n(part.ref)} back on`;
      const c = part.count ?? 1;
      return COUNTERS.includes(part.event) && c > 1 ? `${EVENT_LABEL[part.event]} (${c} times)` : EVENT_LABEL[part.event];
    }
    case 'sound': return part.mode === 'held' ? 'Make it sound while a key is held' : 'Make it silent when no key is held';
    case 'custom': return CUSTOM[part.name]?.label(part.args ?? {}) ?? `Unknown check "${part.name}"`;
  }
  return '';
}

export function partCheck(part: PartSpec, s: S, roles: Roles): boolean {
  const p = s.patch;
  const one = (r: Ref) => resolve(s, roles, r);
  switch (part.kind) {
    case 'module': return part.loose ? !!loose(p, part.type) : mods(p, part.type).length >= (part.count ?? 1);
    case 'cable': {
      // a role with several candidates (the keyboard: Main or a Part) counts when any of them has the cable
      const froms = resolveAll(s, roles, part.from);
      const any = (t: M) => froms.some((f) => cabled(p, f, part.fromPort, t, part.toPort));
      if (part.to.every) { const to = resolveAll(s, roles, part.to); return to.length > 0 && to.every(any); }
      return any(one(part.to));
    }
    case 'noCable': { const to = one(part.to); return !resolveAll(s, roles, part.from).some((f) => cabled(p, f, part.fromPort, to, part.toPort)); }
    case 'slider': {
      const m = one(part.ref);
      if (!m) return false;
      const entry = part.op === 'changed' ? (resolve({ ...s, patch: s.entry }, roles, part.ref)?.params[part.param] ?? paramDef(m.type, part.param)?.default) : undefined;
      return compare(part.op, m.params[part.param] ?? NaN, part.value, part.max, part.tolerance, entry);
    }
    case 'routed': return pinned(p, one(part.from), part.fromPort, one(part.to), part.param);
    case 'pinMap': return !!one(part.ref)?.map?.[part.pin].includes(part.param);
    case 'att': {
      const m = one(part.ref);
      if (!m) return false;
      const before = resolve({ ...s, patch: s.entry }, roles, part.ref);
      return pinsOf(m, part).some((pin) => {
        const i = pin === 'p1' ? 0 : 1;
        const entry = part.op === 'changed' ? (before?.att?.[i] ?? 1) : undefined;
        return compare(part.op, m.att?.[i] ?? 1, part.value, part.max, part.tolerance, entry);
      });
    }
    case 'macroRange': {
      const m = one(part.ref);
      const pd = paramDef(m?.type, part.param);
      if (!m || !pd) return false;
      return pinsOf(m, part).some((pin) => {
        const r = m.range?.[pin]?.[part.param];
        if (!r) return false;
        const ok = Math.abs(r[0] - paramUnit(pd, part.min)) < 0.02 && Math.abs(r[1] - paramUnit(pd, part.max)) < 0.02;
        return ok && (part.depth === undefined || m.att?.[pin === 'p1' ? 0 : 1] === part.depth);
      });
    }
    case 'assembly': {
      const a = roleAssembly(p, roles, part.role);
      if (!a) return false;
      switch (part.fact) {
        case 'exists': return true;
        case 'open': return a.open;
        case 'collapsed': return !a.open;
        case 'promoted': { const m = member(p, a, part.type ?? '', part.index ?? 0); return !!m && a.params.some((r) => r.module === m.id && r.param === part.param); }
        case 'exposed': { const m = member(p, a, part.type ?? '', part.index ?? 0); return !!m && a.outputs.some((r) => r.module === m.id && r.port === part.port); }
        case 'merged': return a.inputs.some((r) => r.port === part.port && !!r.also?.length);
        case 'contains': { const c = roleAssembly(p, roles, part.child ?? ''); return !!c && !!a.children?.includes(c.id); }
        case 'resized': { const e = roleAssembly(s.entry, roles, part.role); return !!a.frameSize && JSON.stringify(a.frameSize) !== JSON.stringify(e?.frameSize); }
        case 'saved': return savedAssembly(s, a) && !!findDef(s.library, part.tag ?? '', part.name ?? '');
      }
      return false;
    }
    case 'poly': {
      const entry = part.op === 'changed' ? polyGroups(s.entry)[0]?.cfg[part.setting] : undefined;
      return polyGroups(p).some((g) => compare(part.op, g.cfg[part.setting], part.value, part.max, 0, entry));
    }
    case 'event': {
      switch (part.event) {
        case 'audio': return s.audio;
        case 'arpPlay': return s.arpPlay;
        case 'snapshotA': return !!s.snapshots.A;
        case 'snapshotB': return !!s.snapshots.B;
        case 'probe': { const m = part.ref && one(part.ref); return !!m && s.probes.has(`${m.id}:${part.port ?? 'out'}`); }
        case 'selected': return (part.types ?? []).every((t) => mods(p, t).some((m) => s.selected.has(m.id)));
        case 'bypassed': { const m = part.ref && one(part.ref); return !!m && !!m.bypass === !!part.on; }
        default: return s.seen[part.event] >= (part.count ?? 1);
      }
    }
    case 'sound': {
      const v = soundPeak(p, part.mode === 'held');
      return part.mode === 'held' ? v > (part.threshold ?? SOUND_DEFAULT.held) : v < (part.threshold ?? SOUND_DEFAULT.silent);
    }
    case 'custom': return !!CUSTOM[part.name]?.check(s, part.args ?? {});
  }
}

/** the elements a part is about: what the highlight points at while it is unmet */
export function partTargets(part: PartSpec, s: S, roles: Roles): Target[] {
  const p = s.patch;
  const one = (r: Ref) => resolve(s, roles, r);
  // where a cable should come from: of several candidates (the keyboard), the one in the same poly assembly as its target
  const fromFor = (to: M): M => {
    if (part.kind !== 'cable') return undefined;
    const all = resolveAll(s, roles, part.from);
    const home = to && polyOfModule(p, to.id);
    return all.find((f) => polyOfModule(p, f.id) === home) ?? all[0];
  };
  switch (part.kind) {
    case 'module': return T.ui('add-btn');
    case 'cable': {
      if (part.to.every) {
        const all = resolveAll(s, roles, part.to);
        const left = all.filter((t) => !cabled(p, one(part.from), part.fromPort, t, part.toPort));
        return [...T.port(fromFor(all[0]), part.fromPort, 'out'), ...(left.length ? left : all).flatMap((t) => T.port(t, part.toPort, 'in'))];
      }
      return [...T.port(fromFor(one(part.to)), part.fromPort, 'out'), ...T.port(one(part.to), part.toPort, 'in')];
    }
    case 'noCable': return T.port(one(part.to), part.toPort, 'in');
    case 'slider': return T.param(one(part.ref), part.param);
    case 'routed': return [...T.param(one(part.to), part.param), ...T.port(one(part.from), part.fromPort, 'out')];
    case 'pinMap': case 'macroRange': return T.param(one(part.ref), part.param);
    case 'att': { const m = one(part.ref); const mapped = part.param ?? (part.pin ? m?.map?.[part.pin]?.[0] : undefined); return mapped ? T.param(m, mapped) : T.module(m?.id); }
    case 'assembly': {
      const a = roleAssembly(p, roles, part.role);
      const asm = T.asm(a?.id);
      switch (part.fact) {
        case 'exists': {
          const r = roles[part.role];
          const types = r?.kind === 'assembly' ? r.types : [];
          const free = types.map((t) => mod(p, t)).filter((m): m is ModuleInst => !!m);
          return free.length ? free.flatMap((m) => T.module(m.id)) : T.ui('add-assembly-btn');
        }
        case 'promoted': return T.param(member(p, a, part.type ?? '', part.index ?? 0), part.param ?? '');
        case 'exposed': return T.port(member(p, a, part.type ?? '', part.index ?? 0), part.port ?? '', 'out');
        case 'contains': return [...asm, ...T.asm(roleAssembly(p, roles, part.child ?? '')?.id)];
        default: return asm;
      }
    }
    case 'poly': {
      // the setting on the Voice allocator that feeds a poly assembly; without one, the poly buttons of the outermost assemblies
      const g = polyGroups(p);
      if (g.length) return g.flatMap((x) => T.param(x.alloc, part.setting === 'parts' ? 'voices' : part.setting));
      const asms = assembliesOf(p).filter((a) => !assembliesOf(p).some((b) => b.children?.includes(a.id)));
      if (asms.length) return asms.map((a) => ({ kind: 'poly', id: a.id, setting: part.setting }));
      // nothing grouped yet: the modules Main plays, the ones to group
      const main = mod(p, 'fm1');
      const played = new Set(p.cables.filter((c) => c.from.module === main?.id && ['pitch', 'gate', 'vel'].includes(c.from.port)).map((c) => c.to.module));
      return [...played].flatMap((id) => T.module(id));
    }
    case 'event': {
      switch (part.event) {
        case 'audio': return T.ui('audio-btn');
        case 'news': return T.ui('new-patch-btn');
        case 'notes': return T.param(mod(p, 'output'), 'level');
        case 'arpPlay': return T.ui('arp-btn');
        case 'probe': return T.probe(part.ref && one(part.ref), part.port ?? 'out');
        case 'bypassed': case 'bypasses': return T.module(part.ref ? one(part.ref)?.id : undefined);
        case 'selected': {
          const types = part.types ?? [];
          const left = types.filter((t) => !mods(p, t).some((m) => s.selected.has(m.id)));
          return (left.length ? left : types).flatMap((t) => T.module(mod(p, t)?.id));
        }
        default: return T.ui('palette-btn');
      }
    }
    case 'sound': return T.module(mod(p, 'output')?.id);
    case 'custom': return CUSTOM[part.name]?.targets(s, part.args ?? {}) ?? [];
  }
}

export function pointerTargets(ptr: Pointer | undefined, s: S, roles: Roles): Target[] {
  if (!ptr) return [];
  switch (ptr.kind) {
    case 'module': return T.module(resolve(s, roles, ptr.ref)?.id);
    case 'port': return T.port(resolve(s, roles, ptr.ref), ptr.port, ptr.dir);
    case 'param': return T.param(resolve(s, roles, ptr.ref), ptr.param);
    case 'ui': return T.ui(ptr.id);
  }
}
