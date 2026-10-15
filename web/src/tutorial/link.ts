// SPDX-License-Identifier: GPL-3.0-only
// The lesson editor and the synth, open in two tabs of the dev server, talk over a BroadcastChannel: the synth reports its
// patch and what happened in it (the events a step can wait for, counted since the editor last asked for a reset), the
// editor checks the selected step against that and can load a patch into the synth (Try this step, Record). Development
// only; nothing here is part of the published app's behaviour.
import type { Patch } from '../patch';
import type { AssemblyDef } from '../assembly';
import { noSeen, type Seen, type TutorialState } from './model';

export const LINK_CHANNEL = 'matryoshka.lesson-link';

/** what the synth reports */
export interface SynthState {
  patch: Patch;
  seen: Seen;
  probes: string[];
  selected: number[];
  arpPlay: boolean;
  audio: boolean;
  snapshots: { A: boolean; B: boolean };
  zoom: number;
  library: AssemblyDef[];
  /** the assembly saved since the last reset */
  lastSaved?: AssemblyDef;
}

export type ToSynth = { t: 'hello' } | { t: 'load'; patch: Patch } | { t: 'reset' };
export type FromSynth = { t: 'state'; state: SynthState };

/** the synth's state as a check sees it; `entry` is the patch the step began with */
export function linkedState(st: SynthState, entry: Patch): TutorialState {
  return {
    patch: st.patch, entry, zoom: st.zoom, probes: new Set(st.probes), arpPlay: st.arpPlay, audio: st.audio, selected: new Set(st.selected),
    library: st.library, lastSaved: st.lastSaved, snapshots: { A: st.snapshots.A ? '1' : null, B: st.snapshots.B ? '1' : null }, seen: st.seen,
  };
}

/** the synth's end: reports while an editor is listening, loads what it is sent */
export function synthLink(read: () => Omit<SynthState, 'seen' | 'lastSaved'>, load: (p: Patch) => void): { event(name: keyof Seen): void; saved(def: AssemblyDef): void } {
  const seen = noSeen();
  let lastSaved: AssemblyDef | undefined;
  if (typeof BroadcastChannel === 'undefined') return { event: () => {}, saved: () => {} };
  const ch = new BroadcastChannel(LINK_CHANNEL);
  let heard = 0;
  let last = '';
  const post = (force = false): void => {
    if (Date.now() - heard > 6000) return;
    const state: SynthState = { ...read(), seen: { ...seen }, lastSaved };
    const text = JSON.stringify(state);
    if (!force && text === last) return;
    last = text;
    ch.postMessage({ t: 'state', state } satisfies FromSynth);
  };
  const reset = (): void => { Object.assign(seen, noSeen()); lastSaved = undefined; };
  ch.onmessage = (ev: MessageEvent<ToSynth>) => {
    const m = ev.data;
    heard = Date.now();
    if (m.t === 'load') { load(structuredClone(m.patch)); reset(); }
    if (m.t === 'reset') reset();
    post(true);
  };
  window.setInterval(() => post(), 400);
  return {
    event: (name) => { seen[name]++; post(); },
    saved: (def) => { lastSaved = structuredClone(def); seen.saves++; post(); },
  };
}

/** the editor's end: hears the synth, sends it commands; `connected` is whether a synth answered recently */
export function editorLink(onState: (s: SynthState) => void): { send(m: ToSynth): void; connected(): boolean; close(): void } {
  if (typeof BroadcastChannel === 'undefined') return { send: () => {}, connected: () => false, close: () => {} };
  const ch = new BroadcastChannel(LINK_CHANNEL);
  let heard = 0;
  ch.onmessage = (ev: MessageEvent<FromSynth>) => { if (ev.data?.t === 'state') { heard = Date.now(); onState(ev.data.state); } };
  const send = (m: ToSynth): void => ch.postMessage(m);
  send({ t: 'hello' });
  const timer = window.setInterval(() => send({ t: 'hello' }), 2000);
  return { send, connected: () => Date.now() - heard < 5000, close: () => { clearInterval(timer); ch.close(); } };
}
