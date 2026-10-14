// SPDX-License-Identifier: GPL-3.0-only
import workletUrl from './worklet.ts?worker&url';
import type { Patch } from './patch';
import { ARP_DEFAULT } from './arp';
import type { HostMsg } from './worklet';
import type { ParameterValues } from './engine';

export class AudioHost {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private ready: Promise<void> | null = null;
  private early: HostMsg[] = [];
  private pending: Patch | null = null;
  private revision = 0;
  private valuesPending = false;
  private latestValues: ParameterValues | null = null;
  private frame = 0;
  onValues: (values: ParameterValues | null) => void = () => {};
  onError: (msg: string) => void = () => {};
  /** a scope probe's latest samples (oldest first) */
  onProbe: (key: string, data: Float32Array, sr: number) => void = () => {};

  get running(): boolean {
    return this.ctx?.state === 'running';
  }

  async start(): Promise<void> {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.ctx = ctx;
      this.ready = this.prepare(ctx);
    }
    // Resume immediately within the trusted gesture, even if the worklet is still loading.
    const resumed = this.ctx.resume();
    await this.ready;
    await resumed;
    this.watchValues();
  }

  private async prepare(ctx: AudioContext): Promise<void> {
    try {
      await ctx.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(ctx, 'modular-1', { numberOfInputs: 0, outputChannelCount: [2] });
      node.port.onmessage = (ev) => {
        if (ev.data?.error) {
          this.latestValues = null; this.onValues(null); this.onError(ev.data.error);
        } else if (ev.data?.probe) {
          if (ev.data.revision === this.revision) this.onProbe(ev.data.probe, ev.data.data, ev.data.sr);
        }
        else if (ev.data?.values) {
          this.valuesPending = false;
          if (ev.data.revision === this.revision) this.latestValues = ev.data.values;
        }
      };
      node.connect(ctx.destination);
      this.node = node;
      ctx.onstatechange = () => this.watchValues();
      if (this.pending) {
        this.send({ t: 'patch', patch: this.pending, revision: this.revision });
        this.send({ t: 'arp', cfg: this.pending.arp ?? ARP_DEFAULT });
      }
      for (const msg of this.early) this.send(msg);
      this.early = [];
    } catch (error) {
      void ctx.close(); this.ctx = null; this.ready = null; this.early = [];
      throw error;
    }
  }

  /** At most one request in flight; hidden tabs and suspended audio do no display work. */
  private watchValues(): void {
    cancelAnimationFrame(this.frame);
    if (!this.running) {
      this.latestValues = null;
      this.valuesPending = false;
      this.onValues(null);
      return;
    }
    this.frame = requestAnimationFrame(() => {
      if (!document.hidden) {
        if (this.latestValues) {
          this.onValues(this.latestValues);
          this.latestValues = null;
        }
        if (!this.valuesPending) {
          this.valuesPending = true;
          this.send({ t: 'values' });
        }
      }
      this.watchValues();
    });
  }

  /** Last patch is replayed when the context starts. */
  setPatch(patch: Patch): void {
    this.pending = patch;
    this.revision++;
    this.latestValues = null;
    this.onValues(null);
    this.send({ t: 'patch', patch, revision: this.revision });
    this.send({ t: 'arp', cfg: patch.arp ?? ARP_DEFAULT });
  }

  send(msg: HostMsg): void {
    if (this.node) this.node.port.postMessage(msg);
    else if (this.ctx && !['patch', 'arp'].includes(msg.t)) this.early.push(msg);
  }
}
