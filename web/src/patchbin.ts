// SPDX-License-Identifier: GPL-3.0-only
// Compact binary patch format, read by firmware/src/engine.c (eng_load).
//
//   u8  magic 0xA1, u8 version 16 (17 with switched fixed links), u8 module count, u8 voices (1..8; 0 = 1, what older files hold), u16 LE cable count, u16 LE flags
//       (bit 0: a morph B set follows the cables; bit 2: disabled-input masks follow it; bit 1: macro ranges are last)
//   per module:  u8 type index (bit 7 set: the module is bypassed), then one i32 LE per parameter (Q16.16), in the order of the definition;
//                modules with parameter inputs (paramInputs) then add i32 att1, i32 att2 (Q16.16, -1..1) and
//                six u16 LE matrix masks for the sources p1, p2, k1, k2, k3, k4 (bit n = the n-th parameter)
//   per cable:   u8 from module index, u8 from output index, u8 to module index, u8 to input index
//   with flag bit 0, per module: one i32 LE per parameter (Q16.16), the B side of the morph (the Main module's morph
//                parameter and input fade every parameter from the record's value to this one)
//   with flag bit 2: one u8 disabled-input mask per module (bit n disconnects fixed input n internally)
//   with flag bit 1: u8 count, then per macro range: u8 module index, u8 pin (0 p1, 1 p2), u8 parameter index, u8 low end,
//                u8 high end (0..255 of the parameter's range, octaves for a log one): the pin's value lands between the ends
//
// Type indices are the position in TYPE_ORDER (append only: the firmware has the same list in defs.h).
// Port indices are positions in ModuleDef.outputs / inputs (explicit ports first, then the `<param>_cv` inputs).

import { DEFS } from './modules';
import { hasMorph, MAX_MODULES, SOURCES, VOICE_PORTS, voiceSplit, voicesOf, type Patch } from './patch';

export const TYPE_ORDER: string[] = Object.keys(DEFS);
export const MAX_CABLES = 192;
export const VERSION = 17; // 17: switchable fixed input links (flag bit 2); unmodified patches still encode as 16; 16: the shaper got the sym and stages parameters; 15: macro ranges (flag bit 1); 14: the Main module got the morph input and parameter, header flag bit 0 = a morph B set follows the cables; 13: the shaper and the digitizer got the os (oversampling) parameter, the sequencer glide and gate; 12: bit 7 of the type byte marks a bypassed module; 11: the oscillator got the unison and detune parameters; 10: the merge of the two lines below: the Main module's clock output comes before spread, the lfo's inputs are clk, reset (the restart input was sync), the delay as in 8b, modules of the second and third batch; 9: the matrix masks are u16 (modules with more than 8 parameters), the modules of the second module batch; 8a: osc and lfo got the sync input (p1 / p2 moved), glide and shape modules, the panel's spread output; 8b: the delay has the clk input, r output and sync, pingpong parameters, the lfo got the clk and reset inputs and the sync, div, bpm parameters, the Main module's clock output; 7: the oscillator got the fb parameter; 6: the filter's outputs are lp24, lp12, bp, hp, mix; 5: the filter got the morph input (ports after cv moved), track and morph parameters; 4: the reverb module was added before the output
/** bytes of a module record */
export const recordSize = (type: string): number => 1 + 4 * DEFS[type].params.length + (DEFS[type].paramInputs ? 20 : 0);
export const Q = 65536;

/** bit 7 of a module record's type byte: the module is bypassed */
export const BYPASS_BIT = 0x80;
/** header flags (u16 at offset 6) */
export const FLAG_MORPH = 1;
export const FLAG_RANGE = 2;
export const FLAG_INPUTS = 4;
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

export function encodePatch(p: Patch): Uint8Array {
  if (p.modules.length > MAX_MODULES) throw new Error(`more than ${MAX_MODULES} modules`);
  if (p.cables.length > MAX_CABLES) throw new Error(`more than ${MAX_CABLES} cables`);
  const index = new Map(p.modules.map((m, i) => [m.id, i]));
  const morph = hasMorph(p);
  const ranges = rangeList(p);
  const masks = p.modules.map((m) => DEFS[m.type].inputs.reduce((mask, port, i) => mask | (m.disabledInputs?.includes(port.name) && DEFS[m.type].params.some((pd) => pd.input === port.name) ? 1 << i : 0), 0));
  const disabled = masks.some(Boolean);
  let size = 8;
  for (const m of p.modules) size += recordSize(m.type);
  size += 4 * p.cables.length;
  if (morph) for (const m of p.modules) size += 4 * DEFS[m.type].params.length;
  if (disabled) size += p.modules.length;
  if (ranges.length) size += 1 + 5 * ranges.length;
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  out[0] = 0xa1;
  out[1] = disabled ? VERSION : 16;
  out[2] = p.modules.length;
  out[3] = voicesOf(p);
  dv.setUint16(4, p.cables.length, true);
  dv.setUint16(6, (morph ? FLAG_MORPH : 0) | (ranges.length ? FLAG_RANGE : 0) | (disabled ? FLAG_INPUTS : 0), true);
  let at = 8;
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
  if (disabled) { out.set(masks, at); at += masks.length; }
  if (ranges.length) {
    out[at++] = ranges.length;
    for (const r of ranges) out.set([r.mod, r.pin, r.par, r.lo, r.hi], (at += 5) - 5);
  }
  return out;
}

/** the FM-1's pools (firmware/src/engine.c, the one-voice build: ENG_NBUF, ENG_MAX_INST, ENG_MAX_POLY); the four-voice
 * build (-DENG_VOICES=4) has 108 buffers and 72 instances shared by its four patches */
export const DEVICE = { buffers: 255, instances: 128, voices: 8 } as const;

/**
 * What a patch costs on the FM-1, counted the way eng_load allocates: one instance per shared module, one per voice for
 * a per-voice module (the panel too); one signal buffer per connected output port and instance (a per-voice port) or per
 * port (a shared one), plus one per input with two or more sources (a shared module reading a per-voice output has one
 * source per voice). `fits` is false when the firmware would refuse the patch.
 */
export function deviceBudget(p: Patch): { buffers: number; instances: number; fits: boolean } {
  const nv = voicesOf(p);
  const poly = voiceSplit(p);
  const types = new Map(p.modules.map((m) => [m.id, m.type]));
  const ninst = (id: number): number => (poly.has(id) || (types.get(id) === 'fm1' && nv > 1) ? nv : 1);
  const portPoly = (id: number, port: string): boolean => ninst(id) > 1 && !(types.get(id) === 'fm1' && !VOICE_PORTS.has(port));
  let instances = 0;
  for (const m of p.modules) instances += ninst(m.id);
  let buffers = 0;
  const seen = new Set<string>();
  for (const c of p.cables) {
    const key = `${c.from.module}:${c.from.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    buffers += portPoly(c.from.module, c.from.port) ? nv : 1;
  }
  for (const m of p.modules) {
    const n = ninst(m.id);
    for (const port of DEFS[m.type].inputs) {
      if (m.disabledInputs?.includes(port.name)) continue;
      let sources = 0;
      for (const c of p.cables) if (c.to.module === m.id && c.to.port === port.name) sources += n === 1 && portPoly(c.from.module, c.from.port) ? nv : 1;
      if (sources >= 2) buffers += n;
    }
  }
  return { buffers, instances, fits: buffers <= DEVICE.buffers && instances <= DEVICE.instances && nv <= DEVICE.voices };
}
