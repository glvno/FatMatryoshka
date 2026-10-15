// SPDX-License-Identifier: GPL-3.0-only
/** Owns only tutorial notes and timers. Every stop also cancels audio-unlock work still in flight. */
export class Audition {
  private notes = new Set<number>();
  private timers = new Set<ReturnType<typeof setTimeout>>();
  private generation = 0;
  constructor(private send: (on: boolean, note: number) => void, private unlock: () => Promise<void>) {}
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
  async play(mode: 'note' | 'chord' | 'riff'): Promise<void> {
    this.stop();
    const generation = this.generation;
    await this.unlock();
    if (generation !== this.generation) return;
    const on = (note: number): void => { this.notes.add(note); this.send(true, note); };
    if (mode !== 'riff') { for (const n of mode === 'note' ? [60] : [60, 64, 67]) on(n); return; }
    let step = 0;
    const tick = (): void => {
      const note = [60, 63, 67, 70, 67, 63, 65, 67][step++ % 8];
      on(note);
      this.later(() => { this.send(false, note); this.notes.delete(note); }, 240);
      this.later(tick, 420);
    };
    tick();
  }
}
