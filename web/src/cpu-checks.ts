// SPDX-License-Identifier: GPL-3.0-only
// The whole patches the CPU model is checked on: scripts/cpu-costs.ts counts them on the emulator (cpu-costs.json `checks`),
// cpu.test.ts holds the model to those counts. Each with the notes held while counting.
import { FACTORY } from './assemblies';
import { insertAssembly } from './assembly';
import { DEFS } from './modules';
import { newPatch, type Patch } from './patch';
import { deviceBudget } from './patchbin';
import { PRESETS } from './presets';
import { withParts } from './test-poly';

export function cpuChecks(note: number): { name: string; patch: Patch; notes: number[] }[] {
  const chord = [note - 12, note - 5, note, note + 4];
  const out = Object.entries(PRESETS).map(([name, make]) => ({ name, patch: make(), notes: [note] }));
  out.push({ name: '303 Acid, 4 parts', patch: withParts(PRESETS['303 Acid'](), 4), notes: chord });
  const morph = PRESETS['303 Acid']();
  for (const m of morph.modules) if (m.type !== 'fm1') m.paramsB = { ...m.params };
  out.push({ name: '303 Acid, morph', patch: morph, notes: [note] });
  for (const def of FACTORY) {                     // those the FM-1 can load (a CPU estimate over 100 % is checked too)
    const patch = newPatch(DEFS, def.name);
    insertAssembly(patch, DEFS, def, 300, 0);
    if (deviceBudget(patch).over.every((i) => i.key === 'cpu')) out.push({ name: `assembly ${def.name}`, patch, notes: chord });
  }
  return out;
}

/** modules whose cost depends on what they are fed (grains alive, a compressor working): the table holds their worst case */
export const BUSY_TYPES = new Set(['grain', 'dyn']);
