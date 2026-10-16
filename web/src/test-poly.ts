// SPDX-License-Identifier: GPL-3.0-only
// Test helper: a patch made polyphonic the way an old patch with `voices` is converted (poly.ts migrateVoicing): the
// modules that hear the Main module's pitch / gate / vel go into a poly assembly with a Part module.
import { fixAssemblies } from './assembly';
import { DEFS } from './modules';
import { validatePatch, type Patch, type PolyCfg } from './patch';

export function withParts(p: Patch, parts: number, cfg: Partial<PolyCfg> = {}): Patch {
  const q = validatePatch(JSON.parse(JSON.stringify({ ...p, voices: parts })), DEFS);
  fixAssemblies(q, DEFS);
  const g = q.assemblies?.find((a) => a.poly);
  if (g) Object.assign(g.poly!, cfg);
  return q;
}

/** the poly assembly's settings (the first one) */
export const polyCfg = (p: Patch): PolyCfg => p.assemblies!.find((a) => a.poly)!.poly!;
