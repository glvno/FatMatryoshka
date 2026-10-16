// SPDX-License-Identifier: GPL-3.0-only
// Compact binary patch format, read by firmware/src/engine.c (eng_load).
//
//   u8  magic 0xA1, u8 version 20, u8 module count, u8 poly group count G (0..MAX_POLY), u16 LE cable count, u16 LE flags
//       (bit 0: a morph B set follows the cables; bit 2: disabled-input masks follow it; bit 3: additional input routes follow masks; bit 1: macro ranges are last)
//   per poly group (poly.ts polyGroups order): u8 parts (1..8), u8 assign, u8 legato, u8 priority, u8 unit (patch.ts PolyCfg)
//   with G > 0: one u8 per module, its poly group (0: it runs once, 1..G); delay, reverb, chorus, granular and output are always 0
//   per module:  u8 type index (bit 7 set: the module is bypassed), then one i32 LE per parameter (Q16.16), in the order of the definition;
//                modules with parameter inputs (paramInputs) then add i32 att1, i32 att2 (Q16.16, -1..1) and
//                six u16 LE matrix masks for the sources p1, p2, k1, k2, k3, k4 (bit n = the n-th parameter)
//   per cable:   u8 from module index, u8 from output index, u8 to module index, u8 to input index
//   with flag bit 0, per module: one i32 LE per parameter (Q16.16), the B side of the morph (the Main module's morph
//                parameter and input fade every parameter from the record's value to this one)
//   with flag bit 2 (legacy, read by the firmware, never written since fixed links became permanent): one u8 disabled-input mask per module
//   with flag bit 3: u8 count, then u8 module index, u8 input index, u16 LE parameter mask per routed input
//   with flag bit 1: u8 count, then per macro range: u8 module index, u8 pin (0 p1, 1 p2), u8 parameter index, u8 low end,
//                u8 high end (0..255 of the parameter's range, octaves for a log one): the pin's value lands between the ends
//
// Type indices are the position in TYPE_ORDER (append only: the firmware has the same list in defs.h).
// Port indices are positions in ModuleDef.outputs / inputs (explicit ports first, then the `<param>_cv` inputs).

import { DEFS } from './modules';
import { hasMorph, MAX_MODULES, MAX_PARTS, SOURCES, type Patch } from './patch';
import { copiesOf, MAX_POLY, polyGroups } from './poly';
import { cpuEstimate, type CpuEstimate } from './cpu';

export const TYPE_ORDER: string[] = Object.keys(DEFS);
export const MAX_CABLES = 192;
export const VERSION = 20; // 20: poly assemblies (the group section after the header; the Main module lost legato, priority, unit and the spread, legato, jump, tol, drift outputs, the oscillator its drift; part and random modules); 19: voicing and drift: the Main module got legato, priority, unit (and the legato, jump, tol, drift outputs), the oscillator blend, stack, drift, the glide curve; 18: arbitrary side-input fan-out (flag bit 3); 17: switchable fixed input links (flag bit 2); unmodified patches still encode as 16; 16: the shaper got the sym and stages parameters; 15: macro ranges (flag bit 1); 14: the Main module got the morph input and parameter, header flag bit 0 = a morph B set follows the cables; 13: the shaper and the digitizer got the os (oversampling) parameter, the sequencer glide and gate; 12: bit 7 of the type byte marks a bypassed module; 11: the oscillator got the unison and detune parameters; 10: the merge of the two lines below: the Main module's clock output comes before spread, the lfo's inputs are clk, reset (the restart input was sync), the delay as in 8b, modules of the second and third batch; 9: the matrix masks are u16 (modules with more than 8 parameters), the modules of the second module batch; 8a: osc and lfo got the sync input (p1 / p2 moved), glide and shape modules, the panel's spread output; 8b: the delay has the clk input, r output and sync, pingpong parameters, the lfo got the clk and reset inputs and the sync, div, bpm parameters, the Main module's clock output; 7: the oscillator got the fb parameter; 6: the filter's outputs are lp24, lp12, bp, hp, mix; 5: the filter got the morph input (ports after cv moved), track and morph parameters; 4: the reverb module was added before the output
/** bytes of a module record */
export const recordSize = (type: string): number => 1 + 4 * DEFS[type].params.length + (DEFS[type].paramInputs ? 20 : 0);
export const Q = 65536;

/** bit 7 of a module record's type byte: the module is bypassed */
export const BYPASS_BIT = 0x80;
/** header flags (u16 at offset 6) */
export const FLAG_MORPH = 1;
export const FLAG_RANGE = 2;
export const FLAG_INPUTS = 4; // legacy: disabled fixed links (format 17); the encoder no longer sets it
export const FLAG_INPUT_MAP = 8;
/** the macro ranges of a patch as the binary lists them (module index, pin, parameter index, ends 0..255) */
export function rangeList(p: Patch): { mod: number; pin: number; par: number; lo: number; hi: number }[] {
  const out: { mod: number; pin: number; par: number; lo: number; hi: number }[] = [];
  p.modules.forEach((m, mod) => {
    const def = DEFS[m.type];
    (['p1', 'p2'] as const).forEach((s, pin) => {
      for (const [name, r] of Object.entries(m.range?.[s] ?? {})) {
        const par = def.params.findIndex((q) => q.name === name);
        if (par >= 0 && m.map?.[s].includes(name)) out.push({ mod, pin, par, lo: Math.round(r[0] * 255), hi: Math.round(r[1] * 255) });
      }
    });
  });
  return out;
}

export const toQ16 = (v: number): number => Math.max(-0x80000000, Math.min(0x7fffffff, Math.round(v * Q)));

/** the additional input routes the binary lists (flag bit 3): module index, input index, parameter mask */
function routesOf(p: Patch): { mod: number; input: number; mask: number }[] {
  return p.modules.flatMap((m, mod) => DEFS[m.type].inputs.flatMap((port, input) => {
    if (port.name === 'p1' || port.name === 'p2') return [];
    const mask = DEFS[m.type].params.reduce((mask, pd, i) => mask | (pd.input !== port.name && m.inputMap?.[port.name]?.includes(pd.name) ? 1 << i : 0), 0);
    return mask ? [{ mod, input, mask }] : [];
  }));
}

/** bytes of the binary patch (what the FM-1 must hold, M1_PATCH_MAX) */
export function encodedSize(p: Patch): number {
  const groups = polyGroups(p).length;
  const routes = routesOf(p).length;
  const ranges = rangeList(p).length;
  let size = 8 + 5 * groups + (groups ? p.modules.length : 0);
  for (const m of p.modules) size += recordSize(m.type);
  size += 4 * p.cables.length;
  if (hasMorph(p)) for (const m of p.modules) size += 4 * DEFS[m.type].params.length;
  if (routes) size += 1 + 4 * routes;
  if (ranges) size += 1 + 5 * ranges;
  return size;
}

/** the binary patch; throws when the patch does not fit the FM-1 (deviceBudget): only a patch that fits is ever sent */
/** the binary patch; refused when it is over the FM-1 budget, unless `anyway` (tools that count the engine's work on patches the
 * estimate has not seen yet: scripts/cpu-costs.ts) */
export function encodePatch(p: Patch, anyway = false): Uint8Array {
  const budget = deviceBudget(p);
  if (!budget.fits && !anyway) throw new Error(`over the FM-1 budget: ${budget.over.map((i) => `${i.label} ${i.used} of ${i.max}`).join(', ')}`);
  const index = new Map(p.modules.map((m, i) => [m.id, i]));
  const morph = hasMorph(p);
  const ranges = rangeList(p);
  const routes = routesOf(p);
  const groups = polyGroups(p);
  const size = encodedSize(p);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out[0] = 0xa1;
  out[1] = VERSION;
  out[2] = p.modules.length;
  out[3] = groups.length;
  dv.setUint16(4, p.cables.length, true);
  dv.setUint16(6, (morph ? FLAG_MORPH : 0) | (ranges.length ? FLAG_RANGE : 0) | (routes.length ? FLAG_INPUT_MAP : 0), true);
  let at = 8;
  for (const { cfg } of groups) out.set([cfg.parts, cfg.assign, cfg.legato, cfg.priority, cfg.unit], (at += 5) - 5);
  if (groups.length) for (const m of p.modules) out[at++] = groups.findIndex((g) => g.modules.has(m.id)) + 1;
  for (const m of p.modules) {
    const def = DEFS[m.type];
    out[at++] = TYPE_ORDER.indexOf(m.type) | (m.bypass ? BYPASS_BIT : 0);
    for (const pd of def.params) {
      dv.setInt32(at, toQ16(m.params[pd.name] ?? pd.default), true);
      at += 4;
    }
    if (def.paramInputs) {
      for (const a of m.att ?? [1, 1]) {
        dv.setInt32(at, toQ16(a), true);
        at += 4;
      }
      for (const s of SOURCES) {
        let mask = 0;
        for (const name of m.map?.[s] ?? []) {
          const i = def.params.findIndex((q) => q.name === name);
          if (i >= 0) mask |= 1 << i;
        }
        dv.setUint16(at, mask, true);
        at += 2;
      }
    }
  }
  for (const c of p.cables) {
    const from = p.modules[index.get(c.from.module)!];
    const to = p.modules[index.get(c.to.module)!];
    out[at++] = index.get(c.from.module)!;
    out[at++] = DEFS[from.type].outputs.findIndex((o) => o.name === c.from.port);
    out[at++] = index.get(c.to.module)!;
    out[at++] = DEFS[to.type].inputs.findIndex((i) => i.name === c.to.port);
  }
  if (morph)
    for (const m of p.modules)
      for (const pd of DEFS[m.type].params) {
        dv.setInt32(at, toQ16(m.paramsB?.[pd.name] ?? m.params[pd.name] ?? pd.default), true);
        at += 4;
      }
  if (routes.length) {
    out[at++] = routes.length;
    for (const r of routes) {
      out[at++] = r.mod; out[at++] = r.input;
      dv.setUint16(at, r.mask, true); at += 2;
    }
  }
  if (ranges.length) {
    out[at++] = ranges.length;
    for (const r of ranges) out.set([r.mod, r.pin, r.par, r.lo, r.hi], (at += 5) - 5);
  }
  return out;
}

/** the FM-1's limits (firmware/src/engine.c, the one-voice build: ENG_MAX_MODULES, ENG_MAX_CABLES, POLY_MAX_GROUPS,
 * POLY_MAX_PARTS, ENG_MAX_INST, ENG_NBUF, ENG_NDELAY, ENG_NREV, ENG_NSTRING, ENG_NCHORUS, ENG_NGRAIN; proto.c M1_PATCH_MAX).
 * The four-voice build (-DENG_VOICES=4) has 108 buffers and 72 instances shared by its four patches. */
export const DEVICE = {
  modules: MAX_MODULES, cables: MAX_CABLES, poly: MAX_POLY, parts: MAX_PARTS, instances: 128, buffers: 255,
  delays: 1, reverbs: 1, strings: 8, chorus: 1, grains: 1, bytes: 3072,
} as const;

export type BudgetKey = keyof typeof DEVICE;
/** one line of the budget: what the patch uses of one FM-1 limit (`cpu`: the estimated load in percent of 100) */
export interface BudgetItem { key: BudgetKey | 'cpu'; label: string; used: number; max: number }

const LABELS: Record<BudgetKey, string> = {
  modules: 'modules', cables: 'cables', poly: 'poly assemblies', parts: 'parts', instances: 'module instances', buffers: 'signal buffers',
  delays: 'delays', reverbs: 'reverbs', strings: 'string / comb lines', chorus: 'choruses', grains: 'granular lines', bytes: 'patch bytes',
};

/**
 * What a patch costs on the FM-1, counted the way eng_load allocates: one instance per copy of a module (a module in a
 * poly assembly has one per part); one signal buffer per connected output port and copy, plus one per input copy with
 * two or more sources (a module outside a poly assembly reading a per-part output has one source per part); the shared
 * lines (delay, reverb, chorus, granular) once each, a string or comb line per copy. `items` lists every limit, `over`
 * those the patch exceeds, `memory` the fullest one as a fraction (single lines count only when exceeded) and `fullest` that
 * line; `cpu` the estimated processor load (cpu.ts); `use` the larger of the two. `fits` is false when the firmware would
 * refuse the patch or, by the estimate, could not render it in time.
 * The editor and the browser engine have none of these limits.
 */
export interface Budget {
  buffers: number;
  instances: number;
  fits: boolean;
  items: BudgetItem[];
  over: BudgetItem[];
  memory: number;
  fullest: BudgetItem | undefined;
  cpu: CpuEstimate;
  use: number;
}

export function deviceBudget(p: Patch): Budget {
  const copies = copiesOf(p);
  const groups = polyGroups(p);
  const groupOf = new Map<number, number>();
  groups.forEach((g, i) => g.modules.forEach((id) => groupOf.set(id, i)));
  const ninst = (id: number): number => copies.get(id) ?? 1;
  let instances = 0;
  for (const m of p.modules) instances += ninst(m.id);
  let buffers = 0;
  const seen = new Set<string>();
  for (const c of p.cables) {
    const key = `${c.from.module}:${c.from.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    buffers += ninst(c.from.module);
  }
  for (const m of p.modules) {
    const n = ninst(m.id);
    for (const port of DEFS[m.type].inputs) {
      let sources = 0;
      for (const c of p.cables)
        if (c.to.module === m.id && c.to.port === port.name) sources += groupOf.get(c.from.module) !== groupOf.get(m.id) ? ninst(c.from.module) : 1;
      if (sources >= 2) buffers += n;
    }
  }
  const count = (...types: string[]): number => p.modules.filter((m) => types.includes(m.type)).reduce((n, m) => n + ninst(m.id), 0);
  const used: Record<BudgetKey, number> = {
    modules: p.modules.length, cables: p.cables.length, poly: groups.length, parts: Math.max(1, ...[...copies.values()]),
    instances, buffers, delays: count('delay'), reverbs: count('reverb'), strings: count('string', 'comb'), chorus: count('chorus'),
    grains: count('grain'), bytes: encodedSize(p),
  };
  const items = (Object.keys(DEVICE) as BudgetKey[]).map((key) => ({ key, label: LABELS[key], used: used[key], max: DEVICE[key] }));
  const over: BudgetItem[] = items.filter((i) => i.used > i.max);
  // a one-of-a-kind line (one delay, one reverb ...) is either there or not: it shows only when exceeded, so a patch with
  // its one reverb does not read as full
  const counted = items.filter((i) => i.max > 1 || i.used > i.max);
  const fullest = counted.reduce<BudgetItem | undefined>((a, i) => (!a || i.used / i.max > a.used / a.max ? i : a), undefined);
  const memory = fullest ? fullest.used / fullest.max : 0;
  const cpu = cpuEstimate(p);
  if (cpu.use > 1) over.push({ key: 'cpu', label: 'CPU (estimate)', used: Math.round(cpu.use * 100), max: 100 });
  return { buffers, instances, fits: !over.length, items, over, memory, fullest, cpu, use: Math.max(memory, cpu.use) };
}

