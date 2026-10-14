// SPDX-License-Identifier: GPL-3.0-only
// The eleven chapters of the tutorial (docs/TUTORIAL.md). Each step: one action, a strict structural check and the
// "do it for me" apply. Checks find modules by type and shape, never by id, since the user adds them in any order.
import { DEFS } from '../modules';
import { newPatch, removeModule, type Patch } from '../patch';
import { PRESETS } from '../presets';
import { addChild, allModules, exposePort, insertAssembly, makeAssembly, mergePorts, promote, toDef, type AssemblyDef } from '../assembly';
import { FACTORY } from '../assemblies';
import { connectParameter, setParameterInput } from '../parameter-routing';
import { asmLike, byId, cabled, feeder, findDef, has, member, mod, mods, place, runCourse, T, unwire, wire, type Actions, type Chapter, type CourseRun, type Step, type TutorialState } from './model';

const pct = (p: Patch, type: string, name: string, i = 0): number => mod(p, type, i)?.params[name] ?? NaN;
const WAVE = { sine: 0, triangle: 1, saw: 2, square: 3 };

// the course run headlessly, for the bundled copies of the assemblies the user saves (chapters 4, 5, 6, 7, 11)
let course: CourseRun | null = null;
export function courseRun(): CourseRun {
  return (course ??= runCourse(CHAPTERS, () => PRESETS['Subtractive saw']()));
}
/** the user's saved assembly, else the bundled copy; `which` says what was used */
export function tutorialDef(tag: string, name: string, library: AssemblyDef[]): { def: AssemblyDef; which: 'yours' | 'bundled' } {
  const mine = findDef(library, tag, name);
  if (mine) return { def: mine, which: 'yours' };
  const bundled = findDef(courseRun().library, tag, name);
  if (!bundled) throw new Error(`no bundled assembly "${name}"`);
  return { def: bundled, which: 'bundled' };
}
const insertDef = (a: Actions, tag: string, name: string): void => {
  const { def } = tutorialDef(tag, name, a.library());
  a.edit((p) => {
    const spot = place(p, 'const'); // borrow the free-spot search, then put the assembly there instead
    p.modules = p.modules.filter((m) => m.id !== spot.id);
    insertAssembly(p, DEFS, def, spot.x, spot.y);
  });
};

// ---- chapter 1

const ch1: Chapter = {
  id: 'hello-sound',
  title: 'Hello sound',
  patchName: 'Tutorial voice',
  intro: 'A patch is a few modules and the cables between them. Main is the keyboard (and, on the FM-1, its panel), Output is the speaker. Between them you put a sound source and whatever shapes it. This chapter makes the simplest possible synth: one oscillator.',
  start: () => PRESETS['Subtractive saw'](),
  keep: true,
  steps: [
    {
      id: 'audio', title: 'Enable audio', transient: true,
      text: 'Click Enable audio in the sidebar (browsers only start sound after a click). The button then reads Audio on.',
      check: (s) => s.audio, apply: (a) => a.startAudio(), target: () => T.ui('audio-btn'),
    },
    {
      id: 'new', title: 'Start a new patch', superseded: true,
      text: 'Click New patch in the sidebar (or press / and choose New patch). Every patch starts with two cards: Main and Output.',
      check: (s) => s.patch.modules.length === 2 && has(s.patch, 'fm1') && has(s.patch, 'output') && !s.patch.cables.length,
      apply: (a) => a.load(newPatch(DEFS, ch1.patchName)), target: () => T.ui('new-patch-btn'),
    },
    {
      id: 'osc', title: 'Add an Oscillator',
      text: 'Click + Add module (or press /) and pick Oscillator. A new card appears on the canvas; drag it by its header to move it.',
      why: 'The oscillator is the sound source: it repeats one waveform at the pitch it is told. Everything else in a synth shapes what comes out of it.',
      check: (s) => has(s.patch, 'osc'), apply: (a) => a.edit((p) => place(p, 'osc')), target: () => T.ui('add-btn'),
    },
    {
      id: 'pitch', title: 'Tell it the pitch',
      text: 'Drag from Main’s pitch jack to the Oscillator’s pitch jack (or click one jack, then the other). Teal cables carry control signals: slow values such as which note is held.',
      check: (s) => cabled(s.patch, mod(s.patch, 'fm1'), 'pitch', mod(s.patch, 'osc'), 'pitch'),
      apply: (a) => a.edit((p) => wire(p, mod(p, 'fm1'), 'pitch', mod(p, 'osc'), 'pitch')),
      target: (s) => [...T.port(mod(s.patch, 'fm1'), 'pitch', 'out'), ...T.port(mod(s.patch, 'osc'), 'pitch', 'in')],
    },
    {
      id: 'audio-out', title: 'Send the sound to the Output',
      text: 'Drag the Oscillator’s out jack to Output’s l jack. Coral cables carry audio. The Oscillator now sounds all the time.',
      check: (s) => cabled(s.patch, mod(s.patch, 'osc'), 'out', mod(s.patch, 'output'), 'l'),
      apply: (a) => a.edit((p) => wire(p, mod(p, 'osc'), 'out', mod(p, 'output'), 'l')),
      target: (s) => [...T.port(mod(s.patch, 'osc'), 'out', 'out'), ...T.port(mod(s.patch, 'output'), 'l', 'in')],
    },
    {
      id: 'note', title: 'Play a note', transient: true,
      text: 'Press A on your keyboard. The keys A W S E D F T G Y H U J K play notes, Z and X move the octave. The pitch changes while the tone keeps going.',
      check: (s) => s.seen.notes > 0, apply: (a) => a.note(), target: () => T.ui('tutorial-note'),
    },
    {
      id: 'scope', title: 'Look at the wave', transient: true,
      text: 'Click ◎ beside the Oscillator’s out jack. The scope window shows the signal; the Spectrum button shows its harmonics.',
      why: 'A sine has one harmonic, a saw has all of them, a square only the odd ones. What you see on the spectrum is what a filter will later take away.',
      check: (s) => [...s.probes].some((k) => k === `${mod(s.patch, 'osc')?.id}:out`),
      apply: (a) => { const o = mod(a.patch(), 'osc'); if (o) a.probe(o.id, 'out'); },
      target: (s) => T.port(mod(s.patch, 'osc'), 'out', 'out'),
    },
    {
      id: 'undo', title: 'Break it, then undo', transient: true,
      text: 'Click × on the Oscillator’s header: the card and its cables are gone. Press Ctrl+Z (Cmd+Z on a Mac), or Commands → Undo, and it is back.',
      check: (s) => s.seen.undos > 0 && has(s.patch, 'osc') && cabled(s.patch, mod(s.patch, 'osc'), 'out', mod(s.patch, 'output'), 'l'),
      apply: (a) => { a.edit((p) => { const o = mod(p, 'osc'); if (o) removeModule(p, o.id); }); a.undo(); },
      target: (s) => T.module(mod(s.patch, 'osc')?.id),
    },
    {
      id: 'wave', title: 'Change the wave',
      text: 'Hold a note and switch the Oscillator’s wave to saw, then square. Drag the level slider too: every slider is a parameter you can set or, later, modulate.',
      check: (s) => pct(s.patch, 'osc', 'wave') === WAVE.saw,
      apply: (a) => a.edit((p) => { mod(p, 'osc')!.params.wave = WAVE.saw; }),
      target: (s) => T.param(mod(s.patch, 'osc'), 'wave'),
    },
  ],
};

// ---- chapter 2

const ch2: Chapter = {
  id: 'shaping-a-note',
  title: 'Shaping a note',
  patchName: 'Tutorial voice',
  intro: 'A note has a shape: it starts, holds and dies away. Two modules draw it. The VCA is a volume control driven by a signal, and the envelope generator (ADSR: attack, decay, sustain, release) makes that signal each time the gate opens.',
  start: () => null,
  steps: [
    {
      id: 'vca', title: 'Add a VCA',
      text: 'Add a VCA (voltage controlled amplifier). It has an audio input, an audio output and a cv input that sets its gain.',
      check: (s) => has(s.patch, 'vca'), apply: (a) => a.edit((p) => place(p, 'vca')), target: () => T.ui('add-btn'),
    },
    {
      id: 'reroute', title: 'Put the VCA in the path',
      text: 'Cable Oscillator out → VCA in and VCA out → Output l. Click the old cable from the Oscillator to Output to remove it. Silence: the gain is driven by nothing yet.',
      check: (s) => cabled(s.patch, mod(s.patch, 'osc'), 'out', mod(s.patch, 'vca'), 'in') && cabled(s.patch, mod(s.patch, 'vca'), 'out', mod(s.patch, 'output'), 'l') && !cabled(s.patch, mod(s.patch, 'osc'), 'out', mod(s.patch, 'output'), 'l'),
      apply: (a) => a.edit((p) => { wire(p, mod(p, 'osc'), 'out', mod(p, 'vca'), 'in'); wire(p, mod(p, 'vca'), 'out', mod(p, 'output'), 'l'); unwire(p, mod(p, 'osc'), 'out', mod(p, 'output'), 'l'); }),
      target: (s) => [...T.port(mod(s.patch, 'vca'), 'in', 'in'), ...T.port(mod(s.patch, 'vca'), 'out', 'out'), ...T.port(mod(s.patch, 'output'), 'l', 'in')],
    },
    {
      id: 'gate', title: 'Open it with the gate', superseded: true,
      text: 'Drag Main’s gate to the VCA’s cv. Gold cables carry gates: on while a key is held, off otherwise. The grey route inside the card shows that cv is wired to gain by design.',
      why: 'The VCA multiplies its input by the cv: gate on means gain 1, gate off means silence. That grey route cannot be removed: a VCA whose cv did not set its gain would not be a VCA.',
      check: (s) => cabled(s.patch, mod(s.patch, 'fm1'), 'gate', mod(s.patch, 'vca'), 'cv'),
      apply: (a) => a.edit((p) => wire(p, mod(p, 'fm1'), 'gate', mod(p, 'vca'), 'cv')),
      target: (s) => [...T.port(mod(s.patch, 'fm1'), 'gate', 'out'), ...T.port(mod(s.patch, 'vca'), 'cv', 'in')],
    },
    {
      id: 'adsr', title: 'Add an ADSR',
      text: 'Add an ADSR. Its env output rises when the gate opens, falls to the sustain level, and dies away after the gate closes.',
      check: (s) => has(s.patch, 'adsr'), apply: (a) => a.edit((p) => place(p, 'adsr')), target: () => T.ui('add-btn'),
    },
    {
      id: 'env', title: 'Let the envelope drive the gain',
      text: 'Cable Main gate → ADSR gate and ADSR env → VCA cv, then click the cable from Main’s gate to the VCA to remove it. The note now has a shape.',
      check: (s) => cabled(s.patch, mod(s.patch, 'fm1'), 'gate', mod(s.patch, 'adsr'), 'gate') && cabled(s.patch, mod(s.patch, 'adsr'), 'env', mod(s.patch, 'vca'), 'cv') && !cabled(s.patch, mod(s.patch, 'fm1'), 'gate', mod(s.patch, 'vca'), 'cv'),
      apply: (a) => a.edit((p) => { wire(p, mod(p, 'fm1'), 'gate', mod(p, 'adsr'), 'gate'); wire(p, mod(p, 'adsr'), 'env', mod(p, 'vca'), 'cv'); unwire(p, mod(p, 'fm1'), 'gate', mod(p, 'vca'), 'cv'); }),
      target: (s) => [...T.port(mod(s.patch, 'adsr'), 'gate', 'in'), ...T.port(mod(s.patch, 'adsr'), 'env', 'out'), ...T.port(mod(s.patch, 'vca'), 'cv', 'in')],
    },
    {
      id: 'shape', title: 'Draw the shape',
      text: 'Drag the ADSR’s a (attack) to about 0.3 s and r (release) to about 1 s. Hold a note: it swells in and fades out after you let go.',
      why: 'Attack and release are times, sustain is a level. Plucked and struck sounds have a short attack and no sustain; pads have long attacks and releases.',
      check: (s) => pct(s.patch, 'adsr', 'a') >= 0.1 && pct(s.patch, 'adsr', 'r') >= 0.5,
      apply: (a) => a.edit((p) => { const e = mod(p, 'adsr')!; e.params.a = 0.3; e.params.r = 1; }),
      target: (s) => [...T.param(mod(s.patch, 'adsr'), 'a'), ...T.param(mod(s.patch, 'adsr'), 'r')],
    },
    {
      id: 'thumb', title: 'A slider thumb is a jack',
      text: 'Set the wave to square. Then Alt-drag the thumb of the Oscillator’s pw slider onto the ADSR’s env jack (or drag from env and drop it on the thumb). The envelope now also sweeps the pulse width.',
      why: 'Dropping a signal on a thumb routes it through one of the module’s parameter inputs, p1 or p2. The same envelope shapes two things at once: loudness and timbre.',
      check: (s) => { const o = mod(s.patch, 'osc'); const e = mod(s.patch, 'adsr'); return !!o && !!e && pct(s.patch, 'osc', 'wave') === WAVE.square && (['p1', 'p2'] as const).some((pin) => cabled(s.patch, e, 'env', o, pin) && !!o.map?.[pin].includes('pw')); },
      apply: (a) => a.edit((p) => { const o = mod(p, 'osc')!; const e = mod(p, 'adsr')!; o.params.wave = WAVE.square; connectParameter(p, DEFS, { module: e.id, port: 'env' }, o.id, 'pw'); }),
      target: (s) => [...T.param(mod(s.patch, 'osc'), 'pw'), ...T.port(mod(s.patch, 'adsr'), 'env', 'out')],
    },
    {
      id: 'redo', title: 'Undo and redo', transient: true,
      text: 'Press Ctrl+Z: the route is gone. Press Shift+Ctrl+Z (Commands → Redo) and it is back. Forty steps of history are kept.',
      check: (s) => s.seen.undos > 0 && s.seen.redos > 0 && (['p1', 'p2'] as const).some((pin) => cabled(s.patch, mod(s.patch, 'adsr'), 'env', mod(s.patch, 'osc'), pin)),
      apply: (a) => { a.undo(); a.redo(); },
    },
  ],
};

// ---- chapter 3

const ch3: Chapter = {
  id: 'subtractive-voice',
  title: 'Subtractive voice',
  patchName: 'Tutorial voice',
  intro: 'Subtractive synthesis starts with a bright wave and takes harmonics away with a filter. The cutoff says where the filter starts cutting, the resonance adds a peak there. Moving the cutoff with an envelope, an LFO or a knob is where most of the classic synth sounds come from.',
  start: () => null,
  steps: [
    {
      id: 'filter', title: 'Add a Filter',
      text: 'Add a Filter and put it between the Oscillator and the VCA: Oscillator out → Filter in, Filter lp24 → VCA in, and remove the cable from the Oscillator to the VCA.',
      why: 'VCO → VCF → VCA is the classic subtractive chain. lp24 is a 24 dB low pass: steep. lp12 is gentler, hp lets the highs through instead.',
      check: (s) => cabled(s.patch, mod(s.patch, 'osc'), 'out', mod(s.patch, 'filter'), 'in') && cabled(s.patch, mod(s.patch, 'filter'), 'lp24', mod(s.patch, 'vca'), 'in') && !cabled(s.patch, mod(s.patch, 'osc'), 'out', mod(s.patch, 'vca'), 'in'),
      apply: (a) => a.edit((p) => { if (!has(p, 'filter')) place(p, 'filter'); wire(p, mod(p, 'osc'), 'out', mod(p, 'filter'), 'in'); wire(p, mod(p, 'filter'), 'lp24', mod(p, 'vca'), 'in'); unwire(p, mod(p, 'osc'), 'out', mod(p, 'vca'), 'in'); }),
      target: (s) => has(s.patch, 'filter') ? [...T.port(mod(s.patch, 'filter'), 'in', 'in'), ...T.port(mod(s.patch, 'filter'), 'lp24', 'out')] : T.ui('add-btn'),
    },
    {
      id: 'cutoff', title: 'Sweep the cutoff',
      text: 'Hold a note and drag cutoff down from 16 kHz to about 400 Hz: the tone gets darker. Raise res to about 0.6: a whistle sits on the cutoff.',
      why: 'The cutoff slider is logarithmic, like pitch: every octave gets the same distance. Resonance feeds a little of the output back, which makes the filter ring at its cutoff.',
      check: (s) => pct(s.patch, 'filter', 'cutoff') <= 800 && pct(s.patch, 'filter', 'res') >= 0.5,
      apply: (a) => a.edit((p) => { const f = mod(p, 'filter')!; f.params.cutoff = 400; f.params.res = 0.6; }),
      target: (s) => [...T.param(mod(s.patch, 'filter'), 'cutoff'), ...T.param(mod(s.patch, 'filter'), 'res')],
    },
    {
      id: 'track', title: 'Track the keyboard',
      text: 'Tick track. The cutoff now follows the note, one octave per octave, so high notes stay as bright as low ones. Play up and down.',
      check: (s) => pct(s.patch, 'filter', 'track') >= 0.5,
      apply: (a) => a.edit((p) => { mod(p, 'filter')!.params.track = 1; }),
      target: (s) => T.param(mod(s.patch, 'filter'), 'track'),
    },
    {
      id: 'lfo', title: 'Add an LFO',
      text: 'Add an LFO (low frequency oscillator). It is an oscillator too slow to hear, made to move other things. Set its rate to about 0.5 Hz.',
      check: (s) => has(s.patch, 'lfo') && pct(s.patch, 'lfo', 'rate') <= 1,
      apply: (a) => a.edit((p) => { const l = mod(p, 'lfo') ?? place(p, 'lfo'); l.params.rate = 0.5; }),
      target: (s) => has(s.patch, 'lfo') ? T.param(mod(s.patch, 'lfo'), 'rate') : T.ui('add-btn'),
    },
    {
      id: 'cv', title: 'Wobble the cutoff',
      text: 'Drag the LFO’s out to the Filter’s cv jack. The grey route shows cv is built into cutoff; cvamt sets how far it reaches: set it to 2 oct. Hold a note.',
      why: 'The cv input is additive in octaves: a signal of 1 moves the cutoff up by cvamt octaves. Pins p1 and p2 work differently: they reach any parameter you tick in its ⋯ menu.',
      check: (s) => cabled(s.patch, mod(s.patch, 'lfo'), 'out', mod(s.patch, 'filter'), 'cv') && pct(s.patch, 'filter', 'cvamt') >= 1.5,
      apply: (a) => a.edit((p) => { wire(p, mod(p, 'lfo'), 'out', mod(p, 'filter'), 'cv'); mod(p, 'filter')!.params.cvamt = 2; }),
      target: (s) => [...T.port(mod(s.patch, 'lfo'), 'out', 'out'), ...T.port(mod(s.patch, 'filter'), 'cv', 'in'), ...T.param(mod(s.patch, 'filter'), 'cvamt')],
    },
    {
      id: 'knob', title: 'One knob, two parameters',
      text: 'Drag Main’s blue k1 jack to the Filter’s p1. Open the ⋯ menu of cutoff and tick P1; do the same for res. Main’s k1 slider stands for the first knob of the FM-1.',
      why: 'The matrix in the ⋯ menu decides which parameters a pin reaches. A blue tick appears on each slider the knob reaches: that is where the knob alone holds the parameter.',
      check: (s) => { const f = mod(s.patch, 'filter'); return cabled(s.patch, mod(s.patch, 'fm1'), 'k1', f, 'p1') && !!f?.map?.p1.includes('cutoff') && !!f.map.p1.includes('res'); },
      apply: (a) => a.edit((p) => { const f = mod(p, 'filter')!; wire(p, mod(p, 'fm1'), 'k1', f, 'p1'); setParameterInput(f, 'p1', 'cutoff', true); setParameterInput(f, 'p1', 'res', true); }),
      target: (s) => [...T.port(mod(s.patch, 'fm1'), 'k1', 'out'), ...T.port(mod(s.patch, 'filter'), 'p1', 'in'), ...T.param(mod(s.patch, 'filter'), 'cutoff')],
    },
    {
      id: 'att', title: 'Set the depth',
      text: 'In the ⋯ menu of cutoff, drag the p1 attenuverter to about 0.5: the knob now reaches half as far. A negative value turns the knob around.',
      check: (s) => Math.abs((mod(s.patch, 'filter')?.att?.[0] ?? 1) - 1) > 0.05,
      apply: (a) => a.edit((p) => { const f = mod(p, 'filter')!; f.att = [0.5, f.att?.[1] ?? 1]; }),
      target: (s) => T.param(mod(s.patch, 'filter'), 'cutoff'),
    },
    {
      id: 'live', title: 'Live value and base value', transient: true,
      text: 'Hold a note and watch the cutoff slider: the thumb follows the live, wobbling value and a tick marks the base. Now move Main’s k1 slider: the blue ticks move, and so does the sound.',
      check: (s) => Math.abs(pct(s.patch, 'fm1', 'k1') - (mod(s.entry, 'fm1')?.params.k1 ?? 0.5)) > 0.05,
      apply: (a) => a.edit((p) => { mod(p, 'fm1')!.params.k1 = 0.8; }),
      target: (s) => T.param(mod(s.patch, 'fm1'), 'k1'),
    },
  ],
};

// ---- chapter 4

const VOICE_TYPES = ['osc', 'filter', 'adsr', 'vca', 'lfo'];
const myVoice = (p: Patch) => asmLike(p, VOICE_TYPES);

const ch4: Chapter = {
  id: 'first-assembly',
  title: 'Your first assembly',
  patchName: 'Tutorial voice',
  intro: 'An assembly packs modules into one card that shows only the ports and knobs you choose. It can be saved to your library, reused in other patches, and put inside other assemblies. The five modules you built are about to become one instrument.',
  start: () => null,
  steps: [
    {
      id: 'select', title: 'Select the modules', transient: true,
      text: 'Shift-click the Oscillator, Filter, ADSR, VCA and LFO, or drag a box around them on the empty canvas. Selected cards get a highlight. Main and Output stay outside.',
      check: (s) => VOICE_TYPES.every((t) => mods(s.patch, t).some((m) => s.selected.has(m.id))),
      apply: (a) => a.select(VOICE_TYPES.map((t) => mod(a.patch(), t)!.id)),
      target: (s) => VOICE_TYPES.flatMap((t) => T.module(mod(s.patch, t)?.id)),
    },
    {
      id: 'group', title: 'Group them',
      text: 'Press G, or Commands → Make assembly, and name it My voice. The five cards fold into one that shows the ports which had cables from outside: pitch, gate and out.',
      why: 'Grouping changes nothing in the sound. Ports with outside cables are exposed automatically; the rest is hidden until you expose it.',
      check: (s) => !!myVoice(s.patch),
      apply: (a) => a.edit((p) => makeAssembly(p, VOICE_TYPES.map((t) => mod(p, t)!.id), 'My voice')),
    },
    {
      id: 'expand', title: 'Open it up', superseded: true,
      text: 'Click expand on the My voice card. A frame shows the modules inside; every port and slider has a ○ toggle.',
      check: (s) => !!myVoice(s.patch)?.open,
      apply: (a) => a.edit((p) => { myVoice(p)!.open = true; }),
      target: (s) => T.asm(myVoice(s.patch)?.id),
    },
    {
      id: 'promote', title: 'Put two knobs on the card',
      text: 'Click ○ next to the Filter’s cutoff and next to the ADSR’s r. They become sliders on the collapsed card. Click ○ beside the LFO’s out too: an extra output.',
      check: (s) => { const a = myVoice(s.patch); if (!a) return false; const f = member(s.patch, a, 'filter'); const e = member(s.patch, a, 'adsr'); const l = member(s.patch, a, 'lfo'); return !!f && !!e && !!l && a.params.some((r) => r.module === f.id && r.param === 'cutoff') && a.params.some((r) => r.module === e.id && r.param === 'r') && a.outputs.some((r) => r.module === l.id && r.port === 'out'); },
      apply: (a) => a.edit((p) => { const v = myVoice(p)!; promote(v, member(p, v, 'filter')!.id, 'cutoff'); promote(v, member(p, v, 'adsr')!.id, 'r'); exposePort(v, 'out', member(p, v, 'lfo')!.id, 'out'); }),
      target: (s) => { const a = myVoice(s.patch); return [...T.param(member(s.patch, a, 'filter'), 'cutoff'), ...T.param(member(s.patch, a, 'adsr'), 'r'), ...T.port(member(s.patch, a, 'lfo'), 'out', 'out')]; },
    },
    {
      id: 'resize', title: 'Resize the frame', transient: true,
      text: 'Drag the ◢ corner of the frame to give the cards room (the arrow keys work on it too). Cards can be moved inside the frame; dragging one out takes it out of the assembly.',
      check: (s) => { const a = myVoice(s.patch); const e = myVoice(s.entry); return !!a?.frameSize && JSON.stringify(a.frameSize) !== JSON.stringify(e?.frameSize); },
      apply: (a) => a.edit((p) => { myVoice(p)!.frameSize = { width: 1400, height: 640 }; }),
      target: (s) => T.asm(myVoice(s.patch)?.id),
    },
    {
      id: 'collapse', title: 'Close it',
      text: 'Click collapse in the frame’s header. One card: pitch, gate, out, the LFO’s out, cutoff and r. Play it.',
      check: (s) => !!myVoice(s.patch) && !myVoice(s.patch)!.open,
      apply: (a) => a.edit((p) => { myVoice(p)!.open = false; }),
      target: (s) => T.asm(myVoice(s.patch)?.id),
    },
    {
      id: 'save', title: 'Save it to your library', transient: true,
      text: 'Click save on the card and keep the name My voice. It is now in the Library tab and in + Add assembly, under Your library, ready for any patch.',
      check: (s) => !!findDef(s.library, 'my-voice', 'My voice'),
      apply: (a) => { const p = a.patch(); const v = myVoice(p)!; v.name = 'My voice'; a.saveAssembly(toDef(p, v), 'my-voice'); },
      target: (s) => T.asm(myVoice(s.patch)?.id),
    },
    {
      id: 'fit', title: 'Fit the patch to the screen', transient: true,
      text: 'Commands → Fit patch to screen scales the canvas so everything is in view. Ctrl+wheel (pinch on touch) zooms freely; Reset canvas scale goes back to 100 %.',
      check: (s) => s.seen.zooms > 0, apply: (a) => a.zoomToFit(), target: () => T.ui('palette-btn'),
    },
  ],
};

// ---- chapter 5

const SPACE_TYPES = ['delay', 'reverb', 'chorus'];
const mySpace = (p: Patch) => asmLike(p, SPACE_TYPES);
/** the module behind My voice's out: its VCA */
const voiceOut = (p: Patch) => member(p, myVoice(p), 'vca');

const ch5: Chapter = {
  id: 'effect-assembly',
  title: 'An effect assembly',
  patchName: 'Tutorial voice',
  intro: 'An effect is a module with audio in and audio out. Delay repeats, reverb smears the repeats into a room, chorus thickens with detuned copies. Each has a mix slider: dry signal against wet. Chained, they become one effect you can save and reuse.',
  start: () => null,
  steps: [
    {
      id: 'add', title: 'Add Delay, Reverb and Chorus',
      text: 'Add a Delay, a Reverb and a Chorus. Three cards, each with in on the left and out on the right (the Chorus has l and r: it is stereo).',
      check: (s) => SPACE_TYPES.every((t) => has(s.patch, t)),
      apply: (a) => a.edit((p) => { for (const t of SPACE_TYPES) if (!has(p, t)) place(p, t); }),
      target: () => T.ui('add-btn'),
    },
    {
      id: 'chain', title: 'Chain them',
      text: 'Cable My voice out → Delay in → Reverb in → Chorus in, then Chorus l → Output l and Chorus r → Output r. Remove the cable from My voice to Output.',
      check: (s) => { const p = s.patch; const v = voiceOut(p); const o = mod(p, 'output'); return cabled(p, v, 'out', mod(p, 'delay'), 'in') && cabled(p, mod(p, 'delay'), 'out', mod(p, 'reverb'), 'in') && cabled(p, mod(p, 'reverb'), 'out', mod(p, 'chorus'), 'in') && cabled(p, mod(p, 'chorus'), 'l', o, 'l') && cabled(p, mod(p, 'chorus'), 'r', o, 'r') && !cabled(p, v, 'out', o, 'l'); },
      apply: (a) => a.edit((p) => { const v = voiceOut(p); const o = mod(p, 'output'); wire(p, v, 'out', mod(p, 'delay'), 'in'); wire(p, mod(p, 'delay'), 'out', mod(p, 'reverb'), 'in'); wire(p, mod(p, 'reverb'), 'out', mod(p, 'chorus'), 'in'); wire(p, mod(p, 'chorus'), 'l', o, 'l'); wire(p, mod(p, 'chorus'), 'r', o, 'r'); unwire(p, v, 'out', o, 'l'); }),
      target: (s) => [...T.port(mod(s.patch, 'delay'), 'in', 'in'), ...T.port(mod(s.patch, 'reverb'), 'in', 'in'), ...T.port(mod(s.patch, 'chorus'), 'in', 'in'), ...T.port(mod(s.patch, 'output'), 'r', 'in')],
    },
    {
      id: 'tune', title: 'Tune the space',
      text: 'Set the Delay’s time to about 375 ms and fb (feedback) to 0.5, and the Reverb’s size to 0.7. Play a short note and listen to the tail.',
      why: 'Feedback sends the delayed signal back into the line: each repeat is quieter than the last. Above 0.9 the repeats barely fade.',
      check: (s) => pct(s.patch, 'delay', 'time') >= 300 && pct(s.patch, 'delay', 'fb') >= 0.4 && pct(s.patch, 'reverb', 'size') >= 0.6,
      apply: (a) => a.edit((p) => { const d = mod(p, 'delay')!; d.params.time = 375; d.params.fb = 0.5; mod(p, 'reverb')!.params.size = 0.7; }),
      target: (s) => [...T.param(mod(s.patch, 'delay'), 'time'), ...T.param(mod(s.patch, 'delay'), 'fb'), ...T.param(mod(s.patch, 'reverb'), 'size')],
    },
    {
      id: 'bypass', title: 'Hear it with and without', transient: true,
      text: 'Click the Reverb card to select it and press B (or click ⏻ in its header): the module is bypassed and passes its input straight through. Press B again to switch it back on.',
      check: (s) => s.seen.bypasses >= 2 && !mod(s.patch, 'reverb')?.bypass,
      apply: (a) => { const r = mod(a.patch(), 'reverb')!; a.bypass(r.id, true); a.bypass(r.id, false); },
      target: (s) => T.module(mod(s.patch, 'reverb')?.id),
    },
    {
      id: 'group', title: 'Group the three',
      text: 'Select the Delay, Reverb and Chorus and press G. Name the assembly My space. Its card shows in, l and r.',
      check: (s) => !!mySpace(s.patch),
      apply: (a) => a.edit((p) => makeAssembly(p, SPACE_TYPES.map((t) => mod(p, t)!.id), 'My space')),
      target: (s) => SPACE_TYPES.flatMap((t) => T.module(mod(s.patch, t)?.id)),
    },
    {
      id: 'promote', title: 'Choose its knobs',
      text: 'Expand My space, click ○ on the Delay’s time and mix and on the Reverb’s mix, then collapse it. An effect needs few knobs on the outside.',
      check: (s) => { const a = mySpace(s.patch); if (!a || a.open) return false; const d = member(s.patch, a, 'delay'); const r = member(s.patch, a, 'reverb'); return !!d && !!r && a.params.some((x) => x.module === d.id && x.param === 'time') && a.params.some((x) => x.module === d.id && x.param === 'mix') && a.params.some((x) => x.module === r.id && x.param === 'mix'); },
      apply: (a) => a.edit((p) => { const sp = mySpace(p)!; const d = member(p, sp, 'delay')!; promote(sp, d.id, 'time'); promote(sp, d.id, 'mix'); promote(sp, member(p, sp, 'reverb')!.id, 'mix'); sp.open = false; }),
      target: (s) => T.asm(mySpace(s.patch)?.id),
    },
    {
      id: 'save', title: 'Save My space', transient: true,
      text: 'Click save on the My space card. Your library now holds an instrument and an effect; the next chapters use both.',
      check: (s) => !!findDef(s.library, 'my-space', 'My space'),
      apply: (a) => { const p = a.patch(); const sp = mySpace(p)!; sp.name = 'My space'; a.saveAssembly(toDef(p, sp), 'my-space'); },
      target: (s) => T.asm(mySpace(s.patch)?.id),
    },
  ],
};

// ---- chapter 6

const FM_TYPES = ['osc', 'osc', 'env', 'vca'];
const fmKeys = (p: Patch) => asmLike(p, FM_TYPES);
/** the oscillator whose pm input is fed by the other one */
const carrier = (p: Patch) => mods(p, 'osc').find((o) => feeder(p, o, 'pm')?.type === 'osc');
const modulator = (p: Patch) => { const c = carrier(p); return c && feeder(p, c, 'pm'); };

const ch6: Chapter = {
  id: 'fm',
  title: 'Second instrument: FM',
  patchName: 'Tutorial FM',
  intro: 'In frequency modulation one oscillator, the modulator, wobbles the phase of another, the carrier, thousands of times a second. The wobble creates new harmonics: the ratio of the two pitches sets which ones, the depth sets how many. An envelope on the depth makes the classic bright-then-mellow electric piano.',
  start: () => newPatch(DEFS, 'Tutorial FM'),
  steps: [
    {
      id: 'osc', title: 'An oscillator, cabled to the pitch',
      text: 'Add an Oscillator and cable Main pitch → Oscillator pitch. Leave the wave on sine: FM wants pure tones.',
      check: (s) => has(s.patch, 'osc') && cabled(s.patch, mod(s.patch, 'fm1'), 'pitch', mod(s.patch, 'osc'), 'pitch'),
      apply: (a) => a.edit((p) => { const o = mod(p, 'osc') ?? place(p, 'osc'); wire(p, mod(p, 'fm1'), 'pitch', o, 'pitch'); }),
      target: (s) => has(s.patch, 'osc') ? [...T.port(mod(s.patch, 'fm1'), 'pitch', 'out'), ...T.port(mod(s.patch, 'osc'), 'pitch', 'in')] : T.ui('add-btn'),
    },
    {
      id: 'dup', title: 'Duplicate it',
      text: 'Click the Oscillator to select it and press Ctrl+D (Cmd+D), or Commands → Duplicate selection. The copy keeps its settings and its pitch cable.',
      check: (s) => has(s.patch, 'osc', 2) && mods(s.patch, 'osc').every((o) => cabled(s.patch, mod(s.patch, 'fm1'), 'pitch', o, 'pitch')),
      apply: (a) => a.edit((p) => { const o = place(p, 'osc'); wire(p, mod(p, 'fm1'), 'pitch', o, 'pitch'); }),
      target: (s) => T.module(mod(s.patch, 'osc')?.id),
    },
    {
      id: 'pm', title: 'Modulator into carrier',
      text: 'Cable the second Oscillator’s out into the first one’s pm input, and set the first one’s pm slider (the depth) to about 2. The first is now the carrier, the second the modulator.',
      why: 'pm is phase modulation, what the DX7 and this engine do; it sounds like FM. The depth slider is the modulation index: 0 is a sine, 8 is a wall of harmonics.',
      check: (s) => !!carrier(s.patch) && (carrier(s.patch)!.params.pm ?? 0) >= 1,
      apply: (a) => a.edit((p) => { const [c, m] = mods(p, 'osc'); wire(p, m, 'out', c, 'pm'); c.params.pm = 2; }),
      target: (s) => { const [c, m] = mods(s.patch, 'osc'); return [...T.port(m, 'out', 'out'), ...T.port(c, 'pm', 'in'), ...T.param(c, 'pm')]; },
    },
    {
      id: 'ratio', title: 'Set the ratio',
      text: 'Set the modulator’s coarse to +12: an octave above the carrier, a 2:1 ratio, hollow like a clarinet. Try +19 (3:1) and +7 for a bell-like clang.',
      why: 'Whole-number ratios give harmonic spectra; odd ratios like 1.41 give inharmonic, metallic ones. coarse is in semitones.',
      check: (s) => (modulator(s.patch)?.params.coarse ?? 0) !== 0,
      apply: (a) => a.edit((p) => { modulator(p)!.params.coarse = 12; }),
      target: (s) => T.param(modulator(s.patch), 'coarse'),
    },
    {
      id: 'env', title: 'Loudness from a level / rate envelope', superseded: true,
      text: 'Add a VCA and an Env L/R. Cable carrier out → VCA in, Main gate → Env gate, Env env → VCA cv, VCA out → Output l.',
      why: 'Env L/R is the DX7 envelope: four levels and the rate to reach each one. The last level, l4, is where the note ends after the key is released.',
      check: (s) => { const p = s.patch; const c = carrier(p); return cabled(p, c, 'out', mod(p, 'vca'), 'in') && cabled(p, mod(p, 'fm1'), 'gate', mod(p, 'env'), 'gate') && cabled(p, mod(p, 'env'), 'env', mod(p, 'vca'), 'cv') && cabled(p, mod(p, 'vca'), 'out', mod(p, 'output'), 'l'); },
      apply: (a) => a.edit((p) => { const v = mod(p, 'vca') ?? place(p, 'vca'); const e = mod(p, 'env') ?? place(p, 'env'); wire(p, carrier(p), 'out', v, 'in'); wire(p, mod(p, 'fm1'), 'gate', e, 'gate'); wire(p, e, 'env', v, 'cv'); wire(p, v, 'out', mod(p, 'output'), 'l'); }),
      target: (s) => has(s.patch, 'env') ? [...T.port(mod(s.patch, 'env'), 'env', 'out'), ...T.port(mod(s.patch, 'vca'), 'cv', 'in')] : T.ui('add-btn'),
    },
    {
      id: 'index', title: 'Brightness from the same envelope',
      text: 'Alt-drag the carrier’s pm thumb onto the Env’s env jack. Set the Env’s l2 to 0.3 and r2 to 0.4 s: the note starts bright and mellows while it decays.',
      check: (s) => { const c = carrier(s.patch); const e = mod(s.patch, 'env'); return !!c && !!e && (['p1', 'p2'] as const).some((pin) => cabled(s.patch, e, 'env', c, pin) && !!c.map?.[pin].includes('pm')) && (e.params.l2 ?? 1) <= 0.5; },
      apply: (a) => a.edit((p) => { const c = carrier(p)!; const e = mod(p, 'env')!; connectParameter(p, DEFS, { module: e.id, port: 'env' }, c.id, 'pm'); e.params.l2 = 0.3; e.params.r2 = 0.4; }),
      target: (s) => [...T.param(carrier(s.patch), 'pm'), ...T.port(mod(s.patch, 'env'), 'env', 'out'), ...T.param(mod(s.patch, 'env'), 'l2')],
    },
    {
      id: 'group', title: 'Group it as FM keys',
      text: 'Select both Oscillators, the Env and the VCA and press G. Name it FM keys. It exposes pitch (twice, one per oscillator), gate and out.',
      check: (s) => !!fmKeys(s.patch),
      apply: (a) => a.edit((p) => makeAssembly(p, [...mods(p, 'osc'), mod(p, 'env')!, mod(p, 'vca')!].map((m) => m.id), 'FM keys')),
      target: (s) => [...mods(s.patch, 'osc'), ...mods(s.patch, 'env'), ...mods(s.patch, 'vca')].flatMap((m) => T.module(m.id)),
    },
    {
      id: 'insert', title: 'Insert My space',
      text: 'Click + Add assembly and pick My space under Your library (the one you saved in chapter 5). It arrives as one card.',
      check: (s) => !!mySpace(s.patch),
      apply: (a) => insertDef(a, 'my-space', 'My space'),
      target: () => T.ui('add-assembly-btn'),
    },
    {
      id: 'wire', title: 'Put the effect behind the keys',
      text: 'Cable FM keys out → My space in, My space l → Output l and My space r → Output r. Remove the cable from FM keys to Output.',
      check: (s) => { const p = s.patch; const v = member(p, fmKeys(p), 'vca'); const sp = mySpace(p); const o = mod(p, 'output'); return cabled(p, v, 'out', member(p, sp, 'delay'), 'in') && cabled(p, member(p, sp, 'chorus'), 'l', o, 'l') && cabled(p, member(p, sp, 'chorus'), 'r', o, 'r') && !cabled(p, v, 'out', o, 'l'); },
      apply: (a) => a.edit((p) => { const v = member(p, fmKeys(p), 'vca'); const sp = mySpace(p); const o = mod(p, 'output'); wire(p, v, 'out', member(p, sp, 'delay'), 'in'); wire(p, member(p, sp, 'chorus'), 'l', o, 'l'); wire(p, member(p, sp, 'chorus'), 'r', o, 'r'); unwire(p, v, 'out', o, 'l'); }),
      target: (s) => { const sp = mySpace(s.patch); return [...T.port(member(s.patch, sp, 'delay'), 'in', 'in'), ...T.port(member(s.patch, sp, 'chorus'), 'l', 'out')]; },
    },
    {
      id: 'nest', title: 'Nest the effect inside the instrument',
      text: 'Expand FM keys and drag the My space card into its frame by its header: it becomes part of FM keys, which now exposes l and r itself. Collapse FM keys.',
      why: 'Assemblies nest three levels deep. An instrument that carries its own effect is one card wherever you use it.',
      check: (s) => { const k = fmKeys(s.patch); const sp = mySpace(s.patch); return !!k && !!sp && !!k.children?.includes(sp.id) && !k.open; },
      apply: (a) => a.edit((p) => { const k = fmKeys(p)!; const sp = mySpace(p)!; addChild(p, k, sp.id); k.open = false; }),
      target: (s) => [...T.asm(fmKeys(s.patch)?.id), ...T.asm(mySpace(s.patch)?.id)],
    },
    {
      id: 'save', title: 'Save FM keys', transient: true,
      text: 'Click save on the FM keys card. My space travels inside it.',
      check: (s) => !!findDef(s.library, 'fm-keys', 'FM keys'),
      apply: (a) => { const p = a.patch(); const k = fmKeys(p)!; k.name = 'FM keys'; a.saveAssembly(toDef(p, k), 'fm-keys'); },
      target: (s) => T.asm(fmKeys(s.patch)?.id),
    },
  ],
};

// ---- chapter 7

const PLUCK_TYPES = ['string', 'modal'];
const pluck = (p: Patch) => asmLike(p, PLUCK_TYPES);

const ch7: Chapter = {
  id: 'plucked-and-struck',
  title: 'Plucked and struck',
  patchName: 'Tutorial pluck',
  intro: 'Physical models start from how real instruments work: a burst of energy goes into something that resonates. String is a Karplus-Strong string, a short delay line fed back on itself. Modal is a set of tuned resonances like a bar or a bell. Comb is a resonator you can excite with anything, even noise.',
  start: () => newPatch(DEFS, 'Tutorial pluck'),
  steps: [
    {
      id: 'string', title: 'A string',
      text: 'Add a String. Cable Main pitch → String pitch, Main gate → String gate and String out → Output l. Each key plucks it.',
      check: (s) => { const p = s.patch; const st = mod(p, 'string'); return cabled(p, mod(p, 'fm1'), 'pitch', st, 'pitch') && cabled(p, mod(p, 'fm1'), 'gate', st, 'gate') && cabled(p, st, 'out', mod(p, 'output'), 'l'); },
      apply: (a) => a.edit((p) => { const st = mod(p, 'string') ?? place(p, 'string'); wire(p, mod(p, 'fm1'), 'pitch', st, 'pitch'); wire(p, mod(p, 'fm1'), 'gate', st, 'gate'); wire(p, st, 'out', mod(p, 'output'), 'l'); }),
      target: (s) => has(s.patch, 'string') ? [...T.port(mod(s.patch, 'string'), 'gate', 'in'), ...T.port(mod(s.patch, 'string'), 'out', 'out')] : T.ui('add-btn'),
    },
    {
      id: 'decay', title: 'Let it ring',
      text: 'Set the String’s decay to about 4 s and damp to 0.1: a long, bright note. Switch burst to pulse for a harder pick.',
      why: 'The string is a delay line as long as one period, with feedback. decay sets how much is fed back, damp how fast the highs are lost on each round trip.',
      check: (s) => pct(s.patch, 'string', 'decay') >= 3 && pct(s.patch, 'string', 'damp') <= 0.15,
      apply: (a) => a.edit((p) => { const st = mod(p, 'string')!; st.params.decay = 4; st.params.damp = 0.1; }),
      target: (s) => [...T.param(mod(s.patch, 'string'), 'decay'), ...T.param(mod(s.patch, 'string'), 'damp')],
    },
    {
      id: 'voices', title: 'Play chords',
      text: 'On the Main card set voices to 4. The String card shows ×4: it runs once per voice. Hold a chord.',
      why: 'Every module that hears pitch, gate or velocity runs once per voice; effects and the Output stay single and sum the voices.',
      check: (s) => (s.patch.voices ?? 1) >= 2,
      apply: (a) => a.edit((p) => { p.voices = 4; }),
      target: (s) => T.module(mod(s.patch, 'fm1')?.id),
    },
    {
      id: 'modal', title: 'Strike a body with it',
      text: 'Add a Modal. Cable String out → Modal in and Modal out → Output r. Set struct to 0.5 and decay to 2 s: the string now rings a bell-like body.',
      check: (s) => { const p = s.patch; const m = mod(p, 'modal'); return cabled(p, mod(p, 'string'), 'out', m, 'in') && cabled(p, m, 'out', mod(p, 'output'), 'r') && (m?.params.struct ?? 0) >= 0.3; },
      apply: (a) => a.edit((p) => { const m = mod(p, 'modal') ?? place(p, 'modal'); wire(p, mod(p, 'string'), 'out', m, 'in'); wire(p, m, 'out', mod(p, 'output'), 'r'); m.params.struct = 0.5; m.params.decay = 2; }),
      target: (s) => has(s.patch, 'modal') ? [...T.port(mod(s.patch, 'modal'), 'in', 'in'), ...T.param(mod(s.patch, 'modal'), 'struct')] : T.ui('add-btn'),
    },
    {
      id: 'comb', title: 'Blow noise through a comb', superseded: true,
      text: 'Add Noise, a Comb and a VCA. Cable Noise out → Comb in, Main pitch → Comb pitch, Comb out → VCA in, Main gate → VCA cv, VCA out → Output l.',
      why: 'A comb filter is a tuned delay line: noise through it rings at the note, like breath through a pipe. The VCA is a simple on / off here, straight from the gate.',
      check: (s) => { const p = s.patch; const c = mod(p, 'comb'); const v = mod(p, 'vca'); return cabled(p, mod(p, 'noise'), 'out', c, 'in') && cabled(p, mod(p, 'fm1'), 'pitch', c, 'pitch') && cabled(p, c, 'out', v, 'in') && cabled(p, mod(p, 'fm1'), 'gate', v, 'cv') && cabled(p, v, 'out', mod(p, 'output'), 'l'); },
      apply: (a) => a.edit((p) => { const n = mod(p, 'noise') ?? place(p, 'noise'); const c = mod(p, 'comb') ?? place(p, 'comb'); const v = mod(p, 'vca') ?? place(p, 'vca'); wire(p, n, 'out', c, 'in'); wire(p, mod(p, 'fm1'), 'pitch', c, 'pitch'); wire(p, c, 'out', v, 'in'); wire(p, mod(p, 'fm1'), 'gate', v, 'cv'); wire(p, v, 'out', mod(p, 'output'), 'l'); }),
      target: (s) => has(s.patch, 'comb') ? [...T.port(mod(s.patch, 'comb'), 'in', 'in'), ...T.port(mod(s.patch, 'comb'), 'pitch', 'in')] : T.ui('add-btn'),
    },
    {
      id: 'fb', title: 'Make it ring',
      text: 'Set the Comb’s fb to 0.95 and damp to 0.1: the noise turns into a breathy, whistling tone at the note.',
      check: (s) => pct(s.patch, 'comb', 'fb') >= 0.9,
      apply: (a) => a.edit((p) => { const c = mod(p, 'comb')!; c.params.fb = 0.95; c.params.damp = 0.1; }),
      target: (s) => T.param(mod(s.patch, 'comb'), 'fb'),
    },
    {
      id: 'glide', title: 'Slide between notes',
      text: 'Add a Glide. Cable Main pitch → Glide in and Glide out → Comb pitch, and remove the cable from Main’s pitch to the Comb. Set time to 0.3 s and play two notes.',
      why: 'Glide (portamento) slews a control signal: the pitch takes time to arrive. It works on any control cable, not only pitch.',
      check: (s) => { const p = s.patch; const g = mod(p, 'glide'); return cabled(p, mod(p, 'fm1'), 'pitch', g, 'in') && cabled(p, g, 'out', mod(p, 'comb'), 'pitch') && !cabled(p, mod(p, 'fm1'), 'pitch', mod(p, 'comb'), 'pitch'); },
      apply: (a) => a.edit((p) => { const g = mod(p, 'glide') ?? place(p, 'glide'); wire(p, mod(p, 'fm1'), 'pitch', g, 'in'); wire(p, g, 'out', mod(p, 'comb'), 'pitch'); unwire(p, mod(p, 'fm1'), 'pitch', mod(p, 'comb'), 'pitch'); g.params.time = 0.3; }),
      target: (s) => has(s.patch, 'glide') ? [...T.port(mod(s.patch, 'glide'), 'in', 'in'), ...T.port(mod(s.patch, 'glide'), 'out', 'out')] : T.ui('add-btn'),
    },
    {
      id: 'group', title: 'Group the pluck',
      text: 'Select the String and the Modal and press G. Name it Pluck. Expand it, click ○ on the String’s decay and the Modal’s struct, and collapse it again.',
      check: (s) => { const a = pluck(s.patch); if (!a || a.open) return false; const st = member(s.patch, a, 'string'); const m = member(s.patch, a, 'modal'); return !!st && !!m && a.params.some((x) => x.module === st.id && x.param === 'decay') && a.params.some((x) => x.module === m.id && x.param === 'struct'); },
      apply: (a) => a.edit((p) => { const pl = pluck(p) ?? makeAssembly(p, PLUCK_TYPES.map((t) => mod(p, t)!.id), 'Pluck'); promote(pl, member(p, pl, 'string')!.id, 'decay'); promote(pl, member(p, pl, 'modal')!.id, 'struct'); pl.open = false; }),
      target: (s) => pluck(s.patch) ? T.asm(pluck(s.patch)!.id) : PLUCK_TYPES.flatMap((t) => T.module(mod(s.patch, t)?.id)),
    },
    {
      id: 'save', title: 'Save Pluck', transient: true,
      text: 'Click save on the Pluck card. Chapter 10 plays it from a melody machine.',
      check: (s) => !!findDef(s.library, 'pluck', 'Pluck'),
      apply: (a) => { const p = a.patch(); const pl = pluck(p)!; pl.name = 'Pluck'; a.saveAssembly(toDef(p, pl), 'pluck'); },
      target: (s) => T.asm(pluck(s.patch)?.id),
    },
  ],
};

// ---- chapter 8

const ch8: Chapter = {
  id: 'wavetables-and-grains',
  title: 'Wavetables and grains',
  patchName: 'Tutorial pad',
  intro: 'A wavetable oscillator holds a row of waveforms and sweeps through them: the timbre moves without a filter. A granular module chops audio into grains a few milliseconds long and scatters them in time and pitch: a cloud out of a note. Both are texture tools, and this patch grows big enough to need the zoom.',
  start: () => newPatch(DEFS, 'Tutorial pad'),
  steps: [
    {
      id: 'wt', title: 'A wavetable oscillator',
      text: 'Add a Wavetable and cable Main pitch → Wavetable pitch. Set bank to formant and drag pos (the position in the table) while a note holds: the vowel moves.',
      check: (s) => cabled(s.patch, mod(s.patch, 'fm1'), 'pitch', mod(s.patch, 'wavetable'), 'pitch') && pct(s.patch, 'wavetable', 'bank') === 2,
      apply: (a) => a.edit((p) => { const w = mod(p, 'wavetable') ?? place(p, 'wavetable'); wire(p, mod(p, 'fm1'), 'pitch', w, 'pitch'); w.params.bank = 2; }),
      target: (s) => has(s.patch, 'wavetable') ? [...T.port(mod(s.patch, 'wavetable'), 'pitch', 'in'), ...T.param(mod(s.patch, 'wavetable'), 'bank')] : T.ui('add-btn'),
    },
    {
      id: 'lfo', title: 'Sweep the table',
      text: 'Add an LFO with rate 0.2 Hz. Alt-drag the Wavetable’s pos thumb onto the LFO’s out (or drop the LFO’s cable on the thumb). The position now sweeps on its own.',
      check: (s) => { const w = mod(s.patch, 'wavetable'); const l = mod(s.patch, 'lfo'); return !!w && !!l && (['p1', 'p2'] as const).some((pin) => cabled(s.patch, l, 'out', w, pin) && !!w.map?.[pin].includes('pos')) && (l.params.rate ?? 4) <= 0.5; },
      apply: (a) => a.edit((p) => { const l = mod(p, 'lfo') ?? place(p, 'lfo'); l.params.rate = 0.2; connectParameter(p, DEFS, { module: l.id, port: 'out' }, mod(p, 'wavetable')!.id, 'pos'); }),
      target: (s) => has(s.patch, 'lfo') ? [...T.param(mod(s.patch, 'wavetable'), 'pos'), ...T.port(mod(s.patch, 'lfo'), 'out', 'out')] : T.ui('add-btn'),
    },
    {
      id: 'env', title: 'A slow envelope',
      text: 'Add an ADSR and a VCA. Cable Main gate → ADSR gate, ADSR env → VCA cv, Wavetable out → VCA in. Set a to 1 s and r to 2 s: a pad.',
      check: (s) => { const p = s.patch; return cabled(p, mod(p, 'fm1'), 'gate', mod(p, 'adsr'), 'gate') && cabled(p, mod(p, 'adsr'), 'env', mod(p, 'vca'), 'cv') && cabled(p, mod(p, 'wavetable'), 'out', mod(p, 'vca'), 'in') && pct(p, 'adsr', 'a') >= 0.5 && pct(p, 'adsr', 'r') >= 1; },
      apply: (a) => a.edit((p) => { const e = mod(p, 'adsr') ?? place(p, 'adsr'); const v = mod(p, 'vca') ?? place(p, 'vca'); wire(p, mod(p, 'fm1'), 'gate', e, 'gate'); wire(p, e, 'env', v, 'cv'); wire(p, mod(p, 'wavetable'), 'out', v, 'in'); e.params.a = 1; e.params.r = 2; }),
      target: (s) => has(s.patch, 'vca') ? [...T.port(mod(s.patch, 'vca'), 'in', 'in'), ...T.param(mod(s.patch, 'adsr'), 'a')] : T.ui('add-btn'),
    },
    {
      id: 'grain', title: 'Into the cloud',
      text: 'Add a Granular. Cable VCA out → Granular in and Main gate → Granular trig. Set size to 0.15 s, density to 40, spray to 0.5 and pitch to +12.',
      why: 'The granular module records what comes in and plays tiny windows of it, spread over position, time and pitch. spray is how far the grains wander from the position.',
      check: (s) => { const p = s.patch; const g = mod(p, 'grain'); return cabled(p, mod(p, 'vca'), 'out', g, 'in') && cabled(p, mod(p, 'fm1'), 'gate', g, 'trig') && (g?.params.spray ?? 0) >= 0.3 && (g?.params.pitch ?? 0) !== 0; },
      apply: (a) => a.edit((p) => { const g = mod(p, 'grain') ?? place(p, 'grain'); wire(p, mod(p, 'vca'), 'out', g, 'in'); wire(p, mod(p, 'fm1'), 'gate', g, 'trig'); Object.assign(g.params, { size: 0.15, density: 40, spray: 0.5, pitch: 12 }); }),
      target: (s) => has(s.patch, 'grain') ? [...T.port(mod(s.patch, 'grain'), 'in', 'in'), ...T.param(mod(s.patch, 'grain'), 'spray')] : T.ui('add-btn'),
    },
    {
      id: 'pan', title: 'Place it in the stereo field', superseded: true,
      text: 'Add a Pan. Cable Granular out → Pan in, Pan l → Output l, Pan r → Output r. Then drop the LFO’s out on the pan slider’s thumb: pos is the Pan’s built-in input, so the cable goes there.',
      check: (s) => { const p = s.patch; const pn = mod(p, 'pan'); const o = mod(p, 'output'); return cabled(p, mod(p, 'grain'), 'out', pn, 'in') && cabled(p, pn, 'l', o, 'l') && cabled(p, pn, 'r', o, 'r') && cabled(p, mod(p, 'lfo'), 'out', pn, 'pos'); },
      apply: (a) => a.edit((p) => { const pn = mod(p, 'pan') ?? place(p, 'pan'); const o = mod(p, 'output'); wire(p, mod(p, 'grain'), 'out', pn, 'in'); wire(p, pn, 'l', o, 'l'); wire(p, pn, 'r', o, 'r'); wire(p, mod(p, 'lfo'), 'out', pn, 'pos'); }),
      target: (s) => has(s.patch, 'pan') ? [...T.port(mod(s.patch, 'pan'), 'in', 'in'), ...T.param(mod(s.patch, 'pan'), 'pan')] : T.ui('add-btn'),
    },
    {
      id: 'phaser', title: 'A phaser on the way out',
      text: 'Add a Phaser between the Granular and the Pan: Granular out → Phaser in, Phaser out → Pan in, and remove the cable from the Granular to the Pan.',
      check: (s) => { const p = s.patch; const ph = mod(p, 'phaser'); return cabled(p, mod(p, 'grain'), 'out', ph, 'in') && cabled(p, ph, 'out', mod(p, 'pan'), 'in') && !cabled(p, mod(p, 'grain'), 'out', mod(p, 'pan'), 'in'); },
      apply: (a) => a.edit((p) => { const ph = mod(p, 'phaser') ?? place(p, 'phaser'); wire(p, mod(p, 'grain'), 'out', ph, 'in'); wire(p, ph, 'out', mod(p, 'pan'), 'in'); unwire(p, mod(p, 'grain'), 'out', mod(p, 'pan'), 'in'); }),
      target: (s) => has(s.patch, 'phaser') ? [...T.port(mod(s.patch, 'phaser'), 'in', 'in'), ...T.port(mod(s.patch, 'phaser'), 'out', 'out')] : T.ui('add-btn'),
    },
    {
      id: 'zoom', title: 'Zoom out', transient: true,
      text: 'Nine cards no longer fit. Hold Ctrl (Cmd) and scroll to zoom, pinch on a touch screen, or use Commands → Fit patch to screen.',
      check: (s) => s.seen.zooms > 0, apply: (a) => a.zoomToFit(), target: () => T.ui('palette-btn'),
    },
    {
      id: 'spectrum', title: 'Watch the cloud', transient: true,
      text: 'Click ◎ on the Granular’s out and switch the scope to Spectrum. Hold a note: the grains smear the harmonics into a band.',
      check: (s) => s.probes.has(`${mod(s.patch, 'grain')?.id}:out`),
      apply: (a) => { const g = mod(a.patch(), 'grain'); if (g) a.probe(g.id, 'out'); },
      target: (s) => T.port(mod(s.patch, 'grain'), 'out', 'out'),
    },
  ],
};

// ---- chapter 9

const ch9: Chapter = {
  id: 'two-instruments',
  title: 'Two instruments, one keyboard',
  patchName: 'Tutorial duo',
  intro: 'Layering is two instruments on one keyboard. A mixer sums them, the arpeggiator plays held keys as a pattern, a macro range gives a knob a useful stretch, and the morph slider fades between two settings of the whole patch.',
  start: () => newPatch(DEFS, 'Tutorial duo'),
  steps: [
    {
      id: 'voice', title: 'Insert My voice',
      text: 'Click + Add assembly and pick My voice from Your library. Cable Main pitch → its pitch and Main gate → its gate.',
      check: (s) => { const p = s.patch; const v = myVoice(p); return cabled(p, mod(p, 'fm1'), 'pitch', member(p, v, 'osc'), 'pitch') && cabled(p, mod(p, 'fm1'), 'gate', member(p, v, 'adsr'), 'gate'); },
      apply: (a) => { if (!myVoice(a.patch())) insertDef(a, 'my-voice', 'My voice'); a.edit((p) => { const v = myVoice(p); wire(p, mod(p, 'fm1'), 'pitch', member(p, v, 'osc'), 'pitch'); wire(p, mod(p, 'fm1'), 'gate', member(p, v, 'adsr'), 'gate'); }); },
      target: (s) => myVoice(s.patch) ? T.asm(myVoice(s.patch)!.id) : T.ui('add-assembly-btn'),
    },
    {
      id: 'fm', title: 'Insert FM keys',
      text: 'Insert FM keys the same way. Its card shows two pitch inputs, one per oscillator, and a gate.',
      check: (s) => !!fmKeys(s.patch),
      apply: (a) => insertDef(a, 'fm-keys', 'FM keys'),
      target: () => T.ui('add-assembly-btn'),
    },
    {
      id: 'merge', title: 'Merge the two pitch inputs',
      text: 'Expand FM keys. Next to one of the exposed pitch inputs open merge into… and choose the other pitch. One pitch jack now feeds both oscillators. Collapse it.',
      why: 'A merged input sends one cable to several inner inputs. Split undoes it.',
      check: (s) => { const k = fmKeys(s.patch); return !!k && !k.open && k.inputs.some((r) => r.port === 'pitch' && !!r.also?.length); },
      apply: (a) => a.edit((p) => { const k = fmKeys(p)!; const [c, m] = allModules(p, k).map((id) => byId(p, id)!).filter((x) => x.type === 'osc'); mergePorts(p, k, DEFS, { module: c.id, port: 'pitch' }, { module: m.id, port: 'pitch' }); k.open = false; }),
      target: (s) => T.asm(fmKeys(s.patch)?.id),
    },
    {
      id: 'wire', title: 'Cable the second instrument',
      text: 'Cable Main pitch → FM keys pitch and Main gate → FM keys gate. Both instruments now play together.',
      check: (s) => { const p = s.patch; const k = fmKeys(p); return !!k && mods(p, 'osc').filter((o) => allModules(p, k).includes(o.id)).every((o) => cabled(p, mod(p, 'fm1'), 'pitch', o, 'pitch')) && cabled(p, mod(p, 'fm1'), 'gate', member(p, k, 'env'), 'gate'); },
      apply: (a) => a.edit((p) => { const k = fmKeys(p)!; for (const o of allModules(p, k).map((id) => byId(p, id)!).filter((x) => x.type === 'osc')) wire(p, mod(p, 'fm1'), 'pitch', o, 'pitch'); wire(p, mod(p, 'fm1'), 'gate', member(p, k, 'env'), 'gate'); }),
      target: (s) => T.asm(fmKeys(s.patch)?.id),
    },
    {
      id: 'mixer', title: 'Mix them',
      text: 'Add a Mixer 4. Cable My voice out → in1, FM keys l → in2, FM keys r → in3, and Mixer out → Output l and r. l1..l4 are the levels.',
      check: (s) => { const p = s.patch; const mx = mod(p, 'mixer'); const o = mod(p, 'output'); const sp = mySpace(p); return cabled(p, voiceOut(p), 'out', mx, 'in1') && cabled(p, member(p, sp, 'chorus'), 'l', mx, 'in2') && cabled(p, member(p, sp, 'chorus'), 'r', mx, 'in3') && cabled(p, mx, 'out', o, 'l') && cabled(p, mx, 'out', o, 'r'); },
      apply: (a) => a.edit((p) => { const mx = mod(p, 'mixer') ?? place(p, 'mixer'); const o = mod(p, 'output'); const ch = member(p, mySpace(p), 'chorus'); wire(p, voiceOut(p), 'out', mx, 'in1'); wire(p, ch, 'l', mx, 'in2'); wire(p, ch, 'r', mx, 'in3'); wire(p, mx, 'out', o, 'l'); wire(p, mx, 'out', o, 'r'); }),
      target: (s) => has(s.patch, 'mixer') ? [...T.port(mod(s.patch, 'mixer'), 'in1', 'in'), ...T.port(mod(s.patch, 'mixer'), 'out', 'out')] : T.ui('add-btn'),
    },
    {
      id: 'arp', title: 'Let the arpeggiator play', transient: true,
      text: 'Open the arp panel on the Main card and press Space (or Commands → arpeggiator). Hold a chord: the keys are played one after another at the rate shown.',
      check: (s) => s.arpPlay, apply: (a) => a.arpPlay(true), target: (s) => T.module(mod(s.patch, 'fm1')?.id),
    },
    {
      id: 'macro', title: 'A knob with a range',
      text: 'Cable Main k2 → My voice p1 (the pin of the Filter inside). Open the ⋯ menu of My voice’s cutoff, tick P1 and Map between two values, then set the ends to about 0.3 and 0.8.',
      why: 'A macro range maps the knob’s whole travel onto a slice of the parameter: the useful part of the cutoff instead of 20 Hz to 16 kHz.',
      check: (s) => { const f = member(s.patch, myVoice(s.patch), 'filter'); return cabled(s.patch, mod(s.patch, 'fm1'), 'k2', f, 'p1') && !!f?.map?.p1.includes('cutoff') && !!f.range?.p1?.cutoff; },
      apply: (a) => a.edit((p) => { const f = member(p, myVoice(p), 'filter')!; wire(p, mod(p, 'fm1'), 'k2', f, 'p1'); setParameterInput(f, 'p1', 'cutoff', true); ((f.range ??= {}).p1 ??= {}).cutoff = [0.3, 0.8]; }),
      target: (s) => [...T.port(mod(s.patch, 'fm1'), 'k2', 'out'), ...T.param(member(s.patch, myVoice(s.patch), 'filter'), 'cutoff')],
    },
    {
      id: 'morph', title: 'Morph between two settings', transient: true,
      text: 'Commands → Set snapshot A. Change a few sliders (cutoff, the mixer levels), then Commands → Set snapshot B. Press Alt+B to flip between them; the Main card’s morph slider fades from one to the other once the B side is picked.',
      check: (s) => !!s.snapshots.A && !!s.snapshots.B && s.seen.flips > 0,
      apply: (a) => { a.snapshot('A'); a.edit((p) => { const mx = mod(p, 'mixer'); if (mx) mx.params.l1 = 0.4; }); a.snapshot('B'); a.flipAB(); },
      target: () => T.ui('palette-btn'),
    },
  ],
};

// ---- chapter 10

const SCALE_PENT_MIN = 4;

const ch10: Chapter = {
  id: 'random-melody-machine',
  title: 'A random melody machine',
  patchName: 'Tutorial machine',
  intro: 'A sequencer is a clock and a value per step. A random one samples noise on every tick; a quantizer snaps the values to a scale so they become notes; a pulse turns each tick into a gate of a chosen length. The instruments you saved will play whatever the machine comes up with.',
  start: () => newPatch(DEFS, 'Tutorial machine'),
  steps: [
    {
      id: 'clock', title: 'A clock',
      text: 'Add an LFO, set its wave to square and its rate to 4 Hz. A square wave is a clock: its rising edge is a tick.',
      check: (s) => pct(s.patch, 'lfo', 'wave') === WAVE.square && pct(s.patch, 'lfo', 'rate') >= 2,
      apply: (a) => a.edit((p) => { const l = mod(p, 'lfo') ?? place(p, 'lfo'); l.params.wave = WAVE.square; l.params.rate = 4; }),
      target: (s) => has(s.patch, 'lfo') ? [...T.param(mod(s.patch, 'lfo'), 'wave'), ...T.param(mod(s.patch, 'lfo'), 'rate')] : T.ui('add-btn'),
    },
    {
      id: 'div', title: 'Divide it', superseded: true,
      text: 'Add a Clock div and cable LFO out → Clock div clock. Its outputs out, d2, d4 and d8 tick every div, 2, 4 and 8 ticks.',
      check: (s) => cabled(s.patch, mod(s.patch, 'lfo'), 'out', mod(s.patch, 'clkdiv'), 'clock'),
      apply: (a) => a.edit((p) => { const d = mod(p, 'clkdiv') ?? place(p, 'clkdiv'); wire(p, mod(p, 'lfo'), 'out', d, 'clock'); }),
      target: (s) => has(s.patch, 'clkdiv') ? T.port(mod(s.patch, 'clkdiv'), 'clock', 'in') : T.ui('add-btn'),
    },
    {
      id: 'sh', title: 'A random value per tick',
      text: 'Add Noise and an S&H (sample and hold). Cable Noise out → S&H in and Clock div out → S&H clock. On every tick the S&H grabs the noise’s value and holds it.',
      check: (s) => cabled(s.patch, mod(s.patch, 'noise'), 'out', mod(s.patch, 'sh'), 'in') && cabled(s.patch, mod(s.patch, 'clkdiv'), 'out', mod(s.patch, 'sh'), 'clock'),
      apply: (a) => a.edit((p) => { const n = mod(p, 'noise') ?? place(p, 'noise'); const sh = mod(p, 'sh') ?? place(p, 'sh'); wire(p, n, 'out', sh, 'in'); wire(p, mod(p, 'clkdiv'), 'out', sh, 'clock'); }),
      target: (s) => has(s.patch, 'sh') ? [...T.port(mod(s.patch, 'sh'), 'in', 'in'), ...T.port(mod(s.patch, 'sh'), 'clock', 'in')] : T.ui('add-btn'),
    },
    {
      id: 'quant', title: 'Snap it to a scale', superseded: true,
      text: 'Add a Quantizer, cable S&H out → Quantizer in and set scale to pent min. Random voltages become notes of a pentatonic minor scale.',
      why: 'Pitch is a control signal: one unit per octave, a semitone is a twelfth. The quantizer rounds to the nearest note of the scale, which is why random noise sounds like a melody.',
      check: (s) => cabled(s.patch, mod(s.patch, 'sh'), 'out', mod(s.patch, 'quant'), 'in') && pct(s.patch, 'quant', 'scale') === SCALE_PENT_MIN,
      apply: (a) => a.edit((p) => { const q = mod(p, 'quant') ?? place(p, 'quant'); wire(p, mod(p, 'sh'), 'out', q, 'in'); q.params.scale = SCALE_PENT_MIN; }),
      target: (s) => has(s.patch, 'quant') ? [...T.port(mod(s.patch, 'quant'), 'in', 'in'), ...T.param(mod(s.patch, 'quant'), 'scale')] : T.ui('add-btn'),
    },
    {
      id: 'pluck', title: 'Play Pluck with it',
      text: 'Insert Pluck from Your library. Cable Quantizer out → Pluck pitch, Clock div out → Pluck gate and Pluck out → Output l. The machine plays on its own now.',
      check: (s) => { const p = s.patch; const pl = pluck(p); const st = member(p, pl, 'string'); return cabled(p, mod(p, 'quant'), 'out', st, 'pitch') && cabled(p, mod(p, 'clkdiv'), 'out', st, 'gate') && (cabled(p, st, 'out', mod(p, 'output'), 'l') || cabled(p, member(p, pl, 'modal'), 'out', mod(p, 'output'), 'l')); },
      apply: (a) => { if (!pluck(a.patch())) insertDef(a, 'pluck', 'Pluck'); a.edit((p) => { const pl = pluck(p); const st = member(p, pl, 'string'); wire(p, mod(p, 'quant'), 'out', st, 'pitch'); wire(p, mod(p, 'clkdiv'), 'out', st, 'gate'); wire(p, st, 'out', mod(p, 'output'), 'l'); }); },
      target: (s) => pluck(s.patch) ? T.asm(pluck(s.patch)!.id) : T.ui('add-assembly-btn'),
    },
    {
      id: 'pulse', title: 'FM keys on every second tick',
      text: 'Add a Pulse with time 0.05 s and cable Clock div d2 → Pulse trig. Insert FM keys; cable Quantizer out → FM keys pitch, Pulse out → FM keys gate, FM keys l → Output r.',
      why: 'A divider output stays high for half its period, which would hold FM keys’ envelope open. The pulse makes a short gate out of each tick instead.',
      check: (s) => { const p = s.patch; const k = fmKeys(p); const pu = mod(p, 'pulse'); return cabled(p, mod(p, 'clkdiv'), 'd2', pu, 'trig') && (pu?.params.time ?? 1) <= 0.1 && !!k && allModules(p, k).map((id) => byId(p, id)!).filter((x) => x.type === 'osc').some((o) => cabled(p, mod(p, 'quant'), 'out', o, 'pitch')) && cabled(p, pu, 'out', member(p, k, 'env'), 'gate') && cabled(p, member(p, mySpace(p), 'chorus'), 'l', mod(p, 'output'), 'r'); },
      apply: (a) => { if (!fmKeys(a.patch())) insertDef(a, 'fm-keys', 'FM keys'); a.edit((p) => { const pu = mod(p, 'pulse') ?? place(p, 'pulse'); pu.params.time = 0.05; wire(p, mod(p, 'clkdiv'), 'd2', pu, 'trig'); const k = fmKeys(p)!; for (const o of allModules(p, k).map((id) => byId(p, id)!).filter((x) => x.type === 'osc')) wire(p, mod(p, 'quant'), 'out', o, 'pitch'); wire(p, pu, 'out', member(p, k, 'env'), 'gate'); wire(p, member(p, mySpace(p), 'chorus'), 'l', mod(p, 'output'), 'r'); }); },
      target: (s) => has(s.patch, 'pulse') ? [...T.port(mod(s.patch, 'pulse'), 'trig', 'in'), ...T.port(mod(s.patch, 'pulse'), 'out', 'out')] : T.ui('add-btn'),
    },
    {
      id: 'seq', title: 'A written melody instead',
      text: 'Add a Sequencer, cable LFO out → Sequencer clock and Sequencer out → Quantizer in, and remove the cable from the S&H to the Quantizer. Set s1..s4 to a few different values; len to 4.',
      why: 'The Sequencer’s steps are the same kind of signal the S&H made, just chosen by you. Through the quantizer the steps land on scale notes whatever you set them to.',
      check: (s) => { const p = s.patch; const sq = mod(p, 'seq'); return cabled(p, mod(p, 'lfo'), 'out', sq, 'clock') && cabled(p, sq, 'out', mod(p, 'quant'), 'in') && !cabled(p, mod(p, 'sh'), 'out', mod(p, 'quant'), 'in') && (sq?.params.len ?? 8) <= 4; },
      apply: (a) => a.edit((p) => { const sq = mod(p, 'seq') ?? place(p, 'seq'); wire(p, mod(p, 'lfo'), 'out', sq, 'clock'); wire(p, sq, 'out', mod(p, 'quant'), 'in'); unwire(p, mod(p, 'sh'), 'out', mod(p, 'quant'), 'in'); Object.assign(sq.params, { s1: 0, s2: 0.25, s3: 0.583, s4: 0.417, len: 4 }); }),
      target: (s) => has(s.patch, 'seq') ? [...T.port(mod(s.patch, 'seq'), 'clock', 'in'), ...T.port(mod(s.patch, 'seq'), 'out', 'out')] : T.ui('add-btn'),
    },
    {
      id: 'mainclock', title: 'Lock to the arpeggiator’s clock',
      text: 'Cable Main clock → Clock div clock and remove the LFO’s cable to it; set the Clock div’s div to 6. Press Space: Main’s clock now ticks 24 times per beat at the arp tempo, and on the FM-1 it follows MIDI clock.',
      check: (s) => { const p = s.patch; return cabled(p, mod(p, 'fm1'), 'clock', mod(p, 'clkdiv'), 'clock') && !cabled(p, mod(p, 'lfo'), 'out', mod(p, 'clkdiv'), 'clock') && pct(p, 'clkdiv', 'div') >= 4; },
      apply: (a) => { a.edit((p) => { const d = mod(p, 'clkdiv')!; wire(p, mod(p, 'fm1'), 'clock', d, 'clock'); unwire(p, mod(p, 'lfo'), 'out', d, 'clock'); d.params.div = 6; }); a.arpPlay(true); },
      target: (s) => [...T.port(mod(s.patch, 'fm1'), 'clock', 'out'), ...T.port(mod(s.patch, 'clkdiv'), 'clock', 'in')],
    },
  ],
};

// ---- chapter 11

const HAT_TYPES = ['noise', 'filter', 'env', 'vca'];
const hat = (p: Patch) => asmLike(p, HAT_TYPES);
const factoryAsm = (p: Patch, name: string) => assembliesOfName(p, name);
function assembliesOfName(p: Patch, name: string) {
  return (p.assemblies ?? []).find((a) => a.name.toLowerCase() === name);
}

const ch11: Chapter = {
  id: 'drums-from-noise',
  title: 'Drums from noise',
  patchName: 'Tutorial drums',
  intro: 'Most drum sounds are noise or a short tone with a very fast envelope. A hi-hat is filtered noise that dies in a tenth of a second; a kick is a sine whose pitch drops; a snare is both. You build the hat, borrow the kick and snare from the library, and clock them from a divider.',
  start: () => newPatch(DEFS, 'Tutorial drums'),
  steps: [
    {
      id: 'noise', title: 'Noise through a high pass',
      text: 'Add Noise and a Filter. Cable Noise out → Filter in and set the cutoff to about 6 kHz: the Filter’s hp output is the hiss of a hat.',
      check: (s) => cabled(s.patch, mod(s.patch, 'noise'), 'out', mod(s.patch, 'filter'), 'in') && pct(s.patch, 'filter', 'cutoff') >= 4000,
      apply: (a) => a.edit((p) => { const n = mod(p, 'noise') ?? place(p, 'noise'); const f = mod(p, 'filter') ?? place(p, 'filter'); wire(p, n, 'out', f, 'in'); f.params.cutoff = 6000; }),
      target: (s) => has(s.patch, 'filter') ? [...T.port(mod(s.patch, 'filter'), 'in', 'in'), ...T.param(mod(s.patch, 'filter'), 'cutoff')] : T.ui('add-btn'),
    },
    {
      id: 'env', title: 'A very short envelope', superseded: true,
      text: 'Add an Env L/R and a VCA. Cable Filter hp → VCA in, Main gate → Env gate, Env env → VCA cv, VCA out → Output l. Set the Env’s l2 to 0 and r2 to 0.08 s. Tap a key.',
      check: (s) => { const p = s.patch; const e = mod(p, 'env'); return cabled(p, mod(p, 'filter'), 'hp', mod(p, 'vca'), 'in') && cabled(p, mod(p, 'fm1'), 'gate', e, 'gate') && cabled(p, e, 'env', mod(p, 'vca'), 'cv') && cabled(p, mod(p, 'vca'), 'out', mod(p, 'output'), 'l') && (e?.params.l2 ?? 1) <= 0.1 && (e?.params.r2 ?? 1) <= 0.15; },
      apply: (a) => a.edit((p) => { const e = mod(p, 'env') ?? place(p, 'env'); const v = mod(p, 'vca') ?? place(p, 'vca'); wire(p, mod(p, 'filter'), 'hp', v, 'in'); wire(p, mod(p, 'fm1'), 'gate', e, 'gate'); wire(p, e, 'env', v, 'cv'); wire(p, v, 'out', mod(p, 'output'), 'l'); Object.assign(e.params, { l1: 1, r1: 0.001, l2: 0, r2: 0.08, l3: 0, l4: 0 }); }),
      target: (s) => has(s.patch, 'env') ? [...T.port(mod(s.patch, 'filter'), 'hp', 'out'), ...T.param(mod(s.patch, 'env'), 'r2')] : T.ui('add-btn'),
    },
    {
      id: 'group', title: 'Group it as Hat and save it', transient: true,
      text: 'Select the Noise, Filter, Env and VCA, press G and name it Hat. Click save on its card.',
      check: (s) => !!hat(s.patch) && !!findDef(s.library, 'hat', 'Hat'),
      apply: (a) => { a.edit((p) => { if (!hat(p)) makeAssembly(p, HAT_TYPES.map((t) => mod(p, t)!.id), 'Hat'); }); const p = a.patch(); const h = hat(p)!; h.name = 'Hat'; a.saveAssembly(toDef(p, h), 'hat'); },
      target: (s) => hat(s.patch) ? T.asm(hat(s.patch)!.id) : HAT_TYPES.flatMap((t) => T.module(mod(s.patch, t)?.id)),
    },
    {
      id: 'kit', title: 'Borrow a kick and a snare',
      text: 'Click + Add assembly and insert kick and snare from the Drums shelf. Expand one to see how it is built: a kick is a sine with a pitch envelope.',
      check: (s) => !!factoryAsm(s.patch, 'kick') && !!factoryAsm(s.patch, 'snare'),
      apply: (a) => { for (const n of ['kick', 'snare']) if (!factoryAsm(a.patch(), n)) { const def = FACTORY_BY_NAME(n); a.edit((p) => { const spot = place(p, 'const'); p.modules = p.modules.filter((m) => m.id !== spot.id); insertAssembly(p, DEFS, def, spot.x, spot.y); }); } },
      target: () => T.ui('add-assembly-btn'),
    },
    {
      id: 'clock', title: 'A clock and a divider',
      text: 'Add an LFO (square, 8 Hz) and a Clock div with div 2. Cable LFO out → Clock div clock.',
      check: (s) => pct(s.patch, 'lfo', 'wave') === WAVE.square && pct(s.patch, 'lfo', 'rate') >= 6 && cabled(s.patch, mod(s.patch, 'lfo'), 'out', mod(s.patch, 'clkdiv'), 'clock') && pct(s.patch, 'clkdiv', 'div') === 2,
      apply: (a) => a.edit((p) => { const l = mod(p, 'lfo') ?? place(p, 'lfo'); const d = mod(p, 'clkdiv') ?? place(p, 'clkdiv'); l.params.wave = WAVE.square; l.params.rate = 8; d.params.div = 2; wire(p, l, 'out', d, 'clock'); }),
      target: (s) => has(s.patch, 'clkdiv') ? T.port(mod(s.patch, 'clkdiv'), 'clock', 'in') : T.ui('add-btn'),
    },
    {
      id: 'pattern', title: 'A pattern from the divisions',
      text: 'Cable LFO out → Hat gate (every eighth), Clock div d2 → kick gate (every beat) and Clock div d4 → snare gate (every second beat). Remove the cable from Main’s gate to the Hat.',
      check: (s) => { const p = s.patch; const h = member(p, hat(p), 'env'); const k = factoryAsm(p, 'kick'); const sn = factoryAsm(p, 'snare'); const gateOf = (a: typeof k) => a && a.inputs.find((r) => r.label === 'gate'); const kg = gateOf(k); const sg = gateOf(sn); return cabled(p, mod(p, 'lfo'), 'out', h, 'gate') && !!kg && cabled(p, mod(p, 'clkdiv'), 'd2', byId(p, kg.module), kg.port) && !!sg && cabled(p, mod(p, 'clkdiv'), 'd4', byId(p, sg.module), sg.port) && !cabled(p, mod(p, 'fm1'), 'gate', h, 'gate'); },
      apply: (a) => a.edit((p) => { const h = member(p, hat(p), 'env'); wire(p, mod(p, 'lfo'), 'out', h, 'gate'); unwire(p, mod(p, 'fm1'), 'gate', h, 'gate'); for (const [n, port] of [['kick', 'd2'], ['snare', 'd4']] as const) { const g = factoryAsm(p, n)!.inputs.find((r) => r.label === 'gate')!; wire(p, mod(p, 'clkdiv'), port, byId(p, g.module), g.port); for (const t of g.also ?? []) wire(p, mod(p, 'clkdiv'), port, byId(p, t.module), t.port); } }),
      target: (s) => [...T.port(mod(s.patch, 'clkdiv'), 'd2', 'out'), ...T.asm(factoryAsm(s.patch, 'kick')?.id), ...T.asm(factoryAsm(s.patch, 'snare')?.id)],
    },
    {
      id: 'mix', title: 'Mix the kit',
      text: 'Add a Mixer 4: kick out → in1, snare out → in2, Hat out → in3, and Mixer out → Output l and r. Remove the Hat’s own cable to Output. Set l1 to 0.9 and l3 to 0.4.',
      check: (s) => { const p = s.patch; const mx = mod(p, 'mixer'); const o = mod(p, 'output'); const outOf = (n: string) => { const a = factoryAsm(p, n); const r = a?.outputs[0]; return r && byId(p, r.module) ? { m: byId(p, r.module), port: r.port } : undefined; }; const k = outOf('kick'); const sn = outOf('snare'); const hv = member(p, hat(p), 'vca'); return !!k && !!sn && cabled(p, k.m, k.port, mx, 'in1') && cabled(p, sn.m, sn.port, mx, 'in2') && cabled(p, hv, 'out', mx, 'in3') && cabled(p, mx, 'out', o, 'l') && cabled(p, mx, 'out', o, 'r') && !cabled(p, hv, 'out', o, 'l'); },
      apply: (a) => a.edit((p) => { const mx = mod(p, 'mixer') ?? place(p, 'mixer'); const o = mod(p, 'output'); for (const [n, port] of [['kick', 'in1'], ['snare', 'in2']] as const) { const r = factoryAsm(p, n)!.outputs[0]; wire(p, byId(p, r.module), r.port, mx, port); } const hv = member(p, hat(p), 'vca'); wire(p, hv, 'out', mx, 'in3'); unwire(p, hv, 'out', o, 'l'); wire(p, mx, 'out', o, 'l'); wire(p, mx, 'out', o, 'r'); mx.params.l1 = 0.9; mx.params.l3 = 0.4; }),
      target: (s) => has(s.patch, 'mixer') ? [...T.port(mod(s.patch, 'mixer'), 'in1', 'in'), ...T.port(mod(s.patch, 'mixer'), 'out', 'out')] : T.ui('add-btn'),
    },
    {
      id: 'share', title: 'Share it', transient: true,
      text: 'Commands → Share patch link copies a link to this patch to your clipboard. Anyone who opens it gets the drum machine, Hat and all. That is the end of the course.',
      check: (s) => s.seen.shares > 0, apply: (a) => a.share(), target: () => T.ui('palette-btn'),
    },
  ],
};

const FACTORY_BY_NAME = (name: string): AssemblyDef => {
  const d = FACTORY.find((d) => d.name.toLowerCase() === name);
  if (!d) throw new Error(`no factory assembly "${name}"`);
  return d;
};

export const CHAPTERS: Chapter[] = [ch1, ch2, ch3, ch4, ch5, ch6, ch7, ch8, ch9, ch10, ch11];

/** a chapter's canned start: the previous chapter's end for a continuing chapter */
export function chapterStart(i: number): Patch {
  return JSON.parse(JSON.stringify(courseRun().starts[i])) as Patch;
}
export function chapterEnd(i: number): Patch {
  return JSON.parse(JSON.stringify(courseRun().ends[i])) as Patch;
}

export type { Step, TutorialState };
