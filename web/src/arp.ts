// SPDX-License-Identifier: GPL-3.0-only
// The arpeggiator of the FM-1 (firmware/src/arp.c, from penta-midi) in TypeScript: the same settings, modes, Euclidean
// rhythm, random generator and timing, so the browser plays what the device plays and a patch carries the groove
// (Patch.arp). No imports: patch.ts uses fixArp for validation.

export const ARP_MODES = ['up', 'down', 'include', 'exclude', 'turing', 'walk', 'random'];
export const ARP_RATES = ['1/1', '1/2', '1/4', '1/4T', '1/8', '1/8T', '1/16', '1/16T', '1/32'];
/** 24 ppqn ticks per step */
export const ARP_RATE_TICKS = [96, 48, 24, 16, 12, 8, 6, 4, 3];
export const ARP_MAX_STEPS = 32;
const ARP_MAX_POOL = 39;
const ARP_VEL_DEFAULT = 100;
const ARP_GATE_PERCENT = 65;

/** semitones above the root; as in penta-midi the octave is part of most scales (the device's table, 67 entries) */
export const ARP_SCALES: { name: string; notes: number[] }[] = [
  { name: 'Chromatic', notes: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
  { name: 'Major', notes: [0, 2, 4, 5, 7, 9, 11, 12] },
  { name: 'Nat Minor', notes: [0, 2, 3, 5, 7, 8, 10, 12] },
  { name: 'Harm Minor', notes: [0, 2, 3, 5, 7, 8, 11, 12] },
  { name: 'Mel Minor', notes: [0, 2, 3, 5, 7, 9, 11, 12] },
  { name: 'Maj Pentatonic', notes: [0, 2, 4, 7, 9, 12] },
  { name: 'Min Pentatonic', notes: [0, 3, 5, 7, 10, 12] },
  { name: 'Blues', notes: [0, 3, 5, 6, 7, 10, 12] },
  { name: 'Dorian', notes: [0, 2, 3, 5, 7, 9, 10, 12] },
  { name: 'Phrygian', notes: [0, 1, 3, 5, 7, 8, 10, 12] },
  { name: 'Lydian', notes: [0, 2, 4, 6, 7, 9, 11, 12] },
  { name: 'Mixolydian', notes: [0, 2, 4, 5, 7, 9, 10, 12] },
  { name: 'Locrian', notes: [0, 1, 3, 5, 6, 8, 10, 12] },
  { name: 'Lydian Dom', notes: [0, 2, 4, 6, 7, 9, 10, 12] },
  { name: 'Altered Dom', notes: [0, 1, 3, 4, 6, 8, 10, 12] },
  { name: 'Major Bebop', notes: [0, 2, 4, 5, 7, 8, 9, 11, 12] },
  { name: 'Minor Bebop', notes: [0, 2, 3, 4, 5, 7, 9, 10, 12] },
  { name: 'Dominant Bebop', notes: [0, 2, 4, 5, 7, 9, 10, 11, 12] },
  { name: 'Phrygian Dom', notes: [0, 1, 4, 5, 7, 8, 10, 12] },
  { name: 'Whole Tone', notes: [0, 2, 4, 6, 8, 10, 12] },
  { name: 'Dim Whole-Half', notes: [0, 2, 3, 5, 6, 8, 9, 11, 12] },
  { name: 'Dim Half-Whole', notes: [0, 1, 3, 4, 6, 7, 9, 10, 12] },
  { name: 'Augmented', notes: [0, 3, 4, 7, 8, 11, 12] },
  { name: 'Dbl Harm Major', notes: [0, 1, 4, 5, 7, 8, 11, 12] },
  { name: 'Hungarian Min', notes: [0, 2, 3, 6, 7, 8, 11, 12] },
  { name: 'Pelog', notes: [0, 1, 3, 7, 8, 12] },
  { name: 'Maqam Nirikriz', notes: [0, 2, 3, 6, 7, 9, 10, 12] },
  { name: 'Maqam Saba', notes: [0, 1, 3, 4, 7, 8, 10, 12] },
  { name: 'Hirajoshi', notes: [0, 2, 3, 7, 8, 12] },
  { name: 'In Sen', notes: [0, 1, 5, 7, 10, 12] },
  { name: 'Iwato', notes: [0, 1, 5, 6, 10, 12] },
  { name: 'Yo Scale', notes: [0, 2, 5, 7, 9, 12] },
  { name: 'Ryukyu', notes: [0, 4, 5, 7, 11, 12] },
  { name: 'Chinese Shang', notes: [0, 2, 5, 7, 10, 12] },
  { name: 'Todi Thaat', notes: [0, 1, 3, 6, 7, 8, 11, 12] },
  { name: 'Purvi Thaat', notes: [0, 1, 4, 6, 7, 8, 11, 12] },
  { name: 'Marva Thaat', notes: [0, 1, 4, 6, 7, 9, 11, 12] },
  { name: 'Ambassel', notes: [0, 1, 5, 7, 8, 12] },
  { name: 'Harmonic Major', notes: [0, 2, 4, 5, 7, 8, 11, 12] },
  { name: 'Lydian Aug', notes: [0, 2, 4, 6, 8, 9, 11, 12] },
  { name: 'Major Triad', notes: [0, 4, 7] },
  { name: 'Minor Triad', notes: [0, 3, 7] },
  { name: 'Dim Triad', notes: [0, 3, 6] },
  { name: 'Aug Triad', notes: [0, 4, 8] },
  { name: 'Power Chord', notes: [0, 7, 12] },
  { name: 'Sus2', notes: [0, 2, 7] },
  { name: 'Sus4', notes: [0, 5, 7] },
  { name: 'Major 7th', notes: [0, 4, 7, 11] },
  { name: 'Dominant 7th', notes: [0, 4, 7, 10] },
  { name: 'Minor 7th', notes: [0, 3, 7, 10] },
  { name: 'MinMaj 7th', notes: [0, 3, 7, 11] },
  { name: 'Half-Dim 7th', notes: [0, 3, 6, 10] },
  { name: 'Dim 7th', notes: [0, 3, 6, 9] },
  { name: 'Aug 7th', notes: [0, 4, 8, 10] },
  { name: 'AugMaj 7th', notes: [0, 4, 8, 11] },
  { name: 'Major 6th', notes: [0, 4, 7, 9] },
  { name: 'Minor 6th', notes: [0, 3, 7, 9] },
  { name: 'Add9', notes: [0, 4, 7, 14] },
  { name: 'Minor Add9', notes: [0, 3, 7, 14] },
  { name: 'Major 9th', notes: [0, 4, 7, 11, 14] },
  { name: 'Dominant 9th', notes: [0, 4, 7, 10, 14] },
  { name: 'Minor 9th', notes: [0, 3, 7, 10, 14] },
  { name: 'Dominant 11th', notes: [0, 4, 7, 10, 14, 17] },
  { name: 'Dominant 13th', notes: [0, 4, 7, 10, 14, 17, 21] },
  { name: '7#9', notes: [0, 4, 7, 10, 15] },
  { name: '7b9', notes: [0, 4, 7, 10, 13] },
  { name: '7#11', notes: [0, 4, 7, 10, 14, 18] },
];

export interface ArpCfg {
  /** ARP_MODES index */
  mode: number;
  /** ARP_SCALES index */
  scale: number;
  /** MIDI note 0..100 (60 = C4) */
  root: number;
  /** 1..3 */
  octaves: number;
  /** % of steps whose note is replaced by a random one (the mode's own meaning for walk / turing) */
  chaos: number;
  /** % of notes with a random velocity */
  vchaos: number;
  /** % of steps whose gate is inverted */
  rchaos: number;
  /** Euclid: 1..32 steps, 0..steps pulses, rotation 0..steps-1 */
  steps: number;
  pulses: number;
  rot: number;
  /** ARP_RATES index */
  rate: number;
  /** 40..300 */
  bpm: number;
}

/** Maj Pentatonic, 16 steps all on, 1/16 at 120 bpm: the device's default set */
export const ARP_DEFAULT: ArpCfg = { mode: 0, scale: 5, root: 60, octaves: 1, chaos: 0, vchaos: 0, rchaos: 0, steps: 16, pulses: 16, rot: 0, rate: 6, bpm: 120 };
export const ARP_FIELDS = ['mode', 'scale', 'root', 'octaves', 'chaos', 'vchaos', 'rchaos', 'steps', 'pulses', 'rot', 'rate', 'bpm'] as const;

const clampInt = (v: unknown, lo: number, hi: number, def: number): number => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

/** a settings object from anything (a patch's `arp`, a device record): every field a whole number in range, dependent ones fixed as arp_fix does */
export function fixArp(raw: unknown): ArpCfg {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const c: ArpCfg = {
    mode: clampInt(r.mode, 0, ARP_MODES.length - 1, ARP_DEFAULT.mode),
    scale: clampInt(r.scale, 0, ARP_SCALES.length - 1, ARP_DEFAULT.scale),
    root: clampInt(r.root, 0, 100, ARP_DEFAULT.root),
    octaves: clampInt(r.octaves, 1, 3, ARP_DEFAULT.octaves),
    chaos: clampInt(r.chaos, 0, 100, 0),
    vchaos: clampInt(r.vchaos, 0, 100, 0),
    rchaos: clampInt(r.rchaos, 0, 100, 0),
    steps: clampInt(r.steps, 1, ARP_MAX_STEPS, ARP_DEFAULT.steps),
    pulses: clampInt(r.pulses, 0, ARP_MAX_STEPS, ARP_DEFAULT.pulses),
    rot: clampInt(r.rot, 0, ARP_MAX_STEPS - 1, 0),
    rate: clampInt(r.rate, 0, ARP_RATES.length - 1, ARP_DEFAULT.rate),
    bpm: clampInt(r.bpm, 40, 300, ARP_DEFAULT.bpm),
  };
  if (c.pulses > c.steps) c.pulses = c.steps;
  if (c.rot >= c.steps) c.rot = c.steps - 1;
  return c;
}

/** the 13 byte record of the device (arp_pack in main.c; the protocol's ARP command carries it) */
export const ARP_PACK = 13;
export function packArp(c: ArpCfg): number[] {
  return [c.mode, c.scale, c.root, c.octaves, c.chaos, c.vchaos, c.rchaos, c.steps, c.pulses, c.rot, c.rate, c.bpm & 0xff, c.bpm >> 8];
}
export function unpackArp(d: ArrayLike<number>): ArpCfg {
  return fixArp({ mode: d[0], scale: d[1], root: d[2], octaves: d[3], chaos: d[4], vchaos: d[5], rchaos: d[6], steps: d[7], pulses: d[8], rot: d[9], rate: d[10], bpm: d[11] | (d[12] << 8) });
}

export const sameArp = (a: ArpCfg, b: ArpCfg): boolean => ARP_FIELDS.every((f) => a[f] === b[f]);

/** a note name for the root: 60 = C4 */
export function noteName(n: number): string {
  const N = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  return `${N[n % 12]}${Math.floor(n / 12) - 1}`;
}

/** floor((i+1)p/n) - floor(ip/n) */
export const euclidGate = (steps: number, pulses: number, i: number): boolean => Math.floor(((i + 1) * pulses) / steps) - Math.floor((i * pulses) / steps) > 0;

/** what the arpeggiator plays: the engine */
export interface ArpTarget {
  noteOn(note: number, vel: number): void;
  noteOff(note: number): void;
  clockTick(): void;
}

/**
 * One arpeggiator. `cfg` and `play` are what the panel edits (the host); run() is called once per audio block before
 * the engine renders, applies changed settings at that boundary and is the only side that touches the engine, as on the
 * device. The timing is the device's: a 24 ppqn clock from a sample accumulator (acc += frames x bpm, a tick every
 * sr x 2.5 units), notes end at 65 % of the step.
 */
export class Arp {
  cfg: ArpCfg = { ...ARP_DEFAULT };
  play = false;
  /** the random seed mixed in at every start (the device uses its millisecond tick); fixed for tests */
  ticks = 12345;
  /** the step last played (ring position + 1), 0 when stopped: for a display */
  stepUi = 0;
  private c: ArpCfg = { ...ARP_DEFAULT };
  private dirty = true;
  private pool: number[] = [];
  private running = false;
  private ppq = 0;
  private noteOn = false;
  private note = 0;
  private acc = 0;
  private phase = 0;
  private offIn = 0;
  private idx = -1;
  private dir = 1;
  private pendingRepeat = false;
  private first = true;
  private turing = 0;
  private rng: number;
  private readonly tickNum: number;

  constructor(readonly sr: number, seed = 0x2545f491) {
    this.rng = seed >>> 0;
    this.tickNum = Math.round(sr * 2.5); // samples per tick x bpm: 44100 x 60 / 24 = 110250 at 44.1 kHz
  }

  /** new settings from the host, taken at the next block */
  set(cfg: ArpCfg): void {
    this.cfg = fixArp(cfg);
    this.dirty = true;
  }

  private rnd(n: number): number {
    let x = this.rng;
    x ^= x << 13;
    x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;
    x >>>= 0;
    this.rng = x;
    return x % n;
  }

  private cursorReset(): void {
    this.idx = -1;
    this.dir = 1;
    this.pendingRepeat = false;
    this.first = true;
  }

  private poolBuild(): void {
    const s = ARP_SCALES[this.c.scale];
    const pool: number[] = [];
    for (let oct = 0; oct < this.c.octaves; oct++) for (let i = 0; i < s.notes.length && pool.length < ARP_MAX_POOL; i++) pool.push(Math.min(127, this.c.root + s.notes[i] + oct * 12));
    this.pool = pool;
    if (this.idx > pool.length - 1) this.idx = pool.length - 1;
  }

  private off(t: ArpTarget): void {
    if (this.noteOn) {
      t.noteOff(this.note);
      this.noteOn = false;
    }
  }

  private apply(): void {
    const n = this.cfg;
    const poolChanged = n.scale !== this.c.scale || n.root !== this.c.root || n.octaves !== this.c.octaves;
    if (n.mode !== this.c.mode) this.cursorReset();
    if (n.rate !== this.c.rate) this.ppq = 0;
    this.c = { ...n };
    if (poolChanged || !this.pool.length) this.poolBuild();
  }

  private nextIndex(): number {
    const size = this.pool.length;
    const chaos = this.c.chaos;
    let next: number;
    switch (this.c.mode) {
      case 0:
        this.idx = this.idx < 0 ? 0 : (this.idx + 1) % size;
        break;
      case 1:
        this.idx = this.idx < 0 ? size - 1 : (this.idx - 1 + size) % size;
        break;
      case 2: // up and down, the end notes played twice
        if (this.first) {
          this.first = false;
          if (this.idx < 0) this.idx = 0;
        } else if (this.pendingRepeat) {
          this.pendingRepeat = false;
          this.dir = -this.dir;
        } else {
          this.idx += this.dir;
          this.idx = this.idx < 0 ? 0 : this.idx > size - 1 ? size - 1 : this.idx;
          if (this.idx === 0 || this.idx === size - 1) this.pendingRepeat = true;
        }
        break;
      case 3: // up and down, the end notes played once
        next = this.idx + this.dir;
        if (next >= size) {
          next = size - 2;
          this.dir = -1;
        } else if (next < 0) {
          next = 1;
          this.dir = 1;
        }
        this.idx = next;
        break;
      case 5: {
        // a random step of one note, sometimes two or three; bounces off the ends
        const dir = this.rnd(2) === 0 ? -1 : 1;
        const mag = this.rnd(100) < Math.floor(chaos / 2) ? 2 + this.rnd(2) : 1;
        next = this.idx < 0 ? 0 : this.idx + dir * mag;
        if (next < 0) next = -next;
        if (next >= size) next = 2 * (size - 1) - next;
        this.idx = next < 0 ? 0 : next > size - 1 ? size - 1 : next;
        return this.idx;
      }
      case 4: {
        // a 16 bit shift register, the top 5 bits pick the note; chaos mutates the fed back bit
        const wrap = (this.turing >> 15) & 1;
        let fb = wrap;
        if (this.rnd(100) < chaos) fb = this.rnd(2);
        this.turing = ((this.turing << 1) | fb) & 0xffff;
        const top = this.turing >> 11;
        this.idx = Math.floor((top * (size - 1)) / 31);
        return this.idx;
      }
      default:
        return this.rnd(size);
    }
    if (chaos && this.rnd(100) < chaos) return this.rnd(size); // chaos: this step's note only; the cursor keeps its course
    return this.idx;
  }

  private step(t: ArpTarget): void {
    const idx = this.nextIndex();
    const steps = this.c.steps;
    const note = this.pool[idx];
    let gate = euclidGate(steps, this.c.pulses, (this.phase + this.c.rot) % steps);
    if (this.c.rchaos && this.rnd(100) < this.c.rchaos) gate = !gate;
    this.stepUi = (this.phase % steps) + 1;
    this.phase++;
    if (!gate) return;
    this.off(t); // never two notes at once
    let v = ARP_VEL_DEFAULT;
    if (this.c.vchaos && this.rnd(100) < this.c.vchaos) v = 1 + this.rnd(127);
    t.noteOn(note, v / 127);
    this.note = note;
    this.noteOn = true;
    const stepFrames = Math.floor((ARP_RATE_TICKS[this.c.rate] * this.tickNum) / this.c.bpm);
    this.offIn = Math.floor((stepFrames * ARP_GATE_PERCENT) / 100);
  }

  /** one audio block of n frames: the transport, the note end, the clock (24 ppqn to the target) */
  run(n: number, t: ArpTarget): void {
    if (this.dirty) {
      this.dirty = false;
      this.apply();
    }
    if (!this.play) {
      if (this.running) {
        this.running = false;
        this.off(t);
        this.stepUi = 0;
      }
      return;
    }
    if (!this.running) {
      // start: the first step comes with the first block
      this.apply();
      this.running = true;
      this.ppq = ARP_RATE_TICKS[this.c.rate] - 1;
      this.acc = this.tickNum - 1;
      this.phase = 0;
      this.rng = (this.rng ^ this.ticks) >>> 0 || 0x2545f491;
      this.turing = ((this.rng >>> 7) | 1) & 0xffff;
      this.cursorReset();
      if (!this.pool.length) this.poolBuild();
    }
    if (this.noteOn) {
      this.offIn -= n;
      if (this.offIn <= 0) this.off(t);
    }
    this.acc += n * this.c.bpm;
    while (this.acc >= this.tickNum) {
      this.acc -= this.tickNum;
      t.clockTick();
      if (++this.ppq >= ARP_RATE_TICKS[this.c.rate]) {
        this.ppq = 0;
        this.step(t);
      }
    }
  }
}
