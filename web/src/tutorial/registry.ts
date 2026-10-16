// SPDX-License-Identifier: GPL-3.0-only
// The code half of the course: checks and roles that are logic rather than data. The lesson editor lists them by name; a
// part refers to one as { kind: 'custom', name, args } and a ref as { role: name }. Add an entry here when a requirement
// cannot be said with the part kinds of course-schema.ts. Each one must judge the patch by its shape, never by module ids.
import type { ModuleInst, Patch } from '../patch';
import { asmLike, byId, cabled, feeder, loose, member, mod, mods, T, type Target, type TutorialState } from './model';
import { hasBeat, hasPerformance } from './performance';
import { DEFS } from '../modules';
import { polyOfModule } from '../poly';

type S = TutorialState;
type M = ModuleInst | undefined;
export type Args = Record<string, string | number>;

export interface CustomCheck {
  /** what the lesson editor shows in the picker */
  describe: string;
  /** the arguments the editor asks for */
  args?: { name: string; options?: string[] }[];
  label(args: Args): string;
  check(s: S, args: Args): boolean;
  targets(s: S, args: Args): Target[];
  /** the check looks at something that happens during the step (an event), not only at the patch */
  momentary?: boolean;
}

export interface CodeRole {
  label: string;
  describe: string;
  module(s: S): M;
  /** every module the role can be (a cable requirement from it holds when any of them has the cable); absent = `module` */
  modules?(s: S): ModuleInst[];
}

const one = (type: string, i = 0) => (s: S): M => mod(s.patch, type, i);
const main = one('fm1');
const out = one('output');

/** the oscillator whose pm input is fed by another oscillator */
const carrier = (s: S): M => mods(s.patch, 'osc').find((o) => feeder(s.patch, o, 'pm')?.type === 'osc');
const modulator = (s: S): M => { const c = carrier(s); return c && feeder(s.patch, c, 'pm'); };

const factoryAsm = (p: Patch, name: string) => (p.assemblies ?? []).find((a) => a.name.toLowerCase() === name);
const gateOf = (p: Patch, name: string) => factoryAsm(p, name)?.inputs.find((r) => r.label === 'gate');
const outOf = (p: Patch, name: string) => factoryAsm(p, name)?.outputs[0];
const pluckMember = (p: Patch, type: string): M => member(p, asmLike(p, ['string', 'modal']), type);
const mixer = (s: S): M => loose(s.patch, 'mixer');
const DRUMS = ['kick', 'snare'];

export const ROLES: Record<string, CodeRole> = {
  carrier: { label: 'carrier', describe: 'the Oscillator whose pm input another Oscillator feeds', module: carrier },
  modulator: { label: 'modulator', describe: 'the Oscillator feeding the carrier’s pm', module: modulator },
  keys: {
    label: 'the keyboard',
    describe: 'Main, or a Part module: what plays a module (inside a poly assembly its Part gives pitch, gate and vel)',
    module: main,
    modules: (s) => [main(s), ...mods(s.patch, 'part')].filter((m): m is ModuleInst => !!m),
  },
};

export const CUSTOM: Record<string, CustomCheck> = {
  newPatch: {
    describe: 'New patch was pressed and the patch is bare (Main and Output, no cables)',
    label: () => 'Press New patch',
    check: (s) => s.seen.news > 0 && s.patch.modules.length === 2 && !!mod(s.patch, 'fm1') && !!mod(s.patch, 'output') && !s.patch.cables.length,
    targets: () => T.ui('new-patch-btn'),
    momentary: true,
  },
  fmCarrier: {
    describe: 'one Oscillator’s out feeds another Oscillator’s pm',
    label: () => 'Cable the second Oscillator’s out → the first one’s pm',
    check: (s) => !!carrier(s),
    targets: (s) => [...T.port(one('osc', 1)(s), 'out', 'out'), ...T.port(one('osc')(s), 'pm', 'in')],
  },
  pluckOut: {
    describe: 'the Pluck assembly’s String or Modal out is cabled to the Output’s l',
    label: () => 'Cable Pluck out → Output l',
    check: (s) => cabled(s.patch, pluckMember(s.patch, 'string'), 'out', out(s), 'l') || cabled(s.patch, pluckMember(s.patch, 'modal'), 'out', out(s), 'l'),
    targets: (s) => [...T.port(pluckMember(s.patch, 'string'), 'out', 'out'), ...T.port(out(s), 'l', 'in')],
  },
  morphTarget: {
    describe: 'a morph target (a B side) is chosen',
    label: () => 'Choose Snapshot B in Main’s B side picker',
    check: (s) => s.patch.modules.some((m) => !!m.paramsB),
    targets: (s) => T.module(main(s)?.id),
  },
  drumTriggered: {
    describe: 'a Clock div output reaches every gate of a factory drum',
    args: [{ name: 'drum', options: DRUMS }, { name: 'port', options: ['out', 'd2', 'd4', 'd8'] }],
    label: (a) => `Cable Clock div ${a.port} → ${a.drum} gate`,
    check: (s, a) => { const g = gateOf(s.patch, String(a.drum)); return !!g && [g, ...(g.also ?? [])].every((r) => cabled(s.patch, one('clkdiv')(s), String(a.port), byId(s.patch, r.module), r.port)); },
    targets: (s, a) => { const g = gateOf(s.patch, String(a.drum)); return [...T.port(one('clkdiv')(s), String(a.port), 'out'), ...T.port(g && byId(s.patch, g.module), g?.port ?? 'gate', 'in')]; },
  },
  drumOut: {
    describe: 'a factory drum’s output is cabled to a loose Mixer input',
    args: [{ name: 'drum', options: DRUMS }, { name: 'input', options: ['in1', 'in2', 'in3', 'in4'] }],
    label: (a) => `Cable ${a.drum} out → Mixer ${a.input}`,
    check: (s, a) => { const r = outOf(s.patch, String(a.drum)); return cabled(s.patch, r && byId(s.patch, r.module), r?.port ?? 'out', mixer(s), String(a.input)); },
    targets: (s, a) => { const r = outOf(s.patch, String(a.drum)); return [...T.port(r && byId(s.patch, r.module), r?.port ?? 'out', 'out'), ...T.port(mixer(s), String(a.input), 'in')]; },
  },
  insidePoly: {
    describe: 'at least `count` (default 1) modules of a type sit inside a poly assembly',
    args: [{ name: 'type' }, { name: 'count' }],
    label: (a) => `Drag the ${DEFS[String(a.type)]?.label ?? a.type} into the poly assembly’s frame`,
    check: (s, a) => mods(s.patch, String(a.type)).filter((m) => polyOfModule(s.patch, m.id)).length >= Number(a.count || 1),
    targets: (s, a) => mods(s.patch, String(a.type)).filter((m) => !polyOfModule(s.patch, m.id)).flatMap((m) => T.module(m.id)),
  },
  beat: {
    describe: 'the kick, snare and Hat each have their own drum sequencer',
    label: () => 'Build three drum sequencers',
    check: (s) => hasBeat(s.patch),
    targets: () => T.ui('add-btn'),
  },
  performance: {
    describe: 'the eight-bar arrangement with Pluck is built',
    label: () => 'Build the eight-bar arrangement with Pluck',
    check: (s) => hasPerformance(s.patch),
    targets: () => T.ui('add-assembly-btn'),
  },
};
