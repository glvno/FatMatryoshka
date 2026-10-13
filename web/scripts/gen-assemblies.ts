// SPDX-License-Identifier: GPL-3.0-only
// Writes the factory assemblies (src/assemblies/*.json) that are defined here as small patches: module grid positions,
// cables, the exposed ports (an input with `also` fans out to several inner inputs) and the promoted parameters.
// `voice` and `echo` are kept as files. Run from web/:  npx vite-node scripts/gen-assemblies.ts
import { writeFileSync } from 'node:fs';
import { DEFS } from '../src/modules';
import { defaultMap, defaultParams, type ModuleInst, type Source } from '../src/patch';
import type { AssemblyDef, PortRef, ParamRef } from '../src/assembly';

const OUT = new URL('../src/assemblies/', import.meta.url);
const GX = 270;
const GY = 560;

interface B {
  /** add a module at grid column / row; returns its local id */
  add(type: string, col: number, row: number, params?: Record<string, number>, o?: { p1?: string; p2?: string; att?: [number, number] }): number;
  wire(a: number, ap: string, b: number, bp: string): void;
  input(label: string, module: number, port: string, ...also: [number, string][]): void;
  output(label: string, module: number, port: string): void;
  param(label: string, module: number, param: string): void;
}

function build(name: string, f: (b: B) => void): AssemblyDef {
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
  return { format: 'modular-1-assembly', version: 1, name, modules, cables, inputs, outputs, params };
}

const defs: AssemblyDef[] = [];
const asm = (name: string, f: (b: B) => void): void => {
  defs.push(build(name, f));
};

// an FM operator: oscillator, DX-style level / rate envelope, VCA
asm('operator', (b) => {
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
asm('fm pair', (b) => {
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

// a kick: a sine with a fast pitch drop, a decaying amplitude envelope and a little drive
asm('kick', (b) => {
  const osc = b.add('osc', 0, 0, { wave: 0, coarse: -26, level: 1 });
  const penv = b.add('env', 1, 0, { l1: 1, r1: 0.001, l2: 0, r2: 0.07, l3: 0, r3: 0.1, l4: 0, r4: 0.05 });
  const sc = b.add('scale', 2, 0, { gain: 2.5, offset: 0 });
  const aenv = b.add('env', 0, 1, { l1: 1, r1: 0.001, l2: 0.5, r2: 0.12, l3: 0, r3: 0.35, l4: 0, r4: 0.05 });
  const vca = b.add('vca', 1, 1);
  const drive = b.add('shape', 2, 1, { drive: 1.6, mode: 0, level: 0.9 });
  b.wire(penv, 'env', sc, 'in');
  b.wire(sc, 'out', osc, 'pitch');
  b.wire(osc, 'out', vca, 'in');
  b.wire(aenv, 'env', vca, 'cv');
  b.wire(vca, 'out', drive, 'in');
  b.input('gate', aenv, 'gate', [penv, 'gate']);
  b.output('out', drive, 'out');
  b.param('tune', osc, 'coarse');
  b.param('drop', sc, 'gain');
  b.param('drop time', penv, 'r2');
  b.param('decay', aenv, 'r3');
  b.param('punch', aenv, 'r2');
  b.param('drive', drive, 'drive');
});

// a snare: a noise burst through a high pass and a short sine body, mixed
asm('snare', (b) => {
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
asm('hihat', (b) => {
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
asm('pluck', (b) => {
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
asm('wavetable pad', (b) => {
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
asm('sub bass', (b) => {
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
asm('vowel voice', (b) => {
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

// a step sequencer with its own clock: pitch (quantized) and gate out; add its pitch to Main's into an oscillator
asm('step sequencer', (b) => {
  const clk = b.add('lfo', 0, 0, { wave: 3, rate: 8, depth: 1 });
  const sq = b.add('seq', 1, 0, { s1: 0, s2: 0.25, s3: 0.58, s4: 0.33, s5: 0, s6: 0.75, s7: 0.58, s8: 1, len: 8, dir: 0 });
  const qn = b.add('quant', 2, 0, { scale: 1, root: 0 });
  b.wire(clk, 'out', sq, 'clock');
  b.wire(sq, 'out', qn, 'in');
  b.input('reset', sq, 'reset', [clk, 'sync']);
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
asm('random melody', (b) => {
  const clk = b.add('lfo', 0, 0, { wave: 3, rate: 6, depth: 1 });
  const nz = b.add('noise', 1, 0, { level: 0.6 });
  const sh = b.add('sh', 2, 0, { mode: 0 });
  const qn = b.add('quant', 3, 0, { scale: 4, root: 0 });
  const pl = b.add('pulse', 1, 1, { time: 0.08 });
  b.wire(nz, 'out', sh, 'in');
  b.wire(clk, 'out', sh, 'clock');
  b.wire(sh, 'out', qn, 'in');
  b.wire(clk, 'out', pl, 'trig');
  b.input('reset', clk, 'sync');
  b.output('pitch', qn, 'out');
  b.output('gate', pl, 'out');
  b.param('tempo', clk, 'rate');
  b.param('range', nz, 'level');
  b.param('scale', qn, 'scale');
  b.param('root', qn, 'root');
  b.param('gate length', pl, 'time');
});

// a clock with divisions
asm('clock', (b) => {
  const clk = b.add('lfo', 0, 0, { wave: 3, rate: 4, depth: 1 });
  const dv = b.add('clkdiv', 1, 0, { div: 3 });
  b.wire(clk, 'out', dv, 'clock');
  b.input('reset', clk, 'sync', [dv, 'reset']);
  b.output('clock', clk, 'out');
  b.output('/2', dv, 'd2');
  b.output('/4', dv, 'd4');
  b.output('/8', dv, 'd8');
  b.output('/div', dv, 'out');
  b.param('rate', clk, 'rate');
  b.param('div', dv, 'div');
});

// an auto pan
asm('auto pan', (b) => {
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

for (const d of defs) writeFileSync(new URL(`${d.name.replace(/[^a-z0-9]+/g, '-')}.json`, OUT), JSON.stringify(d, null, 2) + '\n');
console.log(`wrote ${defs.length} assemblies: ${defs.map((d) => d.name).join(', ')}`);
