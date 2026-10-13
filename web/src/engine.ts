// SPDX-License-Identifier: GPL-3.0-only
// Block-based patch engine. Pure TypeScript with no DOM or Web Audio dependency, so it runs in
// an AudioWorklet, in tests, and (as the reference) next to the firmware port.
//
// Polyphony: a patch has `voices` (1..MAX_VOICES). voiceSplit() in patch.ts says which modules run once per voice; those
// have one instance (state, buffers, effective parameters) per voice. The others run once: a shared module reading a
// per-voice output gets the sum over the voices, a per-voice module reading a shared output gets that one buffer. The
// FM-1 panel is shared but its pitch / gate / vel outputs are per voice. With one voice this is exactly the mono engine.

import { IMPLS, type Ctx, type ModuleImpl, type Voice } from './modules';
import { defaultMap, modulate, morphValue, paramValue, processingOrder, SOURCES, VOICE_PORTS, voiceSplit, voicesOf, type Cable, type Patch, type Range, type Source, thruInput } from './patch';

export const BLOCK = 128;

/** one running copy of a module: shared modules have one, per-voice modules one per voice */
interface Inst {
  state: unknown;
  /** params after modulation, what the module reads */
  eff: Record<string, number>;
  inp: Record<string, Float32Array>;
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
  sources: { port: string; from: Node; fromPort: string }[];
  /** runs once per voice */
  poly: boolean;
  /** bypassed: run() copies `thru` (or silence) to the outputs instead of processing */
  bypass: boolean;
  thru: string | undefined;
  /** the B side of the morph (patch.ts paramsB), null without one */
  paramsB: Record<string, number> | null;
  /** macro ranges per pin (patch.ts ModuleInst.range) */
  range: [Record<string, Range>, Record<string, Range>];
  inst: Inst[];
  /** the FM-1 panel with several voices: its pitch / gate / vel, one buffer per voice */
  vout: Record<string, Float32Array[]> | null;
}

/** a voice: what the panel outputs plus what the allocator needs */
interface VoiceState extends Voice {
  note: number;
  /** a key holds it (gate up) */
  on: boolean;
  onStamp: number;
  offStamp: number;
  /** the voice was taken over while sounding: the next block's gate starts with one low sample so envelopes restart */
  retrig: boolean;
}

const newVoice = (): VoiceState => ({ pitch: 0, gate: 0, velocity: 0, spread: 0, clock: false, bend: 0, mod: 0, at: 0, note: -1, on: false, onStamp: 0, offStamp: 0, retrig: false });
/** the panel's spread output of voice i of n: -1 .. 1 in equal steps, 0 alone */
export const spreadOf = (i: number, n: number): number => (n > 1 ? (2 * i - (n - 1)) / (n - 1) : 0);

export class Engine {
  private nodes = new Map<number, Node>();
  private order: Node[] = [];
  private outputs: Node[] = [];
  private held: { note: number; vel: number }[] = [];
  private voices: VoiceState[] = [newVoice()];
  private stamp = 0;
  private ticks = 0;
  private clockOn = true;
  /** the performance controls (pitch bend -1..1, mod wheel 0..1, channel aftertouch 0..1): one set, every voice sees it */
  private ctl = { bend: 0, mod: 0, at: 0 };
  /** the Main module, and the morph position of the current block (its morph parameter plus the block mean of its morph input, one block late) */
  private main: Node | null = null;
  private morphT = 0;
  private hasB = false;

  constructor(readonly sampleRate: number) {}

  /** the number of voices of the loaded patch */
  get nvoices(): number {
    return this.voices.length;
  }

  /** the first voice (the voice, with a mono patch) */
  get voice(): Voice {
    return this.voices[0];
  }

  /** the notes the voices hold (for tests and displays): -1 = none, gate up or down */
  voiceNotes(): { note: number; on: boolean }[] {
    return this.voices.map((v) => ({ note: v.note, on: v.on }));
  }

  private newInst(impl: ModuleImpl): Inst {
    return {
      state: impl.init(this.sampleRate),
      eff: {},
      inp: Object.fromEntries(impl.def.inputs.map((p) => [p.name, new Float32Array(BLOCK)])),
      out: Object.fromEntries(impl.def.outputs.map((p) => [p.name, new Float32Array(BLOCK)])),
    };
  }

  /** Install a patch. Modules whose id, type and voice count are unchanged keep their running state. */
  load(patch: Patch): void {
    const nv = voicesOf(patch);
    const poly = voiceSplit(patch);
    if (nv !== this.voices.length) {
      this.voices = Array.from({ length: nv }, (_, i) => ({ ...newVoice(), spread: spreadOf(i, nv) }));
      this.held = [];
    }
    const next = new Map<number, Node>();
    for (const m of patch.modules) {
      const impl = IMPLS[m.type];
      if (!impl) throw new Error(`unknown module type "${m.type}"`);
      const isPoly = poly.has(m.id);
      const ninst = isPoly ? nv : 1;
      const panelVoices = m.type === 'fm1' && nv > 1 ? nv : 0;
      const old = this.nodes.get(m.id);
      const keep = old && old.type === m.type && old.inst.length === ninst && (old.vout ? old.vout.pitch.length : 0) === panelVoices;
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
            sources: [],
            poly: isPoly,
            bypass: false,
            thru: thruInput(impl.def),
            paramsB: null,
            range: [{}, {}],
            inst: Array.from({ length: ninst }, () => this.newInst(impl)),
            vout: panelVoices ? Object.fromEntries([...VOICE_PORTS].map((p) => [p, Array.from({ length: panelVoices }, () => new Float32Array(BLOCK))])) : null,
          };
      node.params = { ...m.params };
      node.att = m.att ? [m.att[0], m.att[1]] : [1, 1];
      node.map = Object.fromEntries(SOURCES.map((s) => [s, [...(m.map?.[s] ?? [])]])) as Record<Source, string[]>;
      node.bypass = !!m.bypass;
      node.paramsB = m.paramsB && m.type !== 'fm1' ? { ...m.paramsB } : null;
      node.range = [{ ...(m.range?.p1 ?? {}) }, { ...(m.range?.p2 ?? {}) }];
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

  /** the buffer an output wrote in the last block (voice 0 of a per-voice module; the Main's per-voice ports too), for a scope probe */
  probe(id: number, port: string): Float32Array | null {
    const n = this.nodes.get(id);
    if (!n) return null;
    if (n.vout && VOICE_PORTS.has(port)) return n.vout[port][0];
    return n.inst[0]?.out[port] ?? null;
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

  /** does this output differ per voice? */
  private portIsPoly(from: Node, port: string): boolean {
    return from.vout ? VOICE_PORTS.has(port) : from.poly;
  }

  /** the buffer of an output as voice `v` sees it */
  private bufOf(from: Node, port: string, v: number): Float32Array {
    if (from.vout && VOICE_PORTS.has(port)) return from.vout[port][v];
    return from.inst[from.poly ? v : 0].out[port];
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
        for (const k in inst.out) inst.out[k].fill(0, 0, n);
        return;
      }
    }
  }

  /** Block-rate parameter modulation: the mean of p1 and p2 over the block, times their attenuverters, added to the parameters the matrix assigns them to. */
  private applyCv(node: Node, inst: Inst, n: number): void {
    const pins: (number | null)[] = [null, null];
    if (node.impl.def.paramInputs)
      (['p1', 'p2'] as const).forEach((name, s) => {
        if (!node.connected[name]) return;
        let sum = 0;
        for (let i = 0; i < n; i++) sum += inst.inp[name][i];
        pins[s] = (sum / n) * node.att[s];
      });
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
      if (ranged) {
        const [lo, hi] = ranged as Range;
        base = paramValue(pd, lo + Math.min(1, Math.max(0, rv)) * (hi - lo));
      }
      inst.eff[pd.name] = touched ? modulate(pd, base, mod) : base;
    }
  }

  noteOn(note: number, velocity = 1): void {
    if (this.voices.length === 1) {
      this.held = this.held.filter((h) => h.note !== note);
      this.held.push({ note, vel: velocity });
      this.updateVoice();
      return;
    }
    const vs = this.voices;
    const stamp = ++this.stamp;
    // the key is already down on a voice: that voice again. Else the voice that has been free the longest. Else the oldest.
    let v = vs.findIndex((x) => x.on && x.note === note);
    if (v < 0) for (let i = 0; i < vs.length; i++) if (!vs[i].on && (v < 0 || vs[i].offStamp < vs[v].offStamp)) v = i;
    if (v < 0) {
      v = 0;
      for (let i = 1; i < vs.length; i++) if (vs[i].onStamp < vs[v].onStamp) v = i;
    }
    const x = vs[v];
    if (x.on) x.retrig = true;
    x.note = note;
    x.pitch = (note - 60) / 12;
    x.velocity = velocity;
    x.gate = 1;
    x.on = true;
    x.onStamp = stamp;
  }

  noteOff(note: number): void {
    if (this.voices.length === 1) {
      this.held = this.held.filter((h) => h.note !== note);
      this.updateVoice();
      return;
    }
    for (const x of this.voices)
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

  /** pitch bend, -1..1: +-2 semitones on the Main module's pitch output, and its bend output */
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
    this.held = [];
    for (const x of this.voices) {
      x.on = false;
      x.gate = 0;
      x.retrig = false;
    }
  }

  /** mono: last note priority, legato (the gate stays up while any key is down) */
  private updateVoice(): void {
    const top = this.held[this.held.length - 1];
    const x = this.voices[0];
    if (top) {
      x.pitch = (top.note - 60) / 12;
      x.velocity = top.vel;
      x.gate = 1;
      x.note = top.note;
      x.on = true;
    } else {
      x.gate = 0;
      x.on = false;
    }
  }

  /** the inputs of one instance: zero, then every cable added (a shared module adds all voices of a per-voice output) */
  private gather(node: Node, inst: Inst, v: number, n: number): void {
    for (const name in inst.inp) inst.inp[name].fill(0, 0, n);
    const nv = this.voices.length;
    for (const s of node.sources) {
      const dst = inst.inp[s.port];
      if (!node.poly && this.portIsPoly(s.from, s.fromPort)) {
        for (let k = 0; k < nv; k++) {
          const src = this.bufOf(s.from, s.fromPort, k);
          for (let i = 0; i < n; i++) dst[i] += src[i];
        }
      } else {
        const src = this.bufOf(s.from, s.fromPort, v);
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
    const ctx: Ctx = { sr: this.sampleRate, n, inp: inst.inp, out, connected: node.connected, p: inst.eff, voice };
    node.impl.process(ctx, inst.state);
    if (node.type === 'fm1' && voice.retrig) {
      out.gate[0] = 0; // one low sample: the envelopes of a stolen voice see a new gate
      voice.retrig = false;
    }
  }

  /** Render `left.length` frames (any length; processed in blocks of up to BLOCK). */
  render(left: Float32Array, right: Float32Array): void {
    const total = left.length;
    left.fill(0);
    right.fill(0);
    const vs = this.voices;
    for (let off = 0; off < total; off += BLOCK) {
      const n = Math.min(BLOCK, total - off);
      const clock = this.ticks > 0; // the Main module's clock output: one pulse per block that saw a tick, the same for every voice
      this.ticks = 0;
      this.morphT = this.hasB ? this.morphPosition(n) : 0;
      for (const x of vs) {
        x.clock = clock;
        x.bend = this.ctl.bend;
        x.mod = this.ctl.mod;
        x.at = this.ctl.at;
      }
      for (const node of this.order) {
        if (node.poly) {
          for (let v = 0; v < vs.length; v++) {
            const inst = node.inst[v];
            this.gather(node, inst, v, n);
            this.applyCv(node, inst, n);
            this.run(node, inst, vs[v], inst.out, n);
            this.guard(node, inst, n);
          }
        } else {
          const inst = node.inst[0];
          this.gather(node, inst, 0, n);
          this.applyCv(node, inst, n);
          if (node.vout) {
            // the panel with several voices: the knobs once, pitch / gate / vel for every voice
            for (let v = 0; v < vs.length; v++) {
              const out = { ...inst.out };
              for (const p of VOICE_PORTS) out[p] = node.vout[p][v];
              this.run(node, inst, vs[v], out, n);
            }
          } else {
            this.run(node, inst, vs[0], inst.out, n);
          }
          this.guard(node, inst, n);
        }
      }
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
