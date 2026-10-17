// SPDX-License-Identifier: GPL-3.0-only
// The FM-1's CPU load of a patch, estimated from a table of costs (cpu-costs.json). The table comes from counting the
// fixed-point engine's instructions on an rv32im model (tools/cpu, `npm run cpu-costs`), scaled by the one CPU load measured
// on the device; a table measured on the FM-1 itself can replace it (`source`). Every figure here is an estimate.
import TABLE from './cpu-costs.json';
import { DEFS, STACKS } from './modules';
import { hasMorph, type ModuleInst, type Patch } from './patch';
import { deviceView } from './poly';

/** what changes a module's cost: a choice / switch / small integer (its measured values, the nearest one counts), a number
 * being above its minimum (the oscillator's FM index turns FM mode on), a number across its range (measured points,
 * interpolated: the oscillator's pitch), a patched input, a patched output */
export type CostDim =
  | { param: string; values: number[] }
  | { param: string; above: number }
  | { param: string; points: number[] }
  | { input: string }
  | { output: string };

export interface TypeCost {
  /** cycles per block: the module's own work and its parameter update, with nothing patched and every setting at its default */
  run: number;
  cv: number;
  dims?: CostDim[];
  /** run cost for every combination of the dims' values (row major, the first dim slowest) */
  grid?: number[];
  /** dims left out of the grid (too many combinations): cycles added per value, measured with everything else at default */
  extra?: { dim: CostDim; add: number[] }[];
  /** cycles added when the pitch input moves every sample (not just from the keyboard), per unison copy */
  moving?: number;
}

export interface CpuTable {
  /** where the numbers come from */
  source: string;
  /** the table's unit per microsecond on the FM-1 */
  cyclesPerUs: number;
  /** the time the audio interrupt has per block (128 frames at 44.1 kHz) */
  blockUs: number;
  /** the note the costs were counted at, through a module's pitch input (with nothing patched there a module plays C4, 60:
   * its `coarse` counts that much lower) */
  note: number;
  /** fixed costs: per rendered block, per Output module, per module instance */
  block: number;
  output: number;
  node: number;
  /** summing several cables into one input: per summed input, per source */
  sum: { port: number; source: number };
  /** parameter inputs (per block): per connected p1 / p2 or routed side input, per parameter it moves (linear / log), per
   * parameter while the patch has a morph B side */
  cv: { pin: number; lin: number; log: number; morph: number };
  /** a bypassed module copies its through input: per patched output */
  bypass: number;
  types: Record<string, TypeCost>;
  /** whole patches counted by the emulator, which the model must match (cpu.test.ts) */
  checks: { name: string; cycles: number }[];
  /** how the scale was found */
  calibration: Record<string, number | string>;
}

export const CPU: CpuTable = TABLE as CpuTable;

/** above this the estimate warns: the table is an estimate, not a measurement */
export const CPU_WARN = 0.8;

export interface CpuModule {
  id: number;
  type: string;
  /** instances: the parts of its poly assembly */
  copies: number;
  cycles: number;
}

export interface CpuEstimate {
  cycles: number;
  us: number;
  /** fraction of the block's time */
  use: number;
  /** per module, the costliest first */
  modules: CpuModule[];
}

const nearest = (values: number[], v: number): number => values.reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));

const paramOf = (m: ModuleInst, name: string): number => m.params[name] ?? DEFS[m.type].params.find((p) => p.name === name)?.default ?? 0;

/** where a module's setting falls along a dim: [index into the dim's values, weight], two for a number between two points */
function place(d: CostDim, m: ModuleInst, inputs: Set<string>, outputs: Set<string>, moved: Set<string>, shift: number): [number, number][] {
  if ('values' in d) {
    const v = paramOf(m, d.param);
    return [[d.values.indexOf(nearest(d.values, v)), 1]];
  }
  if ('above' in d) return [[moved.has(d.param) || paramOf(m, d.param) > d.above ? 1 : 0, 1]];
  if ('points' in d) {
    const pts = d.points;
    let v = paramOf(m, d.param) + (d.param === 'coarse' ? shift : 0);
    if (moved.has(d.param) && v <= pts[0] && pts.length > 1) v = pts[1];
    if (v <= pts[0]) return [[0, 1]];
    for (let i = 1; i < pts.length; i++)
      if (v <= pts[i]) {
        const w = (v - pts[i - 1]) / (pts[i] - pts[i - 1]);
        return [[i - 1, 1 - w], [i, w]];
      }
    return [[pts.length - 1, 1]];
  }
  if ('input' in d) return [[inputs.has(d.input) ? 1 : 0, 1]];
  return [[outputs.has(d.output) ? 1 : 0, 1]];
}

export const dimSize = (d: CostDim): number => ('values' in d ? d.values.length : 'points' in d ? d.points.length : 2);

/** the run cost of one instance of `m`; `moved`: the parameters a parameter input or the morph moves (a mode that turns on
 * above a minimum counts as on then: the modulation may take it there) */
export function runCost(m: ModuleInst, t: TypeCost, inputs: Set<string>, outputs: Set<string>, moved: Set<string> = new Set(), note = CPU.note): number {
  const shift = DEFS[m.type]?.inputs.some((i) => i.name === 'pitch') && !inputs.has('pitch') ? 60 - note : 0;
  let c = t.run;
  if (t.dims && t.grid) {
    const parts = t.dims.map((d) => place(d, m, inputs, outputs, moved, shift));
    const sizes = t.dims.map(dimSize);
    c = 0;
    const walk = (k: number, at: number, w: number): void => {
      if (!w) return;
      if (k === parts.length) return void (c += w * t.grid![at]);
      for (const [i, wi] of parts[k]) walk(k + 1, at * sizes[k] + i, w * wi);
    };
    walk(0, 0, 1);
  }
  for (const { dim, add } of t.extra ?? []) for (const [i, w] of place(dim, m, inputs, outputs, moved, shift)) c += w * add[i];
  return c;
}

/** modules whose output never holds still (a periodic or noisy signal) */
const MOVERS = new Set(['lfo', 'osc', 'noise', 'wavetable', 'string', 'grain']);

/** does a signal from module `id` keep moving: a mover feeds it, through any chain of modules */
function keepsMoving(p: Patch, id: number, seen = new Set<number>()): boolean {
  if (seen.has(id)) return false;
  seen.add(id);
  if (MOVERS.has(p.modules.find((m) => m.id === id)?.type ?? '')) return true;
  return p.cables.some((c) => c.to.module === id && keepsMoving(p, c.from.module, seen));
}

export function cpuEstimate(source: Patch, table: CpuTable = CPU): CpuEstimate {
  // counted on what the FM-1 runs (poly.ts deviceView): an allocator is a Part in each group it drives
  const { patch: p, groups } = deviceView(source);
  const copies = new Map<number, number>();
  const groupOf = new Map<number, number>();
  groups.forEach((g, i) => g.modules.forEach((id) => (groupOf.set(id, i), copies.set(id, g.cfg.parts))));
  const ninst = (id: number): number => copies.get(id) ?? 1;
  const morph = hasMorph(p);
  let total = table.block;
  const modules: CpuModule[] = [];
  for (const m of p.modules) {
    const def = DEFS[m.type];
    const t = table.types[m.type];
    if (!def || !t) continue;
    const inputs = new Set<string>(), outputs = new Set<string>();
    const sources = new Map<string, number>();
    for (const c of p.cables) {
      if (c.to.module === m.id) {
        inputs.add(c.to.port);
        const n = groupOf.get(c.from.module) !== groupOf.get(m.id) ? ninst(c.from.module) : 1;
        sources.set(c.to.port, (sources.get(c.to.port) ?? 0) + n);
      }
      if (c.from.module === m.id) outputs.add(c.from.port);
    }
    let one = table.node + t.cv;
    for (const n of sources.values()) if (n >= 2) one += table.sum.port + n * table.sum.source;
    const moved = new Set<string>();
    if (def.paramInputs) {
      for (const pin of ['p1', 'p2'] as const)
        if (inputs.has(pin)) {
          one += table.cv.pin;
          for (const name of m.map?.[pin] ?? []) moved.add(name);
        }
      for (const names of Object.values(m.inputMap ?? {}))
        if (names.length) {
          one += table.cv.pin;
          for (const name of names) moved.add(name);
        }
      for (const name of moved) one += def.params.find((q) => q.name === name)?.log ? table.cv.log : table.cv.lin;
    }
    if (morph && m.type !== 'fm1') {
      one += table.cv.morph * def.params.length;
      for (const [name, v] of Object.entries(m.paramsB ?? {})) if (v !== m.params[name]) moved.add(name);
    }
    one += m.bypass ? table.bypass * outputs.size : runCost(m, t, inputs, outputs, moved, table.note);
    // a pitch input that keeps moving: something that never holds still reaches it (an envelope or a glide only moves for a moment)
    if (t.moving && !m.bypass && p.cables.some((c) => c.to.module === m.id && c.to.port === 'pitch' && keepsMoving(p, c.from.module)))
      one += t.moving * (m.type === 'osc' ? Math.max(Math.round(m.params.unison ?? 1), STACKS[Math.round(m.params.stack ?? 0)]?.length ?? 1) : 1);
    if (m.type === 'output') total += table.output;
    const k = ninst(m.id);
    modules.push({ id: m.id, type: m.type, copies: k, cycles: one * k });
    total += one * k;
  }
  modules.sort((a, b) => b.cycles - a.cycles);
  const us = total / table.cyclesPerUs;
  return { cycles: total, us, use: us / table.blockUs, modules };
}
