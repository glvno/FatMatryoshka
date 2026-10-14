// SPDX-License-Identifier: GPL-3.0-only
// The eleven chapters of the tutorial (docs/TUTORIAL.md). Each step: one action, a strict structural check made of named
// parts, each with the elements it is about (the panel lists the unmet parts and highlights the first one, so a locked
// Next always says why and points where), and the "do it for me" apply. Checks find modules by type and shape, never
// by id, since the user adds them in any order.
import { DEFS } from '../modules';
import { newPatch, type ModuleInst, type Patch } from '../patch';
import { PRESETS } from '../presets';
import { addChild, allModules, exposePort, insertAssembly, makeAssembly, mergePorts, promote, toDef, type AssemblyDef } from '../assembly';
import { FACTORY } from '../assemblies';
import { connectParameter, setParameterInput } from '../parameter-routing';
import { asmLike, byId, cabled, feeder, findDef, has, member, mod, mods, place, runCourse, T, unwire, wire, type Actions, type Chapter, type CourseRun, type Step, type Target, type TutorialState } from './model';

const pct = (p: Patch, type: string, name: string, i = 0): number => mod(p, type, i)?.params[name] ?? NaN;
const WAVE = { sine: 0, triangle: 1, saw: 2, square: 3 };
type S = TutorialState;
type M = ModuleInst | undefined;

/** one named part of a step's check, with the elements it is about */
type Part = [what: string, ok: (s: S) => boolean, target?: (s: S) => Target[]];
/** a check made of parts: `check` is all of them, `todo` the unmet ones, `focus` the elements of the first unmet one */
const need = (...parts: Part[]): Pick<Step, 'check' | 'todo' | 'focus'> => ({
  check: (s) => parts.every(([, ok]) => ok(s)),
  todo: (s) => parts.filter(([, ok]) => !ok(s)).map(([what]) => what),
  // a done step keeps pointing at its last part, so the panel stays anchored while it says "moving on"
  focus: (s) => { const p = parts.find(([, ok]) => !ok(s)) ?? parts[parts.length - 1]; return p?.[2]?.(s) ?? []; },
});
const pins = ['p1', 'p2'] as const;
/** a signal routed through a pin to a parameter (what dropping a cable on the thumb makes) */
const pinned = (p: Patch, from: M, port: string, to: M, param: string): boolean =>
  !!from && !!to && pins.some((pin) => cabled(p, from, port, to, pin) && !!to.map?.[pin].includes(param));
// The parts' labels are imperatives addressed to the user ("Cable Main gate → VCA cv", "Set cutoff to 800 Hz or below").
/** "Cable A x → B y": its target is both jacks */
const cable = (what: string, from: (s: S) => M, fp: string, to: (s: S) => M, tp: string): Part =>
  [`Cable ${what}`, (s) => cabled(s.patch, from(s), fp, to(s), tp), (s) => [...T.port(from(s), fp, 'out'), ...T.port(to(s), tp, 'in')]];
/** "Remove the old cable A x → B y": its target is the destination jack (the cable ends there) */
const gone = (what: string, from: (s: S) => M, fp: string, to: (s: S) => M, tp: string): Part =>
  [`Remove the old cable ${what} (click it)`, (s) => !cabled(s.patch, from(s), fp, to(s), tp), (s) => T.port(to(s), tp, 'in')];
/** "Add a module of this type": its target is the Add button */
const added = (what: string, type: string): Part => [`Add ${what}`, (s) => has(s.patch, type), () => T.ui('add-btn')];
/** "Set a slider to …" */
const knob = (what: string, m: (s: S) => M, param: string, ok: (v: number) => boolean): Part =>
  [what.startsWith('track') ? 'Tick track' : what.includes(' off ') ? `Move ${what}` : `Set ${what}`, (s) => { const x = m(s); return !!x && ok(x.params[param] ?? NaN); }, (s) => T.param(m(s), param)];
const main = (s: S): M => mod(s.patch, 'fm1');
const out = (s: S): M => mod(s.patch, 'output');
const one = (type: string, i = 0) => (s: S): M => mod(s.patch, type, i);

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
const insertAt = (p: Patch, def: AssemblyDef): void => {
  const spot = place(p, 'const'); // borrow the free-spot search, then put the assembly there instead
  p.modules = p.modules.filter((m) => m.id !== spot.id);
  insertAssembly(p, DEFS, def, spot.x, spot.y);
};
const insertDef = (a: Actions, tag: string, name: string): void => {
  const { def } = tutorialDef(tag, name, a.library());
  a.edit((p) => insertAt(p, def));
};
const FACTORY_BY_NAME = (name: string): AssemblyDef => {
  const d = FACTORY.find((d) => d.name.toLowerCase() === name);
  if (!d) throw new Error(`no factory assembly "${name}"`);
  return d;
};

// ---- chapter 1

const ch1: Chapter = {
  id: 'hello-sound',
  title: 'Hello sound',
  patchName: 'Tutorial voice',
  intro: 'A patch is a few modules and the cables between them. Main is the keyboard (and, on the FM-1, its panel), Output is the speaker. Between them you put a sound source and whatever shapes it. The first thing to learn is how a note starts and stops: the oscillator never stops on its own, so a VCA (voltage controlled amplifier) opens and closes for it.',
  start: () => PRESETS['Subtractive saw'](),
  keep: true,
  steps: [
    {
      id: 'audio', title: 'Enable audio', transient: true,
      text: 'Click Enable audio in the sidebar (browsers only start sound after a click). The button then reads Audio on.',
      ...need(['Enable audio', (s) => s.audio, () => T.ui('audio-btn')]),
      apply: (a) => a.startAudio(),
    },
    {
      id: 'new', title: 'Start a new patch', superseded: true,
      text: 'Click New patch in the sidebar (or press / and choose New patch). Every patch starts with two cards: Main and Output.',
      ...need(['Start a new patch (only Main and Output, no cables)', (s) => s.patch.modules.length === 2 && has(s.patch, 'fm1') && has(s.patch, 'output') && !s.patch.cables.length, () => T.ui('new-patch-btn')]),
      apply: (a) => a.load(newPatch(DEFS, ch1.patchName)),
    },
    {
      id: 'osc', title: 'Add an Oscillator',
      text: 'Click + Add module (or press /) and pick Oscillator. A new card appears on the canvas; drag it by its header to move it.',
      why: 'The oscillator is the sound source: it repeats one waveform at the pitch it is told, all the time. Everything else in a synth shapes what comes out of it.',
      ...need(added('an Oscillator', 'osc')),
      apply: (a) => a.edit((p) => place(p, 'osc')),
    },
    {
      id: 'pitch', title: 'Tell it the pitch',
      text: 'Drag from Main’s pitch jack to the Oscillator’s pitch jack (or click one jack, then the other). Teal cables carry control signals: slow values such as which note is held.',
      ...need(cable('Main pitch → Oscillator pitch', main, 'pitch', one('osc'), 'pitch')),
      apply: (a) => a.edit((p) => wire(p, mod(p, 'fm1'), 'pitch', mod(p, 'osc'), 'pitch')),
    },
    {
      id: 'vca', title: 'Add a VCA and feed it',
      text: 'Add a VCA and drag the Oscillator’s out jack to the VCA’s in jack. Coral cables carry audio. Nothing reaches the Output yet, so nothing sounds.',
      why: 'A VCA multiplies its input by the signal at its cv input: cv 1 lets everything through, cv 0 is silence, and an unplugged cv counts as 0. The grey route inside the card shows that cv is wired to gain by design; that link cannot be removed.',
      ...need(added('a VCA', 'vca'), cable('Oscillator out → VCA in', one('osc'), 'out', one('vca'), 'in')),
      apply: (a) => a.edit((p) => { const v = mod(p, 'vca') ?? place(p, 'vca'); wire(p, mod(p, 'osc'), 'out', v, 'in'); }),
    },
    {
      id: 'gate', title: 'Let the key open it',
      text: 'Drag Main’s gate jack to the VCA’s cv jack. Gold cables carry gates: on while a key is held, off otherwise. Now the VCA only passes sound while you hold a key.',
      ...need(cable('Main gate → VCA cv', main, 'gate', one('vca'), 'cv')),
      apply: (a) => a.edit((p) => wire(p, mod(p, 'fm1'), 'gate', mod(p, 'vca'), 'cv')),
    },
    {
      id: 'out', title: 'Send it to the Output',
      text: 'Drag the VCA’s out jack to Output’s l jack. Press A on your keyboard: the note starts when you press and stops when you let go. The keys A W S E D F T G Y H U J K play notes, Z and X move the octave.',
      ...need(cable('VCA out → Output l', one('vca'), 'out', out, 'l')),
      apply: (a) => a.edit((p) => wire(p, mod(p, 'vca'), 'out', mod(p, 'output'), 'l')),
    },
    {
      id: 'note', title: 'Play a note', transient: true,
      text: 'Hold a key, or the button below. The Output’s level slider is the volume: it starts low on purpose, raise it to taste.',
      ...need(['Play a note', (s) => s.seen.notes > 0, (s) => T.param(out(s), 'level')]),
      apply: (a) => a.note(),
    },
    {
      id: 'scope', title: 'Look at the wave', transient: true,
      text: 'Click ◎ beside the Oscillator’s out jack. The scope window opens and traces that signal (the Oscillator runs all the time, so it shows even without a key); the Spectrum button shows its harmonics.',
      why: 'A sine has one harmonic, a saw has all of them, a square only the odd ones. What you see on the spectrum is what a filter will later take away.',
      ...need(['Click ◎ beside the Oscillator’s out', (s) => s.probes.has(`${mod(s.patch, 'osc')?.id}:out`), (s) => T.port(one('osc')(s), 'out', 'out')]),
      apply: (a) => { const o = mod(a.patch(), 'osc'); if (o) a.probe(o.id, 'out'); },
    },
    {
      id: 'wave', title: 'Change the wave',
      text: 'Hold a note and switch the Oscillator’s wave to saw, then square. Drag the level slider too: every slider is a parameter you can set or, later, modulate.',
      ...need(knob('the Oscillator’s wave to saw', one('osc'), 'wave', (v) => v === WAVE.saw)),
      apply: (a) => a.edit((p) => { mod(p, 'osc')!.params.wave = WAVE.saw; }),
    },
  ],
};

// ---- chapter 2

const ch2: Chapter = {
  id: 'shaping-a-note',
  title: 'Shaping a note',
  patchName: 'Tutorial voice',
  intro: 'A gate is on or off, so the note it opens is on or off too. Real notes have a shape: they start, hold and die away. The envelope generator (ADSR: attack, decay, sustain, release) draws that shape each time the gate opens, and the VCA follows it instead of the bare gate.',
  start: () => null,
  steps: [
    {
      id: 'adsr', title: 'Add an ADSR',
      text: 'Add an ADSR. Its env output rises when the gate opens, falls to the sustain level, and dies away after the gate closes.',
      ...need(added('an ADSR', 'adsr')),
      apply: (a) => a.edit((p) => place(p, 'adsr')),
    },
    {
      id: 'env', title: 'Let the envelope drive the gain',
      text: 'Cable Main gate → ADSR gate and ADSR env → VCA cv, then click the cable from Main’s gate to the VCA to remove it. The note now has a shape.',
      ...need(
        cable('Main gate → ADSR gate', main, 'gate', one('adsr'), 'gate'),
        cable('ADSR env → VCA cv', one('adsr'), 'env', one('vca'), 'cv'),
        gone('Main gate → VCA cv', main, 'gate', one('vca'), 'cv'),
      ),
      apply: (a) => a.edit((p) => { wire(p, mod(p, 'fm1'), 'gate', mod(p, 'adsr'), 'gate'); wire(p, mod(p, 'adsr'), 'env', mod(p, 'vca'), 'cv'); unwire(p, mod(p, 'fm1'), 'gate', mod(p, 'vca'), 'cv'); }),
    },
    {
      id: 'shape', title: 'Draw the shape',
      text: 'Drag the ADSR’s a (attack) to about 0.3 s and r (release) to about 1 s. Hold a note: it swells in and fades out after you let go.',
      why: 'Attack and release are times, sustain is a level. Pads have long attacks and releases; the next step makes the opposite.',
      ...need(knob('a (attack) to 0.1 s or more', one('adsr'), 'a', (v) => v >= 0.1), knob('r (release) to 0.5 s or more', one('adsr'), 'r', (v) => v >= 0.5)),
      apply: (a) => a.edit((p) => { const e = mod(p, 'adsr')!; e.params.a = 0.3; e.params.r = 1; }),
    },
    {
      id: 'pluck', title: 'Make it percussive',
      text: 'Set s (sustain) to 0.1 and d (decay) to about 0.2 s. Hold a note: it rings out and dies although the key is still down. Plucked and struck sounds have no sustain.',
      ...need(knob('s (sustain) to 0.3 or less', one('adsr'), 's', (v) => v <= 0.3), knob('d (decay) to 0.4 s or less', one('adsr'), 'd', (v) => v <= 0.4)),
      apply: (a) => a.edit((p) => { const e = mod(p, 'adsr')!; e.params.s = 0.1; e.params.d = 0.2; }),
    },
    {
      id: 'thumb', title: 'A slider thumb is a jack',
      text: 'Set the wave to square (pulse width only matters for a square). Then Alt-drag the thumb of the Oscillator’s pw slider onto the ADSR’s env jack (or drag from env and drop it on the thumb). The envelope now also sweeps the pulse width.',
      why: 'Dropping a signal on a thumb routes it through one of the module’s parameter inputs, p1 or p2. The same envelope shapes two things at once: loudness and timbre.',
      ...need(
        knob('the Oscillator’s wave to square', one('osc'), 'wave', (v) => v === WAVE.square),
        ['Drop the ADSR’s env on the pw thumb (Alt-drag the thumb to env)', (s) => pinned(s.patch, mod(s.patch, 'adsr'), 'env', mod(s.patch, 'osc'), 'pw'), (s) => [...T.param(one('osc')(s), 'pw'), ...T.port(one('adsr')(s), 'env', 'out')]],
      ),
      apply: (a) => a.edit((p) => { const o = mod(p, 'osc')!; const e = mod(p, 'adsr')!; o.params.wave = WAVE.square; connectParameter(p, DEFS, { module: e.id, port: 'env' }, o.id, 'pw'); }),
    },
    {
      id: 'redo', title: 'Undo and redo', transient: true,
      text: 'Press Ctrl+Z (Cmd+Z on a Mac), or Commands → Undo: the route is gone. Press Shift+Ctrl+Z (Commands → Redo) and it is back. Forty steps of history are kept, cables and modules included.',
      ...need(
        ['Press Ctrl+Z to undo', (s) => s.seen.undos > 0, () => T.ui('palette-btn')],
        ['Press Shift+Ctrl+Z to redo', (s) => s.seen.redos > 0, () => T.ui('palette-btn')],
        ['Bring the env → pw route back (redo)', (s) => pins.some((pin) => cabled(s.patch, mod(s.patch, 'adsr'), 'env', mod(s.patch, 'osc'), pin)), (s) => T.param(one('osc')(s), 'pw')],
      ),
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
      ...need(
        added('a Filter', 'filter'),
        cable('Oscillator out → Filter in', one('osc'), 'out', one('filter'), 'in'),
        cable('Filter lp24 → VCA in', one('filter'), 'lp24', one('vca'), 'in'),
        gone('Oscillator out → VCA in', one('osc'), 'out', one('vca'), 'in'),
      ),
      apply: (a) => a.edit((p) => { if (!has(p, 'filter')) place(p, 'filter'); wire(p, mod(p, 'osc'), 'out', mod(p, 'filter'), 'in'); wire(p, mod(p, 'filter'), 'lp24', mod(p, 'vca'), 'in'); unwire(p, mod(p, 'osc'), 'out', mod(p, 'vca'), 'in'); }),
    },
    {
      id: 'cutoff', title: 'Sweep the cutoff',
      text: 'Hold a note and drag cutoff down from 16 kHz to about 400 Hz: the tone gets darker. Raise res to about 0.6: a whistle sits on the cutoff.',
      why: 'The cutoff slider is logarithmic, like pitch: every octave gets the same distance. Resonance feeds a little of the output back, which makes the filter ring at its cutoff.',
      ...need(knob('cutoff to 800 Hz or below', one('filter'), 'cutoff', (v) => v <= 800), knob('res to 0.5 or more', one('filter'), 'res', (v) => v >= 0.5)),
      apply: (a) => a.edit((p) => { const f = mod(p, 'filter')!; f.params.cutoff = 400; f.params.res = 0.6; }),
    },
    {
      id: 'track', title: 'Track the keyboard',
      text: 'Tick track. The cutoff now follows the note, one octave per octave, so high notes stay as bright as low ones. Play up and down.',
      ...need(knob('track on (tick it)', one('filter'), 'track', (v) => v >= 0.5)),
      apply: (a) => a.edit((p) => { mod(p, 'filter')!.params.track = 1; }),
    },
    {
      id: 'lfo', title: 'Add an LFO',
      text: 'Add an LFO (low frequency oscillator). It is an oscillator too slow to hear, made to move other things. Set its rate to about 0.5 Hz.',
      ...need(added('an LFO', 'lfo'), knob('its rate to 1 Hz or below', one('lfo'), 'rate', (v) => v <= 1)),
      apply: (a) => a.edit((p) => { const l = mod(p, 'lfo') ?? place(p, 'lfo'); l.params.rate = 0.5; }),
    },
    {
      id: 'cv', title: 'Wobble the cutoff',
      text: 'Drag the LFO’s out to the Filter’s cv jack. The grey route shows cv is built into cutoff; cvamt sets how far it reaches: set it to 2 oct. Hold a note.',
      why: 'The cv input is additive in octaves: a signal of 1 moves the cutoff up by cvamt octaves. Pins p1 and p2 work differently: they reach any parameter you tick in its ⋯ menu.',
      ...need(cable('LFO out → Filter cv', one('lfo'), 'out', one('filter'), 'cv'), knob('cvamt to 1.5 oct or more', one('filter'), 'cvamt', (v) => v >= 1.5)),
      apply: (a) => a.edit((p) => { wire(p, mod(p, 'lfo'), 'out', mod(p, 'filter'), 'cv'); mod(p, 'filter')!.params.cvamt = 2; }),
    },
    {
      id: 'knob', title: 'One knob, two parameters',
      text: 'Drag Main’s blue k1 jack to the Filter’s p1. Open the ⋯ menu of cutoff and tick P1; do the same for res. Main’s k1 slider stands for the first knob of the FM-1.',
      why: 'The matrix in the ⋯ menu decides which parameters a pin reaches. A blue tick appears on each slider the knob reaches: that is where the knob alone holds the parameter.',
      ...need(
        cable('Main k1 → Filter p1', main, 'k1', one('filter'), 'p1'),
        ['Tick P1 in the ⋯ menu of cutoff', (s) => !!mod(s.patch, 'filter')?.map?.p1.includes('cutoff'), (s) => T.param(one('filter')(s), 'cutoff')],
        ['Tick P1 in the ⋯ menu of res', (s) => !!mod(s.patch, 'filter')?.map?.p1.includes('res'), (s) => T.param(one('filter')(s), 'res')],
      ),
      apply: (a) => a.edit((p) => { const f = mod(p, 'filter')!; wire(p, mod(p, 'fm1'), 'k1', f, 'p1'); setParameterInput(f, 'p1', 'cutoff', true); setParameterInput(f, 'p1', 'res', true); }),
    },
    {
      id: 'att', title: 'Set the depth',
      text: 'In the ⋯ menu of cutoff, drag the p1 attenuverter to about 0.5: the knob now reaches half as far. A negative value turns the knob around.',
      ...need(['Move the p1 attenuverter off 1 (⋯ menu of cutoff)', (s) => Math.abs((mod(s.patch, 'filter')?.att?.[0] ?? 1) - 1) > 0.05, (s) => T.param(one('filter')(s), 'cutoff')]),
      apply: (a) => a.edit((p) => { const f = mod(p, 'filter')!; f.att = [0.5, f.att?.[1] ?? 1]; }),
    },
    {
      id: 'live', title: 'Live value and base value', transient: true,
      text: 'Hold a note and watch the cutoff slider: the thumb follows the live, wobbling value and a tick marks the base. Now move Main’s k1 slider: the blue ticks move, and so does the sound.',
      ...need(['Move Main’s k1 slider', (s) => Math.abs(pct(s.patch, 'fm1', 'k1') - (mod(s.entry, 'fm1')?.params.k1 ?? 0.5)) > 0.05, (s) => T.param(main(s), 'k1')]),
      apply: (a) => a.edit((p) => { mod(p, 'fm1')!.params.k1 = 0.8; }),
    },
  ],
};

// ---- chapter 4

const VOICE_TYPES = ['osc', 'filter', 'adsr', 'vca', 'lfo'];
const myVoice = (p: Patch) => asmLike(p, VOICE_TYPES);
const voiceAsm = (s: S) => T.asm(myVoice(s.patch)?.id);
const inVoice = (type: string) => (s: S): M => member(s.patch, myVoice(s.patch), type);
/** "Promote x on assembly a": the part's target is that slider inside the frame */
const promoted = (what: string, asm: (p: Patch) => ReturnType<typeof asmLike>, type: string, param: string): Part =>
  [`Promote ${what} (click ○ beside it)`, (s) => { const a = asm(s.patch); const m = member(s.patch, a, type); return !!a && !!m && a.params.some((r) => r.module === m.id && r.param === param); }, (s) => T.param(member(s.patch, asm(s.patch), type), param)];

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
      ...need(['Select the Oscillator, Filter, ADSR, VCA and LFO', (s) => VOICE_TYPES.every((t) => mods(s.patch, t).some((m) => s.selected.has(m.id))), (s) => { const left = VOICE_TYPES.filter((t) => !mods(s.patch, t).some((m) => s.selected.has(m.id))); return (left.length ? left : VOICE_TYPES).flatMap((t) => T.module(mod(s.patch, t)?.id)); }]),
      apply: (a) => a.select(VOICE_TYPES.map((t) => mod(a.patch(), t)!.id)),
    },
    {
      id: 'group', title: 'Group them',
      text: 'Press G, or Commands → Make assembly, and name it My voice. The five cards fold into one that shows the ports which had cables from outside: pitch, gate and out.',
      why: 'Grouping changes nothing in the sound. Ports with outside cables are exposed automatically; the rest is hidden until you expose it.',
      ...need(['Group the Oscillator, Filter, ADSR, VCA and LFO (press G)', (s) => !!myVoice(s.patch), (s) => VOICE_TYPES.flatMap((t) => T.module(mod(s.patch, t)?.id))]),
      apply: (a) => a.edit((p) => makeAssembly(p, VOICE_TYPES.map((t) => mod(p, t)!.id), 'My voice')),
    },
    {
      id: 'expand', title: 'Open it up', superseded: true,
      text: 'Click expand on the My voice card. A frame shows the modules inside; every port and slider has a ○ toggle.',
      ...need(['Expand the assembly', (s) => !!myVoice(s.patch)?.open, voiceAsm]),
      apply: (a) => a.edit((p) => { myVoice(p)!.open = true; }),
    },
    {
      id: 'promote', title: 'Put two knobs on the card',
      text: 'Click ○ next to the Filter’s cutoff and next to the ADSR’s r. They become sliders on the collapsed card. Click ○ beside the LFO’s out too: an extra output.',
      ...need(
        promoted('the Filter’s cutoff', myVoice, 'filter', 'cutoff'),
        promoted('the ADSR’s r', myVoice, 'adsr', 'r'),
        ['Expose the LFO’s out (click ○ beside it)', (s) => { const a = myVoice(s.patch); const l = member(s.patch, a, 'lfo'); return !!a && !!l && a.outputs.some((r) => r.module === l.id && r.port === 'out'); }, (s) => T.port(inVoice('lfo')(s), 'out', 'out')],
      ),
      apply: (a) => a.edit((p) => { const v = myVoice(p)!; promote(v, member(p, v, 'filter')!.id, 'cutoff'); promote(v, member(p, v, 'adsr')!.id, 'r'); exposePort(v, 'out', member(p, v, 'lfo')!.id, 'out'); }),
    },
    {
      id: 'resize', title: 'Resize the frame', transient: true,
      text: 'Drag the ◢ corner of the frame to give the cards room (the arrow keys work on it too). Cards can be moved inside the frame; dragging one out takes it out of the assembly.',
      ...need(['Resize the frame (drag ◢)', (s) => { const a = myVoice(s.patch); const e = myVoice(s.entry); return !!a?.frameSize && JSON.stringify(a.frameSize) !== JSON.stringify(e?.frameSize); }, voiceAsm]),
      apply: (a) => a.edit((p) => { myVoice(p)!.frameSize = { width: 1400, height: 640 }; }),
    },
    {
      id: 'collapse', title: 'Close it',
      text: 'Click collapse in the frame’s header. One card: pitch, gate, out, the LFO’s out, cutoff and r. Play it.',
      ...need(['Collapse the assembly', (s) => !!myVoice(s.patch) && !myVoice(s.patch)!.open, voiceAsm]),
      apply: (a) => a.edit((p) => { myVoice(p)!.open = false; }),
    },
    {
      id: 'save', title: 'Save it to your library', transient: true,
      text: 'Click save on the card and keep the name My voice. It is now in the Library tab and in + Add assembly, under Your library, ready for any patch.',
      ...need(['Save it as "My voice" (save on the card)', (s) => !!findDef(s.library, 'my-voice', 'My voice'), voiceAsm]),
      apply: (a) => { const p = a.patch(); const v = myVoice(p)!; v.name = 'My voice'; a.saveAssembly(toDef(p, v), 'my-voice'); },
    },
    {
      id: 'fit', title: 'Fit the patch to the screen', transient: true,
      text: 'Commands → Fit patch to screen scales the canvas so everything is in view. Ctrl+wheel (pinch on touch) zooms freely; Reset canvas scale goes back to 100 %.',
      ...need(['Zoom the canvas (Ctrl+wheel, or Fit patch to screen)', (s) => s.seen.zooms > 0, () => T.ui('palette-btn')]),
      apply: (a) => a.zoomToFit(),
    },
  ],
};

// ---- chapter 5

const SPACE_TYPES = ['delay', 'reverb', 'chorus'];
const mySpace = (p: Patch) => asmLike(p, SPACE_TYPES);
const spaceAsm = (s: S) => T.asm(mySpace(s.patch)?.id);
/** the module behind My voice's out: its VCA */
const voiceOut = (s: S): M => member(s.patch, myVoice(s.patch), 'vca');
const spaceIn = (s: S): M => member(s.patch, mySpace(s.patch), 'delay');
const spaceOut = (s: S): M => member(s.patch, mySpace(s.patch), 'chorus');

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
      ...need(added('a Delay', 'delay'), added('a Reverb', 'reverb'), added('a Chorus', 'chorus')),
      apply: (a) => a.edit((p) => { for (const t of SPACE_TYPES) if (!has(p, t)) place(p, t); }),
    },
    {
      id: 'chain', title: 'Chain them',
      text: 'Cable My voice out → Delay in → Reverb in → Chorus in, then Chorus l → Output l and Chorus r → Output r. Remove the cable from My voice to Output.',
      ...need(
        cable('My voice out → Delay in', voiceOut, 'out', one('delay'), 'in'),
        cable('Delay out → Reverb in', one('delay'), 'out', one('reverb'), 'in'),
        cable('Reverb out → Chorus in', one('reverb'), 'out', one('chorus'), 'in'),
        cable('Chorus l → Output l', one('chorus'), 'l', out, 'l'),
        cable('Chorus r → Output r', one('chorus'), 'r', out, 'r'),
        gone('My voice out → Output l', voiceOut, 'out', out, 'l'),
      ),
      apply: (a) => a.edit((p) => { const v = member(p, myVoice(p), 'vca'); const o = mod(p, 'output'); wire(p, v, 'out', mod(p, 'delay'), 'in'); wire(p, mod(p, 'delay'), 'out', mod(p, 'reverb'), 'in'); wire(p, mod(p, 'reverb'), 'out', mod(p, 'chorus'), 'in'); wire(p, mod(p, 'chorus'), 'l', o, 'l'); wire(p, mod(p, 'chorus'), 'r', o, 'r'); unwire(p, v, 'out', o, 'l'); }),
    },
    {
      id: 'tune', title: 'Tune the space',
      text: 'Set the Delay’s time to about 375 ms and fb (feedback) to 0.5, and the Reverb’s size to 0.7. Play a short note and listen to the tail.',
      why: 'Feedback sends the delayed signal back into the line: each repeat is quieter than the last. Above 0.9 the repeats barely fade.',
      ...need(knob('the Delay’s time to 300 ms or more', one('delay'), 'time', (v) => v >= 300), knob('the Delay’s fb to 0.4 or more', one('delay'), 'fb', (v) => v >= 0.4), knob('the Reverb’s size to 0.6 or more', one('reverb'), 'size', (v) => v >= 0.6)),
      apply: (a) => a.edit((p) => { const d = mod(p, 'delay')!; d.params.time = 375; d.params.fb = 0.5; mod(p, 'reverb')!.params.size = 0.7; }),
    },
    {
      id: 'bypass', title: 'Hear it with and without', transient: true,
      text: 'Click the Reverb card to select it and press B (or click ⏻ in its header): the module is bypassed and passes its input straight through. Press B again to switch it back on.',
      ...need(['Press B twice on the Reverb (off, then on)', (s) => s.seen.bypasses >= 2, (s) => T.module(one('reverb')(s)?.id)], ['Switch the Reverb back on', (s) => !mod(s.patch, 'reverb')?.bypass, (s) => T.module(one('reverb')(s)?.id)]),
      apply: (a) => { const r = mod(a.patch(), 'reverb')!; a.bypass(r.id, true); a.bypass(r.id, false); },
    },
    {
      id: 'group', title: 'Group the three',
      text: 'Select the Delay, Reverb and Chorus and press G. Name the assembly My space. Its card shows in, l and r.',
      ...need(['Group the Delay, Reverb and Chorus (press G)', (s) => !!mySpace(s.patch), (s) => SPACE_TYPES.flatMap((t) => T.module(mod(s.patch, t)?.id))]),
      apply: (a) => a.edit((p) => makeAssembly(p, SPACE_TYPES.map((t) => mod(p, t)!.id), 'My space')),
    },
    {
      id: 'promote', title: 'Choose its knobs',
      text: 'Expand My space, click ○ on the Delay’s time and mix and on the Reverb’s mix, then collapse it. An effect needs few knobs on the outside.',
      ...need(
        promoted('the Delay’s time', mySpace, 'delay', 'time'),
        promoted('the Delay’s mix', mySpace, 'delay', 'mix'),
        promoted('the Reverb’s mix', mySpace, 'reverb', 'mix'),
        ['Collapse My space', (s) => !!mySpace(s.patch) && !mySpace(s.patch)!.open, spaceAsm],
      ),
      apply: (a) => a.edit((p) => { const sp = mySpace(p)!; const d = member(p, sp, 'delay')!; promote(sp, d.id, 'time'); promote(sp, d.id, 'mix'); promote(sp, member(p, sp, 'reverb')!.id, 'mix'); sp.open = false; }),
    },
    {
      id: 'save', title: 'Save My space', transient: true,
      text: 'Click save on the My space card. Your library now holds an instrument and an effect; the next chapters use both.',
      ...need(['Save it as "My space" (save on the card)', (s) => !!findDef(s.library, 'my-space', 'My space'), spaceAsm]),
      apply: (a) => { const p = a.patch(); const sp = mySpace(p)!; sp.name = 'My space'; a.saveAssembly(toDef(p, sp), 'my-space'); },
    },
  ],
};

// ---- chapter 6

const FM_TYPES = ['osc', 'osc', 'env', 'vca'];
const fmKeys = (p: Patch) => asmLike(p, FM_TYPES);
const fmAsm = (s: S) => T.asm(fmKeys(s.patch)?.id);
/** the oscillator whose pm input is fed by the other one */
const carrier = (s: S): M => mods(s.patch, 'osc').find((o) => feeder(s.patch, o, 'pm')?.type === 'osc');
const modulator = (s: S): M => { const c = carrier(s); return c && feeder(s.patch, c, 'pm'); };
const fmOscs = (p: Patch) => { const k = fmKeys(p); return k ? allModules(p, k).map((id) => byId(p, id)!).filter((x) => x.type === 'osc') : []; };
const fmOut = (s: S): M => member(s.patch, fmKeys(s.patch), 'vca');
const fmEnv = (s: S): M => member(s.patch, fmKeys(s.patch), 'env');

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
      ...need(added('an Oscillator', 'osc'), cable('Main pitch → Oscillator pitch', main, 'pitch', one('osc'), 'pitch')),
      apply: (a) => a.edit((p) => { const o = mod(p, 'osc') ?? place(p, 'osc'); wire(p, mod(p, 'fm1'), 'pitch', o, 'pitch'); }),
    },
    {
      id: 'dup', title: 'Duplicate it',
      text: 'Click the Oscillator to select it and press Ctrl+D (Cmd+D), or Commands → Duplicate selection. The copy keeps its settings and its pitch cable.',
      ...need(['Duplicate the Oscillator (Ctrl+D)', (s) => has(s.patch, 'osc', 2), (s) => T.module(one('osc')(s)?.id)], ['Cable Main pitch → the second Oscillator’s pitch', (s) => mods(s.patch, 'osc').every((o) => cabled(s.patch, main(s), 'pitch', o, 'pitch')), (s) => { const left = mods(s.patch, 'osc').filter((o) => !cabled(s.patch, main(s), 'pitch', o, 'pitch')); return (left.length ? left : mods(s.patch, 'osc')).flatMap((o) => T.port(o, 'pitch', 'in')); }]),
      apply: (a) => a.edit((p) => { const o = place(p, 'osc'); wire(p, mod(p, 'fm1'), 'pitch', o, 'pitch'); }),
    },
    {
      id: 'pm', title: 'Modulator into carrier',
      text: 'Cable the second Oscillator’s out into the first one’s pm input, and set the first one’s pm slider (the depth) to about 2. The first is now the carrier, the second the modulator.',
      why: 'pm is phase modulation, what the DX7 and this engine do; it sounds like FM. The depth slider is the modulation index: 0 is a sine, 8 is a wall of harmonics.',
      ...need(['Cable the second Oscillator’s out → the first one’s pm', (s) => !!carrier(s), (s) => [...T.port(one('osc', 1)(s), 'out', 'out'), ...T.port(one('osc')(s), 'pm', 'in')]], knob('the carrier’s pm slider to 1 or more', carrier, 'pm', (v) => v >= 1)),
      apply: (a) => a.edit((p) => { const [c, m] = mods(p, 'osc'); wire(p, m, 'out', c, 'pm'); c.params.pm = 2; }),
    },
    {
      id: 'ratio', title: 'Set the ratio',
      text: 'Set the modulator’s coarse to +12: an octave above the carrier, a 2:1 ratio, hollow like a clarinet. Try +19 (3:1) and +7 for a bell-like clang.',
      why: 'Whole-number ratios give harmonic spectra; odd ratios like 1.41 give inharmonic, metallic ones. coarse is in semitones.',
      ...need(knob('the modulator’s coarse off 0', modulator, 'coarse', (v) => v !== 0)),
      apply: (a) => a.edit((p) => { modulator({ patch: p } as S)!.params.coarse = 12; }),
    },
    {
      id: 'env', title: 'Loudness from a level / rate envelope', superseded: true,
      text: 'Add a VCA and an Env L/R. Cable carrier out → VCA in, Main gate → Env gate, Env env → VCA cv, VCA out → Output l.',
      why: 'Env L/R is the DX7 envelope: four levels and the rate to reach each one. The last level, l4, is where the note ends after the key is released.',
      ...need(
        added('a VCA', 'vca'),
        added('an Env L/R', 'env'),
        cable('carrier out → VCA in', carrier, 'out', one('vca'), 'in'),
        cable('Main gate → Env gate', main, 'gate', one('env'), 'gate'),
        cable('Env env → VCA cv', one('env'), 'env', one('vca'), 'cv'),
        cable('VCA out → Output l', one('vca'), 'out', out, 'l'),
      ),
      apply: (a) => a.edit((p) => { const v = mod(p, 'vca') ?? place(p, 'vca'); const e = mod(p, 'env') ?? place(p, 'env'); wire(p, carrier({ patch: p } as S), 'out', v, 'in'); wire(p, mod(p, 'fm1'), 'gate', e, 'gate'); wire(p, e, 'env', v, 'cv'); wire(p, v, 'out', mod(p, 'output'), 'l'); }),
    },
    {
      id: 'index', title: 'Brightness from the same envelope',
      text: 'Alt-drag the carrier’s pm thumb onto the Env’s env jack. Set the Env’s l2 to 0.3 and r2 to 0.4 s: the note starts bright and mellows while it decays.',
      ...need(['Drop the Env’s env on the carrier’s pm thumb', (s) => pinned(s.patch, mod(s.patch, 'env'), 'env', carrier(s), 'pm'), (s) => [...T.param(carrier(s), 'pm'), ...T.port(one('env')(s), 'env', 'out')]], knob('the Env’s l2 to 0.5 or less', one('env'), 'l2', (v) => v <= 0.5)),
      apply: (a) => a.edit((p) => { const c = carrier({ patch: p } as S)!; const e = mod(p, 'env')!; connectParameter(p, DEFS, { module: e.id, port: 'env' }, c.id, 'pm'); e.params.l2 = 0.3; e.params.r2 = 0.4; }),
    },
    {
      id: 'group', title: 'Group it as FM keys',
      text: 'Select both Oscillators, the Env and the VCA and press G. Name it FM keys. It exposes pitch (twice, one per oscillator), gate and out.',
      ...need(['Group both Oscillators, the Env and the VCA (press G)', (s) => !!fmKeys(s.patch), (s) => [...mods(s.patch, 'osc'), ...mods(s.patch, 'env'), ...mods(s.patch, 'vca')].flatMap((m) => T.module(m.id))]),
      apply: (a) => a.edit((p) => makeAssembly(p, [...mods(p, 'osc'), mod(p, 'env')!, mod(p, 'vca')!].map((m) => m.id), 'FM keys')),
    },
    {
      id: 'insert', title: 'Insert My space',
      text: 'Click + Add assembly and pick My space under Your library (the one you saved in chapter 5). It arrives as one card.',
      ...need(['Insert My space from your library', (s) => !!mySpace(s.patch), () => T.ui('add-assembly-btn')]),
      apply: (a) => insertDef(a, 'my-space', 'My space'),
    },
    {
      id: 'wire', title: 'Put the effect behind the keys',
      text: 'Cable FM keys out → My space in, My space l → Output l and My space r → Output r. Remove the cable from FM keys to Output.',
      ...need(
        cable('FM keys out → My space in', fmOut, 'out', spaceIn, 'in'),
        cable('My space l → Output l', spaceOut, 'l', out, 'l'),
        cable('My space r → Output r', spaceOut, 'r', out, 'r'),
        gone('FM keys out → Output l', fmOut, 'out', out, 'l'),
      ),
      apply: (a) => a.edit((p) => { const s = { patch: p } as S; const v = fmOut(s); const o = mod(p, 'output'); wire(p, v, 'out', spaceIn(s), 'in'); wire(p, spaceOut(s), 'l', o, 'l'); wire(p, spaceOut(s), 'r', o, 'r'); unwire(p, v, 'out', o, 'l'); }),
    },
    {
      id: 'nest', title: 'Nest the effect inside the instrument',
      text: 'Expand FM keys and drag the My space card into its frame by its header: it becomes part of FM keys, which now exposes l and r itself. Collapse FM keys.',
      why: 'Assemblies nest three levels deep. An instrument that carries its own effect is one card wherever you use it.',
      ...need(['Drag the My space card into the FM keys frame', (s) => { const k = fmKeys(s.patch); const sp = mySpace(s.patch); return !!k && !!sp && !!k.children?.includes(sp.id); }, (s) => [...fmAsm(s), ...spaceAsm(s)]], ['Collapse FM keys', (s) => !!fmKeys(s.patch) && !fmKeys(s.patch)!.open, fmAsm]),
      apply: (a) => a.edit((p) => { const k = fmKeys(p)!; const sp = mySpace(p)!; addChild(p, k, sp.id); k.open = false; }),
    },
    {
      id: 'save', title: 'Save FM keys', transient: true,
      text: 'Click save on the FM keys card. My space travels inside it.',
      ...need(['Save it as "FM keys" (save on the card)', (s) => !!findDef(s.library, 'fm-keys', 'FM keys'), fmAsm]),
      apply: (a) => { const p = a.patch(); const k = fmKeys(p)!; k.name = 'FM keys'; a.saveAssembly(toDef(p, k), 'fm-keys'); },
    },
  ],
};

// ---- chapter 7

const PLUCK_TYPES = ['string', 'modal'];
const pluck = (p: Patch) => asmLike(p, PLUCK_TYPES);
const pluckAsm = (s: S) => T.asm(pluck(s.patch)?.id);
const pluckString = (s: S): M => member(s.patch, pluck(s.patch), 'string');

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
      ...need(
        added('a String', 'string'),
        cable('Main pitch → String pitch', main, 'pitch', one('string'), 'pitch'),
        cable('Main gate → String gate', main, 'gate', one('string'), 'gate'),
        cable('String out → Output l', one('string'), 'out', out, 'l'),
      ),
      apply: (a) => a.edit((p) => { const st = mod(p, 'string') ?? place(p, 'string'); wire(p, mod(p, 'fm1'), 'pitch', st, 'pitch'); wire(p, mod(p, 'fm1'), 'gate', st, 'gate'); wire(p, st, 'out', mod(p, 'output'), 'l'); }),
    },
    {
      id: 'decay', title: 'Let it ring',
      text: 'Set the String’s decay to about 4 s and damp to 0.1: a long, bright note. Switch burst to pulse for a harder pick.',
      why: 'The string is a delay line as long as one period, with feedback. decay sets how much is fed back, damp how fast the highs are lost on each round trip.',
      ...need(knob('decay to 3 s or more', one('string'), 'decay', (v) => v >= 3), knob('damp to 0.15 or less', one('string'), 'damp', (v) => v <= 0.15)),
      apply: (a) => a.edit((p) => { const st = mod(p, 'string')!; st.params.decay = 4; st.params.damp = 0.1; }),
    },
    {
      id: 'voices', title: 'Play chords',
      text: 'On the Main card set voices to 4. The String card shows ×4: it runs once per voice. Hold a chord.',
      why: 'Every module that hears pitch, gate or velocity runs once per voice; effects and the Output stay single and sum the voices.',
      ...need(['Set voices to 2 or more on the Main card', (s) => (s.patch.voices ?? 1) >= 2, (s) => T.module(main(s)?.id)]),
      apply: (a) => a.edit((p) => { p.voices = 4; }),
    },
    {
      id: 'modal', title: 'Strike a body with it',
      text: 'Add a Modal. Cable String out → Modal in and Modal out → Output r. Set struct to 0.5 and decay to 2 s: the string now rings a bell-like body.',
      ...need(
        added('a Modal', 'modal'),
        cable('String out → Modal in', one('string'), 'out', one('modal'), 'in'),
        cable('Modal out → Output r', one('modal'), 'out', out, 'r'),
        knob('struct to 0.3 or more', one('modal'), 'struct', (v) => v >= 0.3),
      ),
      apply: (a) => a.edit((p) => { const m = mod(p, 'modal') ?? place(p, 'modal'); wire(p, mod(p, 'string'), 'out', m, 'in'); wire(p, m, 'out', mod(p, 'output'), 'r'); m.params.struct = 0.5; m.params.decay = 2; }),
    },
    {
      id: 'comb', title: 'Blow noise through a comb', superseded: true,
      text: 'Add Noise, a Comb and a VCA. Cable Noise out → Comb in, Main pitch → Comb pitch, Comb out → VCA in, Main gate → VCA cv, VCA out → Output l.',
      why: 'A comb filter is a tuned delay line: noise through it rings at the note, like breath through a pipe. The VCA is a simple on / off here, straight from the gate.',
      ...need(
        added('Noise', 'noise'), added('a Comb', 'comb'), added('a VCA', 'vca'),
        cable('Noise out → Comb in', one('noise'), 'out', one('comb'), 'in'),
        cable('Main pitch → Comb pitch', main, 'pitch', one('comb'), 'pitch'),
        cable('Comb out → VCA in', one('comb'), 'out', one('vca'), 'in'),
        cable('Main gate → VCA cv', main, 'gate', one('vca'), 'cv'),
        cable('VCA out → Output l', one('vca'), 'out', out, 'l'),
      ),
      apply: (a) => a.edit((p) => { const n = mod(p, 'noise') ?? place(p, 'noise'); const c = mod(p, 'comb') ?? place(p, 'comb'); const v = mod(p, 'vca') ?? place(p, 'vca'); wire(p, n, 'out', c, 'in'); wire(p, mod(p, 'fm1'), 'pitch', c, 'pitch'); wire(p, c, 'out', v, 'in'); wire(p, mod(p, 'fm1'), 'gate', v, 'cv'); wire(p, v, 'out', mod(p, 'output'), 'l'); }),
    },
    {
      id: 'fb', title: 'Make it ring',
      text: 'Set the Comb’s fb to 0.95 and damp to 0.1: the noise turns into a breathy, whistling tone at the note.',
      ...need(knob('the Comb’s fb to 0.9 or more', one('comb'), 'fb', (v) => v >= 0.9)),
      apply: (a) => a.edit((p) => { const c = mod(p, 'comb')!; c.params.fb = 0.95; c.params.damp = 0.1; }),
    },
    {
      id: 'glide', title: 'Slide between notes',
      text: 'Add a Glide. Cable Main pitch → Glide in and Glide out → Comb pitch, and remove the cable from Main’s pitch to the Comb. Set time to 0.3 s and play two notes.',
      why: 'Glide (portamento) slews a control signal: the pitch takes time to arrive. It works on any control cable, not only pitch.',
      ...need(
        added('a Glide', 'glide'),
        cable('Main pitch → Glide in', main, 'pitch', one('glide'), 'in'),
        cable('Glide out → Comb pitch', one('glide'), 'out', one('comb'), 'pitch'),
        gone('Main pitch → Comb pitch', main, 'pitch', one('comb'), 'pitch'),
      ),
      apply: (a) => a.edit((p) => { const g = mod(p, 'glide') ?? place(p, 'glide'); wire(p, mod(p, 'fm1'), 'pitch', g, 'in'); wire(p, g, 'out', mod(p, 'comb'), 'pitch'); unwire(p, mod(p, 'fm1'), 'pitch', mod(p, 'comb'), 'pitch'); g.params.time = 0.3; }),
    },
    {
      id: 'group', title: 'Group the pluck',
      text: 'Select the String and the Modal and press G. Name it Pluck. Expand it, click ○ on the String’s decay and the Modal’s struct, and collapse it again.',
      ...need(
        ['Group the String and the Modal (press G)', (s) => !!pluck(s.patch), (s) => PLUCK_TYPES.flatMap((t) => T.module(mod(s.patch, t)?.id))],
        promoted('the String’s decay', pluck, 'string', 'decay'),
        promoted('the Modal’s struct', pluck, 'modal', 'struct'),
        ['Collapse the assembly', (s) => !!pluck(s.patch) && !pluck(s.patch)!.open, pluckAsm],
      ),
      apply: (a) => a.edit((p) => { const pl = pluck(p) ?? makeAssembly(p, PLUCK_TYPES.map((t) => mod(p, t)!.id), 'Pluck'); promote(pl, member(p, pl, 'string')!.id, 'decay'); promote(pl, member(p, pl, 'modal')!.id, 'struct'); pl.open = false; }),
    },
    {
      id: 'save', title: 'Save Pluck', transient: true,
      text: 'Click save on the Pluck card. Chapter 10 plays it from a melody machine.',
      ...need(['Save it as "Pluck" (save on the card)', (s) => !!findDef(s.library, 'pluck', 'Pluck'), pluckAsm]),
      apply: (a) => { const p = a.patch(); const pl = pluck(p)!; pl.name = 'Pluck'; a.saveAssembly(toDef(p, pl), 'pluck'); },
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
      ...need(added('a Wavetable', 'wavetable'), cable('Main pitch → Wavetable pitch', main, 'pitch', one('wavetable'), 'pitch'), knob('bank to formant', one('wavetable'), 'bank', (v) => v === 2)),
      apply: (a) => a.edit((p) => { const w = mod(p, 'wavetable') ?? place(p, 'wavetable'); wire(p, mod(p, 'fm1'), 'pitch', w, 'pitch'); w.params.bank = 2; }),
    },
    {
      id: 'lfo', title: 'Sweep the table',
      text: 'Add an LFO with rate 0.2 Hz. Alt-drag the Wavetable’s pos thumb onto the LFO’s out (or drop the LFO’s cable on the thumb). The position now sweeps on its own.',
      ...need(added('an LFO', 'lfo'), ['Drop the LFO’s out on the pos thumb', (s) => pinned(s.patch, mod(s.patch, 'lfo'), 'out', mod(s.patch, 'wavetable'), 'pos'), (s) => [...T.param(one('wavetable')(s), 'pos'), ...T.port(one('lfo')(s), 'out', 'out')]], knob('the LFO’s rate to 0.5 Hz or below', one('lfo'), 'rate', (v) => v <= 0.5)),
      apply: (a) => a.edit((p) => { const l = mod(p, 'lfo') ?? place(p, 'lfo'); l.params.rate = 0.2; connectParameter(p, DEFS, { module: l.id, port: 'out' }, mod(p, 'wavetable')!.id, 'pos'); }),
    },
    {
      id: 'env', title: 'A slow envelope',
      text: 'Add an ADSR and a VCA. Cable Main gate → ADSR gate, ADSR env → VCA cv, Wavetable out → VCA in. Set a to 1 s and r to 2 s: a pad.',
      ...need(
        added('an ADSR', 'adsr'), added('a VCA', 'vca'),
        cable('Main gate → ADSR gate', main, 'gate', one('adsr'), 'gate'),
        cable('ADSR env → VCA cv', one('adsr'), 'env', one('vca'), 'cv'),
        cable('Wavetable out → VCA in', one('wavetable'), 'out', one('vca'), 'in'),
        knob('a to 0.5 s or more', one('adsr'), 'a', (v) => v >= 0.5), knob('r to 1 s or more', one('adsr'), 'r', (v) => v >= 1),
      ),
      apply: (a) => a.edit((p) => { const e = mod(p, 'adsr') ?? place(p, 'adsr'); const v = mod(p, 'vca') ?? place(p, 'vca'); wire(p, mod(p, 'fm1'), 'gate', e, 'gate'); wire(p, e, 'env', v, 'cv'); wire(p, mod(p, 'wavetable'), 'out', v, 'in'); e.params.a = 1; e.params.r = 2; }),
    },
    {
      id: 'grain', title: 'Into the cloud',
      text: 'Add a Granular. Cable VCA out → Granular in and Main gate → Granular trig. Set size to 0.15 s, density to 40, spray to 0.5 and pitch to +12.',
      why: 'The granular module records what comes in and plays tiny windows of it, spread over position, time and pitch. spray is how far the grains wander from the position.',
      ...need(
        added('a Granular', 'grain'),
        cable('VCA out → Granular in', one('vca'), 'out', one('grain'), 'in'),
        cable('Main gate → Granular trig', main, 'gate', one('grain'), 'trig'),
        knob('spray to 0.3 or more', one('grain'), 'spray', (v) => v >= 0.3), knob('pitch off 0', one('grain'), 'pitch', (v) => v !== 0),
      ),
      apply: (a) => a.edit((p) => { const g = mod(p, 'grain') ?? place(p, 'grain'); wire(p, mod(p, 'vca'), 'out', g, 'in'); wire(p, mod(p, 'fm1'), 'gate', g, 'trig'); Object.assign(g.params, { size: 0.15, density: 40, spray: 0.5, pitch: 12 }); }),
    },
    {
      id: 'pan', title: 'Place it in the stereo field', superseded: true,
      text: 'Add a Pan. Cable Granular out → Pan in, Pan l → Output l, Pan r → Output r. Then drop the LFO’s out on the pan slider’s thumb: pos is the Pan’s built-in input, so the cable goes there.',
      ...need(
        added('a Pan', 'pan'),
        cable('Granular out → Pan in', one('grain'), 'out', one('pan'), 'in'),
        cable('Pan l → Output l', one('pan'), 'l', out, 'l'), cable('Pan r → Output r', one('pan'), 'r', out, 'r'),
        cable('LFO out → Pan pos (drop it on the pan thumb)', one('lfo'), 'out', one('pan'), 'pos'),
      ),
      apply: (a) => a.edit((p) => { const pn = mod(p, 'pan') ?? place(p, 'pan'); const o = mod(p, 'output'); wire(p, mod(p, 'grain'), 'out', pn, 'in'); wire(p, pn, 'l', o, 'l'); wire(p, pn, 'r', o, 'r'); wire(p, mod(p, 'lfo'), 'out', pn, 'pos'); }),
    },
    {
      id: 'phaser', title: 'A phaser on the way out',
      text: 'Add a Phaser between the Granular and the Pan: Granular out → Phaser in, Phaser out → Pan in, and remove the cable from the Granular to the Pan.',
      ...need(
        added('a Phaser', 'phaser'),
        cable('Granular out → Phaser in', one('grain'), 'out', one('phaser'), 'in'),
        cable('Phaser out → Pan in', one('phaser'), 'out', one('pan'), 'in'),
        gone('Granular out → Pan in', one('grain'), 'out', one('pan'), 'in'),
      ),
      apply: (a) => a.edit((p) => { const ph = mod(p, 'phaser') ?? place(p, 'phaser'); wire(p, mod(p, 'grain'), 'out', ph, 'in'); wire(p, ph, 'out', mod(p, 'pan'), 'in'); unwire(p, mod(p, 'grain'), 'out', mod(p, 'pan'), 'in'); }),
    },
    {
      id: 'zoom', title: 'Zoom out', transient: true,
      text: 'Nine cards no longer fit. Hold Ctrl (Cmd) and scroll to zoom, pinch on a touch screen, or use Commands → Fit patch to screen.',
      ...need(['Zoom the canvas (Ctrl+wheel, or Fit patch to screen)', (s) => s.seen.zooms > 0, () => T.ui('palette-btn')]),
      apply: (a) => a.zoomToFit(),
    },
    {
      id: 'spectrum', title: 'Watch the cloud', transient: true,
      text: 'Click ◎ on the Granular’s out and switch the scope to Spectrum. Hold a note: the grains smear the harmonics into a band.',
      ...need(['Click ◎ beside the Granular’s out', (s) => s.probes.has(`${mod(s.patch, 'grain')?.id}:out`), (s) => T.port(one('grain')(s), 'out', 'out')]),
      apply: (a) => { const g = mod(a.patch(), 'grain'); if (g) a.probe(g.id, 'out'); },
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
      ...need(
        ['Insert My voice from your library', (s) => !!myVoice(s.patch), () => T.ui('add-assembly-btn')],
        cable('Main pitch → My voice pitch', main, 'pitch', inVoice('osc'), 'pitch'),
        cable('Main gate → My voice gate', main, 'gate', inVoice('adsr'), 'gate'),
      ),
      apply: (a) => { if (!myVoice(a.patch())) insertDef(a, 'my-voice', 'My voice'); a.edit((p) => { const v = myVoice(p); wire(p, mod(p, 'fm1'), 'pitch', member(p, v, 'osc'), 'pitch'); wire(p, mod(p, 'fm1'), 'gate', member(p, v, 'adsr'), 'gate'); }); },
    },
    {
      id: 'fm', title: 'Insert FM keys',
      text: 'Insert FM keys the same way. Its card shows two pitch inputs, one per oscillator, and a gate.',
      ...need(['Insert FM keys from your library', (s) => !!fmKeys(s.patch), () => T.ui('add-assembly-btn')]),
      apply: (a) => insertDef(a, 'fm-keys', 'FM keys'),
    },
    {
      id: 'merge', title: 'Merge the two pitch inputs',
      text: 'Expand FM keys. Next to one of the exposed pitch inputs open merge into… and choose the other pitch. One pitch jack now feeds both oscillators. Collapse it.',
      why: 'A merged input sends one cable to several inner inputs. Split undoes it.',
      ...need(['Merge the two pitch inputs of FM keys (merge into…)', (s) => !!fmKeys(s.patch)?.inputs.some((r) => r.port === 'pitch' && !!r.also?.length), fmAsm], ['Collapse FM keys', (s) => !!fmKeys(s.patch) && !fmKeys(s.patch)!.open, fmAsm]),
      apply: (a) => a.edit((p) => { const k = fmKeys(p)!; const [c, m] = fmOscs(p); mergePorts(p, k, DEFS, { module: c.id, port: 'pitch' }, { module: m.id, port: 'pitch' }); k.open = false; }),
    },
    {
      id: 'wire', title: 'Cable the second instrument',
      text: 'Cable Main pitch → FM keys pitch and Main gate → FM keys gate. Both instruments now play together.',
      ...need(
        ['Cable Main pitch → FM keys pitch', (s) => fmOscs(s.patch).length > 0 && fmOscs(s.patch).every((o) => cabled(s.patch, main(s), 'pitch', o, 'pitch')), (s) => [...T.port(main(s), 'pitch', 'out'), ...fmOscs(s.patch).filter((o) => !cabled(s.patch, main(s), 'pitch', o, 'pitch')).flatMap((o) => T.port(o, 'pitch', 'in'))]],
        cable('Main gate → FM keys gate', main, 'gate', fmEnv, 'gate'),
      ),
      apply: (a) => a.edit((p) => { for (const o of fmOscs(p)) wire(p, mod(p, 'fm1'), 'pitch', o, 'pitch'); wire(p, mod(p, 'fm1'), 'gate', member(p, fmKeys(p), 'env'), 'gate'); }),
    },
    {
      id: 'mixer', title: 'Mix them',
      text: 'Add a Mixer 4. Cable My voice out → in1, FM keys l → in2, FM keys r → in3, and Mixer out → Output l and r. l1..l4 are the levels.',
      ...need(
        added('a Mixer 4', 'mixer'),
        cable('My voice out → Mixer in1', voiceOut, 'out', one('mixer'), 'in1'),
        cable('FM keys l → Mixer in2', spaceOut, 'l', one('mixer'), 'in2'),
        cable('FM keys r → Mixer in3', spaceOut, 'r', one('mixer'), 'in3'),
        cable('Mixer out → Output l', one('mixer'), 'out', out, 'l'), cable('Mixer out → Output r', one('mixer'), 'out', out, 'r'),
      ),
      apply: (a) => a.edit((p) => { const s = { patch: p } as S; const mx = mod(p, 'mixer') ?? place(p, 'mixer'); const o = mod(p, 'output'); wire(p, voiceOut(s), 'out', mx, 'in1'); wire(p, spaceOut(s), 'l', mx, 'in2'); wire(p, spaceOut(s), 'r', mx, 'in3'); wire(p, mx, 'out', o, 'l'); wire(p, mx, 'out', o, 'r'); }),
    },
    {
      id: 'arp', title: 'Let the arpeggiator play', transient: true,
      text: 'Open the arp panel on the Main card and press Space (or Commands → arpeggiator). Hold a chord: the keys are played one after another at the rate shown.',
      ...need(['Enable the arpeggiator (Space)', (s) => s.arpPlay, (s) => T.module(main(s)?.id)]),
      apply: (a) => a.arpPlay(true),
    },
    {
      id: 'macro', title: 'A knob with a range',
      text: 'Cable Main k2 → My voice p1 (the pin of the Filter inside). Open the ⋯ menu of My voice’s cutoff, tick P1 and Map between two values, then set the ends to about 0.3 and 0.8.',
      why: 'A macro range maps the knob’s whole travel onto a slice of the parameter: the useful part of the cutoff instead of 20 Hz to 16 kHz.',
      ...need(
        cable('Main k2 → My voice p1', main, 'k2', inVoice('filter'), 'p1'),
        ['Tick P1 in the ⋯ menu of cutoff', (s) => !!inVoice('filter')(s)?.map?.p1.includes('cutoff'), (s) => T.param(inVoice('filter')(s), 'cutoff')],
        ['Tick "Map between two values" for cutoff', (s) => !!inVoice('filter')(s)?.range?.p1?.cutoff, (s) => T.param(inVoice('filter')(s), 'cutoff')],
      ),
      apply: (a) => a.edit((p) => { const f = member(p, myVoice(p), 'filter')!; wire(p, mod(p, 'fm1'), 'k2', f, 'p1'); setParameterInput(f, 'p1', 'cutoff', true); ((f.range ??= {}).p1 ??= {}).cutoff = [0.3, 0.8]; }),
    },
    {
      id: 'morph', title: 'Morph between two settings', transient: true,
      text: 'Commands → Set snapshot A. Change a few sliders (cutoff, the mixer levels), then Commands → Set snapshot B. Press Alt+B to flip between them; the Main card’s morph slider fades from one to the other once the B side is picked.',
      ...need(['Set snapshot A (Commands)', (s) => !!s.snapshots.A, () => T.ui('palette-btn')], ['Set snapshot B (Commands)', (s) => !!s.snapshots.B, () => T.ui('palette-btn')], ['Press Alt+B', (s) => s.seen.flips > 0, () => T.ui('palette-btn')]),
      apply: (a) => { a.snapshot('A'); a.edit((p) => { const mx = mod(p, 'mixer'); if (mx) mx.params.l1 = 0.4; }); a.snapshot('B'); a.flipAB(); },
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
      ...need(added('an LFO', 'lfo'), knob('its wave to square', one('lfo'), 'wave', (v) => v === WAVE.square), knob('its rate to 2 Hz or more', one('lfo'), 'rate', (v) => v >= 2)),
      apply: (a) => a.edit((p) => { const l = mod(p, 'lfo') ?? place(p, 'lfo'); l.params.wave = WAVE.square; l.params.rate = 4; }),
    },
    {
      id: 'div', title: 'Divide it', superseded: true,
      text: 'Add a Clock div and cable LFO out → Clock div clock. Its outputs out, d2, d4 and d8 tick every div, 2, 4 and 8 ticks.',
      ...need(added('a Clock div', 'clkdiv'), cable('LFO out → Clock div clock', one('lfo'), 'out', one('clkdiv'), 'clock')),
      apply: (a) => a.edit((p) => { const d = mod(p, 'clkdiv') ?? place(p, 'clkdiv'); wire(p, mod(p, 'lfo'), 'out', d, 'clock'); }),
    },
    {
      id: 'sh', title: 'A random value per tick',
      text: 'Add Noise and an S&H (sample and hold). Cable Noise out → S&H in and Clock div out → S&H clock. On every tick the S&H grabs the noise’s value and holds it.',
      ...need(added('Noise', 'noise'), added('an S&H', 'sh'), cable('Noise out → S&H in', one('noise'), 'out', one('sh'), 'in'), cable('Clock div out → S&H clock', one('clkdiv'), 'out', one('sh'), 'clock')),
      apply: (a) => a.edit((p) => { const n = mod(p, 'noise') ?? place(p, 'noise'); const sh = mod(p, 'sh') ?? place(p, 'sh'); wire(p, n, 'out', sh, 'in'); wire(p, mod(p, 'clkdiv'), 'out', sh, 'clock'); }),
    },
    {
      id: 'quant', title: 'Snap it to a scale', superseded: true,
      text: 'Add a Quantizer, cable S&H out → Quantizer in and set scale to pent min. Random voltages become notes of a pentatonic minor scale.',
      why: 'Pitch is a control signal: one unit per octave, a semitone is a twelfth. The quantizer rounds to the nearest note of the scale, which is why random noise sounds like a melody.',
      ...need(added('a Quantizer', 'quant'), cable('S&H out → Quantizer in', one('sh'), 'out', one('quant'), 'in'), knob('scale to pent min', one('quant'), 'scale', (v) => v === SCALE_PENT_MIN)),
      apply: (a) => a.edit((p) => { const q = mod(p, 'quant') ?? place(p, 'quant'); wire(p, mod(p, 'sh'), 'out', q, 'in'); q.params.scale = SCALE_PENT_MIN; }),
    },
    {
      id: 'pluck', title: 'Play Pluck with it',
      text: 'Insert Pluck from Your library. Cable Quantizer out → Pluck pitch, Clock div out → Pluck gate and Pluck out → Output l. The machine plays on its own now.',
      ...need(
        ['Insert Pluck from your library', (s) => !!pluck(s.patch), () => T.ui('add-assembly-btn')],
        cable('Quantizer out → Pluck pitch', one('quant'), 'out', pluckString, 'pitch'),
        cable('Clock div out → Pluck gate', one('clkdiv'), 'out', pluckString, 'gate'),
        ['Cable Pluck out → Output l', (s) => { const pl = pluck(s.patch); return cabled(s.patch, member(s.patch, pl, 'string'), 'out', out(s), 'l') || cabled(s.patch, member(s.patch, pl, 'modal'), 'out', out(s), 'l'); }, (s) => [...T.port(pluckString(s), 'out', 'out'), ...T.port(out(s), 'l', 'in')]],
      ),
      apply: (a) => { if (!pluck(a.patch())) insertDef(a, 'pluck', 'Pluck'); a.edit((p) => { const pl = pluck(p); const st = member(p, pl, 'string'); wire(p, mod(p, 'quant'), 'out', st, 'pitch'); wire(p, mod(p, 'clkdiv'), 'out', st, 'gate'); wire(p, st, 'out', mod(p, 'output'), 'l'); }); },
    },
    {
      id: 'pulse', title: 'FM keys on every second tick',
      text: 'Add a Pulse with time 0.05 s and cable Clock div d2 → Pulse trig. Insert FM keys; cable Quantizer out → FM keys pitch, Pulse out → FM keys gate, FM keys l → Output r.',
      why: 'A divider output stays high for half its period, which would hold FM keys’ envelope open. The pulse makes a short gate out of each tick instead.',
      ...need(
        added('a Pulse', 'pulse'), knob('the Pulse’s time to 0.1 s or less', one('pulse'), 'time', (v) => v <= 0.1),
        cable('Clock div d2 → Pulse trig', one('clkdiv'), 'd2', one('pulse'), 'trig'),
        ['Insert FM keys from your library', (s) => !!fmKeys(s.patch), () => T.ui('add-assembly-btn')],
        ['Cable Quantizer out → FM keys pitch', (s) => fmOscs(s.patch).some((o) => cabled(s.patch, one('quant')(s), 'out', o, 'pitch')), (s) => [...T.port(one('quant')(s), 'out', 'out'), ...T.port(fmOscs(s.patch)[0], 'pitch', 'in')]],
        cable('Pulse out → FM keys gate', one('pulse'), 'out', fmEnv, 'gate'),
        cable('FM keys l → Output r', spaceOut, 'l', out, 'r'),
      ),
      apply: (a) => { if (!fmKeys(a.patch())) insertDef(a, 'fm-keys', 'FM keys'); a.edit((p) => { const s = { patch: p } as S; const pu = mod(p, 'pulse') ?? place(p, 'pulse'); pu.params.time = 0.05; wire(p, mod(p, 'clkdiv'), 'd2', pu, 'trig'); for (const o of fmOscs(p)) wire(p, mod(p, 'quant'), 'out', o, 'pitch'); wire(p, pu, 'out', fmEnv(s), 'gate'); wire(p, spaceOut(s), 'l', mod(p, 'output'), 'r'); }); },
    },
    {
      id: 'seq', title: 'A written melody instead',
      text: 'Add a Sequencer, cable LFO out → Sequencer clock and Sequencer out → Quantizer in, and remove the cable from the S&H to the Quantizer. Set s1..s4 to a few different values; len to 4.',
      why: 'The Sequencer’s steps are the same kind of signal the S&H made, just chosen by you. Through the quantizer the steps land on scale notes whatever you set them to.',
      ...need(
        added('a Sequencer', 'seq'),
        cable('LFO out → Sequencer clock', one('lfo'), 'out', one('seq'), 'clock'),
        cable('Sequencer out → Quantizer in', one('seq'), 'out', one('quant'), 'in'),
        gone('S&H out → Quantizer in', one('sh'), 'out', one('quant'), 'in'),
        knob('len to 4 or less', one('seq'), 'len', (v) => v <= 4),
      ),
      apply: (a) => a.edit((p) => { const sq = mod(p, 'seq') ?? place(p, 'seq'); wire(p, mod(p, 'lfo'), 'out', sq, 'clock'); wire(p, sq, 'out', mod(p, 'quant'), 'in'); unwire(p, mod(p, 'sh'), 'out', mod(p, 'quant'), 'in'); Object.assign(sq.params, { s1: 0, s2: 0.25, s3: 0.583, s4: 0.417, len: 4 }); }),
    },
    {
      id: 'mainclock', title: 'Lock to the arpeggiator’s clock',
      text: 'Cable Main clock → Clock div clock and remove the LFO’s cable to it; set the Clock div’s div to 6. Press Space: Main’s clock now ticks 24 times per beat at the arp tempo, and on the FM-1 it follows MIDI clock.',
      ...need(
        cable('Main clock → Clock div clock', main, 'clock', one('clkdiv'), 'clock'),
        gone('LFO out → Clock div clock', one('lfo'), 'out', one('clkdiv'), 'clock'),
        knob('the Clock div’s div to 4 or more', one('clkdiv'), 'div', (v) => v >= 4),
      ),
      apply: (a) => { a.edit((p) => { const d = mod(p, 'clkdiv')!; wire(p, mod(p, 'fm1'), 'clock', d, 'clock'); unwire(p, mod(p, 'lfo'), 'out', d, 'clock'); d.params.div = 6; }); a.arpPlay(true); },
    },
  ],
};

// ---- chapter 11

const HAT_TYPES = ['noise', 'filter', 'env', 'vca'];
const hat = (p: Patch) => asmLike(p, HAT_TYPES);
const hatAsm = (s: S) => T.asm(hat(s.patch)?.id);
const hatGate = (s: S): M => member(s.patch, hat(s.patch), 'env');
const hatOut = (s: S): M => member(s.patch, hat(s.patch), 'vca');
const factoryAsm = (p: Patch, name: string) => (p.assemblies ?? []).find((a) => a.name.toLowerCase() === name);
const gateOf = (p: Patch, name: string) => factoryAsm(p, name)?.inputs.find((r) => r.label === 'gate');
const outOf = (p: Patch, name: string) => factoryAsm(p, name)?.outputs[0];
const drumGate = (name: string) => (s: S): M => { const g = gateOf(s.patch, name); return g && byId(s.patch, g.module); };
const drumOut = (name: string) => (s: S): M => { const r = outOf(s.patch, name); return r && byId(s.patch, r.module); };
const drumGatePort = (name: string, s: S): string => gateOf(s.patch, name)?.port ?? 'gate';
const drumOutPort = (name: string, s: S): string => outOf(s.patch, name)?.port ?? 'out';

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
      ...need(added('Noise', 'noise'), added('a Filter', 'filter'), cable('Noise out → Filter in', one('noise'), 'out', one('filter'), 'in'), knob('cutoff to 4 kHz or more', one('filter'), 'cutoff', (v) => v >= 4000)),
      apply: (a) => a.edit((p) => { const n = mod(p, 'noise') ?? place(p, 'noise'); const f = mod(p, 'filter') ?? place(p, 'filter'); wire(p, n, 'out', f, 'in'); f.params.cutoff = 6000; }),
    },
    {
      id: 'env', title: 'A very short envelope', superseded: true,
      text: 'Add an Env L/R and a VCA. Cable Filter hp → VCA in, Main gate → Env gate, Env env → VCA cv, VCA out → Output l. Set the Env’s l2 to 0 and r2 to 0.08 s. Tap a key.',
      ...need(
        added('an Env L/R', 'env'), added('a VCA', 'vca'),
        cable('Filter hp → VCA in', one('filter'), 'hp', one('vca'), 'in'),
        cable('Main gate → Env gate', main, 'gate', one('env'), 'gate'),
        cable('Env env → VCA cv', one('env'), 'env', one('vca'), 'cv'),
        cable('VCA out → Output l', one('vca'), 'out', out, 'l'),
        knob('the Env’s l2 to 0.1 or less', one('env'), 'l2', (v) => v <= 0.1), knob('the Env’s r2 to 0.15 s or less', one('env'), 'r2', (v) => v <= 0.15),
      ),
      apply: (a) => a.edit((p) => { const e = mod(p, 'env') ?? place(p, 'env'); const v = mod(p, 'vca') ?? place(p, 'vca'); wire(p, mod(p, 'filter'), 'hp', v, 'in'); wire(p, mod(p, 'fm1'), 'gate', e, 'gate'); wire(p, e, 'env', v, 'cv'); wire(p, v, 'out', mod(p, 'output'), 'l'); Object.assign(e.params, { l1: 1, r1: 0.001, l2: 0, r2: 0.08, l3: 0, l4: 0 }); }),
    },
    {
      id: 'group', title: 'Group it as Hat and save it', transient: true,
      text: 'Select the Noise, Filter, Env and VCA, press G and name it Hat. Click save on its card.',
      ...need(['Group the Noise, Filter, Env and VCA (press G)', (s) => !!hat(s.patch), (s) => HAT_TYPES.flatMap((t) => T.module(mod(s.patch, t)?.id))], ['Save it as "Hat" (save on the card)', (s) => !!findDef(s.library, 'hat', 'Hat'), hatAsm]),
      apply: (a) => { a.edit((p) => { if (!hat(p)) makeAssembly(p, HAT_TYPES.map((t) => mod(p, t)!.id), 'Hat'); }); const p = a.patch(); const h = hat(p)!; h.name = 'Hat'; a.saveAssembly(toDef(p, h), 'hat'); },
    },
    {
      id: 'kit', title: 'Borrow a kick and a snare',
      text: 'Click + Add assembly and insert kick and snare from the Drums shelf. Expand one to see how it is built: a kick is a sine with a pitch envelope.',
      ...need(['Insert the factory kick (Drums shelf)', (s) => !!factoryAsm(s.patch, 'kick'), () => T.ui('add-assembly-btn')], ['Insert the factory snare (Drums shelf)', (s) => !!factoryAsm(s.patch, 'snare'), () => T.ui('add-assembly-btn')]),
      apply: (a) => { for (const n of ['kick', 'snare']) if (!factoryAsm(a.patch(), n)) a.edit((p) => insertAt(p, FACTORY_BY_NAME(n))); },
    },
    {
      id: 'clock', title: 'A clock and a divider',
      text: 'Add an LFO (square, 8 Hz) and a Clock div with div 2. Cable LFO out → Clock div clock.',
      ...need(
        added('an LFO', 'lfo'), knob('the LFO’s wave to square', one('lfo'), 'wave', (v) => v === WAVE.square), knob('the LFO’s rate to 6 Hz or more', one('lfo'), 'rate', (v) => v >= 6),
        added('a Clock div', 'clkdiv'), knob('the Clock div’s div to 2', one('clkdiv'), 'div', (v) => v === 2),
        cable('LFO out → Clock div clock', one('lfo'), 'out', one('clkdiv'), 'clock'),
      ),
      apply: (a) => a.edit((p) => { const l = mod(p, 'lfo') ?? place(p, 'lfo'); const d = mod(p, 'clkdiv') ?? place(p, 'clkdiv'); l.params.wave = WAVE.square; l.params.rate = 8; d.params.div = 2; wire(p, l, 'out', d, 'clock'); }),
    },
    {
      id: 'pattern', title: 'A pattern from the divisions',
      text: 'Cable LFO out → Hat gate (every eighth), Clock div d2 → kick gate (every beat) and Clock div d4 → snare gate (every second beat). Remove the cable from Main’s gate to the Hat.',
      ...need(
        cable('LFO out → Hat gate', one('lfo'), 'out', hatGate, 'gate'),
        ['Cable Clock div d2 → kick gate', (s) => cabled(s.patch, one('clkdiv')(s), 'd2', drumGate('kick')(s), drumGatePort('kick', s)), (s) => [...T.port(one('clkdiv')(s), 'd2', 'out'), ...T.port(drumGate('kick')(s), drumGatePort('kick', s), 'in')]],
        ['Cable Clock div d4 → snare gate', (s) => cabled(s.patch, one('clkdiv')(s), 'd4', drumGate('snare')(s), drumGatePort('snare', s)), (s) => [...T.port(one('clkdiv')(s), 'd4', 'out'), ...T.port(drumGate('snare')(s), drumGatePort('snare', s), 'in')]],
        gone('Main gate → Hat gate', main, 'gate', hatGate, 'gate'),
      ),
      apply: (a) => a.edit((p) => { const h = member(p, hat(p), 'env'); wire(p, mod(p, 'lfo'), 'out', h, 'gate'); unwire(p, mod(p, 'fm1'), 'gate', h, 'gate'); for (const [n, port] of [['kick', 'd2'], ['snare', 'd4']] as const) { const g = gateOf(p, n)!; wire(p, mod(p, 'clkdiv'), port, byId(p, g.module), g.port); for (const t of g.also ?? []) wire(p, mod(p, 'clkdiv'), port, byId(p, t.module), t.port); } }),
    },
    {
      id: 'mix', title: 'Mix the kit',
      text: 'Add a Mixer 4: kick out → in1, snare out → in2, Hat out → in3, and Mixer out → Output l and r. Remove the Hat’s own cable to Output. Set l1 to 0.9 and l3 to 0.4.',
      ...need(
        added('a Mixer 4', 'mixer'),
        ['Cable kick out → Mixer in1', (s) => cabled(s.patch, drumOut('kick')(s), drumOutPort('kick', s), one('mixer')(s), 'in1'), (s) => [...T.port(drumOut('kick')(s), drumOutPort('kick', s), 'out'), ...T.port(one('mixer')(s), 'in1', 'in')]],
        ['Cable snare out → Mixer in2', (s) => cabled(s.patch, drumOut('snare')(s), drumOutPort('snare', s), one('mixer')(s), 'in2'), (s) => [...T.port(drumOut('snare')(s), drumOutPort('snare', s), 'out'), ...T.port(one('mixer')(s), 'in2', 'in')]],
        cable('Hat out → Mixer in3', hatOut, 'out', one('mixer'), 'in3'),
        cable('Mixer out → Output l', one('mixer'), 'out', out, 'l'), cable('Mixer out → Output r', one('mixer'), 'out', out, 'r'),
        gone('Hat out → Output l', hatOut, 'out', out, 'l'),
      ),
      apply: (a) => a.edit((p) => { const mx = mod(p, 'mixer') ?? place(p, 'mixer'); const o = mod(p, 'output'); for (const [n, port] of [['kick', 'in1'], ['snare', 'in2']] as const) { const r = outOf(p, n)!; wire(p, byId(p, r.module), r.port, mx, port); } const hv = member(p, hat(p), 'vca'); wire(p, hv, 'out', mx, 'in3'); unwire(p, hv, 'out', o, 'l'); wire(p, mx, 'out', o, 'l'); wire(p, mx, 'out', o, 'r'); mx.params.l1 = 0.9; mx.params.l3 = 0.4; }),
    },
    {
      id: 'share', title: 'Share it', transient: true,
      text: 'Commands → Share patch link copies a link to this patch to your clipboard. Anyone who opens it gets the drum machine, Hat and all. That is the end of the course.',
      ...need(['Copy a share link (Commands → Share patch link)', (s) => s.seen.shares > 0, () => T.ui('palette-btn')]),
      apply: (a) => a.share(),
    },
  ],
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
