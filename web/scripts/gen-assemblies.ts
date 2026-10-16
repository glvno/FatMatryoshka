// SPDX-License-Identifier: GPL-3.0-only
// Writes the factory assemblies (src/assemblies/*.json) that are defined here as small patches: module grid positions,
// cables, the exposed ports (an input with `also` fans out to several inner inputs) and the promoted parameters.
// `voice` and `echo` are kept as files. Run from web/:  npx vite-node scripts/gen-assemblies.ts
import { writeFileSync } from 'node:fs';
import { DEFS } from '../src/modules';
import { defaultMap, defaultParams, POLY_DEFAULT, type ModuleInst, type PolyCfg, type Source } from '../src/patch';
import { pinsToParams, type AssemblyDef, type PortRef, type ParamRef } from '../src/assembly';

const OUT = new URL('../src/assemblies/', import.meta.url);
const GX = 320;
const GY = 560;

interface B {
  /** add a module at grid column / row; returns its local id */
  add(type: string, col: number, row: number, params?: Record<string, number>, o?: { p1?: string; p2?: string; att?: [number, number] }): number;
  wire(a: number, ap: string, b: number, bp: string): void;
  input(label: string, module: number, port: string, ...also: [number, string][]): void;
  output(label: string, module: number, port: string): void;
  param(label: string, module: number, param: string): void;
}

function build(name: string, category: string, f: (b: B) => void, poly?: Partial<PolyCfg>): AssemblyDef {
  const modules: ModuleInst[] = [];
  const cables: AssemblyDef['cables'] = [];
  const inputs: (PortRef & { also?: { module: number; port: string }[] })[] = [];
  const outputs: PortRef[] = [];
  const params: ParamRef[] = [];
  const check = (id: number, port: string, dir: 'inputs' | 'outputs'): void => {
    const m = modules[id - 1];
    if (!m || !DEFS[m.type][dir].some((p) => p.name === port)) throw new Error(`${name}: no ${dir} ${port} on module ${id}`);
  };
  const b: B = {
    add(type, col, row, p = {}, o = {}) {
      const def = DEFS[type];
      if (!def) throw new Error(`${name}: no module type ${type}`);
      for (const k of Object.keys(p)) if (!def.params.some((q) => q.name === k)) throw new Error(`${name}: ${type} has no parameter ${k}`);
      const map = defaultMap(def) as Record<Source, string[]>;
      map.k1 = map.k2 = map.k3 = map.k4 = [];
      if (o.p1) map.p1 = [o.p1];
      if (o.p2) map.p2 = [o.p2];
      const m: ModuleInst = { id: modules.length + 1, type, x: col * GX, y: row * GY, params: { ...defaultParams(def), ...p } };
      if (def.paramInputs) {
        m.att = o.att ?? [1, 1];
        m.map = map;
      }
      modules.push(m);
      return m.id;
    },
    wire(a, ap, bb, bp) {
      check(a, ap, 'outputs');
      check(bb, bp, 'inputs');
      cables.push({ from: { module: a, port: ap }, to: { module: bb, port: bp } });
    },
    input(label, module, port, ...also) {
      check(module, port, 'inputs');
      for (const [m, p] of also) check(m, p, 'inputs');
      inputs.push({ module, port, label, ...(also.length ? { also: also.map(([m, p]) => ({ module: m, port: p })) } : {}) });
    },
    output(label, module, port) {
      check(module, port, 'outputs');
      outputs.push({ module, port, label });
    },
    param(label, module, param) {
      const m = modules[module - 1];
      if (!m || !DEFS[m.type].params.some((q) => q.name === param)) throw new Error(`${name}: no parameter ${param} on module ${module}`);
      params.push({ module, param, label });
    },
  };
  f(b);
  return { format: 'modular-1-assembly', version: 1, name, category, modules, cables, inputs, outputs, params, ...(poly ? { poly: { ...POLY_DEFAULT, ...poly } } : {}) };
}

const defs: AssemblyDef[] = [];
/** category: the shelf of the editor's assembly browser (CATEGORIES in src/assemblies.ts) */
/** `poly`: a poly assembly (it plays its own Part module's notes, one per part) */
const asm = (name: string, category: string, f: (b: B) => void, poly?: Partial<PolyCfg>): void => {
  defs.push(build(name, category, f, poly));
};

// an FM operator: oscillator, DX-style level / rate envelope, VCA
asm('operator', 'Voices', (b) => {
  const osc = b.add('osc', 0, 0, { wave: 0, level: 1 });
  const env = b.add('env', 1, 0, { l1: 1, r1: 0.002, l2: 0.6, r2: 0.3, l3: 0.4, r3: 1, l4: 0, r4: 0.3 });
  const vca = b.add('vca', 2, 0);
  b.wire(osc, 'out', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('pitch', osc, 'pitch');
  b.input('gate', env, 'gate');
  b.input('pm', osc, 'pm');
  b.input('level cv', vca, 'p1');
  b.output('out', vca, 'out');
  b.param('ratio', osc, 'coarse');
  b.param('detune', osc, 'fine');
  b.param('index', osc, 'pm');
  b.param('feedback', osc, 'fb');
  b.param('level', vca, 'gain');
  for (const q of ['l1', 'r1', 'l2', 'r2', 'l3', 'r3', 'l4', 'r4']) b.param(q, env, q);
});

// two operators: a modulator with its own envelope into the carrier's phase, the carrier with its envelope
asm('fm pair', 'Voices', (b) => {
  const mod = b.add('osc', 0, 0, { wave: 0, coarse: 12, level: 1 });
  const menv = b.add('env', 1, 0, { l1: 1, r1: 0.002, l2: 0.3, r2: 0.4, l3: 0.2, r3: 1, l4: 0, r4: 0.3 });
  const mvca = b.add('vca', 2, 0);
  const car = b.add('osc', 0, 1, { wave: 0, pm: 3, level: 0.8 });
  const cenv = b.add('env', 1, 1, { l1: 1, r1: 0.003, l2: 0.7, r2: 0.3, l3: 0.6, r3: 1, l4: 0, r4: 0.4 });
  const cvca = b.add('vca', 2, 1);
  b.wire(mod, 'out', mvca, 'in');
  b.wire(menv, 'env', mvca, 'cv');
  b.wire(mvca, 'out', car, 'pm');
  b.wire(car, 'out', cvca, 'in');
  b.wire(cenv, 'env', cvca, 'cv');
  b.input('pitch', car, 'pitch', [mod, 'pitch']);
  b.input('gate', cenv, 'gate', [menv, 'gate']);
  b.output('out', cvca, 'out');
  b.param('index', car, 'pm');
  b.param('ratio', mod, 'coarse');
  b.param('feedback', mod, 'fb');
  b.param('mod decay', menv, 'r2');
  b.param('mod sustain', menv, 'l3');
  b.param('attack', cenv, 'r1');
  b.param('release', cenv, 'r4');
});

// a kick (909 style): a sine with a fast pitch drop, a decaying amplitude envelope, a 1 ms noise click and a little drive
asm('kick', 'Drums', (b) => {
  const osc = b.add('osc', 0, 0, { wave: 0, coarse: -26, level: 1 });
  const penv = b.add('env', 1, 0, { l1: 1, r1: 0.001, l2: 0, r2: 0.07, l3: 0, r3: 0.1, l4: 0, r4: 0.05 });
  const sc = b.add('scale', 2, 0, { gain: 2.5, offset: 0 });
  const aenv = b.add('env', 0, 1, { l1: 1, r1: 0.001, l2: 0.5, r2: 0.12, l3: 0, r3: 0.35, l4: 0, r4: 0.05 });
  const vca = b.add('vca', 1, 1);
  const drive = b.add('shape', 2, 1, { drive: 1.6, mode: 0, level: 0.9 });
  const nz = b.add('noise', 3, 0, { level: 0.5 });
  const cenv = b.add('env', 3, 1, { l1: 1, r1: 0.001, l2: 0, r2: 0.002, l3: 0, r3: 0.002, l4: 0, r4: 0.002 });
  const cvca = b.add('vca', 4, 0);
  const mix = b.add('mixer', 4, 1, { l1: 1, l2: 0.6, l3: 0, l4: 0 });
  b.wire(penv, 'env', sc, 'in');
  b.wire(sc, 'out', osc, 'pitch');
  b.wire(osc, 'out', vca, 'in');
  b.wire(aenv, 'env', vca, 'cv');
  b.wire(nz, 'out', cvca, 'in');
  b.wire(cenv, 'env', cvca, 'cv');
  b.wire(vca, 'out', mix, 'in1');
  b.wire(cvca, 'out', mix, 'in2');
  b.wire(mix, 'out', drive, 'in');
  b.input('gate', aenv, 'gate', [penv, 'gate'], [cenv, 'gate']);
  b.output('out', drive, 'out');
  b.param('tune', osc, 'coarse');
  b.param('drop', sc, 'gain');
  b.param('drop time', penv, 'r2');
  b.param('decay', aenv, 'r3');
  b.param('punch', aenv, 'r2');
  b.param('click', mix, 'l2');
  b.param('drive', drive, 'drive');
});

// a clap: a noise band with a flam (a two-bump envelope on a 20 ms trigger) and a longer tail
asm('clap', 'Drums', (b) => {
  const nz = b.add('noise', 0, 0, { level: 1 });
  const flt = b.add('filter', 1, 0, { cutoff: 1200, res: 0.55 });
  const pl = b.add('pulse', 0, 1, { time: 0.02 });
  const fenv = b.add('env', 1, 1, { l1: 1, r1: 0.001, l2: 0.1, r2: 0.01, l3: 0.9, r3: 0.008, l4: 0, r4: 0.01 });
  const fvca = b.add('vca', 2, 0);
  const tenv = b.add('env', 2, 1, { l1: 1, r1: 0.001, l2: 0, r2: 0.12, l3: 0, r3: 0.1, l4: 0, r4: 0.05 });
  const tvca = b.add('vca', 3, 0, { gain: 0.7 });
  const mix = b.add('mixer', 3, 1, { l1: 0.9, l2: 0.9, l3: 0, l4: 0 });
  b.wire(nz, 'out', flt, 'in');
  b.wire(flt, 'bp', fvca, 'in');
  b.wire(flt, 'bp', tvca, 'in');
  b.wire(pl, 'out', fenv, 'gate');
  b.wire(fenv, 'env', fvca, 'cv');
  b.wire(tenv, 'env', tvca, 'cv');
  b.wire(fvca, 'out', mix, 'in1');
  b.wire(tvca, 'out', mix, 'in2');
  b.input('gate', pl, 'trig', [tenv, 'gate']);
  b.output('out', mix, 'out');
  b.param('tone', flt, 'cutoff');
  b.param('tail', tenv, 'r2');
  b.param('flam', fenv, 'r2');
  b.param('tail level', tvca, 'gain');
});

// a rim shot / cross-stick: a 2 ms strike into a short inharmonic modal body and a tuned comb for the stick
asm('rim', 'Drums', (b) => {
  const pl = b.add('pulse', 0, 0, { time: 0.002 });
  const hit = b.add('scale', 0, 1, { gain: 0.06, offset: 0 });
  const md = b.add('modal', 1, 0, { coarse: 12, decay: 0.06, struct: 0.6, bright: 0.8, damp: 0.2 });
  const cb = b.add('comb', 2, 0, { coarse: 24, fb: 0.6, damp: 0.5, mix: 0.5 });
  b.wire(pl, 'out', hit, 'in');
  b.wire(hit, 'out', md, 'in');
  b.wire(md, 'out', cb, 'in');
  b.input('gate', pl, 'trig');
  b.output('out', cb, 'out');
  b.param('tune', md, 'coarse');
  b.param('decay', md, 'decay');
  b.param('stick', cb, 'mix');
  b.param('body', md, 'struct');
  b.param('hit', hit, 'gain');
});

// hi-hats: a detuned square cluster plus noise through a 7 kHz high pass; `gate` is the closed hat (short), `open` the open
// one (long), and the closed hat chokes the open one (a 250 ms pulse on the closed trigger shuts the open hat's VCA)
asm('hats', 'Drums', (b) => {
  const osc = b.add('osc', 0, 0, { wave: 3, coarse: 38, level: 0.6, unison: 5, detune: 90, pw: 0.3 });
  const nz = b.add('noise', 1, 0, { level: 0.5 });
  const src = b.add('mixer', 2, 0, { l1: 0.7, l2: 0.7, l3: 0, l4: 0 });
  const flt = b.add('filter', 3, 0, { cutoff: 7000, res: 0.2 });
  const cenv = b.add('env', 0, 1, { l1: 1, r1: 0.001, l2: 0.3, r2: 0.02, l3: 0, r3: 0.07, l4: 0, r4: 0.02 });
  const cvca = b.add('vca', 1, 1);
  const oenv = b.add('env', 2, 1, { l1: 1, r1: 0.001, l2: 0.4, r2: 0.05, l3: 0, r3: 0.45, l4: 0, r4: 0.05 });
  const ovca = b.add('vca', 3, 1);
  const choke = b.add('pulse', 0, 2, { time: 0.25 });
  const inv = b.add('scale', 1, 2, { gain: -1, offset: 1 });
  const cvca2 = b.add('vca', 2, 2);
  const mix = b.add('mixer', 3, 2, { l1: 0.9, l2: 0.9, l3: 0, l4: 0 });
  b.wire(osc, 'out', src, 'in1');
  b.wire(nz, 'out', src, 'in2');
  b.wire(src, 'out', flt, 'in');
  b.wire(flt, 'hp', cvca, 'in');
  b.wire(flt, 'hp', ovca, 'in');
  b.wire(cenv, 'env', cvca, 'cv');
  b.wire(oenv, 'env', ovca, 'cv');
  b.wire(choke, 'out', inv, 'in');
  b.wire(ovca, 'out', cvca2, 'in');
  b.wire(inv, 'out', cvca2, 'cv');
  b.wire(cvca, 'out', mix, 'in1');
  b.wire(cvca2, 'out', mix, 'in2');
  b.input('gate', cenv, 'gate', [choke, 'trig']);
  b.input('open', oenv, 'gate');
  b.output('out', mix, 'out');
  b.param('decay', cenv, 'r3');
  b.param('open decay', oenv, 'r3');
  b.param('tone', flt, 'cutoff');
  b.param('metal', src, 'l1');
  b.param('noise', src, 'l2');
});

// a cowbell: two squares a sixth apart through a band pass and a short envelope
asm('cowbell', 'Drums', (b) => {
  const o1 = b.add('osc', 0, 0, { wave: 3, coarse: 14, fine: -5, level: 0.7 });
  const o2 = b.add('osc', 0, 1, { wave: 3, coarse: 20, fine: 30, level: 0.7 });
  const mix = b.add('mixer', 1, 0, { l1: 0.7, l2: 0.7, l3: 0, l4: 0 });
  const flt = b.add('filter', 2, 0, { cutoff: 1000, res: 0.5 });
  const env = b.add('env', 1, 1, { l1: 1, r1: 0.001, l2: 0.3, r2: 0.02, l3: 0, r3: 0.3, l4: 0, r4: 0.03 });
  const vca = b.add('vca', 2, 1);
  b.wire(o1, 'out', mix, 'in1');
  b.wire(o2, 'out', mix, 'in2');
  b.wire(mix, 'out', flt, 'in');
  b.wire(flt, 'bp', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('gate', env, 'gate');
  b.output('out', vca, 'out');
  b.param('tune', o1, 'coarse');
  b.param('tune 2', o2, 'coarse');
  b.param('decay', env, 'r3');
  b.param('tone', flt, 'cutoff');
});

// a tom: a harmonic modal body struck by a 2 ms pulse, with a pitch drop; `tune` picks the size
asm('tom', 'Drums', (b) => {
  const pl = b.add('pulse', 0, 0, { time: 0.002 });
  const hit = b.add('scale', 2, 0, { gain: 0.015, offset: 0 });
  const md = b.add('modal', 1, 0, { coarse: -12, decay: 0.5, struct: 0, bright: 0.4, damp: 0.5 });
  const denv = b.add('env', 0, 1, { l1: 1, r1: 0.001, l2: 0, r2: 0.08, l3: 0, r3: 0.1, l4: 0, r4: 0.05 });
  const sc = b.add('scale', 1, 1, { gain: 0.6, offset: 0 });
  b.wire(pl, 'out', hit, 'in');
  b.wire(hit, 'out', md, 'in');
  b.wire(denv, 'env', sc, 'in');
  b.wire(sc, 'out', md, 'pitch');
  b.input('gate', pl, 'trig', [denv, 'gate']);
  b.output('out', md, 'out');
  b.param('tune', md, 'coarse');
  b.param('decay', md, 'decay');
  b.param('drop', sc, 'gain');
  b.param('bright', md, 'bright');
  b.param('hit', hit, 'gain');
});

// a tabla / membrane: a slightly inharmonic modal head hit by a pulse and a noise slap; velocity opens `bright`, a slow
// envelope bends the pitch down (the bass drum's "ghe")
asm('tabla', 'Drums', (b) => {
  const pl = b.add('pulse', 0, 0, { time: 0.0015 });
  const nz = b.add('noise', 1, 0, { level: 1 });
  const nenv = b.add('env', 2, 0, { l1: 1, r1: 0.001, l2: 0, r2: 0.008, l3: 0, r3: 0.01, l4: 0, r4: 0.01 });
  const nvca = b.add('vca', 3, 0, { gain: 0.3 });
  const exc = b.add('mixer', 0, 1, { l1: 0.03, l2: 0.03, l3: 0, l4: 0 });
  const md = b.add('modal', 1, 1, { coarse: -5, decay: 0.6, struct: 0.15, bright: 0.35, damp: 0.5 }, { p1: 'bright', att: [0.5, 1] });
  const denv = b.add('env', 2, 1, { l1: 1, r1: 0.001, l2: 0, r2: 0.25, l3: 0, r3: 0.1, l4: 0, r4: 0.05 });
  const sc = b.add('scale', 3, 1, { gain: 0.3, offset: 0 });
  b.wire(pl, 'out', exc, 'in1');
  b.wire(nz, 'out', nvca, 'in');
  b.wire(nenv, 'env', nvca, 'cv');
  b.wire(nvca, 'out', exc, 'in2');
  b.wire(exc, 'out', md, 'in');
  b.wire(denv, 'env', sc, 'in');
  b.wire(sc, 'out', md, 'pitch');
  b.input('gate', pl, 'trig', [nenv, 'gate'], [denv, 'gate']);
  b.input('vel', md, 'p1');
  b.input('pitch', md, 'pitch');
  b.output('out', md, 'out');
  b.param('tune', md, 'coarse');
  b.param('decay', md, 'decay');
  b.param('drop', sc, 'gain');
  b.param('drop time', denv, 'r2');
  b.param('slap', nvca, 'gain');
});

// a snare: a noise burst through a high pass and a short sine body, mixed
asm('snare', 'Drums', (b) => {
  const nz = b.add('noise', 0, 0, { level: 1 });
  const flt = b.add('filter', 1, 0, { cutoff: 1500, res: 0.3 });
  const nvca = b.add('vca', 2, 0);
  const nenv = b.add('env', 3, 0, { l1: 1, r1: 0.001, l2: 0.3, r2: 0.06, l3: 0, r3: 0.18, l4: 0, r4: 0.03 });
  const osc = b.add('osc', 0, 1, { wave: 0, coarse: -7, level: 1 });
  const bvca = b.add('vca', 1, 1);
  const benv = b.add('env', 2, 1, { l1: 1, r1: 0.001, l2: 0.2, r2: 0.05, l3: 0, r3: 0.08, l4: 0, r4: 0.03 });
  const mix = b.add('mixer', 3, 1, { l1: 0.8, l2: 0.6, l3: 0, l4: 0 });
  b.wire(nz, 'out', flt, 'in');
  b.wire(flt, 'hp', nvca, 'in');
  b.wire(nenv, 'env', nvca, 'cv');
  b.wire(osc, 'out', bvca, 'in');
  b.wire(benv, 'env', bvca, 'cv');
  b.wire(nvca, 'out', mix, 'in1');
  b.wire(bvca, 'out', mix, 'in2');
  b.input('gate', nenv, 'gate', [benv, 'gate']);
  b.output('out', mix, 'out');
  b.param('snap', flt, 'cutoff');
  b.param('decay', nenv, 'r3');
  b.param('noise', mix, 'l1');
  b.param('body', mix, 'l2');
  b.param('body tune', osc, 'coarse');
});

// a hi-hat: noise through a high pass with a very short envelope
asm('hihat', 'Drums', (b) => {
  const nz = b.add('noise', 0, 0, { level: 1 });
  const flt = b.add('filter', 1, 0, { cutoff: 4000, res: 0.2 });
  const vca = b.add('vca', 2, 0, { gain: 0.8 });
  const env = b.add('env', 0, 1, { l1: 1, r1: 0.001, l2: 0.25, r2: 0.03, l3: 0, r3: 0.09, l4: 0, r4: 0.02 });
  b.wire(nz, 'out', flt, 'in');
  b.wire(flt, 'hp', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('gate', env, 'gate');
  b.output('out', vca, 'out');
  b.param('decay', env, 'r3');
  b.param('tone', flt, 'cutoff');
  b.param('level', vca, 'gain');
});

// a plucked string with a tracking low pass for the body
asm('pluck', 'Voices', (b) => {
  const str = b.add('string', 0, 0, { decay: 2, damp: 0.3, burst: 0, level: 0.8 });
  const flt = b.add('filter', 1, 0, { cutoff: 3000, res: 0.1, track: 1 });
  b.wire(str, 'out', flt, 'in');
  b.input('pitch', str, 'pitch');
  b.input('gate', str, 'gate');
  b.input('exc', str, 'exc');
  b.output('out', flt, 'lp24');
  b.param('decay', str, 'decay');
  b.param('damp', str, 'damp');
  b.param('pick', str, 'burst');
  b.param('tone', flt, 'cutoff');
});

// a wavetable pad: slow sweep of the frame position, low pass, slow envelope
asm('wavetable pad', 'Voices', (b) => {
  const wt = b.add('wavetable', 0, 0, { bank: 2, pos: 0.3, level: 0.7 }, { p1: 'pos', att: [0.5, 1] });
  const lfo = b.add('lfo', 1, 0, { wave: 1, rate: 0.15, depth: 1 });
  const flt = b.add('filter', 2, 0, { cutoff: 2500, res: 0.2 });
  const env = b.add('adsr', 0, 1, { a: 0.4, d: 0.5, s: 0.8, r: 0.8 });
  const vca = b.add('vca', 1, 1);
  b.wire(lfo, 'out', wt, 'p1');
  b.wire(wt, 'out', flt, 'in');
  b.wire(flt, 'lp24', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('pitch', wt, 'pitch');
  b.input('gate', env, 'gate');
  b.output('out', vca, 'out');
  b.param('bank', wt, 'bank');
  b.param('position', wt, 'pos');
  b.param('sweep', lfo, 'rate');
  b.param('cutoff', flt, 'cutoff');
  b.param('attack', env, 'a');
  b.param('release', env, 'r');
});

// a sub bass: glide, a square an octave down, a dark tracking low pass
asm('sub bass', 'Voices', (b) => {
  const gl = b.add('glide', 0, 0, { time: 0.08 });
  const osc = b.add('osc', 1, 0, { wave: 3, coarse: -12, level: 0.8 });
  const flt = b.add('filter', 2, 0, { cutoff: 300, res: 0.3, track: 1 });
  const env = b.add('adsr', 0, 1, { a: 0.005, d: 0.2, s: 0.8, r: 0.1 });
  const vca = b.add('vca', 1, 1);
  b.wire(gl, 'out', osc, 'pitch');
  b.wire(osc, 'out', flt, 'in');
  b.wire(flt, 'lp24', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('pitch', gl, 'in');
  b.input('gate', env, 'gate');
  b.output('out', vca, 'out');
  b.param('glide', gl, 'time');
  b.param('cutoff', flt, 'cutoff');
  b.param('res', flt, 'res');
  b.param('release', env, 'r');
});

// a vowel voice: a saw through the vowel filter swept by an LFO
asm('vowel voice', 'Voices', (b) => {
  const osc = b.add('osc', 0, 0, { wave: 2, level: 0.8 });
  const vow = b.add('vowel', 1, 0, { vowel: 0, res: 0.6, level: 0.8 });
  const lfo = b.add('lfo', 2, 0, { wave: 1, rate: 0.3, depth: 1 });
  const sc = b.add('scale', 3, 0, { gain: 2, offset: 2 });
  const env = b.add('adsr', 0, 1, { a: 0.05, d: 0.3, s: 0.7, r: 0.3 });
  const vca = b.add('vca', 1, 1);
  b.wire(osc, 'out', vow, 'in');
  b.wire(lfo, 'out', sc, 'in');
  b.wire(sc, 'out', vow, 'vowel');
  b.wire(vow, 'out', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('pitch', osc, 'pitch');
  b.input('gate', env, 'gate');
  b.output('out', vca, 'out');
  b.param('rate', lfo, 'rate');
  b.param('res', vow, 'res');
  b.param('depth', sc, 'gain');
  b.param('release', env, 'r');
});

// ---- the recipes of the factory patches (presets.ts voice() / toOut()), so a patch opens as a few cards

// one oscillator through a filter into a VCA with one ADSR (the filter's cv is exposed for an envelope or LFO)
asm('filter voice', 'Voices', (b) => {
  const osc = b.add('osc', 0, 0, { wave: 2, level: 0.8 });
  const flt = b.add('filter', 1, 0, { cutoff: 1200, res: 0.3 });
  const env = b.add('adsr', 0, 1, { a: 0.01, d: 0.2, s: 0.6, r: 0.3 });
  const vca = b.add('vca', 1, 1);
  b.wire(osc, 'out', flt, 'in');
  b.wire(flt, 'lp12', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('pitch', osc, 'pitch');
  b.input('gate', env, 'gate');
  b.input('cutoff cv', flt, 'cv');
  b.output('out', vca, 'out');
  b.param('wave', osc, 'wave');
  b.param('cutoff', flt, 'cutoff');
  b.param('res', flt, 'res');
  for (const q of ['a', 'd', 's', 'r']) b.param(q, env, q);
});

// an oscillator into a VCA with an ADSR: the operator of the FM patches, a plain voice without a filter
asm('adsr operator', 'Voices', (b) => {
  const osc = b.add('osc', 0, 0, { wave: 0, level: 0.8 });
  const env = b.add('adsr', 1, 0, { a: 0.01, d: 0.2, s: 0.6, r: 0.3 });
  const vca = b.add('vca', 2, 0);
  b.wire(osc, 'out', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('pitch', osc, 'pitch');
  b.input('gate', env, 'gate');
  b.input('pm', osc, 'pm');
  b.output('out', vca, 'out');
  b.param('wave', osc, 'wave');
  b.param('ratio', osc, 'coarse');
  b.param('index', osc, 'pm');
  b.param('level', osc, 'level');
  for (const q of ['a', 'd', 's', 'r']) b.param(q, env, q);
});

// noise through a filter into a VCA with an ADSR: wind, hats, sweeps
asm('noise voice', 'Voices', (b) => {
  const nz = b.add('noise', 0, 0, { level: 0.6 });
  const flt = b.add('filter', 1, 0, { cutoff: 2000, res: 0.4 });
  const env = b.add('adsr', 0, 1, { a: 0.01, d: 0.2, s: 0.5, r: 0.3 });
  const vca = b.add('vca', 1, 1);
  b.wire(nz, 'out', flt, 'in');
  b.wire(flt, 'bp', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('gate', env, 'gate');
  b.input('cutoff cv', flt, 'cv');
  b.output('out', vca, 'out');
  b.param('color', nz, 'color');
  b.param('cutoff', flt, 'cutoff');
  b.param('res', flt, 'res');
  for (const q of ['a', 'd', 's', 'r']) b.param(q, env, q);
});

// two oscillators into a mixer, a filter and a VCA with an ADSR (a third oscillator can go into the mixer's in3)
asm('stack voice', 'Voices', (b) => {
  const o1 = b.add('osc', 0, 0, { wave: 2, level: 0.7 });
  const o2 = b.add('osc', 0, 1, { wave: 2, fine: 8, level: 0.7 });
  const mix = b.add('mixer', 1, 0, { l1: 0.7, l2: 0.7, l3: 0.7, l4: 0 });
  const flt = b.add('filter', 2, 0, { cutoff: 1500, res: 0.2 });
  const env = b.add('adsr', 1, 1, { a: 0.05, d: 0.3, s: 0.7, r: 0.4 });
  const vca = b.add('vca', 2, 1);
  b.wire(o1, 'out', mix, 'in1');
  b.wire(o2, 'out', mix, 'in2');
  b.wire(mix, 'out', flt, 'in');
  b.wire(flt, 'lp12', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('pitch', o1, 'pitch', [o2, 'pitch']);
  b.input('gate', env, 'gate');
  b.input('in3', mix, 'in3');
  b.input('cutoff cv', flt, 'cv');
  b.output('out', vca, 'out');
  b.param('detune', o2, 'fine');
  b.param('cutoff', flt, 'cutoff');
  b.param('res', flt, 'res');
  for (const q of ['a', 'd', 's', 'r']) b.param(q, env, q);
});

// a mono lead: a poly assembly of one part (so its legato and priority apply), whose portamento only acts on legato
// playing: the Part's legato output lengthens the glide by `porta` of the time range while a note overlaps the one before
asm('mono lead', 'Voices', (b) => {
  const part = b.add('part', 0, 1);
  const gl = b.add('glide', 0, 0, { time: 0.001 }, { p1: 'time', att: [0.6, 1] });
  const osc = b.add('osc', 1, 0, { wave: 2, level: 0.8, unison: 2, detune: 6 });
  const flt = b.add('ladder', 2, 0, { cutoff: 1800, res: 0.35 });
  const env = b.add('adsr', 1, 1, { a: 0.005, d: 0.25, s: 0.6, r: 0.2 });
  const vca = b.add('vca', 2, 1);
  b.wire(part, 'pitch', gl, 'in');
  b.wire(part, 'legato', gl, 'p1');
  b.wire(part, 'gate', env, 'gate');
  b.wire(gl, 'out', osc, 'pitch');
  b.wire(osc, 'out', flt, 'in');
  b.wire(flt, 'lp24', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('cutoff cv', flt, 'cv');
  b.output('out', vca, 'out');
  b.param('porta', gl, 'time');
  b.param('curve', gl, 'curve');
  b.param('cutoff', flt, 'cutoff');
  b.param('res', flt, 'res');
  for (const q of ['a', 'd', 's', 'r']) b.param(q, env, q);
}, { parts: 1 });

// a supersaw pad of four parts: five detuned copies with the centre one held back (blend), an octave stacked on top, each
// part panned by its index (spread across the stereo field by `width`)
asm('supersaw stack', 'Voices', (b) => {
  const part = b.add('part', 0, 2);
  const osc = b.add('osc', 0, 0, { wave: 2, level: 0.9, unison: 5, detune: 22, blend: 0.65, stack: 1 });
  const flt = b.add('filter', 1, 0, { cutoff: 3500, res: 0.15 });
  const env = b.add('adsr', 0, 1, { a: 0.02, d: 0.4, s: 0.75, r: 0.5 });
  const vca = b.add('vca', 1, 1);
  const width = b.add('scale', 1, 2, { gain: 0.6, offset: 0 });
  const pan = b.add('pan', 2, 0, { pan: 0 });
  b.wire(part, 'pitch', osc, 'pitch');
  b.wire(part, 'gate', env, 'gate');
  b.wire(part, 'index', width, 'in');
  b.wire(width, 'out', pan, 'pos');
  b.wire(osc, 'out', flt, 'in');
  b.wire(flt, 'lp12', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.wire(vca, 'out', pan, 'in');
  b.output('l', pan, 'l');
  b.output('r', pan, 'r');
  for (const q of ['unison', 'detune', 'blend', 'stack']) b.param(q, osc, q);
  b.param('cutoff', flt, 'cutoff');
  b.param('width', width, 'gain');
  for (const q of ['a', 'd', 's', 'r']) b.param(q, env, q);
}, { parts: 4 });

// an analog polysynth voice of four parts that has drifted out of spec: each oscillator's fine tune follows its own slow
// Random walk (a few cents), a fixed Random per part (its tolerance) offsets the cutoff and the decay. `unit` of the
// assembly picks another set of values: another instrument of the same model.
asm('analog voice', 'Voices', (b) => {
  const part = b.add('part', 0, 2);
  const w1 = b.add('random', 1, 2, { mode: 1, rate: 0.7 });
  const w2 = b.add('random', 2, 2, { mode: 1, rate: 0.9 });
  const tol = b.add('random', 3, 2, { mode: 0 });
  const o1 = b.add('osc', 0, 0, { wave: 2, level: 0.7 }, { p1: 'fine', att: [0.03, 1] });
  const o2 = b.add('osc', 0, 1, { wave: 3, pw: 0.45, level: 0.6, fine: 4 }, { p1: 'fine', att: [0.045, 1] });
  const mix = b.add('mixer', 1, 0, { l1: 0.7, l2: 0.6, l3: 0, l4: 0 });
  const flt = b.add('filter', 2, 0, { cutoff: 1400, res: 0.25 }, { p1: 'cutoff', att: [0.08, 1] });
  const env = b.add('adsr', 1, 1, { a: 0.008, d: 0.35, s: 0.55, r: 0.3 }, { p1: 'd', att: [0.06, 1] });
  const vca = b.add('vca', 2, 1);
  b.wire(part, 'pitch', o1, 'pitch');
  b.wire(part, 'pitch', o2, 'pitch');
  b.wire(part, 'gate', env, 'gate');
  b.wire(w1, 'out', o1, 'p1');
  b.wire(w2, 'out', o2, 'p1');
  b.wire(tol, 'out', flt, 'p1');
  b.wire(tol, 'out', env, 'p1');
  b.wire(o1, 'out', mix, 'in1');
  b.wire(o2, 'out', mix, 'in2');
  b.wire(mix, 'out', flt, 'in');
  b.wire(flt, 'lp24', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.output('out', vca, 'out');
  b.param('drift rate', w1, 'rate');
  b.param('cutoff', flt, 'cutoff');
  b.param('res', flt, 'res');
  for (const q of ['a', 'd', 's', 'r']) b.param(q, env, q);
}, { parts: 4 });

// the plainest polyphonic voice: a poly assembly of four parts (saw, low pass, ADSR, VCA), each playing its own note
asm('poly voice', 'Voices', (b) => {
  const part = b.add('part', 0, 1);
  const osc = b.add('osc', 0, 0, { wave: 2, level: 0.8 });
  const flt = b.add('filter', 1, 0, { cutoff: 2000, res: 0.2 });
  const env = b.add('adsr', 1, 1, { a: 0.005, d: 0.3, s: 0.6, r: 0.3 });
  const vca = b.add('vca', 2, 0);
  b.wire(part, 'pitch', osc, 'pitch');
  b.wire(part, 'gate', env, 'gate');
  b.wire(osc, 'out', flt, 'in');
  b.wire(flt, 'lp24', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('cutoff cv', flt, 'cv');
  b.output('out', vca, 'out');
  b.param('wave', osc, 'wave');
  b.param('cutoff', flt, 'cutoff');
  b.param('res', flt, 'res');
  for (const q of ['a', 'd', 's', 'r']) b.param(q, env, q);
}, { parts: 4 });

// an LFO through a Scale: vibrato (into a pitch input), tremolo (into a VCA's cv with an offset), a filter sweep
asm('vibrato', 'Utilities', (b) => {
  const lfo = b.add('lfo', 0, 0, { wave: 0, rate: 5, depth: 1 });
  const sc = b.add('scale', 1, 0, { gain: 0.03, offset: 0 });
  b.wire(lfo, 'out', sc, 'in');
  b.input('reset', lfo, 'reset');
  b.output('out', sc, 'out');
  b.param('rate', lfo, 'rate');
  b.param('depth', sc, 'gain');
  b.param('offset', sc, 'offset');
  b.param('wave', lfo, 'wave');
});

// a step sequencer with its own clock: pitch (quantized) and gate out; add its pitch to Main's into an oscillator
asm('step sequencer', 'Utilities', (b) => {
  const clk = b.add('lfo', 0, 0, { wave: 3, rate: 8, depth: 1 });
  const sq = b.add('seq', 1, 0, { s1: 0, s2: 0.25, s3: 0.58, s4: 0.33, s5: 0, s6: 0.75, s7: 0.58, s8: 1, len: 8, dir: 0 });
  const qn = b.add('quant', 2, 0, { scale: 1, root: 0 });
  b.wire(clk, 'out', sq, 'clock');
  b.wire(sq, 'out', qn, 'in');
  b.input('reset', sq, 'reset', [clk, 'reset']);
  b.output('pitch', qn, 'out');
  b.output('gate', sq, 'gate');
  b.param('tempo', clk, 'rate');
  b.param('length', sq, 'len');
  b.param('direction', sq, 'dir');
  b.param('scale', qn, 'scale');
  b.param('root', qn, 'root');
  for (const q of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) b.param(q, sq, q);
});

// a random melody: clocked sample & hold on noise, quantized; a pulse makes the gate
asm('random melody', 'Utilities', (b) => {
  const clk = b.add('lfo', 0, 0, { wave: 3, rate: 6, depth: 1 });
  const nz = b.add('noise', 1, 0, { level: 0.6 });
  const sh = b.add('sh', 2, 0, { mode: 0 });
  const qn = b.add('quant', 3, 0, { scale: 4, root: 0 });
  const pl = b.add('pulse', 1, 1, { time: 0.08 });
  b.wire(nz, 'out', sh, 'in');
  b.wire(clk, 'out', sh, 'clock');
  b.wire(sh, 'out', qn, 'in');
  b.wire(clk, 'out', pl, 'trig');
  b.input('reset', clk, 'reset');
  b.output('pitch', qn, 'out');
  b.output('gate', pl, 'out');
  b.param('tempo', clk, 'rate');
  b.param('range', nz, 'level');
  b.param('scale', qn, 'scale');
  b.param('root', qn, 'root');
  b.param('gate length', pl, 'time');
});

// a clock with divisions
asm('clock', 'Utilities', (b) => {
  const clk = b.add('lfo', 0, 0, { wave: 3, rate: 4, depth: 1 });
  const dv = b.add('clkdiv', 1, 0, { div: 3 });
  b.wire(clk, 'out', dv, 'clock');
  b.input('reset', clk, 'reset', [dv, 'reset']);
  b.output('clock', clk, 'out');
  b.output('/2', dv, 'd2');
  b.output('/4', dv, 'd4');
  b.output('/8', dv, 'd8');
  b.output('/div', dv, 'out');
  b.param('rate', clk, 'rate');
  b.param('div', dv, 'div');
});

// ---- granular

// a cloud: whatever comes in, scattered into a dense pitch-true cloud; `freeze` is the instrument: play a chord, freeze it,
// play over the cloud (put a Reverb after it)
asm('cloud', 'Textures', (b) => {
  const gr = b.add('grain', 0, 0, { position: 0.3, size: 0.15, density: 25, pitch: 0, spray: 0.6, freeze: 0, mix: 1 });
  b.input('in', gr, 'in');
  b.input('trig', gr, 'trig');
  b.output('out', gr, 'out');
  b.param('freeze', gr, 'freeze');
  b.param('position', gr, 'position');
  b.param('pitch', gr, 'pitch');
  b.param('spray', gr, 'spray');
  b.param('size', gr, 'size');
  b.param('density', gr, 'density');
  b.param('mix', gr, 'mix');
});

// shimmer: the reverb's tail is fed back through a granular pitch shift an octave up (one Reverb and one Granular: the
// patch cannot hold another of either)
asm('shimmer', 'Textures', (b) => {
  const mix = b.add('mixer', 0, 0, { l1: 1, l2: 0.4, l3: 0, l4: 0 });
  const rv = b.add('reverb', 1, 0, { size: 0.8, damp: 0.3, mix: 0.5, pre: 10, mod: 0.4 });
  const gr = b.add('grain', 2, 0, { position: 0.05, size: 0.25, density: 12, pitch: 12, spray: 0, freeze: 0, mix: 1 });
  b.wire(mix, 'out', rv, 'in');
  b.wire(rv, 'out', gr, 'in');
  b.wire(gr, 'out', mix, 'in2');
  b.input('in', mix, 'in1');
  b.output('out', rv, 'out');
  b.param('shimmer', mix, 'l2');
  b.param('decay', rv, 'size');
  b.param('interval', gr, 'pitch');
  b.param('damp', rv, 'damp');
  b.param('mix', rv, 'mix');
});

// stutter: grains fired by an internal clock (divided), the read position jumping with a slow square; density 0 = only the
// clock fires grains
asm('stutter', 'Effects', (b) => {
  const clk = b.add('lfo', 0, 0, { wave: 3, rate: 8, depth: 1 });
  const dv = b.add('clkdiv', 1, 0, { div: 2 });
  const pos = b.add('lfo', 0, 1, { wave: 3, rate: 0.7, depth: 1 });
  const sc = b.add('scale', 1, 1, { gain: 0.2, offset: 0 });
  const gr = b.add('grain', 2, 0, { position: 0.3, size: 0.12, density: 0, pitch: 0, spray: 0, freeze: 0, mix: 1 }, { p1: 'position', att: [1, 1] });
  b.wire(clk, 'out', dv, 'clock');
  b.wire(dv, 'out', gr, 'trig');
  b.wire(pos, 'out', sc, 'in');
  b.wire(sc, 'out', gr, 'p1');
  b.input('in', gr, 'in');
  b.input('reset', clk, 'reset', [dv, 'reset']);
  b.output('out', gr, 'out');
  b.param('rate', clk, 'rate');
  b.param('div', dv, 'div');
  b.param('size', gr, 'size');
  b.param('pitch', gr, 'pitch');
  b.param('jump', sc, 'gain');
  b.param('freeze', gr, 'freeze');
});

// time smear: a feedback delay into grains an octave down whose read position drifts with a slow triangle, crossfaded with
// the dry signal (holds the patch's Delay and Granular)
asm('time smear', 'Textures', (b) => {
  const dly = b.add('delay', 0, 0, { time: 400, fb: 0.5, mix: 1 });
  const lfo = b.add('lfo', 0, 1, { wave: 1, rate: 0.1, depth: 1 });
  const sc = b.add('scale', 1, 1, { gain: 0.3, offset: 0 });
  const gr = b.add('grain', 1, 0, { position: 0.5, size: 0.3, density: 8, pitch: -12, spray: 0.2, freeze: 0, mix: 1 }, { p1: 'position', att: [1, 1] });
  const xf = b.add('xfade', 2, 0, { mix: 0.5 });
  b.wire(dly, 'out', gr, 'in');
  b.wire(lfo, 'out', sc, 'in');
  b.wire(sc, 'out', gr, 'p1');
  b.wire(gr, 'out', xf, 'b');
  b.input('in', dly, 'in', [xf, 'a']);
  b.output('out', xf, 'out');
  b.param('smear', xf, 'mix');
  b.param('time', dly, 'time');
  b.param('feedback', dly, 'fb');
  b.param('pitch', gr, 'pitch');
  b.param('drift', lfo, 'rate');
});

// a slicer: a step sequencer picks the read position of the last second of audio, its gate fires the grain: a sample
// slicer on whatever was played into it
asm('slicer', 'Effects', (b) => {
  const clk = b.add('lfo', 0, 0, { wave: 3, rate: 8, depth: 1 });
  const sq = b.add('seq', 1, 0, { s1: -0.8, s2: 0.2, s3: -0.4, s4: 0.8, s5: 0, s6: -0.6, s7: 0.5, s8: -0.2, len: 8, dir: 0 });
  const gr = b.add('grain', 2, 0, { position: 0.5, size: 0.2, density: 0, pitch: 0, spray: 0, freeze: 0, mix: 1 }, { p1: 'position', att: [0.5, 1] });
  b.wire(clk, 'out', sq, 'clock');
  b.wire(sq, 'out', gr, 'p1');
  b.wire(sq, 'gate', gr, 'trig');
  b.input('in', gr, 'in');
  b.input('reset', sq, 'reset', [clk, 'reset']);
  b.output('out', gr, 'out');
  b.param('tempo', clk, 'rate');
  b.param('length', sq, 'len');
  b.param('direction', sq, 'dir');
  b.param('size', gr, 'size');
  b.param('pitch', gr, 'pitch');
  b.param('freeze', gr, 'freeze');
  for (const q of ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8']) b.param(q, sq, q);
});

// a reverse pad: long grains read from `age` seconds back, under a slow attack: a "played from the past" smear (turn age up for the oldest audio)
asm('reverse pad', 'Textures', (b) => {
  const gr = b.add('grain', 0, 0, { position: 0.2, size: 0.15, density: 12, pitch: 0, spray: 0, freeze: 0, mix: 1 });
  const env = b.add('adsr', 0, 1, { a: 0.5, d: 0.5, s: 1, r: 1.5 });
  const vca = b.add('vca', 1, 0);
  b.wire(gr, 'out', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.input('in', gr, 'in');
  b.input('gate', env, 'gate');
  b.output('out', vca, 'out');
  b.param('attack', env, 'a');
  b.param('release', env, 'r');
  b.param('age', gr, 'position');
  b.param('size', gr, 'size');
  b.param('pitch', gr, 'pitch');
});

// ---- modal

// a glass bell: a 3 ms strike into a bar-like modal body, a little frequency shift for the shimmer; velocity opens `bright`
asm('glass bell', 'Voices', (b) => {
  const pl = b.add('pulse', 0, 0, { time: 0.003 });
  const hit = b.add('scale', 0, 1, { gain: 0.04, offset: 0 });
  const md = b.add('modal', 1, 0, { coarse: 0, decay: 4, struct: 1, bright: 0.7, damp: 0.2 }, { p1: 'bright', att: [0.4, 1] });
  const fs = b.add('shift', 2, 0, { shift: 3, cvamt: 100, mix: 0.3 });
  b.wire(pl, 'out', hit, 'in');
  b.wire(hit, 'out', md, 'in');
  b.wire(md, 'out', fs, 'in');
  b.input('gate', pl, 'trig');
  b.input('pitch', md, 'pitch');
  b.input('vel', md, 'p1');
  b.output('out', fs, 'up');
  b.param('decay', md, 'decay');
  b.param('bright', md, 'bright');
  b.param('shimmer', fs, 'shift');
  b.param('shimmer mix', fs, 'mix');
  b.param('hit', hit, 'gain');
});

// gamelan: two bar-like modal bodies a fifth apart, the second a little sharp (beating), both hit by one noise burst
asm('gamelan', 'Voices', (b) => {
  const nz = b.add('noise', 0, 0, { level: 1 });
  const env = b.add('env', 1, 0, { l1: 1, r1: 0.001, l2: 0, r2: 0.015, l3: 0, r3: 0.01, l4: 0, r4: 0.01 });
  const vca = b.add('vca', 2, 0, { gain: 0.05 });
  const m1 = b.add('modal', 0, 1, { coarse: 0, decay: 2.5, struct: 1, bright: 0.5, damp: 0.3 });
  const det = b.add('scale', 1, 1, { gain: 1, offset: 0.015 });
  const m2 = b.add('modal', 2, 1, { coarse: 7, decay: 2, struct: 1, bright: 0.4, damp: 0.3 });
  const mix = b.add('mixer', 3, 0, { l1: 0.7, l2: 0.5, l3: 0, l4: 0 });
  b.wire(nz, 'out', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.wire(vca, 'out', m1, 'in');
  b.wire(vca, 'out', m2, 'in');
  b.wire(det, 'out', m2, 'pitch');
  b.wire(m1, 'out', mix, 'in1');
  b.wire(m2, 'out', mix, 'in2');
  b.input('gate', env, 'gate');
  b.input('pitch', m1, 'pitch', [det, 'in']);
  b.output('out', mix, 'out');
  b.param('decay', m1, 'decay');
  b.param('detune', det, 'offset');
  b.param('interval', m2, 'coarse');
  b.param('balance', mix, 'l2');
  b.param('hit', vca, 'gain');
});

// a kalimba: a plucked modal tine with a tuned comb for the body
asm('kalimba', 'Voices', (b) => {
  const pl = b.add('pulse', 0, 0, { time: 0.002 });
  const hit = b.add('scale', 0, 1, { gain: 0.015, offset: 0 });
  const md = b.add('modal', 1, 0, { coarse: 0, decay: 0.8, struct: 0.3, bright: 0.5, damp: 0.7 });
  const cb = b.add('comb', 2, 0, { coarse: -12, fb: 0.4, damp: 0.6, mix: 0.4 });
  b.wire(pl, 'out', hit, 'in');
  b.wire(hit, 'out', md, 'in');
  b.wire(md, 'out', cb, 'in');
  b.input('gate', pl, 'trig');
  b.input('pitch', md, 'pitch', [cb, 'pitch']);
  b.output('out', cb, 'out');
  b.param('decay', md, 'decay');
  b.param('body', cb, 'mix');
  b.param('bright', md, 'bright');
  b.param('hit', hit, 'gain');
});

// marimba / vibes: a harmonic modal bar with a resonator tube (a darker modal an octave below) by `tube`, and a tremolo
// `motor` for the vibes
asm('marimba', 'Voices', (b) => {
  const pl = b.add('pulse', 0, 0, { time: 0.002 });
  const hit = b.add('scale', 0, 1, { gain: 0.02, offset: 0 });
  const bar = b.add('modal', 1, 0, { coarse: 0, decay: 0.4, struct: 0, bright: 0.6, damp: 0.4 });
  const tube = b.add('modal', 1, 1, { coarse: -12, decay: 0.7, struct: 0, bright: 0.2, damp: 0.9 });
  const xf = b.add('xfade', 2, 0, { mix: 0.3 });
  const lfo = b.add('lfo', 2, 1, { wave: 0, rate: 5, depth: 1 });
  const sc = b.add('scale', 3, 1, { gain: 0, offset: 1 });
  const vca = b.add('vca', 3, 0);
  b.wire(pl, 'out', hit, 'in');
  b.wire(hit, 'out', bar, 'in');
  b.wire(hit, 'out', tube, 'in');
  b.wire(bar, 'out', xf, 'a');
  b.wire(tube, 'out', xf, 'b');
  b.wire(xf, 'out', vca, 'in');
  b.wire(lfo, 'out', sc, 'in');
  b.wire(sc, 'out', vca, 'cv');
  b.input('gate', pl, 'trig');
  b.input('pitch', bar, 'pitch', [tube, 'pitch']);
  b.output('out', vca, 'out');
  b.param('decay', bar, 'decay');
  b.param('tube', xf, 'mix');
  b.param('motor', sc, 'gain');
  b.param('motor rate', lfo, 'rate');
  b.param('bright', bar, 'bright');
  b.param('hit', hit, 'gain');
});

// bowed glass: noise through a tracking ladder into a modal body, the noise under a slow envelope (the bow pressure), a
// compressor keeps the sustain even
asm('bowed glass', 'Voices', (b) => {
  const nz = b.add('noise', 0, 0, { level: 1 });
  const env = b.add('adsr', 0, 1, { a: 0.4, d: 0.3, s: 0.8, r: 0.6 });
  const vca = b.add('vca', 1, 0, { gain: 0.5 });
  const ld = b.add('ladder', 2, 0, { cutoff: 1500, res: 0.6, drive: 1, track: 1 });
  const md = b.add('modal', 1, 1, { coarse: 0, decay: 1, struct: 0.5, bright: 0.5, damp: 0.3 });
  const dyn = b.add('dyn', 2, 1, { thresh: -24, ratio: 6, attack: 0.01, release: 0.2, gain: 6 });
  b.wire(nz, 'out', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.wire(vca, 'out', ld, 'in');
  b.wire(ld, 'lp24', md, 'in');
  b.wire(md, 'out', dyn, 'in');
  b.input('gate', env, 'gate');
  b.input('pitch', md, 'pitch');
  b.output('out', dyn, 'out');
  b.param('pressure', vca, 'gain');
  b.param('attack', env, 'a');
  b.param('brightness', ld, 'cutoff');
  b.param('decay', md, 'decay');
  b.param('release', env, 'r');
});

// rain: a fast random clock samples noise into a pentatonic pitch and strikes a modal body with a 2 ms burst
asm('rain', 'Textures', (b) => {
  const clk = b.add('lfo', 0, 0, { wave: 3, rate: 9, depth: 1 });
  const nz = b.add('noise', 1, 0, { level: 0.8 });
  const sh = b.add('sh', 2, 0, { mode: 0 });
  const qn = b.add('quant', 3, 0, { scale: 3, root: 0 });
  const pl = b.add('pulse', 0, 1, { time: 0.002 });
  const hit = b.add('scale', 2, 1, { gain: 0.03, offset: 0 });
  const md = b.add('modal', 1, 1, { coarse: 12, decay: 0.6, struct: 0.8, bright: 0.6, damp: 0.3 });
  b.wire(nz, 'out', sh, 'in');
  b.wire(clk, 'out', sh, 'clock');
  b.wire(sh, 'out', qn, 'in');
  b.wire(qn, 'out', md, 'pitch');
  b.wire(clk, 'out', pl, 'trig');
  b.wire(pl, 'out', hit, 'in');
  b.wire(hit, 'out', md, 'in');
  b.input('reset', clk, 'reset');
  b.output('out', md, 'out');
  b.param('density', clk, 'rate');
  b.param('range', nz, 'level');
  b.param('scale', qn, 'scale');
  b.param('decay', md, 'decay');
  b.param('tune', md, 'coarse');
  b.param('hit', hit, 'gain');
});

// a resonator bank (effect): three modal bodies on the root, the fifth and the octave in parallel
asm('resonator bank', 'Textures', (b) => {
  const m1 = b.add('modal', 0, 0, { coarse: 0, decay: 1.5, struct: 0, bright: 0.5, damp: 0.4 });
  const m2 = b.add('modal', 0, 1, { coarse: 7, decay: 1.5, struct: 0, bright: 0.5, damp: 0.4 });
  const m3 = b.add('modal', 0, 2, { coarse: 12, decay: 1.5, struct: 0, bright: 0.5, damp: 0.4 });
  const mix = b.add('mixer', 1, 0, { l1: 0.05, l2: 0.04, l3: 0.03, l4: 0 });
  b.wire(m1, 'out', mix, 'in1');
  b.wire(m2, 'out', mix, 'in2');
  b.wire(m3, 'out', mix, 'in3');
  b.input('in', m1, 'in', [m2, 'in'], [m3, 'in']);
  b.input('pitch', m1, 'pitch', [m2, 'pitch'], [m3, 'pitch']);
  b.output('out', mix, 'out');
  b.param('decay', m1, 'decay');
  b.param('decay 5th', m2, 'decay');
  b.param('decay oct', m3, 'decay');
  b.param('struct', m1, 'struct');
  b.param('bright', m1, 'bright');
  b.param('level', mix, 'l1');
});

// ---- comb, shifter, compressor

// a bowed string: noise through a ladder into a high-feedback comb at the pitch; an ADSR on the noise, a glide on the pitch
asm('bowed string', 'Voices', (b) => {
  const gl = b.add('glide', 0, 0, { time: 0.08 });
  const nz = b.add('noise', 1, 0, { level: 1 });
  const env = b.add('adsr', 2, 0, { a: 0.15, d: 0.3, s: 0.8, r: 0.3 });
  const vca = b.add('vca', 0, 1, { gain: 0.4 });
  const ld = b.add('ladder', 1, 1, { cutoff: 2500, res: 0.3, drive: 1 });
  const cb = b.add('comb', 2, 1, { coarse: 0, fb: 0.95, damp: 0.3, mix: 1 });
  b.wire(gl, 'out', cb, 'pitch');
  b.wire(nz, 'out', vca, 'in');
  b.wire(env, 'env', vca, 'cv');
  b.wire(vca, 'out', ld, 'in');
  b.wire(ld, 'lp24', cb, 'in');
  b.input('pitch', gl, 'in');
  b.input('gate', env, 'gate');
  b.output('out', cb, 'out');
  b.param('pressure', vca, 'gain');
  b.param('brightness', ld, 'cutoff');
  b.param('damp', cb, 'damp');
  b.param('glide', gl, 'time');
  b.param('attack', env, 'a');
});

// barber pole: a slow frequency shift up and down, crossfaded by a slow LFO: an endless rise (or fall)
asm('barber pole', 'Effects', (b) => {
  const fs = b.add('shift', 0, 0, { shift: 0.3, cvamt: 100, mix: 1 });
  const lfo = b.add('lfo', 0, 1, { wave: 1, rate: 0.08, depth: 1 });
  const sc = b.add('scale', 1, 1, { gain: 0.5, offset: 0.5 });
  const xf = b.add('xfade', 1, 0, { mix: 0.5 });
  b.wire(fs, 'up', xf, 'a');
  b.wire(fs, 'down', xf, 'b');
  b.wire(lfo, 'out', sc, 'in');
  b.wire(sc, 'out', xf, 'pos');
  b.input('in', fs, 'in');
  b.output('out', xf, 'out');
  b.param('speed', fs, 'shift');
  b.param('sweep', lfo, 'rate');
  b.param('depth', sc, 'gain');
});

// sidechain pump: a compressor ducked by an internal clock's pulse
asm('sidechain pump', 'Effects', (b) => {
  const clk = b.add('lfo', 0, 0, { wave: 3, rate: 2, depth: 1 });
  const pl = b.add('pulse', 1, 0, { time: 0.03 });
  const dyn = b.add('dyn', 2, 0, { thresh: -30, ratio: 12, attack: 0.002, release: 0.18, gain: 0 });
  b.wire(clk, 'out', pl, 'trig');
  b.wire(pl, 'out', dyn, 'side');
  b.input('in', dyn, 'in');
  b.input('reset', clk, 'reset');
  b.output('out', dyn, 'out');
  b.output('env', dyn, 'env');
  b.param('amount', dyn, 'thresh');
  b.param('release', dyn, 'release');
  b.param('rate', clk, 'rate');
});

// a talking filter: the input's envelope opens the vowel (the louder, the more open)
asm('talking filter', 'Effects', (b) => {
  const dyn = b.add('dyn', 0, 0, { thresh: 0, ratio: 1, attack: 0.005, release: 0.08, gain: 0 });
  const sc = b.add('scale', 1, 0, { gain: 4, offset: 0 });
  const vow = b.add('vowel', 2, 0, { vowel: 0, res: 0.6, level: 0.8 });
  b.wire(dyn, 'env', sc, 'in');
  b.wire(sc, 'out', vow, 'vowel');
  b.input('in', dyn, 'in', [vow, 'in']);
  b.output('out', vow, 'out');
  b.param('depth', sc, 'gain');
  b.param('res', vow, 'res');
  b.param('release', dyn, 'release');
  b.param('start', vow, 'vowel');
});

// an auto pan
asm('auto pan', 'Effects', (b) => {
  const lfo = b.add('lfo', 0, 0, { wave: 1, rate: 0.5, depth: 1 });
  const pan = b.add('pan', 1, 0, { pan: 0 });
  b.wire(lfo, 'out', pan, 'pos');
  b.input('in', pan, 'in');
  b.output('l', pan, 'l');
  b.output('r', pan, 'r');
  b.param('rate', lfo, 'rate');
  b.param('width', lfo, 'depth');
  b.param('centre', pan, 'pan');
});

// an exposed pin is offered as the sliders it routes to (the editor has no p1 / p2 jacks): the same migration as on load
for (const d of defs) d.inputs = pinsToParams(d.inputs, d.params, (id) => d.modules.find((m) => m.id === id));
for (const d of defs) writeFileSync(new URL(`${d.name.replace(/[^a-z0-9]+/g, '-')}.json`, OUT), JSON.stringify(d, null, 2) + '\n');
console.log(`wrote ${defs.length} assemblies: ${defs.map((d) => d.name).join(', ')}`);
