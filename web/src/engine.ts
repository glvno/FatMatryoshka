// SPDX-License-Identifier: GPL-3.0-only
// Block-based patch engine. Pure TypeScript with no DOM or Web Audio dependency, so it runs in
// an AudioWorklet, in tests, and (as the reference) next to the firmware port.
//
// Polyphony: a poly assembly (poly.ts) runs its member modules once per part, each copy (instance) with its own state,
// buffers and effective parameters; its allocator hands the notes to the parts, and its Part module outputs each part's
// note. Everything else runs once and plays the shared keyboard (the Main module's pitch / gate / vel: one note, the last
// held). A module reading another group's per-part output gets the sum over those parts; a per-part module reading a
// shared output gets that one buffer.

import { IMPLS, instSeed, type Ctx, type ModuleImpl, type Voice } from './modules';
import { defaultMap, modulate, morphValue, paramValue, processingOrder, SOURCES, type Cable, type Patch, type PolyCfg, type Range, type Source, thruInput } from './patch';
import { polyGroups } from './poly';

export const BLOCK = 128;

/** A display snapshot, detached from the patch and the audio thread's mutable state. */
export type ParameterValues = { id: number; params: Record<string, number> }[];

/** one running copy of a module: one per part inside a poly assembly, else one */
interface Inst {
  /** instSeed of the module index and part: the Random module's seed, the same as the firmware's */
  seed: number;
  state: unknown;
  /** params after modulation, what the module reads */
  eff: Record<string, number>;
  /** Overrides captured by DSP for dedicated CV inputs, after the parameter matrix. */
  display: Record<string, number>;
  inp: Record<string, Float32Array>;
  /** Native DSP inputs: aliases of the raw buffers (kept apart from `inp` for the per-block parameter routes). */
  dspInp: Record<string, Float32Array>;
  out: Record<string, Float32Array>;
}

interface Node {
  id: number;
  type: string;
  impl: ModuleImpl;
  params: Record<string, number>;
  att: [number, number];
  map: Record<Source, string[]>;
  connected: Record<string, boolean>;
  inputRoutes: { port: string; params: string[]; mean: number }[];
  sources: { port: string; from: Node; fromPort: string }[];
  /** the poly group it runs in (index in Engine.groups), -1: runs once */
  group: number;
  /** bypassed: run() copies `thru` (or silence) to the outputs instead of processing */
  bypass: boolean;
  thru: string | undefined;
  /** the B side of the morph (patch.ts paramsB), null without one */
  paramsB: Record<string, number> | null;
  /** macro ranges per pin (patch.ts ModuleInst.range) */
  range: [Record<string, Range>, Record<string, Range>];
  inst: Inst[];
}

/** a part: what its Part module outputs plus what the allocator needs */
interface VoiceState extends Voice {
  note: number;
  /** a key holds it (gate up) */
  on: boolean;
  onStamp: number;
  offStamp: number;
  /** the part was taken over while sounding: this block's gate starts with one low sample so envelopes restart */
  retrig: boolean;
}

/** an allocator and its parts: a poly assembly's, or the shared keyboard (one part, legato auto, last note) */
interface Group {
  /** the poly assembly's id and part count: a reload keeps the group (its notes) while these stay */
  key: string;
  cfg: PolyCfg;
  parts: VoiceState[];
  /** the held keys, oldest first (one part: the sounding key is chosen among them) */
  held: { note: number; vel: number }[];
  /** rotate: the part the next note tries first */
  rot: number;
}

const newVoice = (index: number, parts: number): VoiceState => ({
  pitch: 0, gate: 0, velocity: 0, clock: false, bend: 0, mod: 0, at: 0, index, parts, legato: 0, jump: 0, unit: 0,
  note: -1, on: false, onStamp: 0, offStamp: 0, retrig: false,
});
const KEYBOARD: PolyCfg = { parts: 1, assign: 0, legato: 0, priority: 0, unit: 0 };
const newGroup = (key: string, cfg: PolyCfg): Group => ({
  key, cfg: { ...cfg }, parts: Array.from({ length: cfg.parts }, (_, i) => newVoice(i, cfg.parts)), held: [], rot: 0,
});

export class Engine {
  private nodes = new Map<number, Node>();
  private order: Node[] = [];
  private outputs: Node[] = [];
  /** the shared keyboard (the Main module, Part modules outside poly assemblies) */
  private kb: Group = newGroup('kb', KEYBOARD);
  /** the poly assemblies' allocators, in polyGroups order */
  private groups: Group[] = [];
  private stamp = 0;
  private ticks = 0;
  private clockOn = true;
  /** the performance controls (pitch bend -1..1, mod wheel 0..1, channel aftertouch 0..1): one set, every part sees it */
  private ctl = { bend: 0, mod: 0, at: 0 };
  /** the Main module, and the morph position of the current block (its morph parameter plus the block mean of its morph input, one block late) */
  private main: Node | null = null;
  private morphT = 0;
  private hasB = false;

  constructor(readonly sampleRate: number) {}

  /** the part count of the first poly assembly (1 without one), for tests and displays */
  get nvoices(): number {
    return this.groups[0]?.parts.length ?? 1;
  }

  /** the shared keyboard's note (what the Main module plays) */
  get voice(): Voice {
    return this.kb.parts[0];
  }

  /** the notes the first poly assembly's parts hold (the shared keyboard without one): -1 = none, gate up or down */
  voiceNotes(): { note: number; on: boolean }[] {
    return (this.groups[0] ?? this.kb).parts.map((v) => ({ note: v.note, on: v.on }));
  }

  private newInst(impl: ModuleImpl, seed: number): Inst {
    const state = impl.init(this.sampleRate);
    impl.seed?.(state, seed);
    return {
      seed,
      state,
      eff: {},
      display: {},
      dspInp: {},
      inp: Object.fromEntries(impl.def.inputs.map((p) => [p.name, new Float32Array(BLOCK)])),
      out: Object.fromEntries(impl.def.outputs.map((p) => [p.name, new Float32Array(BLOCK)])),
    };
  }

  /** Install a patch. Modules whose id, type and copy count are unchanged keep their running state; so do poly groups. */
  load(patch: Patch): void {
    const pg = polyGroups(patch);
    const oldGroups = new Map(this.groups.map((g) => [g.key, g]));
    this.groups = pg.map((x) => {
      const key = `${x.asm.id}:${x.cfg.parts}`;
      const g = oldGroups.get(key) ?? newGroup(key, x.cfg);
      g.cfg = { ...x.cfg };
      return g;
    });
    const groupOf = new Map<number, number>();
    pg.forEach((x, i) => x.modules.forEach((id) => groupOf.set(id, i)));
    const next = new Map<number, Node>();
    for (const [mi, m] of patch.modules.entries()) {
      const impl = IMPLS[m.type];
      if (!impl) throw new Error(`unknown module type "${m.type}"`);
      const group = groupOf.get(m.id) ?? -1;
      const ninst = group >= 0 ? this.groups[group].parts.length : 1;
      const old = this.nodes.get(m.id);
      const keep = old && old.type === m.type && old.inst.length === ninst;
      const node: Node = keep
        ? old!
        : {
            id: m.id,
            type: m.type,
            impl,
            params: {},
            att: [1, 1],
            map: defaultMap(impl.def),
            connected: {},
            inputRoutes: [],
            sources: [],
            group,
            bypass: false,
            thru: thruInput(impl.def),
            paramsB: null,
            range: [{}, {}],
            inst: Array.from({ length: ninst }, (_, v) => this.newInst(impl, instSeed(mi, v))),
          };
      node.group = group;
      node.params = { ...m.params };
      node.att = m.att ? [m.att[0], m.att[1]] : [1, 1];
      node.map = Object.fromEntries(SOURCES.map((s) => [s, [...(m.map?.[s] ?? [])]])) as Record<Source, string[]>;
      node.bypass = !!m.bypass;
      node.paramsB = m.paramsB && m.type !== 'fm1' ? { ...m.paramsB } : null;
      node.range = [{ ...(m.range?.p1 ?? {}) }, { ...(m.range?.p2 ?? {}) }];
      node.inputRoutes = Object.entries(m.inputMap ?? {}).map(([port, params]) => ({ port, params: [...params], mean: 0 }));
      for (const inst of node.inst) inst.dspInp = { ...inst.inp };
      node.sources = [];
      node.connected = {};
      next.set(m.id, node);
    }
    for (const c of patch.cables) {
      const to = next.get(c.to.module)!;
      const from = next.get(c.from.module)!;
      to.sources.push({ port: c.to.port, from, fromPort: c.from.port });
      to.connected[c.to.port] = true;
    }
    this.nodes = next;
    const { order } = processingOrder(patch);
    this.order = order.map((id) => next.get(id)!);
    this.outputs = this.order.filter((n) => n.type === 'output');
    this.main = this.order.find((n) => n.type === 'fm1') ?? null;
    this.hasB = this.order.some((n) => n.paramsB);
  }

  /** the morph position the current block uses (for tests) */
  get morph(): number {
    return this.morphT;
  }

  /** the buffer an output wrote in the last block (part 0 of a per-part module), for a scope probe */
  probe(id: number, port: string): Float32Array | null {
    return this.nodes.get(id)?.inst[0]?.out[port] ?? null;
  }

  /** the part of a group whose values a display shows: the newest held one, else the newest released */
  private shownPart(g: Group): number {
    let voice = 0;
    for (let i = 1; i < g.parts.length; i++) {
      const a = g.parts[i], b = g.parts[voice];
      if ((a.on && !b.on) || (a.on === b.on && a.onStamp > b.onStamp)) voice = i;
    }
    return voice;
  }

  /** Last rendered values. Per-part controls follow their poly assembly's newest held part, or its release. */
  parameterValues(): ParameterValues {
    const shown = this.groups.map((g) => this.shownPart(g));
    return this.order.map((node) => {
      const { eff, display } = node.inst[node.group >= 0 ? shown[node.group] : 0];
      const params = Object.fromEntries(node.impl.def.params.map((pd) => [
        pd.name, node.bypass ? node.params[pd.name] ?? pd.default : display[pd.name] ?? eff[pd.name] ?? node.params[pd.name] ?? pd.default,
      ]));
      if (node === this.main && this.hasB) params.morph = this.morphT;
      return { id: node.id, params };
    });
  }

  /** the morph position for the next block: the Main module's `morph` parameter plus the block mean of its morph input (what the input summed in the previous block) */
  private morphPosition(n: number): number {
    const m = this.main;
    if (!m) return 0;
    let t = m.params.morph ?? 0;
    if (m.connected.morph) {
      const b = m.inst[0].inp.morph;
      let s = 0;
      for (let i = 0; i < n; i++) s += b[i];
      t += s / n;
    }
    return Math.min(1, Math.max(0, t));
  }

  setParam(id: number, name: string, value: number): void {
    const n = this.nodes.get(id);
    if (n) n.params[name] = value;
  }

  setAtt(id: number, index: number, value: number): void {
    const n = this.nodes.get(id);
    if (n && (index === 0 || index === 1)) n.att[index] = value;
  }

  /** a macro range of pin `index` (0 p1, 1 p2) on a parameter, or none */
  setRange(id: number, index: number, name: string, range: Range | null): void {
    const n = this.nodes.get(id);
    if (!n || (index !== 0 && index !== 1)) return;
    if (range) n.range[index][name] = [range[0], range[1]];
    else delete n.range[index][name];
  }

  /** bypass a module (its state is kept: it resumes where it stopped) */
  setBypass(id: number, on: boolean): void {
    const n = this.nodes.get(id);
    if (n && n.type !== 'fm1' && n.type !== 'output') n.bypass = on;
  }

  /**
   * A module whose output went NaN or infinite (a filter blown up by resonance and a hot input, a feedback loop) would keep
   * poisoning everything after it, because its state never recovers: silence its outputs and restart its state.
   */
  private guard(node: Node, inst: Inst, n: number): void {
    for (const name in inst.out) {
      const o = inst.out[name];
      for (let i = 0; i < n; i++) {
        if (Number.isFinite(o[i]) && o[i] < 1e6 && o[i] > -1e6) continue;
        inst.state = node.impl.init(this.sampleRate);
        node.impl.seed?.(inst.state, inst.seed);
        for (const k in inst.out) inst.out[k].fill(0, 0, n);
        return;
      }
    }
  }

  /** Block-rate parameter modulation: side-input means add to their destinations; p1/p2 also apply their depth and macro ranges. */
  private applyCv(node: Node, inst: Inst, n: number): void {
    const pins: (number | null)[] = [null, null];
    if (node.impl.def.paramInputs)
      (['p1', 'p2'] as const).forEach((name, s) => {
        if (!node.connected[name]) return;
        let sum = 0;
        for (let i = 0; i < n; i++) sum += inst.inp[name][i];
        pins[s] = (sum / n) * node.att[s];
      });
    for (const route of node.inputRoutes) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += inst.inp[route.port][i];
      route.mean = sum / n;
    }
    for (const pd of node.impl.def.params) {
      const a = node.params[pd.name] ?? pd.default;
      let base = node.paramsB && this.morphT > 0 ? morphValue(pd, a, node.paramsB[pd.name] ?? a, this.morphT) : a;
      let mod = 0;
      let touched = false;
      // a pin with a macro range on this parameter sets it: its value 0..1 lands between the two ends (replacing the base);
      // the other pin still adds as usual
      let ranged: Range | null = null;
      let rv = 0;
      (['p1', 'p2'] as const).forEach((name, s) => {
        if (pins[s] === null || !node.map[name].includes(pd.name)) return;
        const r = node.range[s][pd.name];
        if (r) {
          ranged = r;
          rv += pins[s]!;
        } else {
          mod += pins[s]!;
          touched = true;
        }
      });
      for (const route of node.inputRoutes) if (route.params.includes(pd.name)) {
        mod += route.mean;
        touched = true;
      }
      if (ranged) {
        const [lo, hi] = ranged as Range;
        base = paramValue(pd, lo + Math.min(1, Math.max(0, rv)) * (hi - lo));
      }
      inst.eff[pd.name] = touched ? modulate(pd, base, mod) : base;
    }
  }

  noteOn(note: number, velocity = 1): void {
    for (const g of [this.kb, ...this.groups]) this.groupOn(g, note, velocity);
  }

  noteOff(note: number): void {
    for (const g of [this.kb, ...this.groups]) this.groupOff(g, note);
  }

  /**
   * A note for one group. One part: the key joins the held list and the sounding key is chosen among them (monoUpdate).
   * Several: the key already down on a part keeps it; else a free part by the assign mode (rotate: the next in turn;
   * lowest: the lowest-numbered; reuse: a free part whose last note was the key, else the one free the longest); with none free
   * one is taken over by priority (last: the oldest note; low / high: the highest / lowest note, only for a lower / higher
   * key; otherwise the key does not sound). A taken-over part restarts its envelopes unless legato is on.
   */
  private groupOn(g: Group, note: number, velocity: number): void {
    if (g.parts.length === 1) {
      g.held = g.held.filter((h) => h.note !== note);
      g.held.push({ note, vel: velocity });
      this.monoUpdate(g);
      return;
    }
    const vs = g.parts;
    const n = vs.length;
    const over = vs.some((x) => x.on && x.note !== note); // another key is down: this note overlaps it
    let v = vs.findIndex((x) => x.on && x.note === note);
    if (v < 0) {
      const free = vs.map((x, i) => (x.on ? -1 : i)).filter((i) => i >= 0);
      if (free.length) {
        const mode = g.cfg.assign;
        if (mode === 0) {
          for (let k = 0; k < n && v < 0; k++) if (!vs[(g.rot + k) % n].on) v = (g.rot + k) % n;
          g.rot = (v + 1) % n;
        } else if (mode === 1) v = free[0];
        else v = free.find((i) => vs[i].note === note) ?? free.reduce((a, i) => (vs[i].offStamp < vs[a].offStamp ? i : a), free[0]);
      } else {
        const pr = g.cfg.priority;
        v = 0;
        for (let i = 1; i < n; i++) {
          const better = pr === 1 ? vs[i].note > vs[v].note : pr === 2 ? vs[i].note < vs[v].note : vs[i].onStamp < vs[v].onStamp;
          if (better) v = i;
        }
        if ((pr === 1 && note > vs[v].note) || (pr === 2 && note < vs[v].note)) return;
      }
    }
    const x = vs[v];
    // a taken-over part restarts its envelopes unless legato is on
    if (x.on && g.cfg.legato !== 2) x.retrig = true;
    x.legato = over ? 1 : 0;
    x.jump = (note - 60) / 12 - x.pitch;
    x.note = note;
    x.pitch = (note - 60) / 12;
    x.velocity = velocity;
    x.gate = 1;
    x.on = true;
    x.onStamp = ++this.stamp;
  }

  private groupOff(g: Group, note: number): void {
    if (g.parts.length === 1) {
      g.held = g.held.filter((h) => h.note !== note);
      this.monoUpdate(g);
      return;
    }
    for (const x of g.parts)
      if (x.on && x.note === note) {
        x.on = false;
        x.gate = 0;
        x.offStamp = ++this.stamp;
      }
  }

  /** MIDI clock (0xF8): one tick; Stop (0xFC) mutes the clock until Start/Continue */
  clockTick(): void {
    if (this.clockOn) this.ticks++;
  }

  clockRun(on: boolean): void {
    this.clockOn = on;
  }

  /** pitch bend, -1..1: +-2 semitones on every pitch output, and the Main module's bend output */
  bend(v: number): void {
    this.ctl.bend = Math.max(-1, Math.min(1, v));
  }

  /** channel aftertouch, 0..1: the Main module's at output */
  aftertouch(v: number): void {
    this.ctl.at = Math.max(0, Math.min(1, v));
  }

  /** a control change: CC 1 (mod wheel) is the Main module's mod output, CC 16..19 turn its knobs k1..k4; others are ignored */
  cc(n: number, v: number): void {
    const x = Math.max(0, Math.min(1, v / 127));
    if (n === 1) this.ctl.mod = x;
    else if (n >= 16 && n <= 19) for (const node of this.nodes.values()) if (node.type === 'fm1') node.params[`k${n - 15}`] = x;
  }

  allNotesOff(): void {
    for (const g of [this.kb, ...this.groups]) {
      g.held = [];
      for (const x of g.parts) {
        x.on = false;
        x.gate = 0;
        x.retrig = false;
      }
    }
  }

  /**
   * One part: the gate stays up while any key is down; the sounding key is the last, lowest or highest held (priority). A
   * change of key while the gate is up is a legato transition: the legato output goes to 1 and, with legato off, the
   * envelopes restart (one low gate sample); auto and on keep them running.
   */
  private monoUpdate(g: Group): void {
    const { legato, priority } = g.cfg;
    let top = g.held[g.held.length - 1];
    if (priority) for (const h of g.held) if (priority === 1 ? h.note < top.note : h.note > top.note) top = h;
    const x = g.parts[0];
    if (top) {
      const p = (top.note - 60) / 12;
      if (!x.on || top.note !== x.note) {
        x.jump = p - x.pitch;
        x.legato = x.on ? 1 : 0;
        if (x.on && legato === 1) x.retrig = true;
        x.onStamp = ++this.stamp;
      }
      x.pitch = p;
      x.velocity = top.vel;
      x.gate = 1;
      x.note = top.note;
      x.on = true;
    } else {
      if (x.on) x.offStamp = ++this.stamp;
      x.gate = 0;
      x.on = false;
    }
  }

  /** the inputs of one instance: zero, then every cable added (another group's per-part output adds all its parts) */
  private gather(node: Node, inst: Inst, v: number, n: number): void {
    for (const name in inst.inp) inst.inp[name].fill(0, 0, n);
    for (const s of node.sources) {
      const dst = inst.inp[s.port];
      const g = s.from.group;
      if (g >= 0 && g !== node.group) {
        for (const k of s.from.inst) {
          const src = k.out[s.fromPort];
          for (let i = 0; i < n; i++) dst[i] += src[i];
        }
      } else {
        const src = s.from.inst[g >= 0 ? v : 0].out[s.fromPort];
        for (let i = 0; i < n; i++) dst[i] += src[i];
      }
    }
  }

  private run(node: Node, inst: Inst, voice: VoiceState, out: Record<string, Float32Array>, n: number): void {
    if (node.bypass) {
      const src = node.thru ? inst.inp[node.thru] : undefined;
      for (const name in out) if (src) out[name].set(src.subarray(0, n));
      else out[name].fill(0, 0, n);
      return;
    }
    const ctx: Ctx = { sr: this.sampleRate, n, inp: inst.dspInp, out, connected: node.connected, p: inst.eff, voice, display: inst.display };
    node.impl.process(ctx, inst.state);
    if ((node.type === 'fm1' || node.type === 'part') && voice.retrig) out.gate[0] = 0; // one low sample: a taken-over part's envelopes see a new gate
  }

  /** Render `left.length` frames (any length; processed in blocks of up to BLOCK). */
  render(left: Float32Array, right: Float32Array): void {
    const total = left.length;
    left.fill(0);
    right.fill(0);
    const all = [this.kb, ...this.groups];
    for (let off = 0; off < total; off += BLOCK) {
      const n = Math.min(BLOCK, total - off);
      const clock = this.ticks > 0; // the Main module's clock output: one pulse per block that saw a tick
      this.ticks = 0;
      this.morphT = this.hasB ? this.morphPosition(n) : 0;
      for (const g of all)
        for (const x of g.parts) {
          x.unit = g.cfg.unit;
          x.clock = clock;
          x.bend = this.ctl.bend;
          x.mod = this.ctl.mod;
          x.at = this.ctl.at;
        }
      const kb = this.kb.parts[0];
      for (const node of this.order) {
        const parts = node.group >= 0 ? this.groups[node.group].parts : null;
        for (let v = 0; v < node.inst.length; v++) {
          const inst = node.inst[v];
          this.gather(node, inst, v, n);
          this.applyCv(node, inst, n);
          this.run(node, inst, parts ? parts[v] : kb, inst.out, n);
          this.guard(node, inst, n);
        }
      }
      for (const g of all) for (const x of g.parts) x.retrig = false;
      for (const o of this.outputs) {
        const inst = o.inst[0];
        const lvl = inst.eff.level ?? 1;
        const l = inst.inp.l;
        const r = o.connected.r ? inst.inp.r : inst.inp.l;
        for (let i = 0; i < n; i++) {
          left[off + i] += l[i] * lvl;
          right[off + i] += r[i] * lvl;
        }
      }
    }
    for (let i = 0; i < total; i++) {
      left[i] = Number.isFinite(left[i]) ? Math.max(-1, Math.min(1, left[i])) : 0;
      right[i] = Number.isFinite(right[i]) ? Math.max(-1, Math.min(1, right[i])) : 0;
    }
  }
}

export type { Cable };
