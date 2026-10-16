// SPDX-License-Identifier: GPL-3.0-only
// The CPU cost table (src/cpu-costs.json) for the editor's estimate (src/cpu.ts). Counts the fixed-point engine on an rv32im
// model (tools/cpu: build.sh builds it, rv32.mjs runs it) module by module:
//   - every module type alone, every setting changed one at a time (alone and with every input patched), to find what changes
//     its cost (dims); the settings that do are measured in all combinations (grid), numbers at the points where their cost
//     bends (the editor interpolates);
//   - the shared costs: summing inputs, parameter inputs, morph, bypass, the render loop per module and per block;
//   - the scale: the M1-0.2 engine running its 303 Acid, which took 12 % (peak) of the audio interrupt on the FM-1, checked
//     against the fixed-point kernels of firmware/src/bench.c, also measured there;
//   - whole factory patches, as checks of the model (cpu.test.ts).
// Kits hold C5 (a square or saw oscillator costs more the higher it plays). Run from web/: npm run cpu-costs
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
// @ts-ignore: plain JavaScript modules
import { pool } from '../../tools/cpu/pool.mjs';
import { cpuEstimate, type CostDim, type CpuTable, type TypeCost } from '../src/cpu';
import { DEFS } from '../src/modules';
import { encodePatch } from '../src/patchbin';
import { addModule, connect, fromUnit, newPatch, type ModuleInst, type ParamDef, type Patch } from '../src/patch';
import { cpuChecks } from '../src/cpu-checks';

const ROOT = new URL('../../', import.meta.url).pathname;
execSync('tools/cpu/build.sh', { cwd: ROOT, stdio: 'inherit' });
const ELF = { prof: 'prof', plain: 'plain', old: 'old', bench: 'bench' } as const;
const POOL = pool(Object.fromEntries(Object.keys(ELF).map((k) => [k, `${ROOT}build/cpu/${k}.elf`])));
const NOTE = 72; // C5

const BLOCK_US = 2902;
const OLD_PEAK = 0.12; // 303 Acid on M1-0.2: 11 % typical, 12 % peak of the half buffer (ISR time incl. key scan and USB)
const BLOCKS = 24;
const SKIP = 3; // blocks before the maximum is taken (the first notes, envelopes starting)

const ON = (n: number): number => (1 << 16) | n;
const RENDER = 3 << 16;
const events = (notes: number[]): number[] => [...notes.map(ON), ...Array(BLOCKS).fill(RENDER)];

type Stage = { sum: number; cv: number; run: number };
type Run = { totals: number[]; nodes: Map<string, Stage>[] };

type Blocks = { blocks: { total: number; nodes: Map<string, Stage> }[]; exit: number };
const emulate = (elf: string, patch: Uint8Array, ev: number[]): Promise<Blocks> => POOL.run(elf, patch, ev);
const run = async (elf: string, p: Patch, notes = [NOTE]): Promise<Run> => {
  const r = await emulate(elf, encodePatch(p, true), events(notes));
  if (r.exit) throw new Error(`${p.name}: the engine refused the patch (${r.exit})`);
  return { totals: r.blocks.map((b) => b.total), nodes: r.blocks.map((b) => b.nodes) };
};
const peak = (xs: number[]): number => Math.max(...xs.slice(SKIP));

/** the cost of one hook (the cycles a stage counts when it does nothing) */
let HOOK = 0;
/** module `index`'s stages, part 0, each its maximum over the blocks, less the hook */
const stages = (r: Run, index: number, part = 0): Stage => {
  const pick = (k: keyof Stage): number => peak(r.nodes.map((n) => n.get(`${index}/${part}`)?.[k] ?? 0)) - HOOK;
  return { sum: Math.max(0, pick('sum')), cv: Math.max(0, pick('cv')), run: Math.max(0, pick('run')) };
};

// ------------------------------------------------------------------ a module alone

interface KitCfg {
  params?: Record<string, number>;
  inputs?: string[];
  outputs?: string[];
  /** what feeds the inputs: an oscillator (edges every few samples) or the Main gate (high for whole blocks) */
  feed?: 'osc' | 'gate';
}

/** Main + the module + Output, its first output into the Output, a pitch input always fed by the Main pitch (the played note
 * sets the cost of a square or saw), `inputs` fed (gate inputs by the Main gate, the rest by `feed`), `outputs` also patched */
function kit(type: string, cfg: KitCfg = {}): { p: Patch; m: ModuleInst } {
  const p = newPatch(DEFS, `cpu ${type}`);
  const main = p.modules[0], out = p.modules[1];
  const m = type === 'fm1' ? main : type === 'output' ? out : addModule(p, DEFS[type], 300, 0);
  Object.assign(m.params, cfg.params ?? {});
  const def = DEFS[type];
  let src: ModuleInst | undefined;
  if (m !== main && def.inputs.some((i) => i.name === 'pitch')) connect(p, DEFS, { module: main.id, port: 'pitch' }, { module: m.id, port: 'pitch' });
  for (const name of cfg.inputs ?? []) {
    if (name === 'pitch') continue;
    if ((name === 'gate' || cfg.feed === 'gate') && m !== main) connect(p, DEFS, { module: main.id, port: 'gate' }, { module: m.id, port: name });
    else {
      src ??= addModule(p, DEFS.osc, 0, 300);
      connect(p, DEFS, { module: src.id, port: 'out' }, { module: m.id, port: name });
    }
  }
  if (m !== out && def.outputs.length) connect(p, DEFS, { module: m.id, port: def.outputs[0].name }, { module: out.id, port: 'l' });
  for (const name of cfg.outputs ?? []) connect(p, DEFS, { module: m.id, port: name }, { module: out.id, port: 'r' });
  return { p, m };
}

const cache = new Map<string, Promise<Stage>>();
const measureFed = (type: string, cfg: KitCfg): Promise<Stage> => {
  const key = `${type} ${JSON.stringify(cfg)}`;
  let r = cache.get(key);
  if (!r) {
    const { p, m } = kit(type, cfg);
    r = run(ELF.prof, p).then((x) => stages(x, p.modules.indexOf(m)));
    cache.set(key, r);
  }
  return r;
};
/** the module's stages in a kit (each configuration counted once): with inputs patched, the worse of the two feeds (a clock
 * divider works hardest while its clock is high, an oscillator's sync on many edges) */
const measure = async (type: string, cfg: KitCfg = {}): Promise<Stage> => {
  if (!cfg.inputs?.length) return measureFed(type, cfg);
  const [a, b] = await Promise.all([measureFed(type, { ...cfg, feed: 'osc' }), measureFed(type, { ...cfg, feed: 'gate' })]);
  return { sum: Math.max(a.sum, b.sum), cv: Math.max(a.cv, b.cv), run: Math.max(a.run, b.run) };
};
const runs = (type: string, cfgs: KitCfg[]): Promise<number[]> => Promise.all(cfgs.map((c) => measure(type, c).then((x) => x.run)));

/** a parameter's values to try: every value of a choice / switch / small integer, else points across its range (just above
 * the minimum too: some modules change mode when a value leaves 0) */
function tries(pd: ParamDef): { values: number[]; discrete: boolean } {
  if (pd.choices) return { values: pd.choices.map((_, i) => i), discrete: true };
  if (pd.toggle) return { values: [0, 1], discrete: true };
  if (pd.step && pd.step >= 1 && pd.max - pd.min <= 8) {
    const values: number[] = [];
    for (let v = pd.min; v <= pd.max; v += pd.step) values.push(v);
    return { values, discrete: true };
  }
  const eps = Math.max(pd.step ?? 0, (pd.max - pd.min) * 0.01);
  const values = [pd.min, pd.log ? pd.min * 1.01 : pd.min + eps, ...[0.25, 0.5, 0.75, 1].map((u) => fromUnit(pd, u))];
  return { values: [...new Set(values.map((v) => +v.toPrecision(6)))], discrete: false };
}

/** the points of a cost curve that linear interpolation needs (every curve in `costs` within `thr`); the first two stay
 * when the cost steps there */
function bends(values: number[], costs: number[][], thr: number, step: boolean): number[] {
  const keep = values.map((_, i) => i);
  for (let changed = true; changed; ) {
    changed = false;
    for (let k = step ? 2 : 1; k < keep.length - 1; k++) {
      const [a, i, b] = [keep[k - 1], keep[k], keep[k + 1]];
      const w = (values[i] - values[a]) / (values[b] - values[a]);
      if (costs.every((c) => Math.abs(c[a] + w * (c[b] - c[a]) - c[i]) <= thr)) {
        keep.splice(k, 1);
        changed = true;
        break;
      }
    }
  }
  return keep.map((i) => values[i]);
}

const GRID_MAX = 16384;
type Dim = { dim: CostDim; values: number[]; effect: number; set: (cfg: KitCfg, v: number) => void };

async function typeCost(type: string): Promise<TypeCost> {
  const def = DEFS[type];
  const base = await measure(type);
  const thr = Math.max(0.03 * base.run, 100);
  const pins = new Set(def.inputs.filter((i) => i.pin).map((i) => i.name));
  const allInputs = def.inputs.filter((i) => !pins.has(i.name) && i.name !== 'pitch').map((i) => i.name);
  const dims: Dim[] = [];
  const setParam = (name: string) => (cfg: KitCfg, v: number): void => void (cfg.params = { ...cfg.params, [name]: v });
  // 1. choices, switches, small integers: alone and with every input patched
  const numbers: ParamDef[] = [];
  await Promise.all(
    def.params.map(async (pd) => {
      const t = tries(pd);
      if (!t.discrete) return void numbers.push(pd);
      const effect = await effectOf(type, (v) => ({ [pd.name]: v }), t.values, [{}, { inputs: allInputs }]);
      if (effect > thr) dims.push({ dim: { param: pd.name, values: t.values }, values: t.values, effect, set: setParam(pd.name) });
    }),
  );
  // 2. numbers, in the same two contexts and with each value of the choices found (a saw's cost does not depend on its pitch,
  // a square's does): a step just above the minimum and flat after it is a mode (on / off), else a curve through its bends
  const contexts: KitCfg[] = [{}, { inputs: allInputs }, ...dims.flatMap((d) => d.values.map((v) => ({ params: { [(d.dim as { param: string }).param]: v } })))];
  const modes: { name: string; min: number; ref: number }[] = [];
  await Promise.all(
    numbers.map(async (pd) => {
      const t = tries(pd);
      const curves = await Promise.all(contexts.map((c) => runs(type, t.values.map((v) => ({ ...c, params: { ...c.params, [pd.name]: v } })))));
      const effect = Math.max(...curves.map((c) => Math.max(...c) - Math.min(...c)));
      if (effect <= thr) return;
      const step = curves.some((c) => Math.abs(c[1] - c[0]) > thr);
      const flat = curves.every((c) => c.slice(1).every((x) => Math.abs(x - c[1]) <= thr));
      if (step && flat) {
        const ref = pd.default > pd.min ? pd.default : t.values[1];
        modes.push({ name: pd.name, min: pd.min, ref });
        dims.push({ dim: { param: pd.name, above: pd.min }, values: [0, 1], effect, set: (cfg, on) => setParam(pd.name)(cfg, on ? ref : pd.min) });
      } else {
        const points = bends(t.values, curves, thr, step);
        dims.push({ dim: { param: pd.name, points }, values: points, effect, set: setParam(pd.name) });
      }
    }),
  );
  // 3. inputs, alone and with each mode on (an oscillator's pm input does nothing until its pm index is above 0; its feedback
  // would hide that, it turns on the same FM mode)
  const off = Object.fromEntries(modes.map((q) => [q.name, q.min]));
  const modeContexts: KitCfg[] = [{}, ...modes.map((q) => ({ params: { ...off, [q.name]: q.ref } }))];
  const flag = (cfg: KitCfg, key: 'inputs' | 'outputs', name: string, on: number): void => void (on && (cfg[key] = [...(cfg[key] ?? []), name]));
  await Promise.all(
    allInputs.map(async (name) => {
      const effects = await Promise.all(modeContexts.map(async (c) => Math.abs((await measure(type, { ...c, inputs: [name] })).run - (await measure(type, c)).run)));
      const effect = Math.max(...effects);
      if (effect > thr) dims.push({ dim: { input: name }, values: [0, 1], effect, set: (cfg, on) => flag(cfg, 'inputs', name, on) });
    }),
  );
  await Promise.all(
    def.outputs.slice(1).map(async (output) => {
      const effect = Math.abs((await measure(type, { outputs: [output.name] })).run - base.run);
      if (effect > thr) dims.push({ dim: { output: output.name }, values: [0, 1], effect, set: (cfg, on) => flag(cfg, 'outputs', output.name, on) });
    }),
  );
  // 4. every combination of the dims; the smallest effects become additive when there are too many
  dims.sort((a, b) => b.effect - a.effect);
  const extra: Dim[] = [];
  while (dims.reduce((n, d) => n * d.values.length, 1) > GRID_MAX) extra.unshift(dims.pop()!);
  const out: TypeCost = { run: Math.round(base.run), cv: Math.round(base.cv) };
  if (dims.length) {
    out.dims = dims.map((d) => d.dim);
    const cells: KitCfg[] = [];
    const walk = (i: number, cfg: KitCfg): void => {
      if (i === dims.length) return void cells.push(cfg);
      for (const v of dims[i].values) {
        const next = structuredClone(cfg);
        dims[i].set(next, v);
        walk(i + 1, next);
      }
    };
    walk(0, {});
    out.grid = (await runs(type, cells)).map(Math.round);
  }
  if (extra.length)
    out.extra = await Promise.all(
      extra.map(async (d) => ({
        dim: d.dim,
        add: (await runs(type, d.values.map((v) => { const cfg: KitCfg = {}; d.set(cfg, v); return cfg; }))).map((c) => Math.round(c - base.run)),
      })),
    );
  return out;
}

/** the largest change of the run cost over `values` of a setting, in any of the contexts */
async function effectOf(type: string, params: (v: number) => Record<string, number>, values: number[], contexts: KitCfg[]): Promise<number> {
  const curves = await Promise.all(contexts.map((c) => runs(type, values.map((v) => ({ ...c, params: { ...c.params, ...params(v) } })))));
  return Math.max(...curves.map((c) => Math.max(...c) - Math.min(...c)));
}

// ------------------------------------------------------------------ the shared costs

async function hookCost(): Promise<number> {
  const { p } = kit('const');
  const r = await run(ELF.prof, p);
  return Math.min(...p.modules.map((_, i) => peak(r.nodes.map((n) => n.get(`${i}/0`)?.sum ?? 0))));
}

/** summing: a Scale's input fed by 2 and by 5 Constants */
async function sumCost(): Promise<CpuTable['sum']> {
  const at = async (k: number): Promise<number> => {
    const { p, m } = kit('scale');
    for (let i = 0; i < k; i++) {
      const c = addModule(p, DEFS.const, 0, 100 * i);
      connect(p, DEFS, { module: c.id, port: 'out' }, { module: m.id, port: 'in' });
    }
    return stages(await run(ELF.prof, p), p.modules.indexOf(m)).sum;
  };
  const [a, b] = await Promise.all([at(2), at(5)]);
  const source = (b - a) / 3;
  return { port: Math.round(a - 2 * source), source: Math.round(source) };
}

/** parameter inputs, on a filter: p1 patched moving nothing, the resonance (linear), the cutoff (log); morph per parameter */
async function cvCost(): Promise<CpuTable['cv']> {
  const at = async (map: string[] | null, morph = false): Promise<number> => {
    const { p, m } = kit('filter');
    if (map) {
      const c = addModule(p, DEFS.lfo, 0, 200);
      connect(p, DEFS, { module: c.id, port: 'out' }, { module: m.id, port: 'p1' });
      m.map!.p1 = map;
      m.map!.p2 = [];
    }
    if (morph) m.paramsB = { ...m.params };
    return stages(await run(ELF.prof, p), p.modules.indexOf(m)).cv;
  };
  const [none, pin, lin, log, morph] = await Promise.all([at(null), at([]), at(['res']), at(['cutoff']), at(null, true)]);
  return {
    pin: Math.round(pin - none),
    lin: Math.round(lin - pin),
    log: Math.round(log - pin),
    morph: Math.round((morph - none) / DEFS.filter.params.length),
  };
}

/** a bypassed filter with one output patched */
async function bypassCost(): Promise<number> {
  const { p, m } = kit('filter', { inputs: ['in'] });
  m.bypass = true;
  return Math.round(stages(await run(ELF.prof, p), p.modules.indexOf(m)).run);
}

/** the plain engine's whole block against the hooked stages: the render loop per module, the Output's mix, the rest */
async function loopCosts(types: Record<string, TypeCost>): Promise<{ block: number; node: number; output: number }> {
  const own = (t: string): number => types[t].run + types[t].cv;
  const total = async (p: Patch): Promise<number> => peak((await run(ELF.plain, p)).totals);
  const base = newPatch(DEFS, 'cpu loop');
  const many = structuredClone(base);
  for (let i = 0; i < 10; i++) addModule(many, DEFS.const, 0, 100 * i);
  const two = structuredClone(base);
  addModule(two, DEFS.output, 0, 300);
  const [t0, t10, t2] = await Promise.all([total(base), total(many), total(two)]);
  const node = (t10 - t0 - 10 * own('const')) / 10;
  const output = t2 - t0 - node - own('output');
  const block = t0 - 2 * node - output - own('fm1') - own('output');
  return { block: Math.round(block), node: Math.round(node), output: Math.round(output) };
}

// ------------------------------------------------------------------ the scale

async function calibration(): Promise<CpuTable['calibration'] & { cyclesPerUs: number }> {
  const [old, bench] = await Promise.all([emulate(ELF.old, new Uint8Array(0), events([60])), emulate(ELF.bench, new Uint8Array(0), [])]);
  const oldPeak = peak(old.blocks.map((b) => b.total));
  const kernel = bench.blocks.map((b) => b.total / 16);
  return {
    cyclesPerUs: Math.round(oldPeak / (OLD_PEAK * BLOCK_US)),
    method: '303 Acid of M1-0.2 (b907693), one note held, peak cycles per block = 12 % of 2902 us (the ISR peak measured on the FM-1)',
    acidM102Cycles: oldPeak,
    benchMac4CyclesPerUs: Math.round(kernel[0] / 9),
    benchSvfCyclesPerUs: Math.round(kernel[1] / 8),
    benchNote: 'firmware/src/bench.c kernels (4x Q15 MAC 9 us, Q15 SVF 8 us per block, rounded down) give the same scale within a few %',
    note: `module kits hold note ${NOTE}; a square or saw oscillator costs more the higher it plays`,
  };
}

// ------------------------------------------------------------------ the table

HOOK = await hookCost();
const names = Object.keys(DEFS);
const costs = await Promise.all(names.map(typeCost));
const types: Record<string, TypeCost> = Object.fromEntries(names.map((n, i) => [n, costs[i]]));
for (const type of names) {
  const t = types[type];
  const show = (d: CostDim): string => ('values' in d ? `${d.param}[${d.values.length}]` : 'above' in d ? `${d.param}>${d.above}` : 'points' in d ? `${d.param}~${d.points.length}` : 'input' in d ? `in:${d.input}` : `out:${d.output}`);
  console.log(`${type.padEnd(10)} run ${String(t.run).padStart(7)}  cv ${String(t.cv).padStart(5)}${t.dims ? `  ${t.dims.map(show).join(' ')} (${t.grid!.length})` : ''}${t.extra ? `  + ${t.extra.map((e) => show(e.dim)).join(' ')}` : ''}`);
}
const [{ cyclesPerUs, ...cal }, loop, sum, cv, bypass] = await Promise.all([calibration(), loopCosts(types), sumCost(), cvCost(), bypassCost()]);
const table: CpuTable = {
  source: 'estimate: the fixed-point engine counted on an rv32im model (tools/cpu), scaled by one measurement on the FM-1',
  cyclesPerUs,
  blockUs: BLOCK_US,
  note: NOTE,
  ...loop,
  sum,
  cv,
  bypass,
  types,
  checks: [],
  calibration: cal,
};

// whole patches: the plain engine's peak against the model
const checks = cpuChecks(NOTE).map(({ name, patch, notes }): [string, Patch, number[]] => [name, patch, notes]);
const totals = await Promise.all(checks.map(([, p, notes]) => run(ELF.plain, p, notes).then((r) => peak(r.totals))));
let worst = 0;
checks.forEach(([name, p], i) => {
  const cycles = totals[i];
  table.checks.push({ name, cycles });
  const est = cpuEstimate(p, table).cycles;
  const err = est / cycles - 1;
  worst = Math.max(worst, Math.abs(err));
  console.log(`${name.padEnd(28)} ${String(cycles).padStart(8)}  model ${String(Math.round(est)).padStart(8)}  ${(100 * err).toFixed(1).padStart(6)} %  load ${((100 * cycles) / cyclesPerUs / BLOCK_US).toFixed(0)} %`);
});
console.log(`scale ${cyclesPerUs} cycles/us (bench ${cal.benchMac4CyclesPerUs}, ${cal.benchSvfCyclesPerUs}); worst model error ${(100 * worst).toFixed(1)} %`);
writeFileSync(new URL('../src/cpu-costs.json', import.meta.url), JSON.stringify(table, null, 1) + '\n');
await POOL.close();
