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
  | { t: 'patch'; patch: Patch }
  | { t: 'param'; id: number; name: string; value: number }
  | { t: 'att'; id: number; index: number; value: number }
  | { t: 'bypass'; id: number; on: boolean }
  | { t: 'range'; id: number; index: number; name: string; range: [number, number] | null }
  | { t: 'arp'; cfg: ArpCfg }
  | { t: 'arpplay'; on: boolean }
  | { t: 'on'; note: number; vel: number }
  | { t: 'off'; note: number }
  | { t: 'clock' }
  | { t: 'clockrun'; on: boolean }
  | { t: 'bend'; v: number }
  | { t: 'cc'; n: number; v: number }
  | { t: 'at'; v: number }
  | { t: 'panic' };

class ModularProcessor extends AudioWorkletProcessor {
  private engine = new Engine(sampleRate);
  /** the arpeggiator: runs before every block, plays the engine, drives its clock while it plays (then MIDI clock is ignored, as on the device) */
  private arp = new Arp(sampleRate, (Math.random() * 0xffffffff) >>> 0);
  private failed = false;
  constructor() {
    super();
    this.port.onmessage = (ev: MessageEvent<HostMsg>) => {
      const m = ev.data;
      try {
        if (m.t === 'patch') {
          this.engine.load(m.patch);
          this.failed = false;
        }
        else if (m.t === 'param') this.engine.setParam(m.id, m.name, m.value);
        else if (m.t === 'att') this.engine.setAtt(m.id, m.index, m.value);
        else if (m.t === 'bypass') this.engine.setBypass(m.id, m.on);
        else if (m.t === 'range') this.engine.setRange(m.id, m.index, m.name, m.range);
        else if (m.t === 'arp') this.arp.set(m.cfg);
        else if (m.t === 'arpplay') {
          this.arp.play = m.on;
          this.arp.ticks = (Date.now() & 0xffffffff) >>> 0;
          if (!m.on) this.engine.clockRun(true);
        }
        else if (m.t === 'on') this.engine.noteOn(m.note, m.vel);
        else if (m.t === 'off') this.engine.noteOff(m.note);
        else if (m.t === 'clock') {
          if (!this.arp.play) this.engine.clockTick();
        } else if (m.t === 'clockrun') {
          if (!this.arp.play) this.engine.clockRun(m.on);
        }
        else if (m.t === 'bend') this.engine.bend(m.v);
        else if (m.t === 'cc') this.engine.cc(m.n, m.v);
        else if (m.t === 'at') this.engine.aftertouch(m.v);
        else if (m.t === 'panic') this.engine.allNotesOff();
      } catch (e) {
        this.port.postMessage({ error: String(e) });
      }
    };
  }
  process(_in: Float32Array[][], outputs: Float32Array[][]): boolean {
    const out = outputs[0];
    try {
      this.arp.run(out[0].length, this.engine);
      this.engine.render(out[0], out[1] ?? out[0]);
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
