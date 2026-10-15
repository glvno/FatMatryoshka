// SPDX-License-Identifier: GPL-3.0-only
// The finale is an ordinary shareable patch. Sequencers store its eight-bar form; no UI timer is needed to play it.
import { DEFS } from '../modules';
import { insertAssembly, makeAssembly, type AssemblyDef, type AssemblyInst } from '../assembly';
import { paramUnit, removeModule, type ModuleInst, type Patch } from '../patch';
import { setParameterInput } from '../parameter-routing';
import { asmLike, byId, cabled, loose, member, place, wire } from './model';

const marker = 'Eight-bar arrangement';
const arrangement = (p: Patch) => p.assemblies?.find((a) => a.name === marker);
const drum = (p: Patch, name: string) => p.assemblies?.find((a) => a.name.toLowerCase() === name.toLowerCase());
/** Sequencer advances on its first clock edge, so store the first sounding beat in s2. */
export function pattern(seq: ModuleInst, values: number[]): void {
  seq.params.len = values.length;
  seq.params.dir = 0;
  values.forEach((v, i) => { seq.params[`s${(i + 1) % values.length + 1}`] = v; });
}
const externalSeq = (p: Patch, name: string): ModuleInst | undefined => {
  const gate = drum(p, name)?.inputs.find((r) => r.label === 'gate');
  const cable = gate && p.cables.find((c) => c.to.module === gate.module && c.to.port === gate.port);
  const seq = cable && byId(p, cable.from.module);
  return seq?.type === 'seq' ? seq : undefined;
};
export function hasBeat(p: Patch): boolean { return ['kick', 'snare', 'Hat'].every((n) => !!externalSeq(p, n)); }
export function buildBeat(p: Patch): void {
  const clock = loose(p, 'lfo')!;
  clock.params.rate = 4; // eighth notes at 120 bpm
  for (const [name, values] of [
    ['kick', [0, -1, -1, -1, 0, -1, -1, -1]],
    ['snare', [-1, -1, 0, -1, -1, -1, 0, -1]],
    ['Hat', [0, -1, 0, -1, 0, -1, 0, -1]],
  ] as [string, number[]][]) {
    const seq = externalSeq(p, name) ?? place(p, 'seq');
    pattern(seq, values);
    wire(p, clock, 'out', seq, 'clock');
    const gate = drum(p, name)?.inputs.find((r) => r.label === 'gate');
    if (!gate) throw new Error(`The ${name} gate is missing`);
    for (const target of [gate, ...(gate.also ?? [])]) {
      p.cables = p.cables.filter((c) => c.to.module !== target.module || c.to.port !== target.port);
      wire(p, seq, 'gate', byId(p, target.module), target.port);
    }
  }
}
function range(p: Patch, from: ModuleInst, to: ModuleInst, param: string, low: number, high: number): void {
  wire(p, from, 'out', to, 'p1');
  setParameterInput(to, 'p1', param, true);
  (to.att ??= [1, 1])[0] = 1;
  ((to.range ??= {}).p1 ??= {})[param] = [low, high];
}
export function hasPerformance(p: Patch): boolean {
  const a = arrangement(p);
  const bars = member(p, a, 'clkdiv'), form = member(p, a, 'seq');
  const clock = loose(p, 'lfo'), mixer = loose(p, 'mixer');
  const string = member(p, asmLike(p, ['string', 'modal']), 'string');
  const melody = externalSeq(p, 'kick');
  const hatInput = drum(p, 'Hat')?.inputs.find((r) => r.label === 'gate');
  const envelope = hatInput && byId(p, hatInput.module);
  const mapped = (m: ModuleInst | undefined, param: string): boolean =>
    !!m?.map?.p1.includes(param) && !!m.range?.p1?.[param] && m.att?.[0] === 1 && cabled(p, form, 'out', m, 'p1');
  return bars?.params.div === 8 && form?.params.len === 8 &&
    cabled(p, clock, 'out', bars, 'clock') && cabled(p, bars, 'out', form, 'clock') &&
    mapped(mixer, 'l4') && mapped(envelope, 'r2') &&
    cabled(p, melody, 'out', string, 'pitch') && cabled(p, melody, 'gate', string, 'gate') &&
    cabled(p, string, 'out', mixer, 'in4');
}
function repairForm(p: Patch, a: AssemblyInst): void {
  const get = (type: string): ModuleInst => {
    const existing = member(p, a, type);
    if (existing) return existing;
    const created = place(p, type); a.modules.push(created.id);
    if (type === 'seq') pattern(created, [0, 0, 0.5, 0.5, 0.5, 0.5, 1, 0]);
    return created;
  };
  const bars = get('clkdiv'), form = get('seq');
  bars.params.div = 8; form.params.len = 8;
  const clock = loose(p, 'lfo'), mixer = loose(p, 'mixer');
  const string = member(p, asmLike(p, ['string', 'modal']), 'string');
  const melody = externalSeq(p, 'kick');
  const hatInput = drum(p, 'Hat')?.inputs.find((r) => r.label === 'gate');
  const envelope = hatInput && byId(p, hatInput.module);
  if (!clock || !mixer || !string || !melody || !envelope) throw new Error('Restore the kit, its kick sequencer and Pluck before repairing the arrangement');
  wire(p, clock, 'out', bars, 'clock'); wire(p, bars, 'out', form, 'clock');
  wire(p, melody, 'out', string, 'pitch'); wire(p, melody, 'gate', string, 'gate'); wire(p, string, 'out', mixer, 'in4');
  range(p, form, mixer, 'l4', 0, 0.7);
  const decay = DEFS.env.params.find((pd) => pd.name === 'r2')!;
  range(p, form, envelope, 'r2', paramUnit(decay, 0.08), paramUnit(decay, 0.3));
}
export function buildPerformance(p: Patch, pluck: AssemblyDef): void {
  if (hasPerformance(p)) return;
  const existing = arrangement(p);
  if (existing) { repairForm(p, existing); return; }
  if (!hasBeat(p)) buildBeat(p);
  const hatSequence = externalSeq(p, 'Hat');
  if (hatSequence) removeModule(p, hatSequence.id);
  const hatInput = drum(p, 'Hat')!.inputs.find((r) => r.label === 'gate')!;
  wire(p, loose(p, 'lfo'), 'out', byId(p, hatInput.module), hatInput.port);
  const spot = place(p, 'const'); p.modules = p.modules.filter((m) => m.id !== spot.id);
  const instrument = insertAssembly(p, DEFS, pluck, spot.x, spot.y);
  if (!member(p, instrument, 'string')) throw new Error('Pluck needs a String module for this arrangement');
  const melody = externalSeq(p, 'kick')!;
  // A hit's value can also be pitch: reuse the kick sequence without changing its rests.
  let note = 0;
  for (let i = 1; i <= 8; i++) if (melody.params[`s${i}`] > -1) melody.params[`s${i}`] = [0, 0.583, 0.25, 0.417][note++ % 4];
  const bars = loose(p, 'clkdiv') ?? place(p, 'clkdiv');
  const form = place(p, 'seq'); pattern(form, [0, 0, 0.5, 0.5, 0.5, 0.5, 1, 0]);
  const a = makeAssembly(p, [bars.id, form.id], marker);
  repairForm(p, a);
  p.name = 'My eight-bar performance';
}
