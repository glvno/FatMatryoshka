// SPDX-License-Identifier: GPL-3.0-only
// Test helper: a patch made polyphonic the way an old patch with `voices` is converted (poly.ts migrateVoicing, then
// migrateParts): the modules that hear the Main module's pitch / gate / vel go into a poly assembly, fed by a Voice
// allocator (Main's keys in).
import { fixAssemblies } from './assembly';
import { DEFS } from './modules';
import { addModule, validatePatch, type ModuleInst, type Patch, type PolyCfg } from './patch';
import { allocatorOf } from './poly';

export function withParts(p: Patch, parts: number, cfg: Partial<PolyCfg> = {}): Patch {
  const q = validatePatch(JSON.parse(JSON.stringify({ ...p, voices: parts })), DEFS);
  fixAssemblies(q, DEFS);
  if (q.assemblies?.some((a) => a.poly)) Object.assign(polyCfg(q), cfg);
  return q;
}

/** the first poly assembly's settings as one object, read and written through: parts / assign / legato / priority / unison are
 * its allocator's parameters, flaws the assembly's */
export function polyCfg(p: Patch): PolyCfg {
  const a = p.assemblies!.find((x) => x.poly)!;
  const alloc = allocatorOf(p, a)!;
  const o = {} as PolyCfg;
  const params: Record<string, string> = { parts: 'voices', assign: 'assign', legato: 'legato', priority: 'priority' };
  for (const [k, q] of Object.entries(params))
    Object.defineProperty(o, k, { enumerable: true, get: () => alloc.params[q], set: (v: number) => (alloc.params[q] = v) });
  Object.defineProperty(o, 'unison', { enumerable: false, get: () => alloc.params.unison >= 0.5 || undefined, set: (v: boolean) => (alloc.params.unison = v ? 1 : 0) });
  Object.defineProperty(o, 'flaws', { enumerable: true, get: () => a.poly!.flaws, set: (v: PolyCfg['flaws']) => (v ? (a.poly!.flaws = v) : delete a.poly!.flaws) });
  return o;
}

/** a Voice allocator with these settings (parts = voices), Main's keys in (a Main module is added when the patch has none) */
export function addAlloc(p: Patch, cfg: Partial<PolyCfg> = {}): ModuleInst {
  const main = p.modules.find((m) => m.type === 'fm1') ?? addModule(p, DEFS.fm1, 0, 0);
  const a = addModule(p, DEFS.alloc, 0, 0);
  if (cfg.parts !== undefined) a.params.voices = cfg.parts;
  for (const k of ['assign', 'legato', 'priority'] as const) if (cfg[k] !== undefined) a.params[k] = cfg[k]!;
  if (cfg.unison) a.params.unison = 1;
  p.cables.push({ from: { module: main.id, port: 'keys' }, to: { module: a.id, port: 'keys' } });
  return a;
}
