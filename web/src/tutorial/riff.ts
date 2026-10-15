// SPDX-License-Identifier: GPL-3.0-only
// A step's own riff for the Riff button: notes read from a Standard MIDI File by the lesson editor and stored in the
// course as data (start and length in beats, so the file's tempo is one number). The tutorial loops it.

/** [start beat, length in beats, MIDI note, velocity 1..127] */
export type RiffNote = [number, number, number, number];

export interface Riff {
  /** the file it came from, for the editor */
  name: string;
  bpm: number;
  /** the loop length in beats: whole bars, at least the last note's end */
  beats: number;
  notes: RiffNote[];
}

export const RIFF_MAX_NOTES = 1024;
export const RIFF_MAX_BEATS = 256;
const BPM_MIN = 20, BPM_MAX = 400;

/** the shape check the course loader uses; returns what is wrong, or '' */
export function riffProblem(v: unknown): string {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'expected a riff object';
  const r = v as Record<string, unknown>;
  if (typeof r.name !== 'string') return 'expected a name';
  if (typeof r.bpm !== 'number' || !(r.bpm >= BPM_MIN && r.bpm <= BPM_MAX)) return `expected a tempo of ${BPM_MIN}..${BPM_MAX} bpm`;
  if (typeof r.beats !== 'number' || !(r.beats > 0 && r.beats <= RIFF_MAX_BEATS)) return `expected a length of 1..${RIFF_MAX_BEATS} beats`;
  if (!Array.isArray(r.notes) || !r.notes.length || r.notes.length > RIFF_MAX_NOTES) return `expected 1..${RIFF_MAX_NOTES} notes`;
  for (const n of r.notes) {
    if (!Array.isArray(n) || n.length !== 4 || !n.every((x) => typeof x === 'number' && Number.isFinite(x))) return 'expected notes as [start, length, note, velocity]';
    const [t, d, note, vel] = n as number[];
    if (t < 0 || t >= r.beats || d <= 0 || note < 0 || note > 127 || vel < 1 || vel > 127) return 'a note is outside the loop or the MIDI range';
  }
  return '';
}

const round = (x: number) => Math.round(x * 1000) / 1000;

/**
 * Reads a Standard MIDI File (format 0 or 1, ticks per quarter note): every note of every track and channel, the first
 * tempo (else 120 bpm) and the first time signature (else 4/4), which sets the bar the loop is rounded up to. The loop
 * ends at the later of the last note-off and the end-of-track marker. Throws on what it cannot read.
 */
export function parseMidi(bytes: Uint8Array, name: string): Riff {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 14 || tag(0) !== 'MThd') throw new Error('not a MIDI file');
  const headLen = view.getUint32(4);
  const division = view.getUint16(12);
  if (division & 0x8000) throw new Error('SMPTE time code is not supported; export with ticks per quarter note');
  let tempo = 0, barBeats = 0, end = 0;
  const notes: { t: number; d: number; n: number; v: number }[] = [];
  let pos = 8 + headLen;
  while (pos + 8 <= bytes.length) {
    const len = view.getUint32(pos + 4);
    const stop = Math.min(bytes.length, pos + 8 + len);
    if (tag(pos) === 'MTrk') {
      let p = pos + 8, tick = 0, status = 0;
      const open = new Map<number, { t: number; v: number }[]>();
      const vlq = () => { let x = 0; for (let k = 0; k < 4 && p < stop; k++) { const b = bytes[p++]; x = (x << 7) | (b & 0x7f); if (!(b & 0x80)) break; } return x; };
      const off = (key: number) => {
        const started = open.get(key)?.shift();
        if (started) notes.push({ t: started.t, d: tick - started.t, n: key & 0x7f, v: started.v });
      };
      while (p < stop) {
        tick += vlq();
        let b = bytes[p];
        // running status: a data byte repeats the last channel message's status
        if (b & 0x80) { status = b; p++; } else if (!status) throw new Error('bad track data');
        b = status;
        if (b === 0xff) {
          status = 0;
          const type = bytes[p++]; const l = vlq(); const at = p; p += l;
          if (type === 0x51 && l === 3 && !tempo) tempo = 60e6 / ((bytes[at] << 16) | (bytes[at + 1] << 8) | bytes[at + 2]);
          if (type === 0x58 && l >= 2 && !barBeats) barBeats = bytes[at] * 4 / 2 ** bytes[at + 1];
          if (type === 0x2f) { end = Math.max(end, tick); break; }
        } else if (b === 0xf0 || b === 0xf7) { status = 0; p += vlq(); }
        else {
          const kind = b & 0xf0, ch = b & 0x0f;
          const d1 = bytes[p++]; const d2 = kind === 0xc0 || kind === 0xd0 ? 0 : bytes[p++];
          const key = (ch << 7) | d1;
          if (kind === 0x90 && d2 > 0) { off(key); (open.get(key) ?? open.set(key, []).get(key)!).push({ t: tick, v: d2 }); }
          else if (kind === 0x80 || kind === 0x90) off(key);
        }
      }
      // notes still held when the track ends stop there
      for (const [key, list] of open) while (list.length) off(key);
    }
    pos += 8 + len;
  }
  const out = notes.filter((x) => x.d > 0).sort((a, b) => a.t - b.t || a.n - b.n);
  if (!out.length) throw new Error('the file has no notes');
  if (out.length > RIFF_MAX_NOTES) throw new Error(`the file has ${out.length} notes; a riff may have ${RIFF_MAX_NOTES}`);
  const bar = barBeats > 0 ? barBeats : 4;
  const last = Math.max(end, ...out.map((x) => x.t + x.d)) / division;
  const beats = Math.max(bar, Math.ceil(last / bar - 1e-6) * bar);
  if (beats > RIFF_MAX_BEATS) throw new Error(`the loop is ${beats} beats long; a riff may have ${RIFF_MAX_BEATS}`);
  const bpm = round(Math.min(BPM_MAX, Math.max(BPM_MIN, tempo || 120)));
  return { name, bpm, beats, notes: out.map((x) => [round(x.t / division), round(x.d / division), x.n, x.v]) };
}
