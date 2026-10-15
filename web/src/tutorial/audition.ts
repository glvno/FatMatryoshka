// SPDX-License-Identifier: GPL-3.0-only
import type { Riff } from './riff';

/** Owns only tutorial notes and timers. Every stop also cancels audio-unlock work still in flight. */
export class Audition {
  private notes = new Set<number>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private generation = 0;
  constructor(private send: (on: boolean, note: number, vel?: number) => void, private unlock: () => Promise<void>) {}
  stop(): void {
    this.generation++;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    for (const note of this.notes) this.send(false, note);
    this.notes.clear();
  }
  private later(fn: () => void, ms: number): void {
    const timer = setTimeout(() => { this.timers.delete(timer); fn(); }, ms);
    this.timers.add(timer);
  }
  /** `riff`: the step's own loop (from a MIDI file); without one the Riff button plays the built-in arpeggio */
  async play(mode: 'note' | 'chord' | 'riff', riff?: Riff): Promise<void> {
    this.stop();
    const generation = this.generation;
    await this.unlock();
    if (generation !== this.generation) return;
    const on = (note: number): void => { this.notes.add(note); this.send(true, note); };
    if (mode !== 'riff') { for (const n of mode === 'note' ? [60] : [60, 64, 67]) on(n); return; }
    if (riff) { this.loop(riff); return; }
    let step = 0;
    const tick = (): void => {
      const note = [60, 63, 67, 70, 67, 63, 65, 67][step++ % 8];
      on(note);
      this.later(() => { this.send(false, note); this.notes.delete(note); }, 240);
      this.later(tick, 420);
    };
    tick();
  }
  /** schedules one pass of the riff and the next pass at its end; a note retriggered before its off keeps sounding */
  private loop(riff: Riff): void {
    const ms = 60000 / riff.bpm;
    const held = new Map<number, number>();
    const pass = (): void => {
      for (const [t, d, note, vel] of riff.notes) {
        this.later(() => {
          held.set(note, (held.get(note) ?? 0) + 1);
          this.notes.add(note); this.send(true, note, vel / 127);
        }, t * ms);
        this.later(() => {
          const n = (held.get(note) ?? 1) - 1;
          held.set(note, n);
          if (n <= 0) { this.notes.delete(note); this.send(false, note); }
        }, (t + d) * ms);
      }
      this.later(pass, riff.beats * ms);
    };
    pass();
  }
}
