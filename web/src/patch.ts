// SPDX-License-Identifier: GPL-3.0-only
import type { AssemblyInst } from './assembly';
import { fixArp, type ArpCfg } from './arp';
// Patch data model, shared by the editor, the WebAudio engine and (later) the firmware encoder.

export type SignalKind = 'audio' | 'control' | 'gate';

export interface PortDef {
  name: string;
  kind: SignalKind;
  /** shown in the editor instead of `name` */
  label?: string;
  /** set on the two parameter inputs `p1` and `p2` (1 or 2) */
  pin?: 1 | 2;
}

/** What can change a module's parameters: its two parameter inputs and the four FM-1 knobs. */
export type Source = 'p1' | 'p2' | 'k1' | 'k2' | 'k3' | 'k4';
export const SOURCES: Source[] = ['p1', 'p2', 'k1', 'k2', 'k3', 'k4'];

export interface ParamDef {
  name: string;
  /** Dedicated signal input controlling this value; also exposed on the editor's slider thumb. */
  input?: string;
  min: number;
  max: number;
  default: number;
  step?: number;
  unit?: string;
  /** names for integer-valued choice params (waveform etc.) */
  choices?: string[];
  /** logarithmic: the range is covered in equal ratios (a filter cutoff in octaves). Modulation and the knobs move the value in
   * that space: a fraction of the range is a fraction of the octaves. */
  log?: boolean;
  /** with `log`: the position is the square root of the octave fraction (an inverse logarithmic bend: the low end gets more of the knob / slider travel) */
  bend?: boolean;
  /** an on/off switch (0 or 1): a check box in the editor, OFF / ON on the LCD */
  toggle?: boolean;
  /** while the toggle parameter `when` is on, the value is shown as `text(value)` instead of the number (the synced delay time as a note length) */
  altText?: { when: string; text: (v: number) => string };
}

/** position of a value in its range, 0..1 (logarithmic for log parameters) */
export function toUnit(pd: ParamDef, v: number): number {
  const x = Math.min(pd.max, Math.max(pd.min, v));
  if (!pd.log) return (x - pd.min) / (pd.max - pd.min);
  const t = Math.log(x / pd.min) / Math.log(pd.max / pd.min);
  return pd.bend ? Math.sqrt(t) : t;
}

export function fromUnit(pd: ParamDef, u: number): number {
  const x = Math.min(1, Math.max(0, u));
  if (!pd.log) return pd.min + x * (pd.max - pd.min);
  return pd.min * Math.pow(pd.max / pd.min, pd.bend ? x * x : x);
}

/** a parameter's base value moved by `mod` of its range (mean of a parameter input x attenuverter), clamped */
export function modulate(pd: ParamDef, base: number, mod: number): number {
  if (!pd.log) return Math.min(pd.max, Math.max(pd.min, base + mod * (pd.max - pd.min)));
  return fromUnit(pd, toUnit(pd, base) + mod);
}

/** a parameter's position in its range without the slider's bend (octaves for a log parameter): the space macro ranges and the morph move in */
export function paramUnit(pd: ParamDef, v: number): number {
  const x = Math.min(pd.max, Math.max(pd.min, v));
  return pd.log ? Math.log(x / pd.min) / Math.log(pd.max / pd.min) : (x - pd.min) / (pd.max - pd.min);
}

export function paramValue(pd: ParamDef, u: number): number {
  const x = Math.min(1, Math.max(0, u));
  return pd.log ? pd.min * Math.pow(pd.max / pd.min, x) : pd.min + x * (pd.max - pd.min);
}

/** the macro range of pin `s` on parameter `name`: the pin's value 0..1 lands between these two unit positions instead of adding to the base */
export type Range = [number, number];
export const rangeOf = (m: ModuleInst, s: 'p1' | 'p2', name: string): Range | undefined => m.range?.[s]?.[name];

export interface ModuleDef {
  type: string;
  label: string;
  inputs: PortDef[];
  outputs: PortDef[];
  params: ParamDef[];
  /** the module has the two parameter inputs p1, p2 (attenuverters) and the source matrix: every module but the FM-1 panel (the input) and the output */
  paramInputs?: boolean;
  /** the input a bypassed module passes to all of its outputs; default: the input called `in`, or none (the outputs are silent) */
  thru?: string;
}

/** the input a bypassed module of this definition passes through, undefined when it mutes instead */
export const thruInput = (def: ModuleDef): string | undefined => def.thru ?? (def.inputs.some((p) => p.name === 'in') ? 'in' : undefined);

export interface Endpoint {
  module: number;
  port: string;
}

export interface Cable {
  from: Endpoint; // an output
  to: Endpoint; // an input
}

export interface ModuleInst {
  id: number;
  type: string;
  x: number;
  y: number;
  params: Record<string, number>;
  /** attenuverters of the parameter inputs p1 and p2, -1..1 (only on modules with paramInputs) */
  att?: [number, number];
  /** the matrix: the parameters each source controls. p1 / p2 add (input mean x attenuverter x range) to them, k1..k4 are
   * the FM-1 knobs, which nudge them while the module is selected on the device (only on modules with paramInputs) */
  map?: Record<Source, string[]>;
  /** bypassed: the module does not run; its outputs carry its through input (thruInput) or silence. Not on the panel or the output. */
  bypass?: boolean;
  /** Dedicated input-to-parameter links switched off; incoming cables remain plugged in. */
  disabledInputs?: string[];
  /** Additional additive routes from side inputs to parameters; p1/p2 keep their existing map/depth/ranges. */
  inputMap?: Record<string, string[]>;
  /** the B side of a morph: the same parameters as `params`, taken from another patch of the same structure (setMorphTarget); the
   * Main module's `morph` (plus its morph input) fades every parameter from `params` to these. Not on the Main module. */
  paramsB?: Record<string, number>;
  /** macro ranges: for a parameter that p1 / p2 controls (map), the input's value 0..1 lands between these two positions of the
   * parameter's range (0..1, octaves for a log parameter; paramUnit) instead of adding to the base value */
  range?: { p1?: Record<string, [number, number]>; p2?: Record<string, [number, number]> };
}

export interface Patch {
  version: 2;
  name: string;
  modules: ModuleInst[];
  cables: Cable[];
  /** number of voices, 1 (mono, the default) .. MAX_VOICES. See voiceSplit() for what a voice is. */
  voices?: number;
  /** groups of modules shown as one card (an editor-only overlay, see assembly.ts); the engine and the FM-1 ignore it */
  assemblies?: AssemblyInst[];
  /** the name of the patch the B side (paramsB) was taken from, for display */
  morphName?: string;
  /** the arpeggiator's settings (arp.ts), an optional overlay: the browser's arpeggiator and the FM-1's (ARP command) take
   * them with the patch; the binary patch does not carry them */
  arp?: ArpCfg;
}

/** do two patches have the same structure (modules of the same types in the same order, the same cables), so that one can be the B side of the other? */
export function sameStructure(a: Patch, b: Patch): boolean {
  if (a.modules.length !== b.modules.length || a.cables.length !== b.cables.length) return false;
  if (a.modules.some((m, i) => m.type !== b.modules[i].type)) return false;
  const key = (p: Patch): string => {
    const idx = new Map(p.modules.map((m, i) => [m.id, i]));
    return p.cables
      .map((c) => `${idx.get(c.from.module)}:${c.from.port}>${idx.get(c.to.module)}:${c.to.port}`)
      .sort()
      .join(' ');
  };
  return key(a) === key(b);
}

/** take patch b's parameters as the B side of p (same structure required); the Main module's own parameters are not morphed */
export function setMorphTarget(p: Patch, b: Patch, defs: Record<string, ModuleDef>): void {
  if (!sameStructure(p, b)) throw new Error('the B patch must have the same modules and cables');
  p.modules.forEach((m, i) => {
    if (m.type === 'fm1') return;
    const out: Record<string, number> = {};
    for (const pd of defs[m.type].params) out[pd.name] = b.modules[i].params[pd.name] ?? pd.default;
    m.paramsB = out;
  });
  p.morphName = b.name;
}

export function clearMorph(p: Patch): void {
  for (const m of p.modules) delete m.paramsB;
  delete p.morphName;
}

export const hasMorph = (p: Patch): boolean => p.modules.some((m) => m.paramsB);

/** a parameter between its A and B values at morph position t (0..1): linearly, or in octaves for a log parameter (without the
 * slider's bend: the midpoint of 200 and 3200 Hz is 800 Hz); a choice or switch snaps at 0.5 */
export function morphValue(pd: ParamDef, a: number, b: number, t: number): number {
  if (pd.choices || pd.toggle) return t < 0.5 ? a : b;
  return paramValue(pd, paramUnit(pd, a) + (paramUnit(pd, b) - paramUnit(pd, a)) * t);
}

export const MAX_MODULES = 32;
export const MAX_VOICES = 8;

export function emptyPatch(name = 'init'): Patch {
  return { version: 2, name, modules: [], cables: [] };
}

/** what the editor's "New patch" opens: the Main panel at the top left and the Output at the right, nothing wired (grid of assembly.ts) */
export function newPatch(defs: Record<string, ModuleDef>, name = 'init'): Patch {
  const p = emptyPatch(name);
  addModule(p, defs.fm1, 20, 20);
  addModule(p, defs.output, 20 + 3 * 270, 20);
  return p;
}

/** the voice count of a patch: a whole number 1..MAX_VOICES, 1 when missing */
export function voicesOf(p: Pick<Patch, 'voices'>): number {
  const v = Math.round(Number(p.voices));
  return Number.isFinite(v) ? Math.max(1, Math.min(MAX_VOICES, v)) : 1;
}

/** the panel outputs that differ per voice; its knobs are the same for every voice */
export const VOICE_PORTS = new Set(['pitch', 'gate', 'vel', 'spread']);
/** modules that always run once, however many voices: their inputs sum the voices (big state, or the end of the chain) */
export const SHARED_TYPES = new Set(['delay', 'reverb', 'chorus', 'grain', 'output']);

/**
 * Which modules run once per voice. With more than one voice the FM-1 panel's pitch, gate and vel are per voice, and so
 * is every module that (through any chain of cables, p1 / p2 included) hears them, except the SHARED_TYPES. A cable from a
 * per-voice output into a shared module carries the sum of the voices; a cable from a shared output into a per-voice
 * module reaches every voice. With one voice nothing is per voice: that is the mono engine as it was.
 */
export function voiceSplit(p: Patch): Set<number> {
  const poly = new Set<number>();
  if (voicesOf(p) < 2) return poly;
  const types = new Map(p.modules.map((m) => [m.id, m.type]));
  const isPolyPort = (module: number, port: string): boolean =>
    types.get(module) === 'fm1' ? VOICE_PORTS.has(port) : poly.has(module);
  for (;;) {
    let grew = false;
    for (const c of p.cables) {
      const t = types.get(c.to.module);
      if (!t || t === 'fm1' || SHARED_TYPES.has(t) || poly.has(c.to.module)) continue; // the Main module's own input (morph) does not make it per voice
      if (isPolyPort(c.from.module, c.from.port)) {
        poly.add(c.to.module);
        grew = true;
      }
    }
    if (!grew) return poly;
  }
}

export function nextId(p: Patch): number {
  return p.modules.reduce((m, x) => Math.max(m, x.id), 0) + 1;
}

export function defaultParams(def: ModuleDef): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of def.params) out[p.name] = p.default;
  return out;
}

/** the default matrix: p1 and p2 control the first two parameters, knob n the n-th */
export function defaultMap(def: ModuleDef): Record<Source, string[]> {
  const at = (i: number): string[] => (def.params[i] ? [def.params[i].name] : []);
  return { p1: at(0), p2: at(1), k1: at(0), k2: at(1), k3: at(2), k4: at(3) };
}

/** Validate native link switches and additional side-input destinations; old patches retain their original routing. */
export function fixInputRoutes(m: ModuleInst, def: ModuleDef): void {
  const valid = new Set(def.params.flatMap((pd) => pd.input ? [pd.input] : []));
  const disabled = Array.isArray(m.disabledInputs) ? [...new Set(m.disabledInputs.filter((name) => valid.has(name)))] : [];
  if (disabled.length) m.disabledInputs = disabled;
  else delete m.disabledInputs;
  const routes: Record<string, string[]> = {};
  for (const port of def.inputs) {
    if (port.name === 'p1' || port.name === 'p2') continue;
    const names = m.inputMap?.[port.name];
    if (!Array.isArray(names)) continue;
    const targets = [...new Set(names.filter((name) => def.params.some((pd) => pd.name === name && pd.input !== port.name)))];
    if (targets.length) routes[port.name] = targets;
  }
  if (Object.keys(routes).length) m.inputMap = routes;
  else delete m.inputMap;
}

/** att and map for a module that has parameter inputs, filled in or repaired */
export function fixMatrix(m: ModuleInst, def: ModuleDef): void {
  if (!def.paramInputs) {
    delete m.att;
    delete m.map;
    return;
  }
  const a = Array.isArray(m.att) ? m.att : [1, 1];
  m.att = [0, 1].map((i) => Math.max(-1, Math.min(1, Number.isFinite(Number(a[i])) ? Number(a[i]) : 1))) as [number, number];
  const names = new Set(def.params.map((q) => q.name));
  const dm = defaultMap(def);
  const map = {} as Record<Source, string[]>;
  for (const s of SOURCES) map[s] = Array.isArray(m.map?.[s]) ? m.map![s].filter((n) => names.has(n)) : dm[s];
  m.map = map;
  // macro ranges: only on parameters the pin controls, both ends 0..1
  if (m.range && typeof m.range === 'object') {
    const out: NonNullable<ModuleInst['range']> = {};
    for (const s of ['p1', 'p2'] as const) {
      const r = m.range[s];
      if (!r || typeof r !== 'object') continue;
      for (const name of map[s]) {
        const v = r[name];
        if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => Number.isFinite(Number(x)))) continue;
        (out[s] ??= {})[name] = [Math.min(1, Math.max(0, Number(v[0]))), Math.min(1, Math.max(0, Number(v[1])))];
      }
    }
    if (Object.keys(out).length) m.range = out;
    else delete m.range;
  } else delete m.range;
}

export function addModule(p: Patch, def: ModuleDef, x: number, y: number): ModuleInst {
  if (p.modules.length >= MAX_MODULES) throw new Error(`a patch holds at most ${MAX_MODULES} modules`);
  const m: ModuleInst = { id: nextId(p), type: def.type, x, y, params: defaultParams(def) };
  fixMatrix(m, def);
  p.modules.push(m);
  return m;
}

export function removeModule(p: Patch, id: number): void {
  p.modules = p.modules.filter((m) => m.id !== id);
  p.cables = p.cables.filter((c) => c.from.module !== id && c.to.module !== id);
}

/** Connect an output to an input. Several cables into one input are summed. Returns false if rejected. */
export function connect(p: Patch, defs: Record<string, ModuleDef>, from: Endpoint, to: Endpoint): boolean {
  const mf = p.modules.find((m) => m.id === from.module);
  const mt = p.modules.find((m) => m.id === to.module);
  if (!mf || !mt || mf.id === mt.id) return false;
  if (!defs[mf.type]?.outputs.some((o) => o.name === from.port)) return false;
  if (!defs[mt.type]?.inputs.some((i) => i.name === to.port)) return false;
  if (p.cables.some((c) => sameEnd(c.from, from) && sameEnd(c.to, to))) return false;
  p.cables.push({ from: { ...from }, to: { ...to } });
  return true;
}

export function sameEnd(a: Endpoint, b: Endpoint): boolean {
  return a.module === b.module && a.port === b.port;
}

export function disconnect(p: Patch, cable: Cable): void {
  p.cables = p.cables.filter((c) => !(sameEnd(c.from, cable.from) && sameEnd(c.to, cable.to)));
}

/**
 * Processing order: every module after the modules that feed it. A cable that closes a loop is
 * a feedback cable and reads the producer's previous block (one block of delay).
 */
export function processingOrder(p: Patch): { order: number[]; feedback: Set<Cable> } {
  const ids = p.modules.map((m) => m.id);
  const state = new Map<number, 0 | 1 | 2>(); // 0 new, 1 on stack, 2 done
  const order: number[] = [];
  const feedback = new Set<Cable>();
  const incoming = new Map<number, Cable[]>();
  for (const c of p.cables) {
    const l = incoming.get(c.to.module) ?? [];
    l.push(c);
    incoming.set(c.to.module, l);
  }
  const visit = (id: number): void => {
    state.set(id, 1);
    for (const c of incoming.get(id) ?? []) {
      const s = state.get(c.from.module) ?? 0;
      if (s === 1) feedback.add(c);
      else if (s === 0) visit(c.from.module);
    }
    state.set(id, 2);
    order.push(id);
  };
  for (const id of ids) if ((state.get(id) ?? 0) === 0) visit(id);
  return { order, feedback };
}

/** Structural check of a patch loaded from JSON. Version 1 patches (one `<param>_cv` input per parameter) are converted, and a `midi` module becomes the FM-1 panel. Throws with a readable message. */
export function validatePatch(raw: unknown, defs: Record<string, ModuleDef>): Patch {
  const p = raw as Omit<Patch, 'version'> & { version: number };
  if (!p || (p.version !== 1 && p.version !== 2) || !Array.isArray(p.modules) || !Array.isArray(p.cables)) throw new Error('not a FatMatryoshka patch');
  if (p.modules.length > MAX_MODULES) throw new Error(`more than ${MAX_MODULES} modules`);
  const seen = new Set<number>();
  for (const m of p.modules) {
    if (m.type === 'midi') m.type = 'fm1'; // the MIDI module is gone: the FM-1 panel has the same pitch / gate / vel outputs
    const def = defs[m.type];
    if (!def) throw new Error(`unknown module type "${m.type}"`);
    if (!Number.isInteger(m.id) || seen.has(m.id)) throw new Error(`bad or duplicate module id ${m.id}`);
    seen.add(m.id);
    m.params = { ...defaultParams(def), ...(m.params ?? {}) };
    m.x = Number(m.x) || 0;
    m.y = Number(m.y) || 0;
    if (p.version === 1) {
      delete m.att;
      delete m.map;
    }
    if (m.bypass && m.type !== 'fm1' && m.type !== 'output') m.bypass = true;
    else delete m.bypass;
    if (m.paramsB && typeof m.paramsB === 'object' && m.type !== 'fm1') {
      const out: Record<string, number> = {};
      for (const pd of def.params) out[pd.name] = Number.isFinite(Number(m.paramsB[pd.name])) ? Number(m.paramsB[pd.name]) : m.params[pd.name];
      m.paramsB = out;
    } else delete m.paramsB;
    fixMatrix(m, def);
    fixInputRoutes(m, def);
  }
  if (p.version === 1) {
    // a cable into `<param>_cv` becomes a cable into p1 (first such parameter of the module) or p2 (second)
    const used = new Map<number, string[]>();
    for (const c of p.cables) {
      const mt = p.modules.find((m) => m.id === c.to?.module);
      const pm = /^(.*)_cv$/.exec(c.to?.port ?? '');
      if (!mt || !pm || !defs[mt.type].params.some((q) => q.name === pm[1])) continue;
      const list = used.get(mt.id) ?? [];
      if (!list.includes(pm[1])) list.push(pm[1]);
      if (list.length > 2) throw new Error(`${mt.type} uses more than two parameter inputs: this old patch cannot be converted`);
      used.set(mt.id, list);
      const pin = list.indexOf(pm[1]) === 0 ? 'p1' : 'p2';
      mt.map![pin] = [pm[1]];
      c.to.port = pin;
    }
  }
  (p as { version: number }).version = 2;
  for (const c of p.cables) {
    const mf = p.modules.find((m) => m.id === c.from?.module);
    if (mf?.type === 'filter' && c.from?.port === 'lp') c.from.port = 'lp12'; // the filter's 12 dB output used to be called lp
    const mt = p.modules.find((m) => m.id === c.to?.module);
    if (mt?.type === 'lfo' && c.to?.port === 'sync') c.to.port = 'reset'; // the LFO's restart input used to be called sync (its tempo-sync toggle is `sync` now)
    if (!mf || !mt) throw new Error('cable to a missing module');
    if (!defs[mf.type].outputs.some((o) => o.name === c.from.port)) throw new Error(`no output "${c.from.port}" on ${mf.type}`);
    if (!defs[mt.type].inputs.some((i) => i.name === c.to.port)) throw new Error(`no input "${c.to.port}" on ${mt.type}`);
  }
  p.name = String(p.name ?? 'patch');
  if (!hasMorph(p as Patch) || typeof p.morphName !== 'string') delete p.morphName;
  if (p.arp && typeof p.arp === 'object') p.arp = fixArp(p.arp);
  else delete p.arp;
  if (p.voices === undefined || p.voices === null) delete p.voices;
  else p.voices = voicesOf(p);
  return p as Patch;
}
