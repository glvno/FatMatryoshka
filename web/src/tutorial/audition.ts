// SPDX-License-Identifier: GPL-3.0-only
import { parseMidi, swing, type Riff } from './riff';
// a data: URL (base64) of the file, so the default is ready without a fetch
import defaultRiff from '../../dev/riffs/default_riff.mid?inline';

/** how long before the next note a legato note lets go, and how far past it a note still counts as legato */
const GAP_MS = 20, LEGATO_MS = 60;

/** the Riff button's own loop when a step has none: web/dev/riffs/default_riff.mid (written straight), bundled as bytes,
 * read once and played with triplet swing */
export const DEFAULT_RIFF: Riff = swing(parseMidi(Uint8Array.from(atob(defaultRiff.slice(defaultRiff.indexOf(',') + 1)), (c) => c.charCodeAt(0)), 'default_riff.mid'));

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
  /** `riff`: the step's own loop (from a MIDI file); without one the Riff button plays DEFAULT_RIFF */
  async play(mode: 'note' | 'chord' | 'riff', riff?: Riff): Promise<void> {
    this.stop();
    const generation = this.generation;
    await this.unlock();
    if (generation !== this.generation) return;
    const on = (note: number): void => { this.notes.add(note); this.send(true, note); };
    if (mode !== 'riff') { for (const n of mode === 'note' ? [60] : [60, 64, 67]) on(n); return; }
    this.loop(riff ?? DEFAULT_RIFF);
  }
  /** schedules one pass of the riff and the next pass at its end; a note retriggered before its off keeps sounding */
  private loop(riff: Riff): void {
    const ms = 60000 / riff.bpm;
    const held = new Map<number, number>();
    // A note that ends where the next one starts (or overlaps it a little) ends GAP_MS early instead: on a one-voice patch the
    // gate never falls between legato notes, so an envelope would not start again and a pluck would sound only once.
    const starts = [...new Set(riff.notes.flatMap(([t]) => [t, t + riff.beats]))].sort((a, b) => a - b);
    const offAt = (t: number, d: number): number => {
      const end = (t + d) * ms;
      const next = starts.find((s) => s > t && end > s * ms - GAP_MS && end <= s * ms + LEGATO_MS);
      return next === undefined ? end : Math.max(t * ms + 1, next * ms - GAP_MS);
    };
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
        }, offAt(t, d));
      }
      this.later(pass, riff.beats * ms);
    };
    pass();
  }
}
