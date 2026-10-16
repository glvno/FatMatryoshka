// SPDX-License-Identifier: GPL-3.0-only
// The on-screen keyboard along the bottom of the patch view: 88 keys (A0..C8), played with the mouse or touch. The keys
// the computer keyboard plays at the current octave carry that key's letter; Z / X (also the two buttons at the left)
// move the letters by an octave. Keys light while their note is held, whatever played it (mouse, letters, MIDI).
import { KEYS, keyBase } from './input';

const LOW = 21, HIGH = 108; // A0, C8
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const BLACK = new Set([1, 3, 6, 8, 10]);
const VEL = 0.8; // as the letter keys

export const noteName = (n: number): string => `${NAMES[n % 12]}${Math.floor(n / 12) - 1}`;

export interface PianoHost {
  on(note: number, vel: number): void;
  off(note: number): void;
  /** move the computer keyboard's notes by d octaves */
  shift(d: number): void;
}

export class Piano {
  private keys = new Map<number, HTMLElement>();
  private strip: HTMLElement;
  private where: HTMLElement;
  /** the octave buttons and the A = note readout: the editor shows them in the dock, under Main's outputs */
  readonly octaveControls: HTMLElement;
  /** how many sources hold each note (the mouse and a letter key can hold the same one) */
  private held = new Map<number, number>();
  /** pointer id -> the note it holds */
  private pointers = new Map<number, number>();
  private octave = 0;

  constructor(root: HTMLElement, private host: PianoHost) {
    root.innerHTML = '';
    const ctl = document.createElement('div');
    ctl.className = 'piano-octave';
    const button = (d: number, letter: string, label: string): HTMLButtonElement => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = `${label} (${letter})`;
      b.setAttribute('aria-label', label);
      b.onclick = () => host.shift(d);
      return b;
    };
    this.where = document.createElement('output');
    this.where.title = 'The note key A plays';
    ctl.append(button(-1, 'Z', 'Octave down'), this.where, button(1, 'X', 'Octave up'));
    this.octaveControls = ctl;

    this.strip = document.createElement('div');
    this.strip.className = 'piano-keys';
    const bed = document.createElement('div');
    bed.className = 'piano-bed';
    let white = 0;
    for (let n = LOW; n <= HIGH; n++) {
      const k = document.createElement('div');
      const black = BLACK.has(n % 12);
      k.className = `key ${black ? 'black' : 'white'}`;
      k.dataset.note = String(n);
      // white keys sit in the flow of whole steps; a black key straddles the line between its two neighbours
      k.style.setProperty('--at', String(black ? white : white++));
      k.innerHTML = `<span class="letter"></span>${n % 12 === 0 ? `<span class="name">${noteName(n)}</span>` : ''}`;
      this.keys.set(n, k);
      bed.append(k);
    }
    bed.style.setProperty('--whites', String(white));
    this.strip.append(bed);
    root.append(ctl, this.strip);

    this.strip.addEventListener('pointerdown', (e) => this.down(e));
    this.strip.addEventListener('pointermove', (e) => this.move(e));
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) this.strip.addEventListener(t, (e) => this.up(e));
    window.addEventListener('blur', () => { for (const id of [...this.pointers.keys()]) this.release(id); });
    this.setOctave(0, false);
  }

  /** the computer keyboard's octave changed: move the letters and bring them into view */
  setOctave(octave: number, smooth = true): void {
    this.octave = octave;
    const base = keyBase(octave);
    for (const [n, k] of this.keys) {
      const i = n - base;
      k.querySelector('.letter')!.textContent = i >= 0 && i < KEYS.length ? KEYS[i].toUpperCase() : '';
      k.classList.toggle('mapped', i >= 0 && i < KEYS.length);
    }
    this.where.textContent = `A = ${noteName(base)}`;
    requestAnimationFrame(() => this.reveal(smooth));
  }

  /** follow a note message from any source, so the keys show what is held */
  track(msg: { t: string; note?: number }): void {
    if (msg.t === 'panic') {
      this.held.clear();
      for (const k of this.keys.values()) k.classList.remove('held');
      return;
    }
    if ((msg.t !== 'on' && msg.t !== 'off') || msg.note === undefined) return;
    const c = Math.max(0, (this.held.get(msg.note) ?? 0) + (msg.t === 'on' ? 1 : -1));
    if (c) this.held.set(msg.note, c);
    else this.held.delete(msg.note);
    this.keys.get(msg.note)?.classList.toggle('held', c > 0);
  }

  /** scroll the strip so the lettered keys are in the middle */
  private reveal(smooth: boolean): void {
    const lo = this.keys.get(Math.max(LOW, keyBase(this.octave)));
    const hi = this.keys.get(Math.min(HIGH, keyBase(this.octave) + KEYS.length - 1));
    if (!lo || !hi) return;
    const mid = (lo.offsetLeft + hi.offsetLeft + hi.offsetWidth) / 2;
    this.strip.scrollTo({ left: mid - this.strip.clientWidth / 2, behavior: smooth ? 'smooth' : 'auto' });
  }

  private keyAt(x: number, y: number): number | undefined {
    const el = document.elementFromPoint(x, y)?.closest<HTMLElement>('.key');
    return el && this.strip.contains(el) ? Number(el.dataset.note) : undefined;
  }

  private down(e: PointerEvent): void {
    if (e.button !== 0) return;
    const note = this.keyAt(e.clientX, e.clientY);
    if (note === undefined) return;
    e.preventDefault(); // no text selection while sliding
    this.pointers.set(e.pointerId, note);
    this.host.on(note, VEL);
    try {
      this.strip.setPointerCapture(e.pointerId); // a slide keeps playing past the strip's edge
    } catch {
      /* the pointer is already gone */
    }
  }

  /** sliding across the keys plays each one in turn */
  private move(e: PointerEvent): void {
    const was = this.pointers.get(e.pointerId);
    if (was === undefined) return;
    const note = this.keyAt(e.clientX, e.clientY);
    if (note === undefined || note === was) return;
    this.host.off(was);
    this.pointers.set(e.pointerId, note);
    this.host.on(note, VEL);
  }

  private up(e: PointerEvent): void {
    this.release(e.pointerId);
  }

  private release(id: number): void {
    const note = this.pointers.get(id);
    if (note === undefined) return;
    this.pointers.delete(id);
    this.host.off(note);
  }
}
