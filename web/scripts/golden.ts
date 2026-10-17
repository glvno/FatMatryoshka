// SPDX-License-Identifier: GPL-3.0-only
// Golden vectors for the firmware engine: for each test patch, the binary patch (.m1p), the note events (.ev) and the
// reference output of web/src/engine.ts (.f32, float32 stereo interleaved) at 44.1 kHz, written to build/golden/.
// Run from web/:  npx vite-node scripts/golden.ts   (tools/golden.sh does this and runs the C comparison)
import { mkdirSync, writeFileSync } from 'node:fs';
import { Engine } from '../src/engine';
import { encodePatch, toQ16 } from '../src/patchbin';
import { cpuEstimate } from '../src/cpu';
import { DEFS } from '../src/modules';
import { attFrame, chunkFrames, commitFrame, paramFrame, slotEraseFrame, slotFrame, slotInfoFrame } from '../src/protocol';
import { make, PRESETS, type Build } from '../src/presets';
import { addModule, defaultParams, emptyPatch, fixMatrix, paramUnit, setMorphTarget, type Patch, type PolyCfg } from '../src/patch';
import { makeAssembly } from '../src/assembly';
import { withParts } from '../src/test-poly';

const SR = 44100;
const OUT = new URL('../../build/golden/', import.meta.url);
mkdirSync(OUT, { recursive: true });

type Ev = [number, 'on' | 'off', number];
const EVENTS: Ev[] = [
  [0, 'on', 60],
  [128 * 40, 'on', 67],
  [128 * 80, 'off', 67],
  [128 * 120, 'off', 60],
];
/** a chord, two more notes than voices (stealing), staggered releases: for the polyphonic patches */
const POLY_EVENTS: Ev[] = [
  [0, 'on', 60],
  [0, 'on', 64],
  [128 * 10, 'on', 67],
  [128 * 30, 'on', 72],
  [128 * 45, 'on', 55],
  [128 * 60, 'on', 59],
  [128 * 70, 'off', 64],
  [128 * 80, 'on', 76],
  [128 * 100, 'off', 72],
  [128 * 100, 'off', 67],
  [128 * 110, 'off', 55],
  [128 * 120, 'off', 59],
  [128 * 120, 'off', 76],
  [128 * 130, 'off', 60],
];
const END_DEFAULT = 128 * 180;

const tests: Record<string, Patch> = {};
const events: Record<string, Ev[]> = {};
/** a kit's length in frames, when not END */
const ends: Record<string, number> = {};
for (const [n, p] of Object.entries(PRESETS)) tests[n] = p();

/**
 * A kit built the way patches were before poly assemblies (`voices`, the Main module's legato / priority / unit and its
 * spread / legato / jump / tol / drift outputs, the oscillator's drift), then loaded as the editor loads such a patch
 * (poly.ts migrateVoicing): a poly assembly with a Part module, Random modules. The conversion is part of what is checked.
 */
const makeOld = (name: string, b: Build, voices: number): Patch => {
  const p = emptyPatch(name);
  b(
    (type, x, y, params = {}, opts = {}) => {
      const m = addModule(p, DEFS[type], x, y);
      Object.assign(m.params, params);
      if (opts.map) Object.assign(m.map!, opts.map);
      if (opts.att) m.att = opts.att;
      return m.id;
    },
    (a, ap, b, bp) => void p.cables.push({ from: { module: a, port: ap }, to: { module: b, port: bp } }),
  );
  return withParts(p, voices);
};
const kit = (name: string, b: Build, voices = 1): void => {
  tests[name] = voices > 1 ? makeOld(name, b, voices) : make(name, b);
  if (voices > 1) events[name] = POLY_EVENTS;
};
/** the modules `ids` as a poly assembly with these settings (the rest of the patch plays the shared keyboard) */
// (the kits add a 'part' module where the allocator goes: it becomes a Voice allocator with these settings, Main's keys in,
// as an old patch's Part does on load; the binary the firmware gets has the Part back in its place, poly.ts deviceView)
const polyAsm = (p: Patch, ids: number[], cfg: Partial<PolyCfg>): void => {
  const alloc = p.modules.find((m) => ids.includes(m.id) && m.type === 'part')!;
  alloc.type = 'alloc';
  alloc.params = { ...defaultParams(DEFS.alloc), voices: cfg.parts ?? 4, assign: cfg.assign ?? 0, legato: cfg.legato ?? 0, priority: cfg.priority ?? 0, unison: cfg.unison ? 1 : 0 };
  fixMatrix(alloc, DEFS.alloc);
  const main = p.modules.find((m) => m.type === 'fm1')!;
  p.cables.push({ from: { module: main.id, port: 'keys' }, to: { module: alloc.id, port: 'keys' } });
  makeAssembly(p, ids, `poly ${ids.join(' ')}`).poly = cfg.flaws ? { flaws: cfg.flaws } : {};
};
kit('waves', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const mix = add('mixer', 0, 0, { l1: 0.25, l2: 0.25, l3: 0.25, l4: 0.25 });
  const out = add('output', 0, 0);
  [0, 1, 2, 3].forEach((w, i) => {
    const o = add('osc', 0, 0, { wave: w, pw: 0.3, coarse: i * 3 - 12, fine: i * 7, level: 0.9 });
    wire(kb, 'pitch', o, 'pitch');
    wire(o, 'out', mix, `in${i + 1}`);
  });
  wire(mix, 'out', out, 'l');
});
kit('lfo-sh', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const sh = add('lfo', 0, 0, { wave: 4, rate: 9, depth: 0.8 });
  const tri = add('lfo', 0, 0, { wave: 1, rate: 2.5, depth: 0.6 });
  const osc = add('osc', 0, 0, { wave: 3, pw: 0.5, level: 0.8 }, { map: { p1: ['level'], p2: ['pw'] } });
  const sc = add('scale', 0, 0, { gain: 0.5, offset: 0.1 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(sh, 'out', osc, 'p2');
  wire(tri, 'out', sc, 'in');
  wire(sc, 'out', osc, 'p1');
  wire(osc, 'out', out, 'l');
});
const lfoKit = (name: string, slave: Record<string, number>, wireIn: (wire: (a: number, ap: string, b: number, bp: string) => void, clk: number, rst: number, lfo: number) => void): void =>
  kit(name, (add, wire) => {
    const kb = add('fm1', 0, 0);
    const clk = add('lfo', 0, 0, { wave: 3, rate: 50, depth: 1 });
    const rst = add('lfo', 0, 0, { wave: 3, rate: 1.7, depth: 1 });
    const lfo = add('lfo', 0, 0, { wave: 2, depth: 0.8, ...slave });
    const osc = add('osc', 0, 0, { wave: 3, pw: 0.5, level: 0.8 }, { map: { p1: ['level'], p2: ['pw'] } });
    const out = add('output', 0, 0);
    wire(kb, 'pitch', osc, 'pitch');
    wireIn(wire, clk, rst, lfo);
    wire(lfo, 'out', osc, 'p1');
    wire(osc, 'out', out, 'l');
  });
lfoKit('lfo-clk', { sync: 1, div: 2 }, (wire, clk, _r, lfo) => wire(clk, 'out', lfo, 'clk'));
lfoKit('lfo-clk-sh', { sync: 1, div: 4, wave: 4 }, (wire, clk, _r, lfo) => wire(clk, 'out', lfo, 'clk'));
lfoKit('lfo-bpm', { sync: 1, div: 6, bpm: 140 }, () => undefined);
lfoKit('lfo-reset', { rate: 5 }, (wire, _c, rst, lfo) => wire(rst, 'out', lfo, 'reset'));
kit('noise-svf', (add, wire) => {
  const nz = add('noise', 0, 0, { level: 0.6 });
  const flt = add('filter', 0, 0, { cutoff: 900, res: 0.7 });
  const mix = add('mixer', 0, 0, { l1: 0.5, l2: 0.5, l3: 0.5 });
  const out = add('output', 0, 0, { level: 0.8 });
  wire(nz, 'out', flt, 'in');
  wire(flt, 'lp12', mix, 'in1');
  wire(flt, 'bp', mix, 'in2');
  wire(flt, 'hp', mix, 'in3');
  wire(mix, 'out', out, 'l');
});
kit('filter-notch', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.7 });
  const lfo = add('lfo', 0, 0, { wave: 0, rate: 0.7, depth: 1 });
  const flt = add('filter', 0, 0, { cutoff: 900, res: 0.6, cvamt: 2 });
  const mix = add('mixer', 0, 0, { l1: 0.4, l2: 0.3, l3: 0.3 });
  const out = add('output', 0, 0, { level: 0.8 });
  wire(kb, 'pitch', osc, 'pitch');
  wire(osc, 'out', flt, 'in');
  wire(lfo, 'out', flt, 'cv');
  wire(flt, 'notch', mix, 'in1');
  wire(flt, 'peak', mix, 'in2');
  wire(flt, 'ap', mix, 'in3');
  wire(mix, 'out', out, 'l');
});
kit('filter-morph', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.8 });
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 1.5, depth: 0.5 });
  const sc = add('scale', 0, 0, { gain: 0.5, offset: 0.5 });
  const flt = add('filter', 0, 0, { cutoff: 700, res: 0.5, track: 1, morph: 0.1 });
  const mix = add('mixer', 0, 0, { l1: 0.5, l2: 0.5 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(osc, 'out', flt, 'in');
  wire(lfo, 'out', sc, 'in');
  wire(sc, 'out', flt, 'morph');
  wire(flt, 'mix', mix, 'in1');
  wire(flt, 'lp24', mix, 'in2');
  wire(mix, 'out', out, 'l');
});
kit('unison', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.8, unison: 5, detune: 25 });
  const osc2 = add('osc', 0, 0, { wave: 1, level: 0.5, unison: 2, detune: 60, coarse: -12 });
  const mix = add('mixer', 0, 0, { l1: 0.6, l2: 0.4 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(kb, 'pitch', osc2, 'pitch');
  wire(osc, 'out', mix, 'in1');
  wire(osc2, 'out', mix, 'in2');
  wire(mix, 'out', out, 'l');
});
// voicing (issue #22): unison with blend and stack
kit('unison-stack', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.8, unison: 5, detune: 30, blend: 0.2, stack: 3 });
  const osc2 = add('osc', 0, 0, { wave: 3, level: 0.5, unison: 1, detune: 12, stack: 4, blend: 0.9 });
  const osc3 = add('osc', 0, 0, { wave: 1, level: 0.5, unison: 4, detune: 40, blend: 0 });
  const mix = add('mixer', 0, 0, { l1: 0.4, l2: 0.3, l3: 0.3 });
  const out = add('output', 0, 0);
  for (const o of [osc, osc2, osc3]) wire(kb, 'pitch', o, 'pitch');
  wire(osc, 'out', mix, 'in1');
  wire(osc2, 'out', mix, 'in2');
  wire(osc3, 'out', mix, 'in3');
  wire(mix, 'out', out, 'l');
});
// mono, high priority, legato off (envelopes restart on every change of key): one glide timed by the legato output through a
// macro range (legato-only portamento), one linear glide timed by |jump| (scaled)
tests['legato-glide'] = makeOld('legato-glide', (add, wire) => {
  const kb = add('fm1', 0, 0, { legato: 1, priority: 2 });
  const g1 = add('glide', 0, 0, { time: 0.001 }, { map: { p1: ['time'] } });
  const g2 = add('glide', 0, 0, { time: 0.02, curve: 1 }, { map: { p1: ['time'] } });
  const m = add('math', 0, 0, { ka: 2 });
  // sine and triangle: a gliding pitch leaves a small phase offset between the engines, which saw / square edges magnify
  const o1 = add('osc', 0, 0, { wave: 0, level: 0.6 });
  const o2 = add('osc', 0, 0, { wave: 1, level: 0.4, coarse: -12 });
  const env = add('adsr', 0, 0, { a: 0.01, d: 0.1, s: 0.4, r: 0.1 });
  const vca = add('vca', 0, 0);
  const mix = add('mixer', 0, 0, { l1: 0.5, l2: 0.5 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', g1, 'in');
  wire(kb, 'pitch', g2, 'in');
  wire(kb, 'legato', g1, 'p1');
  wire(kb, 'jump', m, 'a');
  wire(m, 'abs', g2, 'p1');
  wire(g1, 'out', o1, 'pitch');
  wire(g2, 'out', o2, 'pitch');
  wire(o1, 'out', mix, 'in1');
  wire(o2, 'out', mix, 'in2');
  wire(mix, 'out', vca, 'in');
  wire(kb, 'gate', env, 'gate');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', out, 'l');
}, 1);
tests['legato-glide'].modules[1].range = { p1: { time: [0, 0.6] } }; // 166 ms
events['legato-glide'] = [
  [0, 'on', 60],
  [128 * 30, 'on', 67],
  [128 * 50, 'on', 55], // high priority: 67 stays
  [128 * 70, 'off', 67], // back to 60 (the highest still held)
  [128 * 95, 'off', 60],
  [128 * 105, 'off', 55],
  [128 * 120, 'on', 72], // detached
  [128 * 150, 'off', 72],
];
// analog drift: drifting unison copies, the Main tol on the filter and its drift walk on a second oscillator, three
// notes (each with its own tolerance and walk), a unit (dropped since the flaws replaced it)
kit('drift', (add, wire) => {
  const kb = add('fm1', 0, 0, { unit: 7 });
  const o1 = add('osc', 0, 0, { wave: 2, level: 0.6, unison: 3, detune: 8, drift: 30 });
  const o2 = add('osc', 0, 0, { wave: 3, level: 0.4, drift: 12 }, { map: { p1: ['fine'] }, att: [0.5, 1] });
  const fm = add('osc', 0, 0, { wave: 0, level: 0.5, drift: 40, fb: 0.3 });
  const flt = add('filter', 0, 0, { cutoff: 1200, res: 0.3 }, { map: { p1: ['cutoff'] }, att: [0.2, 1] });
  const env = add('adsr', 0, 0, { a: 0.005, d: 0.2, s: 0.5, r: 0.1 });
  const vca = add('vca', 0, 0);
  const mix = add('mixer', 0, 0, { l1: 0.4, l2: 0.3, l3: 0.3 });
  const out = add('output', 0, 0);
  for (const o of [o1, o2, fm]) wire(kb, 'pitch', o, 'pitch');
  wire(kb, 'drift', o2, 'p1');
  wire(kb, 'tol', flt, 'p1');
  wire(o1, 'out', mix, 'in1');
  wire(o2, 'out', mix, 'in2');
  wire(fm, 'out', mix, 'in3');
  wire(mix, 'out', flt, 'in');
  wire(flt, 'lp12', vca, 'in');
  wire(kb, 'gate', env, 'gate');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', out, 'l');
}, 3);
// long enough for the walks to pick new targets (every 256 blocks)
ends.drift = 128 * 700;
events.drift = [
  [0, 'on', 48],
  [0, 'on', 55],
  [128 * 20, 'on', 64],
  [128 * 300, 'off', 55],
  [128 * 320, 'on', 62],
  [128 * 650, 'off', 48],
  [128 * 650, 'off', 62],
  [128 * 650, 'off', 64],
];
// poly assemblies layered: three groups get every note. A: three parts, rotate, the oldest note taken over; its Part's
// index detunes, a shared LFO (one copy, every part) moves the pulse width, a shared filter reads the sum of its parts.
// B: two parts, reuse, low priority, legato on, FM from the sum of A's parts, its legato output opens the level. C: one
// part, high priority, legato off, its jump sets the glide time. The shared delay hears all three.
const layers: number[][] = [];
kit('poly-layers', (add, wire) => {
  add('fm1', 0, 0);
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 3, depth: 0.3 });
  const pa = add('part', 0, 0);
  const oa = add('osc', 0, 0, { wave: 3, level: 0.3 }, { map: { p1: ['fine'], p2: ['pw'] }, att: [0.3, 1] });
  const ea = add('adsr', 0, 0, { a: 0.005, d: 0.2, s: 0.5, r: 0.1 });
  const va = add('vca', 0, 0);
  const pb = add('part', 0, 0);
  const ob = add('osc', 0, 0, { wave: 0, coarse: 12, level: 0.3, pm: 0.4 });
  const eb = add('adsr', 0, 0, { a: 0.04, d: 0.1, s: 0.2, r: 0.15 }); // a restart (legato not on) is loud
  const vb = add('vca', 0, 0, { gain: 0.5 }, { map: { p1: ['gain'] }, att: [0.5, 1] });
  const pc = add('part', 0, 0);
  const gc = add('glide', 0, 0, { time: 0.01 }, { map: { p1: ['time'] }, att: [0.3, 1] });
  const oc = add('osc', 0, 0, { wave: 1, coarse: -12, level: 0.4 });
  const ec = add('adsr', 0, 0, { a: 0.005, d: 0.1, s: 0.6, r: 0.1 });
  const vc = add('vca', 0, 0);
  const flt = add('filter', 0, 0, { cutoff: 1500, res: 0.4 });
  const mix = add('mixer', 0, 0, { l1: 0.5, l2: 0.5, l3: 0.5 });
  const dly = add('delay', 0, 0, { time: 120, fb: 0.3, mix: 0.3 });
  const out = add('output', 0, 0, { level: 0.6 });
  wire(pa, 'pitch', oa, 'pitch');
  wire(pa, 'index', oa, 'p1');
  wire(lfo, 'out', oa, 'p2');
  wire(pa, 'gate', ea, 'gate');
  wire(oa, 'out', va, 'in');
  wire(ea, 'env', va, 'cv');
  wire(va, 'out', flt, 'in');
  wire(flt, 'lp12', mix, 'in1');
  wire(pb, 'pitch', ob, 'pitch');
  wire(oa, 'out', ob, 'pm');
  wire(pb, 'gate', eb, 'gate');
  wire(pb, 'legato', vb, 'p1');
  wire(ob, 'out', vb, 'in');
  wire(eb, 'env', vb, 'cv');
  wire(vb, 'out', mix, 'in2');
  wire(pc, 'pitch', gc, 'in');
  wire(pc, 'jump', gc, 'p1');
  wire(gc, 'out', oc, 'pitch');
  wire(pc, 'gate', ec, 'gate');
  wire(oc, 'out', vc, 'in');
  wire(ec, 'env', vc, 'cv');
  wire(vc, 'out', mix, 'in3');
  wire(mix, 'out', dly, 'in');
  wire(dly, 'out', out, 'l');
  wire(dly, 'r', out, 'r');
  layers.push([pa, oa, ea, va], [pb, ob, eb, vb], [pc, gc, oc, ec, vc]);
});
polyAsm(tests['poly-layers'], layers[0], { parts: 3, assign: 0, priority: 0 });
polyAsm(tests['poly-layers'], layers[1], { parts: 2, assign: 2, priority: 1, legato: 2 });
polyAsm(tests['poly-layers'], layers[2], { parts: 1, priority: 2, legato: 1 });
// single notes first (rotate moves on, lowest stays on part 0, reuse returns to a key's part), then a chord past every
// group's part count (take-over by priority), staggered releases
events['poly-layers'] = [
  [0, 'on', 60],
  [128 * 8, 'off', 60],
  [128 * 16, 'on', 62],
  [128 * 24, 'off', 62],
  [128 * 32, 'on', 60],
  [128 * 40, 'on', 64],
  [128 * 48, 'on', 67],
  [128 * 56, 'on', 69],
  [128 * 64, 'on', 55],
  [128 * 72, 'off', 64],
  [128 * 80, 'on', 72],
  [128 * 96, 'off', 60],
  [128 * 100, 'off', 67],
  [128 * 104, 'off', 69],
  [128 * 108, 'off', 55],
  [128 * 112, 'off', 72],
];
// four parts, lowest free, every part with its own flaws: a fixed Random (tolerance) on each part's cutoff, a walking one (drift, its rate swept
// by a shared LFO) on its pitch, the Part's index on the pan; a walking Random outside (the shared keyboard's)
// on every part's resonance
const randomParts: number[] = [];
kit('part-random', (add, wire) => {
  add('fm1', 0, 0);
  const pt = add('part', 0, 0);
  const rf = add('random', 0, 0, { mode: 0 });
  const rw = add('random', 0, 0, { mode: 1, rate: 4 }, { map: { p1: ['rate'] }, att: [0.5, 1] });
  const rs = add('random', 0, 0, { mode: 1, rate: 2 });
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 0.5, depth: 1 });
  const osc = add('osc', 0, 0, { wave: 2, level: 0.5 }, { map: { p1: ['fine'] }, att: [0.3, 1] });
  const flt = add('filter', 0, 0, { cutoff: 1200, res: 0.3 }, { map: { p1: ['cutoff'], p2: ['res'] }, att: [0.3, 0.2] });
  const env = add('adsr', 0, 0, { a: 0.005, d: 0.2, s: 0.6, r: 0.1 });
  const vca = add('vca', 0, 0);
  const pan = add('pan', 0, 0);
  const out = add('output', 0, 0, { level: 0.6 });
  wire(pt, 'pitch', osc, 'pitch');
  wire(lfo, 'out', rw, 'p1');
  wire(rw, 'out', osc, 'p1');
  wire(rf, 'out', flt, 'p1');
  wire(rs, 'out', flt, 'p2');
  wire(osc, 'out', flt, 'in');
  wire(flt, 'lp12', vca, 'in');
  wire(pt, 'gate', env, 'gate');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', pan, 'in');
  wire(pt, 'index', pan, 'pos');
  wire(pan, 'l', out, 'l');
  wire(pan, 'r', out, 'r');
  randomParts.push(pt, rf, rw, osc, flt, env, vca, pan);
});
polyAsm(tests['part-random'], randomParts, {
  parts: 4, assign: 1,
  flaws: [{ detune: 12, drift: 60, bright: -5, env: 30, level: 90 }, { detune: -20, drift: 100, bright: 7, env: -40, level: 100 }, { detune: 0, drift: 0, bright: 0, env: 0, level: 70 }],
});
events['part-random'] = POLY_EVENTS;
ends['part-random'] = 128 * 400;
// the part flaws alone, every kind at its ends: detune and drift on the Part's pitch, bright on a filter and a ladder,
// env on an ADSR and an envelope, level on the VCA; four parts, a chord
const flawParts: number[] = [];
kit('part-flaws', (add, wire) => {
  add('fm1', 0, 0);
  const pt = add('part', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.5 });
  const flt = add('filter', 0, 0, { cutoff: 900, res: 0.3 });
  const lad = add('ladder', 0, 0, { cutoff: 2500, res: 0.2 });
  const env = add('adsr', 0, 0, { a: 0.01, d: 0.15, s: 0.5, r: 0.08 });
  const lr = add('env', 0, 0, { r1: 0.02, r2: 0.1, r3: 0.3, r4: 0.05 });
  const vca = add('vca', 0, 0);
  const vca2 = add('vca', 0, 0);
  const out = add('output', 0, 0, { level: 0.6 });
  wire(pt, 'pitch', osc, 'pitch');
  wire(osc, 'out', flt, 'in');
  wire(flt, 'lp12', lad, 'in');
  wire(lad, 'lp24', vca, 'in');
  wire(pt, 'gate', env, 'gate');
  wire(pt, 'gate', lr, 'gate');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', vca2, 'in');
  wire(lr, 'env', vca2, 'cv');
  wire(vca2, 'out', out, 'l');
  flawParts.push(pt, osc, flt, lad, env, lr, vca, vca2);
});
polyAsm(tests['part-flaws'], flawParts, {
  parts: 4,
  flaws: [
    { detune: 50, drift: 100, bright: 24, env: 50, level: 100 },
    { detune: -50, drift: 0, bright: -24, env: -50, level: 50 },
    { detune: 7, drift: 40, bright: 3, env: 10, level: 0 },
  ],
});
events['part-flaws'] = POLY_EVENTS;
// unison: four voices on the one note the priority picks (high), legato off so every change of key restarts the envelopes
// of all four; the voices are told apart by their detune flaws and by the index into the pulse width
const unisonParts: number[] = [];
kit('alloc-unison', (add, wire) => {
  add('fm1', 0, 0);
  const pt = add('part', 0, 0);
  const osc = add('osc', 0, 0, { wave: 3, level: 0.2 }, { map: { p1: ['pw'] }, att: [0.3, 1] });
  const env = add('adsr', 0, 0, { a: 0.02, d: 0.1, s: 0.5, r: 0.08 });
  const vca = add('vca', 0, 0);
  const out = add('output', 0, 0, { level: 0.6 });
  wire(pt, 'pitch', osc, 'pitch');
  wire(pt, 'index', osc, 'p1');
  wire(pt, 'gate', env, 'gate');
  wire(osc, 'out', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', out, 'l');
  unisonParts.push(pt, osc, env, vca);
});
polyAsm(tests['alloc-unison'], unisonParts, {
  parts: 4, unison: true, priority: 2, legato: 1,
  flaws: [{ detune: 12, drift: 0, bright: 0, env: 0, level: 100 }, { detune: -9, drift: 0, bright: 0, env: 0, level: 100 }, { detune: 4, drift: 30, bright: 0, env: 0, level: 100 }],
});
events['alloc-unison'] = POLY_EVENTS;
ends['part-flaws'] = 128 * 400;
kit('dyn', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.9 });
  const adsr = add('adsr', 0, 0, { a: 0.005, d: 0.2, s: 0.3, r: 0.1 });
  const vca = add('vca', 0, 0);
  const dyn = add('dyn', 0, 0, { thresh: -18, ratio: 8, attack: 0.003, release: 0.08, gain: 6 });
  const osc2 = add('osc', 0, 0, { wave: 0, level: 0.5, coarse: 12 });
  const vca2 = add('vca', 0, 0);
  const mix = add('mixer', 0, 0, { l1: 0.6, l2: 0.4 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(kb, 'pitch', osc2, 'pitch');
  wire(kb, 'gate', adsr, 'gate');
  wire(osc, 'out', vca, 'in');
  wire(adsr, 'env', vca, 'cv');
  wire(vca, 'out', dyn, 'in');
  wire(dyn, 'out', mix, 'in1');
  wire(osc2, 'out', vca2, 'in');
  wire(dyn, 'env', vca2, 'cv');
  wire(vca2, 'out', mix, 'in2');
  wire(mix, 'out', out, 'l');
});
kit('math-logic', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const lfo1 = add('lfo', 0, 0, { wave: 3, rate: 3, depth: 1 });
  const lfo2 = add('lfo', 0, 0, { wave: 3, rate: 5, depth: 1 });
  const lfo3 = add('lfo', 0, 0, { wave: 1, rate: 0.7, depth: 1 });
  const lg = add('logic', 0, 0);
  const mt = add('math', 0, 0, { ka: 0.5, kb: 0.3, off: 0.1 });
  const osc = add('osc', 0, 0, { wave: 2, level: 0.7 });
  const adsr = add('adsr', 0, 0, { a: 0.002, d: 0.08, s: 0.2, r: 0.05 });
  const vca = add('vca', 0, 0);
  const vca2 = add('vca', 0, 0);
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(lfo1, 'out', lg, 'a');
  wire(lfo2, 'out', lg, 'b');
  wire(lg, 'xor', adsr, 'gate');
  wire(osc, 'out', vca, 'in');
  wire(adsr, 'env', vca, 'cv');
  wire(lfo3, 'out', mt, 'a');
  wire(lfo1, 'out', mt, 'b');
  wire(mt, 'max', vca2, 'cv');
  wire(vca, 'out', vca2, 'in');
  wire(vca2, 'out', out, 'l');
  wire(mt, 'abs', osc, 'pitch');
});
kit('grain', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.7 });
  const adsr = add('adsr', 0, 0, { a: 0.01, d: 0.3, s: 0.5, r: 0.2 });
  const vca = add('vca', 0, 0);
  const lfo = add('lfo', 0, 0, { wave: 3, rate: 6, depth: 1 });
  const gr = add('grain', 0, 0, { position: 0.25, size: 0.06, density: 15, pitch: 7, spray: 0.3, mix: 0.7 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(kb, 'gate', adsr, 'gate');
  wire(osc, 'out', vca, 'in');
  wire(adsr, 'env', vca, 'cv');
  wire(vca, 'out', gr, 'in');
  wire(lfo, 'out', gr, 'trig');
  wire(gr, 'out', out, 'l');
});
kit('comb', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.5 });
  const cb = add('comb', 0, 0, { fb: -0.85, damp: 0.3, mix: 0.8, coarse: 7 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(kb, 'pitch', cb, 'pitch');
  wire(osc, 'out', cb, 'in');
  wire(cb, 'out', out, 'l');
});
kit('modal', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const pl = add('pulse', 0, 0, { time: 0.002 });
  const nz = add('noise', 0, 0, { level: 0.8 });
  const vca = add('vca', 0, 0);
  const md = add('modal', 0, 0, { decay: 1.2, struct: 0.4, bright: 0.6, damp: 0.4 });
  const out = add('output', 0, 0);
  wire(kb, 'gate', pl, 'trig');
  wire(nz, 'out', vca, 'in');
  wire(pl, 'out', vca, 'cv');
  wire(vca, 'out', md, 'in');
  wire(kb, 'pitch', md, 'pitch');
  wire(md, 'out', out, 'l');
});
kit('shift', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.6 });
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 0.5, depth: 1 });
  const sh = add('shift', 0, 0, { shift: 80, cvamt: 200, mix: 0.9 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(osc, 'out', sh, 'in');
  wire(lfo, 'out', sh, 'cv');
  wire(sh, 'up', out, 'l');
  wire(sh, 'down', out, 'r');
});
kit('bypass', (add, wire) => {
  // a bypassed filter (in -> every output), pan (in -> l, r) and LFO (silent, so the level stays at its base)
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.7 }, { map: { p1: ['level'] } });
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 3, depth: 1 });
  const flt = add('filter', 0, 0, { cutoff: 120, res: 0.5 });
  const lad = add('ladder', 0, 0, { cutoff: 900, res: 0.3, drive: 2 });
  const pan = add('pan', 0, 0, { pan: 0.8 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(lfo, 'out', osc, 'p1');
  wire(osc, 'out', flt, 'in');
  wire(flt, 'lp24', lad, 'in');
  wire(flt, 'hp', pan, 'pos');
  wire(lad, 'lp24', pan, 'in');
  wire(pan, 'l', out, 'l');
  wire(pan, 'r', out, 'r');
});
for (const m of tests.bypass.modules) if (['filter', 'pan', 'lfo'].includes(m.type)) m.bypass = true;
kit('ladder', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.8 });
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 2, depth: 0.6 });
  const lad = add('ladder', 0, 0, { cutoff: 500, res: 0.85, drive: 3, cvamt: 2, track: 1 });
  const mix = add('mixer', 0, 0, { l1: 0.5, l2: 0.3 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(osc, 'out', lad, 'in');
  wire(lfo, 'out', lad, 'cv');
  wire(lad, 'lp24', mix, 'in1');
  wire(lad, 'lp12', mix, 'in2');
  wire(mix, 'out', out, 'l');
});
kit('fm1-panel', (add, wire) => {
  const pn = add('fm1', 0, 0, { k1: 0.2, k3: 0.4 });
  const osc = add('osc', 0, 0, { wave: 2 }, { map: { p1: ['level'], p2: ['fine'] } });
  const out = add('output', 0, 0);
  wire(pn, 'pitch', osc, 'pitch');
  wire(pn, 'k3', osc, 'p1');
  wire(pn, 'k1', osc, 'p2');
  wire(osc, 'out', out, 'l');
});
kit('delay-fb', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 1, level: 0.5 });
  const env = add('adsr', 0, 0, { a: 0.002, d: 0.05, s: 0, r: 0.05 });
  const vca = add('vca', 0, 0);
  const dly = add('delay', 0, 0, { time: 100, fb: 0.6, mix: 0.5 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(kb, 'gate', env, 'gate');
  wire(osc, 'out', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', dly, 'in');
  wire(dly, 'out', out, 'l');
  wire(dly, 'out', out, 'r');
});
const delayKit = (name: string, params: Record<string, number>): void =>
  kit(name, (add, wire) => {
    const kb = add('fm1', 0, 0);
    const osc = add('osc', 0, 0, { wave: 1, level: 0.5 });
    const env = add('adsr', 0, 0, { a: 0.002, d: 0.05, s: 0, r: 0.05 });
    const vca = add('vca', 0, 0);
    const dly = add('delay', 0, 0, { fb: 0.6, mix: 0.5, ...params });
    const out = add('output', 0, 0);
    wire(kb, 'pitch', osc, 'pitch');
    wire(kb, 'gate', env, 'gate');
    wire(osc, 'out', vca, 'in');
    wire(env, 'env', vca, 'cv');
    wire(vca, 'out', dly, 'in');
    wire(dly, 'out', out, 'l');
    wire(dly, 'r', out, 'r');
  });
delayKit('delay-pingpong', { time: 120, pingpong: 1 });
delayKit('delay-sync', { sync: 1, div: 5, bpm: 133 });
delayKit('delay-sync-pingpong', { sync: 1, div: 6, bpm: 90, pingpong: 1 });
kit('feedback-pm', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 0, pm: 2 });
  const vca = add('vca', 0, 0, { gain: 0.7 });
  const env = add('adsr', 0, 0, { a: 0.01, d: 0.2, s: 0.6, r: 0.2 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(kb, 'gate', env, 'gate');
  wire(osc, 'out', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', osc, 'pm');
  wire(vca, 'out', out, 'l');
});
kit('osc-feedback', (add, wire) => {
  // operator feedback on a sine (saw-like), a square with feedback, both through the envelope
  const kb = add('fm1', 0, 0);
  const a = add('osc', 0, 0, { wave: 0, fb: 0.5 });
  const b = add('osc', 0, 0, { wave: 3, fb: 0.3, coarse: -12, level: 0.4 });
  const vca = add('vca', 0, 0, { gain: 0.6 });
  const env = add('adsr', 0, 0, { a: 0.005, d: 0.3, s: 0.5, r: 0.2 });
  const mix = add('mixer', 0, 0);
  const out = add('output', 0, 0);
  wire(kb, 'pitch', a, 'pitch');
  wire(kb, 'pitch', b, 'pitch');
  wire(kb, 'gate', env, 'gate');
  wire(a, 'out', mix, 'in1');
  wire(b, 'out', mix, 'in2');
  wire(mix, 'out', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', out, 'l');
});
kit('fm-2op', (add, wire) => {
  // two operators: modulator (ratio 2, its own envelope, velocity on the index) into the carrier's pm, carrier feedback 0.2
  const kb = add('fm1', 0, 0);
  const mod = add('osc', 0, 0, { wave: 0, coarse: 12, level: 1 });
  const car = add('osc', 0, 0, { wave: 0, pm: 3, fb: 0.2 });
  const menv = add('adsr', 0, 0, { a: 0.002, d: 0.25, s: 0.2, r: 0.2 });
  const aenv = add('adsr', 0, 0, { a: 0.002, d: 0.8, s: 0.4, r: 0.3 });
  const mvca = add('vca', 0, 0, { gain: 0.4 }, { map: { p1: ['gain'] }, att: [1, 1] });
  const avca = add('vca', 0, 0, { gain: 0.7 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', mod, 'pitch');
  wire(kb, 'pitch', car, 'pitch');
  wire(kb, 'gate', menv, 'gate');
  wire(kb, 'gate', aenv, 'gate');
  wire(kb, 'vel', mvca, 'p1');
  wire(mod, 'out', mvca, 'in');
  wire(menv, 'env', mvca, 'cv');
  wire(mvca, 'out', car, 'pm');
  wire(car, 'out', avca, 'in');
  wire(aenv, 'env', avca, 'cv');
  wire(avca, 'out', out, 'l');
  wire(avca, 'out', out, 'r');
});
kit('sync-glide-shape', (add, wire) => {
  // key-synced oscillator, a glide on its pitch, a synced LFO on the filter, the result through the shaper in each mode
  const kb = add('fm1', 0, 0);
  const gl = add('glide', 0, 0, { time: 0.08 });
  const osc = add('osc', 0, 0, { wave: 2 });
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 3, depth: 0.5 });
  const flt = add('filter', 0, 0, { cutoff: 900, res: 0.4, cvamt: 2 });
  const env = add('adsr', 0, 0, { a: 0.005, d: 0.3, s: 0.6, r: 0.2 });
  const vca = add('vca', 0, 0, { gain: 0.9 });
  const soft = add('shape', 0, 0, { drive: 4, mode: 0, level: 0.4 });
  const hard = add('shape', 0, 0, { drive: 3, mode: 1, level: 0.3 });
  const fold = add('shape', 0, 0, { drive: 6, mode: 2, level: 0.3 });
  const mix = add('mixer', 0, 0);
  const out = add('output', 0, 0);
  wire(kb, 'pitch', gl, 'in');
  wire(gl, 'out', osc, 'pitch');
  wire(kb, 'gate', osc, 'sync');
  wire(kb, 'gate', lfo, 'reset');
  wire(kb, 'gate', env, 'gate');
  wire(osc, 'out', flt, 'in');
  wire(lfo, 'out', flt, 'cv');
  wire(flt, 'lp12', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', soft, 'in');
  wire(vca, 'out', hard, 'in');
  wire(vca, 'out', fold, 'in');
  wire(soft, 'out', mix, 'in1');
  wire(hard, 'out', mix, 'in2');
  wire(fold, 'out', mix, 'in3');
  wire(mix, 'out', out, 'l');
});
kit(
  'spread',
  (add, wire) => {
    // three voices: spread detunes the oscillators (p1 -> fine) and sets each voice's level (p1 -> gain)
    const kb = add('fm1', 0, 0);
    const osc = add('osc', 0, 0, { wave: 2 }, { map: { p1: ['fine'] }, att: [0.2, 1] });
    const env = add('adsr', 0, 0, { a: 0.005, d: 0.3, s: 0.6, r: 0.2 });
    const vca = add('vca', 0, 0, { gain: 0.4 }, { map: { p1: ['gain'] }, att: [0.3, 1] });
    const out = add('output', 0, 0);
    wire(kb, 'pitch', osc, 'pitch');
    wire(kb, 'spread', osc, 'p1');
    wire(kb, 'spread', vca, 'p1');
    wire(kb, 'gate', env, 'gate');
    wire(osc, 'out', vca, 'in');
    wire(env, 'env', vca, 'cv');
    wire(vca, 'out', out, 'l');
  },
  3,
);
kit('summed-inputs', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const a = add('osc', 0, 0, { wave: 2, coarse: -12, level: 0.4 });
  const b = add('osc', 0, 0, { wave: 3, coarse: 7, level: 0.4 });
  const k = add('const', 0, 0, { value: 0.25 });
  const vca = add('vca', 0, 0);
  const out = add('output', 0, 0);
  wire(kb, 'pitch', a, 'pitch');
  wire(kb, 'pitch', b, 'pitch');
  wire(a, 'out', vca, 'in');
  wire(b, 'out', vca, 'in');
  wire(k, 'out', vca, 'cv');
  wire(vca, 'out', out, 'l');
});

kit('matrix-att', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const lfo = add('lfo', 0, 0, { wave: 0, rate: 3, depth: 1 });
  const k = add('const', 0, 0, { value: 0.5 });
  const osc = add('osc', 0, 0, { wave: 0, level: 0.6 }, { map: { p1: ['level'], p2: ['level'] }, att: [-0.5, 0.3] });
  const flt = add('filter', 0, 0, { cutoff: 800, res: 0.3 }, { map: { p1: ['cutoff', 'res'], p2: ['cvamt'] }, att: [0.3, -1] });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(lfo, 'out', osc, 'p1');
  wire(k, 'out', osc, 'p2');
  wire(lfo, 'out', flt, 'p1');
  wire(k, 'out', flt, 'p2');
  wire(osc, 'out', flt, 'in');
  wire(flt, 'lp12', out, 'l');
});

kit('reverb', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 0, level: 0.8 });
  const env = add('adsr', 0, 0, { a: 0.002, d: 0.05, s: 0, r: 0.05 });
  const vca = add('vca', 0, 0);
  const rv = add('reverb', 0, 0, { size: 0.8, damp: 0.3, mix: 0.6 });
  const out = add('output', 0, 0);
  wire(kb, 'pitch', osc, 'pitch');
  wire(kb, 'gate', env, 'gate');
  wire(osc, 'out', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', rv, 'in');
  wire(rv, 'out', out, 'l');
});

// polyphony: osc -> filter (its own envelope on cv) -> vca (second envelope) per voice, one delay and the output shared
kit(
  'poly-pluck',
  (add, wire) => {
    const kb = add('fm1', 0, 0);
    const osc = add('osc', 0, 0, { wave: 2, level: 0.5 });
    const fenv = add('adsr', 0, 0, { a: 0.002, d: 0.15, s: 0.1, r: 0.1 });
    const flt = add('filter', 0, 0, { cutoff: 300, res: 0.4, cvamt: 3 });
    const aenv = add('adsr', 0, 0, { a: 0.003, d: 0.4, s: 0.3, r: 0.2 });
    const vca = add('vca', 0, 0);
    const dly = add('delay', 0, 0, { time: 120, fb: 0.4, mix: 0.3 });
    const out = add('output', 0, 0, { level: 0.6 });
    wire(kb, 'pitch', osc, 'pitch');
    wire(kb, 'gate', fenv, 'gate');
    wire(kb, 'gate', aenv, 'gate');
    wire(osc, 'out', flt, 'in');
    wire(fenv, 'env', flt, 'cv');
    wire(flt, 'lp24', vca, 'in');
    wire(aenv, 'env', vca, 'cv');
    wire(vca, 'out', dly, 'in');
    wire(dly, 'out', out, 'l');
    wire(vca, 'out', out, 'r');
  },
  4,
);
// polyphony with shared sources: one LFO (into every voice's filter p1) and one noise (through a per-voice VCA, velocity on
// its p1), a per-voice mixer with two cables into one input, the reverb and output shared; key tracking on the filter
kit(
  'poly-shared',
  (add, wire) => {
    const kb = add('fm1', 0, 0);
    const osc = add('osc', 0, 0, { wave: 3, pw: 0.3, level: 0.4 });
    const sub = add('osc', 0, 0, { wave: 1, coarse: -12, level: 0.3 });
    const lfo = add('lfo', 0, 0, { wave: 0, rate: 2, depth: 0.4 });
    const flt = add('filter', 0, 0, { cutoff: 600, res: 0.3, track: 1 }, { map: { p1: ['cutoff'] }, att: [0.5, 1] });
    const env = add('adsr', 0, 0, { a: 0.005, d: 0.2, s: 0.5, r: 0.15 });
    const nz = add('noise', 0, 0, { level: 0.3 });
    const nvca = add('vca', 0, 0, { gain: 0.5 }, { map: { p1: ['gain'] } });
    const mix = add('mixer', 0, 0, { l1: 0.7, l2: 0.5 });
    const vca = add('vca', 0, 0);
    const rv = add('reverb', 0, 0, { size: 0.6, damp: 0.4, mix: 0.3 });
    const out = add('output', 0, 0, { level: 0.7 });
    wire(kb, 'pitch', osc, 'pitch');
    wire(kb, 'pitch', sub, 'pitch');
    wire(kb, 'gate', env, 'gate');
    wire(lfo, 'out', flt, 'p1');
    wire(osc, 'out', flt, 'in');
    wire(sub, 'out', flt, 'in');
    wire(nz, 'out', nvca, 'in');
    wire(env, 'env', nvca, 'cv');
    wire(kb, 'vel', nvca, 'p1');
    wire(flt, 'lp12', mix, 'in1');
    wire(nvca, 'out', mix, 'in2');
    wire(mix, 'out', vca, 'in');
    wire(env, 'env', vca, 'cv');
    wire(vca, 'out', rv, 'in');
    wire(rv, 'out', out, 'l');
    wire(rv, 'out', out, 'r');
  },
  3,
);
// a feedback cable inside a voice (the VCA back into the oscillator's phase) and a shared delay fed back into every voice's mixer
kit(
  'poly-feedback',
  (add, wire) => {
    const kb = add('fm1', 0, 0);
    const osc = add('osc', 0, 0, { wave: 0, pm: 1.5, level: 0.6 });
    const env = add('adsr', 0, 0, { a: 0.01, d: 0.3, s: 0.4, r: 0.2 });
    const vca = add('vca', 0, 0, { gain: 0.6 });
    const mix = add('mixer', 0, 0, { l1: 0.8, l2: 0.3 });
    const dly = add('delay', 0, 0, { time: 90, fb: 0.3, mix: 1 });
    const out = add('output', 0, 0, { level: 0.5 });
    wire(kb, 'pitch', osc, 'pitch');
    wire(kb, 'gate', env, 'gate');
    wire(osc, 'out', vca, 'in');
    wire(env, 'env', vca, 'cv');
    wire(vca, 'out', osc, 'pm');
    wire(vca, 'out', mix, 'in1');
    wire(dly, 'out', mix, 'in2');
    wire(mix, 'out', dly, 'in');
    wire(mix, 'out', out, 'l');
  },
  2,
);

// the level / rate envelope on the amplitude and (through a Scale) on the pitch of an FM pair
kit('env-lr', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const mod = add('osc', 0, 0, { wave: 0, coarse: 12, level: 0.8 });
  const car = add('osc', 0, 0, { wave: 0, pm: 2.5 });
  const ea = add('env', 0, 0, { l1: 1, r1: 0.005, l2: 0.3, r2: 0.15, l3: 0.5, r3: 0.4, l4: 0, r4: 0.3 });
  const ep = add('env', 0, 0, { l1: 1, r1: 0.002, l2: 0, r2: 0.08, l3: 0.2, r3: 0.5, l4: 0.6, r4: 0.2 });
  const sc = add('scale', 0, 0, { gain: 0.5, offset: -0.25 });
  const va = add('vca', 0, 0);
  const out = add('output', 0, 0, { level: 0.8 });
  wire(kb, 'pitch', mod, 'pitch');
  wire(kb, 'pitch', car, 'pitch');
  wire(ep, 'env', sc, 'in');
  wire(sc, 'out', car, 'pitch');
  wire(kb, 'gate', ea, 'gate');
  wire(kb, 'gate', ep, 'gate');
  wire(mod, 'out', car, 'pm');
  wire(car, 'out', va, 'in');
  wire(ea, 'env', va, 'cv');
  wire(va, 'out', out, 'l');
});
// two plucked strings per voice (noise and pulse bursts, damp and decay apart), plus one rung by an oscillator
kit(
  'string',
  (add, wire) => {
    const kb = add('fm1', 0, 0);
    const s1 = add('string', 0, 0, { decay: 1.5, damp: 0.3, burst: 0, level: 0.6 });
    const s2 = add('string', 0, 0, { decay: 0.4, damp: 0.7, burst: 1, coarse: 12, level: 0.5 });
    const o = add('osc', 0, 0, { wave: 3, pw: 0.1, coarse: -24, level: 0.03 });
    const s3 = add('string', 0, 0, { decay: 2, damp: 0.1, coarse: 7, level: 0.3 });
    const mix = add('mixer', 0, 0, { l1: 0.6, l2: 0.6, l3: 0.4 });
    const out = add('output', 0, 0, { level: 0.6 });
    wire(kb, 'pitch', s1, 'pitch');
    wire(kb, 'pitch', s2, 'pitch');
    wire(kb, 'pitch', s3, 'pitch');
    wire(kb, 'pitch', o, 'pitch');
    wire(kb, 'gate', s1, 'gate');
    wire(kb, 'gate', s2, 'gate');
    wire(o, 'out', s3, 'exc');
    wire(s1, 'out', mix, 'in1');
    wire(s2, 'out', mix, 'in2');
    wire(s3, 'out', mix, 'in3');
    wire(mix, 'out', out, 'l');
  },
  2,
);
// every bank of the wavetable, the position swept by an LFO through p1, one of them phase modulated and synced
kit('wavetable', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 0.7, depth: 1 });
  const mix = add('mixer', 0, 0, { l1: 0.3, l2: 0.3, l3: 0.3, l4: 0.3 });
  const out = add('output', 0, 0);
  const mod = add('osc', 0, 0, { wave: 0, coarse: 7, level: 0.5 });
  wire(kb, 'pitch', mod, 'pitch');
  [0, 1, 2, 3].forEach((b, i) => {
    const w = add('wavetable', 0, 0, { bank: b, pos: 0.5, coarse: i === 3 ? 12 : i * -12, fine: i * 5, pm: i === 1 ? 1.5 : 0, level: 0.7 }, { map: { p1: ['pos'] }, att: [0.5, 1] });
    wire(kb, 'pitch', w, 'pitch');
    wire(lfo, 'out', w, 'p1');
    if (i === 1) wire(mod, 'out', w, 'pm');
    if (i === 2) wire(kb, 'gate', w, 'sync');
    wire(w, 'out', mix, `in${i + 1}`);
  });
  wire(mix, 'out', out, 'l');
});
// a shared chorus on a two-voice saw pad, l and r to the output
kit(
  'chorus',
  (add, wire) => {
    const kb = add('fm1', 0, 0);
    const o = add('osc', 0, 0, { wave: 2, level: 0.5 });
    const env = add('adsr', 0, 0, { a: 0.02, d: 0.3, s: 0.7, r: 0.3 });
    const vca = add('vca', 0, 0);
    const ch = add('chorus', 0, 0, { rate: 0.8, depth: 0.7, mix: 0.6 });
    const out = add('output', 0, 0, { level: 0.7 });
    wire(kb, 'pitch', o, 'pitch');
    wire(kb, 'gate', env, 'gate');
    wire(o, 'out', vca, 'in');
    wire(env, 'env', vca, 'cv');
    wire(vca, 'out', ch, 'in');
    wire(ch, 'l', out, 'l');
    wire(ch, 'r', out, 'r');
  },
  2,
);

// a clocked sequence: square LFO -> clock divider -> pendulum sequencer -> quantizer -> oscillator; the sequencer's gate
// through a pulse into the envelope; the divider's d4 syncs the oscillator
kit('seq-clock', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const clk = add('lfo', 0, 0, { wave: 3, rate: 12, depth: 1 });
  const dv = add('clkdiv', 0, 0, { div: 2 });
  const sq = add('seq', 0, 0, { s1: 0, s2: 0.25, s3: 0.58, s4: -1, s5: 0.33, s6: 1, s7: 0.75, s8: 0.1, len: 7, dir: 2 });
  const qn = add('quant', 0, 0, { scale: 2, root: 9 });
  const pl = add('pulse', 0, 0, { time: 0.03 });
  const env = add('adsr', 0, 0, { a: 0.002, d: 0.08, s: 0.3, r: 0.05 });
  const osc = add('osc', 0, 0, { wave: 2, level: 0.7 });
  const vca = add('vca', 0, 0);
  const out = add('output', 0, 0, { level: 0.8 });
  wire(clk, 'out', dv, 'clock');
  wire(kb, 'gate', dv, 'reset');
  wire(dv, 'out', sq, 'clock');
  wire(kb, 'gate', sq, 'reset');
  wire(sq, 'out', qn, 'in');
  wire(qn, 'out', osc, 'pitch');
  wire(kb, 'pitch', osc, 'pitch');
  wire(sq, 'gate', pl, 'trig');
  wire(pl, 'out', env, 'gate');
  wire(dv, 'd4', osc, 'sync');
  wire(osc, 'out', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', out, 'l');
});
// a random melody: noise sampled by a clock, quantized to a pentatonic, a tracked S&H on the filter; a random sequencer
// on the second voice's pulse width
kit(
  'sh-random',
  (add, wire) => {
    const kb = add('fm1', 0, 0);
    const clk = add('lfo', 0, 0, { wave: 3, rate: 7, depth: 1 });
    const nz = add('noise', 0, 0, { level: 1 });
    const sh = add('sh', 0, 0, { mode: 0 });
    const qn = add('quant', 0, 0, { scale: 4, root: 2 });
    const tri = add('lfo', 0, 0, { wave: 1, rate: 0.3, depth: 1 });
    const th = add('sh', 0, 0, { mode: 1 });
    const sq = add('seq', 0, 0, { s1: -0.5, s2: 0.2, s3: 0.4, s4: -0.2, len: 4, dir: 3 });
    const osc = add('osc', 0, 0, { wave: 3, pw: 0.5, level: 0.6 }, { map: { p1: ['pw'] }, att: [0.4, 1] });
    const flt = add('filter', 0, 0, { cutoff: 600, res: 0.4, cvamt: 2 });
    const env = add('adsr', 0, 0, { a: 0.005, d: 0.15, s: 0.2, r: 0.1 });
    const vca = add('vca', 0, 0);
    const out = add('output', 0, 0, { level: 0.7 });
    wire(nz, 'out', sh, 'in');
    wire(clk, 'out', sh, 'clock');
    wire(sh, 'out', qn, 'in');
    wire(qn, 'out', osc, 'pitch');
    wire(kb, 'pitch', osc, 'pitch');
    wire(tri, 'out', th, 'in');
    wire(clk, 'out', th, 'clock');
    wire(th, 'out', flt, 'cv');
    wire(clk, 'out', sq, 'clock');
    wire(sq, 'out', osc, 'p1');
    wire(osc, 'out', flt, 'in');
    wire(flt, 'lp24', vca, 'in');
    wire(clk, 'out', env, 'gate');
    wire(env, 'env', vca, 'cv');
    wire(vca, 'out', out, 'l');
  },
  2,
);

// pan by the panel's spread (three voices) and a crossfade of two oscillators swept by an LFO
kit(
  'pan-xfade',
  (add, wire) => {
    const kb = add('fm1', 0, 0);
    const o1 = add('osc', 0, 0, { wave: 2, level: 0.3 });
    const o2 = add('osc', 0, 0, { wave: 1, coarse: 7, level: 0.3 });
    const o3 = add('osc', 0, 0, { wave: 3, coarse: -12, pw: 0.3, level: 0.3 });
    const pn = add('pan', 0, 0, { pan: 0.1 });
    const lfo = add('lfo', 0, 0, { wave: 1, rate: 1.3, depth: 0.5 });
    const xf = add('xfade', 0, 0, { mix: 0.5 });
    const out = add('output', 0, 0, { level: 0.4 });
    wire(kb, 'pitch', o1, 'pitch');
    wire(kb, 'pitch', o2, 'pitch');
    wire(kb, 'pitch', o3, 'pitch');
    wire(kb, 'spread', pn, 'pos');
    wire(o1, 'out', pn, 'in');
    wire(o2, 'out', xf, 'a');
    wire(o3, 'out', xf, 'b');
    wire(lfo, 'out', xf, 'pos');
    wire(pn, 'l', out, 'l');
    wire(pn, 'r', out, 'r');
    wire(xf, 'out', out, 'l');
    wire(xf, 'out', out, 'r');
  },
  3,
);
// a saw through the vowel filter swept A -> U by an LFO, then the phaser
kit('vowel-phaser', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.6 });
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 0.7, depth: 1 });
  const sc = add('scale', 0, 0, { gain: 2, offset: 2 });
  const vw = add('vowel', 0, 0, { vowel: 0, res: 0.6, level: 0.9 });
  const ph = add('phaser', 0, 0, { rate: 1.1, depth: 0.8, center: 600, fb: 0.5, mix: 0.5 });
  const out = add('output', 0, 0, { level: 0.8 });
  wire(kb, 'pitch', osc, 'pitch');
  wire(osc, 'out', vw, 'in');
  wire(lfo, 'out', sc, 'in');
  wire(sc, 'out', vw, 'vowel');
  wire(vw, 'out', ph, 'in');
  wire(ph, 'out', out, 'l');
  wire(ph, 'out', out, 'r');
});
// coloured noise through the digitizer
kit('os-shape-crush', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 2, level: 0.8, coarse: 12 });
  const sh = add('shape', 0, 0, { mode: 1, drive: 6, level: 0.6, os: 1 });
  const cr = add('crush', 0, 0, { bits: 5, rate: 3, os: 1 });
  const out = add('output', 0, 0, { level: 0.8 });
  wire(kb, 'pitch', osc, 'pitch');
  wire(osc, 'out', sh, 'in');
  wire(sh, 'out', cr, 'in');
  wire(cr, 'out', out, 'l');
});
kit('wavefold', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const osc = add('osc', 0, 0, { wave: 0, level: 0.9 });
  const lfo = add('lfo', 0, 0, { wave: 0, rate: 0.7, depth: 1 });
  const sh = add('shape', 0, 0, { mode: 2, drive: 3, level: 0.5, os: 1, sym: 0.3, stages: 3 }, { map: { p1: ['drive'] }, att: [0.5, 1] });
  const out = add('output', 0, 0, { level: 0.8 });
  wire(kb, 'pitch', osc, 'pitch');
  wire(osc, 'out', sh, 'in');
  wire(lfo, 'out', sh, 'p1');
  wire(sh, 'out', out, 'l');
});
kit('seq-glide', (add, wire) => {
  const kb = add('fm1', 0, 0);
  const clk = add('lfo', 0, 0, { wave: 3, rate: 8, depth: 1 });
  const sq = add('seq', 0, 0, { s1: 0, s2: 0.5, s3: -1, s4: 0.25, s5: 1, s6: 0.4, s7: -0.5, s8: 0, len: 8, glide: 0.35, gate: 0.6 });
  const env = add('adsr', 0, 0, { a: 0.005, d: 0.1, s: 0.5, r: 0.08 });
  const osc = add('osc', 0, 0, { wave: 3, level: 0.7 });
  const vca = add('vca', 0, 0);
  const out = add('output', 0, 0, { level: 0.8 });
  wire(clk, 'out', sq, 'clock');
  wire(kb, 'gate', sq, 'reset');
  wire(sq, 'out', osc, 'pitch');
  wire(kb, 'pitch', osc, 'pitch');
  wire(sq, 'gate', env, 'gate');
  wire(osc, 'out', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', out, 'l');
});
// morphing: the same subtractive voice twice, the B side brighter and square, an LFO on the Main's morph input
const morphVoice = (b: boolean): Build => (add, wire) => {
  const kb = add('fm1', 0, 0, { morph: 0.3 });
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 0.6, depth: 0.5 });
  const sc = add('scale', 0, 0, { gain: 1, offset: 0.2 });
  const osc = add('osc', 0, 0, { wave: b ? 3 : 2, pw: b ? 0.3 : 0.5, level: 0.7, coarse: b ? -12 : 0 });
  const env = add('adsr', 0, 0, { a: b ? 0.2 : 0.005, d: 0.2, s: b ? 0.9 : 0.4, r: b ? 0.5 : 0.1 });
  const flt = add('filter', 0, 0, { cutoff: b ? 6000 : 250, res: b ? 0.1 : 0.7 });
  const vca = add('vca', 0, 0);
  const dly = add('delay', 0, 0, { time: b ? 375 : 120, fb: b ? 0.6 : 0.2, mix: b ? 0.5 : 0.1 });
  const out = add('output', 0, 0, { level: 0.8 });
  wire(lfo, 'out', sc, 'in');
  wire(sc, 'out', kb, 'morph');
  wire(kb, 'pitch', osc, 'pitch');
  wire(kb, 'gate', env, 'gate');
  wire(osc, 'out', flt, 'in');
  wire(flt, 'lp24', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', dly, 'in');
  wire(dly, 'out', out, 'l');
};
kit('morph', morphVoice(false));
// macro ranges: one triangle LFO into the filter's p1 (cutoff between 150 Hz and 6 kHz in octaves) and the ADSR's p1
// (decay between 0.6 s and 30 ms, the ends swapped), the Main's K2 into the oscillator's p2 (pulse width 0.2..0.5)
kit('macro', (add, wire) => {
  const kb = add('fm1', 0, 0, { k2: 0.7 });
  const lfo = add('lfo', 0, 0, { wave: 1, rate: 0.5, depth: 1 });
  const sc = add('scale', 0, 0, { gain: 0.5, offset: 0.5 });
  const osc = add('osc', 0, 0, { wave: 3, level: 0.7 }, { map: { p2: ['pw'] } });
  const env = add('adsr', 0, 0, { a: 0.005, d: 0.2, s: 0.3, r: 0.1 }, { map: { p1: ['d'] } });
  const flt = add('filter', 0, 0, { cutoff: 1200, res: 0.6 }, { map: { p1: ['cutoff'] } });
  const vca = add('vca', 0, 0);
  const out = add('output', 0, 0, { level: 0.8 });
  wire(lfo, 'out', sc, 'in');
  wire(sc, 'out', flt, 'p1');
  wire(sc, 'out', env, 'p1');
  wire(kb, 'k2', osc, 'p2');
  wire(kb, 'pitch', osc, 'pitch');
  wire(kb, 'gate', env, 'gate');
  wire(osc, 'out', flt, 'in');
  wire(flt, 'lp24', vca, 'in');
  wire(env, 'env', vca, 'cv');
  wire(vca, 'out', out, 'l');
});
{
  const m = tests.macro.modules;
  const unit = (type: string, name: string, v: number): number => paramUnit(DEFS[type].params.find((q) => q.name === name)!, v);
  m[5].range = { p1: { cutoff: [unit('filter', 'cutoff', 150), unit('filter', 'cutoff', 6000)] } };
  m[4].range = { p1: { d: [unit('adsr', 'd', 0.6), unit('adsr', 'd', 0.03)] } };
  m[3].range = { p2: { pw: [unit('osc', 'pw', 0.2), unit('osc', 'pw', 0.5)] } };
}
setMorphTarget(tests.morph, make('morph-b', morphVoice(true)), DEFS);
kit('crush-color', (add, wire) => {
  const nz = add('noise', 0, 0, { level: 0.6, color: 0.6 });
  const cr = add('crush', 0, 0, { bits: 6, rate: 5 });
  const out = add('output', 0, 0, { level: 0.8 });
  wire(nz, 'out', cr, 'in');
  wire(cr, 'out', out, 'l');
});

// Every dedicated input link at once (they are built in: a cable into cv always moves cutoff, and so on).
kit('fixed-links', (add, wire) => {
  const main = add('fm1', 0, 0, { morph: 0 });
  const osc = add('osc', 0, 0, { wave: 2, level: 1 });
  const cv = add('const', 0, 0, { value: .3 });
  const filter = add('filter', 0, 0, { cutoff: 1200, morph: .2 });
  const ladder = add('ladder', 0, 0, { cutoff: 1600, res: .1 });
  const pan = add('pan', 0, 0, { pan: -.2 });
  const xfade = add('xfade', 0, 0, { mix: .3 });
  const shift = add('shift', 0, 0, { shift: 50, cvamt: 100 });
  const vowel = add('vowel', 0, 0, { vowel: 1 });
  const amp = add('vca', 0, 0, { gain: .8 });
  const out = add('output', 0, 0, { level: 1 }); // the chain is quiet: keep the reference above the Q16 floor
  wire(main, 'pitch', osc, 'pitch');
  wire(osc, 'out', filter, 'in'); wire(filter, 'mix', ladder, 'in');
  wire(ladder, 'lp12', pan, 'in'); wire(pan, 'l', xfade, 'a'); wire(pan, 'r', xfade, 'b');
  wire(xfade, 'out', shift, 'in'); wire(shift, 'up', vowel, 'in'); wire(vowel, 'out', amp, 'in'); wire(amp, 'out', out, 'l');
  for (const [id, port] of [[main, 'morph'], [filter, 'cv'], [filter, 'morph'], [ladder, 'cv'], [pan, 'pos'], [xfade, 'pos'], [shift, 'cv'], [vowel, 'vowel'], [amp, 'cv']] as const)
    wire(cv, 'out', id, port);
});
{
  const p = tests['fixed-links'];
  const filter = p.modules.find((m) => m.type === 'filter')!;
  filter.paramsB = { ...filter.params, cutoff: 4000 };
  filter.range = { p1: { cutoff: [.2, .8] } }; // exercises all optional sections together
}

// A physical input fans out on top of its built-in link, alongside morph and macro ranges.
{
  const p = structuredClone(tests['fixed-links']);
  tests['side-input-fanout'] = p;
  const source = p.modules.find((m) => m.type === 'const')!; source.params.value = .015625;
  const amp = p.modules.find((m) => m.type === 'vca')!;
  const second = { ...structuredClone(source), id: Math.max(...p.modules.map((m) => m.id)) + 1 };
  p.modules.push(second);
  p.cables.push({ from: { module: second.id, port: 'out' }, to: { module: p.modules.find((m) => m.type === 'filter')!.id, port: 'cv' } });
  // the tiny source would close the VCA (an unplugged or near-zero cv is silence): hold it open with its own constant
  const open = { ...structuredClone(source), id: second.id + 1, params: { value: 1 } };
  p.modules.push(open);
  p.cables = p.cables.filter((c) => !(c.to.module === amp.id && c.to.port === 'cv'));
  p.cables.push({ from: { module: open.id, port: 'out' }, to: { module: amp.id, port: 'cv' } });
  for (const m of p.modules) {
    if (m.type === 'filter') m.inputMap = { cv: ['res', 'cvamt'], in: ['track'] };
    if (m.type === 'ladder') m.inputMap = { cv: ['res', 'drive'] };
    if (m.type === 'vca') m.inputMap = { in: ['gain'] };
    if (m.type === 'output') m.inputMap = { l: ['level'] };
  }
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
for (const [name, patch] of Object.entries(tests)) {
  const e = new Engine(SR);
  e.load(patch);
  const END = ends[name] ?? END_DEFAULT;
  const l = new Float32Array(END);
  const r = new Float32Array(END);
  let pos = 0;
  const seg = (to: number): void => {
    if (to > pos) {
      const a = new Float32Array(to - pos);
      const b = new Float32Array(to - pos);
      e.render(a, b);
      l.set(a, pos);
      r.set(b, pos);
      pos = to;
    }
  };
  const evs = events[name] ?? EVENTS;
  for (const [fr, kind, note] of evs) {
    seg(fr);
    if (kind === 'on') e.noteOn(note, 1);
    else e.noteOff(note);
  }
  seg(END);
  const st = new Float32Array(END * 2);
  for (let i = 0; i < END; i++) {
    st[2 * i] = l[i];
    st[2 * i + 1] = r[i];
  }
  const f = slug(name);
  const cpu = cpuEstimate(patch).use;
  if (cpu > 1) console.log(`${name}: estimated at ${Math.round(cpu * 100)} % of the FM-1's CPU (a correctness kit, not a real-time one)`);
  writeFileSync(new URL(`${f}.m1p`, OUT), encodePatch(patch, true));
  writeFileSync(new URL(`${f}.f32`, OUT), new Uint8Array(st.buffer));
  writeFileSync(new URL(`${f}.ev`, OUT), evs.map(([fr, k, n]) => (k === 'on' ? `${fr} on ${n} 127` : `${fr} off ${n}`)).join('\n') + `\n${END} end\n`);
}
// protocol test input: upload of 303 Acid, then a cutoff change on its filter
{
  const p = PRESETS['303 Acid']();
  const bin = encodePatch(p);
  const mod = p.modules.findIndex((m) => m.type === 'filter');
  const par = DEFS.filter.params.findIndex((x) => x.name === 'cutoff');
  const val = toQ16(900);
  const attVal = toQ16(-0.5);
  const frames = [...chunkFrames(bin, 50), commitFrame(bin), paramFrame(mod, par, val), attFrame(mod, 0, attVal)];
  writeFileSync(new URL('proto.syx', OUT), Buffer.concat(frames));
  // preset bank: the patch into slot 5 as '303 ACID', an erase of slot 7 and an info request for slot 5, then a slot
  // command with a wrong CRC (must be refused)
  const bad = Uint8Array.from(bin);
  const slotFrames = [...chunkFrames(bin, 90), slotFrame(5, '303 ACID', bin), slotInfoFrame(5), slotEraseFrame(7), ...chunkFrames(bad, 90), slotFrame(6, 'BAD', bad, 0x1234)];
  writeFileSync(new URL('proto-slot.syx', OUT), Buffer.concat(slotFrames));
  writeFileSync(new URL('proto.args', OUT), `${mod} ${par} ${val} ${mod} 0 ${attVal}\n`);
}
console.log(`golden vectors for ${Object.keys(tests).length} patches in build/golden/`);
