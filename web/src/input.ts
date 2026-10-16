// SPDX-License-Identifier: GPL-3.0-only
// Computer-keyboard and Web MIDI note input.
import type { AudioHost } from './audio';

/** the note keys, C up to D# a bit more than an octave above; key i plays `keyBase(octave) + i` */
export const KEYS = 'awsedftgyhujkolp';
export const OCTAVE_MIN = -3, OCTAVE_MAX = 3;
export const keyBase = (octave: number): number => 60 + octave * 12;
const NON_TYPING_INPUTS = new Set(['range', 'checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'color']);

/** Text editing owns letter keys; merely focusing a synth control does not. */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || target.tagName === 'TEXTAREA' ||
    (target.tagName === 'INPUT' && !NON_TYPING_INPUTS.has((target as HTMLInputElement).type));
}

export interface NoteKeys {
  octave(): number;
  /** move the note keys by `d` octaves (clamped); held notes keep sounding until their key is released */
  shift(d: number): void;
}

export function attachKeyboard(host: Pick<AudioHost, 'send'>, isActive: () => boolean, onOctave: (octave: number) => void = () => {}): NoteKeys {
  let octave = 0;
  const shift = (d: number): void => {
    const o = Math.max(OCTAVE_MIN, Math.min(OCTAVE_MAX, octave + d));
    if (o !== octave) (octave = o), onOctave(o);
  };
  const down = new Map<string, number>();
  window.addEventListener('keydown', (e) => {
    if (!isActive() || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTextEntry(e.target)) return;
    // An expanded native dropdown still owns its keyboard navigation/typeahead.
    if (e.target instanceof HTMLElement && e.target.tagName === 'SELECT' && e.target.matches(':open')) return;
    const k = e.key.toLowerCase();
    const i = KEYS.indexOf(k);
    if (i < 0 && k !== 'z' && k !== 'x') return;
    // Also consume repeats: otherwise holding F starts native select typeahead.
    e.preventDefault();
    if (e.repeat) return;
    if (k === 'z') shift(-1);
    else if (k === 'x') shift(1);
    if (i >= 0 && !down.has(k)) {
      const note = keyBase(octave) + i;
      down.set(k, note);
      host.send({ t: 'on', note, vel: 0.8 });
    }
  });
  window.addEventListener('keyup', (e) => {
    const k = e.key.toLowerCase();
    const note = down.get(k);
    if (note !== undefined) {
      down.delete(k);
      host.send({ t: 'off', note });
    }
  });
  window.addEventListener('blur', () => {
    for (const note of down.values()) host.send({ t: 'off', note });
    down.clear();
  });
  return { octave: () => octave, shift };
}

export async function attachMidi(host: Pick<AudioHost, 'send'>, status: (s: string) => void): Promise<void> {
  if (!navigator.requestMIDIAccess) return status('Web MIDI is not available in this browser');
  try {
    const access = await navigator.requestMIDIAccess();
    const hook = (): void => {
      for (const input of access.inputs.values()) {
        input.onmidimessage = (ev) => {
          const [s, a, b] = ev.data ?? [];
          if (s === 0xf8) return void host.send({ t: 'clock' });
          if (s === 0xfa || s === 0xfb || s === 0xfc) return void host.send({ t: 'clockrun', on: s !== 0xfc });
          const cmd = s & 0xf0;
          if (cmd === 0x90 && b > 0) host.send({ t: 'on', note: a, vel: b / 127 });
          else if (cmd === 0x80 || (cmd === 0x90 && b === 0)) host.send({ t: 'off', note: a });
          else if (cmd === 0xb0 && a === 123) host.send({ t: 'panic' });
          else if (cmd === 0xb0) host.send({ t: 'cc', n: a, v: b }); // CC 1 = mod wheel, 16..19 = the Main module's knobs
          else if (cmd === 0xe0) host.send({ t: 'bend', v: (((b << 7) | a) - 8192) / 8192 });
          else if (cmd === 0xd0) host.send({ t: 'at', v: a / 127 });
        };
      }
      status(`${access.inputs.size} MIDI input(s)`);
    };
    access.onstatechange = hook;
    hook();
  } catch (e) {
    status(`MIDI access denied: ${e}`);
  }
}
