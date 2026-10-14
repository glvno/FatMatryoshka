// SPDX-License-Identifier: GPL-3.0-only
// AudioWorklet wrapper around Engine.
import { Engine } from './engine';
import { Arp, type ArpCfg } from './arp';
import type { Patch } from './patch';

declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(name: string, ctor: new () => AudioWorkletProcessor): void;

export type HostMsg =
  | { t: 'patch'; patch: Patch; revision?: number }
  | { t: 'values' }
  | { t: 'param'; id: number; name: string; value: number }
  | { t: 'att'; id: number; index: number; value: number }
  | { t: 'bypass'; id: number; on: boolean }
  | { t: 'range'; id: number; index: number; name: string; range: [number, number] | null }
  | { t: 'arp'; cfg: ArpCfg }
  | { t: 'arpplay'; on: boolean }
  | { t: 'probe'; key: string; id: number; port: string }
  | { t: 'unprobe'; key: string }
  | { t: 'on'; note: number; vel: number }
  | { t: 'off'; note: number }
  | { t: 'clock' }
  | { t: 'clockrun'; on: boolean }
  | { t: 'bend'; v: number }
  | { t: 'cc'; n: number; v: number }
  | { t: 'at'; v: number }
  | { t: 'panic' };

/** samples a probe keeps (about 85 ms at 48 kHz: a few cycles of a bass note, a whole envelope attack) */
const PROBE_LEN = 4096;
/** blocks between two probe messages: 12 x 128 = 1536 samples, about 32 ms */
const PROBE_EVERY = 12;

class ModularProcessor extends AudioWorkletProcessor {
  private engine = new Engine(sampleRate);
  /** the arpeggiator: runs before every block, plays the engine, drives its clock while it plays (then MIDI clock is ignored, as on the device) */
  private arp = new Arp(sampleRate, (Math.random() * 0xffffffff) >>> 0);
  private failed = false;
  private revision = 0;
  private valuesRequested = false;
  /** scope probes: the last PROBE_LEN samples of an output, sent to the host about 30 times a second */
  private probes = new Map<string, { id: number; port: string; ring: Float32Array; w: number }>();
  private probeBlocks = 0;
  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<HostMsg>) => {
      const m = ev.data;
      try {
        if (m.t === 'patch') {
          this.arp.clear(this.engine);
          this.engine.load(m.patch);
          this.revision = m.revision ?? 0;
          this.failed = false;
        }
        else if (m.t === 'values') this.valuesRequested = true;
        else if (m.t === 'param') this.engine.setParam(m.id, m.name, m.value);
        else if (m.t === 'att') this.engine.setAtt(m.id, m.index, m.value);
        else if (m.t === 'bypass') this.engine.setBypass(m.id, m.on);
        else if (m.t === 'range') this.engine.setRange(m.id, m.index, m.name, m.range);
        else if (m.t === 'probe') this.probes.set(m.key, { id: m.id, port: m.port, ring: new Float32Array(PROBE_LEN), w: 0 });
        else if (m.t === 'unprobe') this.probes.delete(m.key);
        else if (m.t === 'arp') this.arp.set(m.cfg);
        else if (m.t === 'arpplay') {
          this.arp.play = m.on;
          this.arp.ticks = (Date.now() & 0xffffffff) >>> 0;
          if (!m.on) this.engine.clockRun(true);
        }
        else if (m.t === 'on') this.arp.keyOn(m.note, m.vel, this.engine);
        else if (m.t === 'off') this.arp.keyOff(m.note, this.engine);
        else if (m.t === 'clock') {
          if (!this.arp.active) this.engine.clockTick();
        } else if (m.t === 'clockrun') {
          if (!this.arp.active) this.engine.clockRun(m.on);
        }
        else if (m.t === 'bend') this.engine.bend(m.v);
        else if (m.t === 'cc') this.engine.cc(m.n, m.v);
        else if (m.t === 'at') this.engine.aftertouch(m.v);
        else if (m.t === 'panic') { this.arp.clear(this.engine); this.engine.allNotesOff(); }
      } catch (e) {
        this.port.postMessage({ error: String(e) });
      }
    };
  }
  private feedProbes(n: number): void {
    for (const p of this.probes.values()) {
      const src = this.engine.probe(p.id, p.port);
      if (!src) continue;
      for (let i = 0; i < n; i++) {
        p.ring[p.w] = src[i];
        if (++p.w === PROBE_LEN) p.w = 0;
      }
    }
    if (++this.probeBlocks < PROBE_EVERY) return;
    this.probeBlocks = 0;
    for (const [key, p] of this.probes) {
      const data = new Float32Array(PROBE_LEN); // oldest first
      data.set(p.ring.subarray(p.w));
      data.set(p.ring.subarray(0, p.w), PROBE_LEN - p.w);
      this.port.postMessage({ probe: key, data, sr: sampleRate }, [data.buffer]);
    }
  }

  process(_in: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    try {
      this.arp.run(out[0].length, this.engine);
      this.engine.render(out[0], out[1] ?? out[0]);
      if (this.probes.size) this.feedProbes(out[0].length);
      if (this.valuesRequested) {
        this.valuesRequested = false;
        this.port.postMessage({ values: this.engine.parameterValues(), revision: this.revision });
      }
    } catch (e) {
      if (!this.failed) this.port.postMessage({ error: `engine: ${e}` });
      this.failed = true; // stay silent instead of throwing in the audio thread on every block
      out[0].fill(0);
      out[1]?.fill(0);
    }
    return true;
  }
}
registerProcessor('modular-1', ModularProcessor as never);
