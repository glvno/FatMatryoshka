// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseMidi, riffProblem } from './riff';
import { Audition } from './audition';
import { COURSE } from './chapters';
import { formatCourse, validateShape } from './course-schema';

const vlq = (n: number): number[] => { const out = [n & 0x7f]; while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80); return out; };
const u32 = (n: number) => [n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255];
/** a Standard MIDI File from tracks of [delta ticks, ...event bytes] */
function smf(division: number, ...tracks: number[][][]): Uint8Array {
  const out = [...'MThd'].map((c) => c.charCodeAt(0)).concat(u32(6), [0, tracks.length > 1 ? 1 : 0, 0, tracks.length, division >> 8, division & 255]);
  for (const t of tracks) {
    const body = t.flatMap(([delta, ...ev]) => [...vlq(delta), ...ev]);
    out.push(...[...'MTrk'].map((c) => c.charCodeAt(0)), ...u32(body.length), ...body);
  }
  return new Uint8Array(out);
}
const EOT = [0xff, 0x2f, 0x00];

describe('MIDI riffs', () => {
  it('reads notes in beats, the tempo, and rounds the loop up to a whole bar', () => {
    const r = parseMidi(smf(96,
      [[0, 0xff, 0x51, 3, 0x0b, 0x71, 0xb0], [0, 0x90, 62, 100], [48, 0x80, 62, 0], [0, 0x90, 65, 90], [144, 65, 0], [0, ...EOT]]), 'a.mid');
    expect(r.bpm).toBe(80);
    expect(r.notes).toEqual([[0, 0.5, 62, 100], [0.5, 1.5, 65, 90]]);
    expect(r.beats).toBe(4);
    expect(riffProblem(r)).toBe('');
  });
  it('keeps an end-of-track marker past the last note, merges format-1 tracks and honours the time signature', () => {
    const r = parseMidi(smf(480,
      [[0, 0xff, 0x58, 4, 3, 2, 24, 8], [0, ...EOT]],
      [[0, 0x91, 60, 80], [480, 0x91, 60, 0], [0, 0x90, 67, 70], [480, 0x80, 67, 0], [1920, ...EOT]]), 'b.mid');
    expect(r.bpm).toBe(120);
    expect(r.notes).toEqual([[0, 1, 60, 80], [1, 1, 67, 70]]);
    expect(r.beats).toBe(6);
  });
  it('refuses files it cannot use', () => {
    expect(() => parseMidi(new Uint8Array([1, 2, 3]), 'x')).toThrow('not a MIDI file');
    expect(() => parseMidi(smf(96, [[0, ...EOT]]), 'x')).toThrow('no notes');
    expect(riffProblem({ name: 'x', bpm: 120, beats: 4, notes: [[4, 1, 60, 100]] })).toMatch('outside');
  });
  it('a course with a riff keeps its shape and puts the riff on one line', () => {
    const course = structuredClone(COURSE);
    course.chapters[0].steps[0].riff = { name: 'a.mid', bpm: 90, beats: 4, notes: [[0, 1, 60, 100]] };
    validateShape(course);
    expect(formatCourse(course)).toContain('"riff": {"name":"a.mid","bpm":90,"beats":4,"notes":[[0,1,60,100]]}');
    course.chapters[0].steps[0].riff.bpm = 1;
    expect(() => validateShape(course)).toThrow('tempo');
  });
});

describe('riff playback', () => {
  afterEach(() => vi.useRealTimers());
  it('loops the notes at the file tempo with their velocity, and Stop ends them', async () => {
    vi.useFakeTimers(); const send = vi.fn(); const a = new Audition(send, async () => {});
    // 120 bpm: a beat is 500 ms; two beats loop
    await a.play('riff', { name: 'r', bpm: 120, beats: 2, notes: [[0, 0.5, 60, 127], [1, 1, 64, 64]] });
    await vi.advanceTimersByTimeAsync(1100);
    expect(send.mock.calls).toEqual([[true, 60, 1], [false, 60], [true, 64, 64 / 127], [false, 64], [true, 60, 1]]);
    a.stop(); const n = send.mock.calls.length;
    expect(send.mock.calls[n - 1]).toEqual([false, 60]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).toHaveBeenCalledTimes(n); expect(vi.getTimerCount()).toBe(0);
  });
});
