// SPDX-License-Identifier: GPL-3.0-only
// What the editor shows for a module, port, parameter or choice: the short names spelled out. Identifiers (patch files,
// engine, firmware, the binary format, the tutorial's checks) keep the short names; only the labels change. The module
// titles ADSR, LFO and VCA stay: the long forms do not fit a card's header.

const GENERIC: Record<string, string> = {
  cv: 'control voltage', cvamt: 'control amount', pw: 'pulse width', fb: 'feedback', res: 'resonance',
  pm: 'phase modulation', vel: 'velocity', mod: 'modulation', at: 'aftertouch', tol: 'tolerance', clk: 'clock',
  lp24: 'low pass 24', lp12: 'low pass 12', bp: 'band pass', hp: 'high pass', ap: 'all pass',
  pos: 'position', exc: 'excitation', trig: 'trigger', len: 'length', dir: 'direction', div: 'division',
  thresh: 'threshold', os: 'oversampling', sym: 'symmetry', struct: 'structure', bright: 'brightness', damp: 'damping',
  pre: 'pre-delay', env: 'envelope', fine: 'fine tune', coarse: 'coarse tune', bpm: 'tempo', pingpong: 'ping-pong',
  l: 'left', r: 'right', k1: 'K1', k2: 'K2', k3: 'K3', k4: 'K4',
  in1: 'in 1', in2: 'in 2', in3: 'in 3', in4: 'in 4', d2: '÷ 2', d4: '÷ 4', d8: '÷ 8',
};

const BY_TYPE: Record<string, Record<string, string>> = {
  adsr: { a: 'attack', d: 'decay', s: 'sustain', r: 'release' },
  mixer: { l1: 'level 1', l2: 'level 2', l3: 'level 3', l4: 'level 4' },
  env: { l1: 'level 1', r1: 'rate 1', l2: 'level 2', r2: 'rate 2', l3: 'level 3', r3: 'rate 3', l4: 'level 4', r4: 'rate 4' },
  seq: { s1: 'step 1', s2: 'step 2', s3: 'step 3', s4: 'step 4', s5: 'step 5', s6: 'step 6', s7: 'step 7', s8: 'step 8' },
  math: { ka: 'a gain', kb: 'b gain', off: 'offset', sub: 'subtract', mul: 'multiply', abs: 'absolute', cmp: 'compare' },
};

const MODULES: Record<string, string> = {
  sh: 'Sample & hold', clkdiv: 'Clock divider', shift: 'Frequency shifter', env: 'Level/rate envelope',
};

const CHOICES: Record<string, Record<string, string>> = {
  'osc.stack': { '+oct': '+octave', '+5th': '+fifth', '+oct+5th': '+octave +fifth', '-oct': '−octave' },
  'lfo.wave': { 'S&H': 'sample & hold' },
  'lfo.div': { '1/16T': '1/16 triplet', '1/8T': '1/8 triplet', '1/16.': '1/16 dotted', '1/8.': '1/8 dotted' },
  'glide.curve': { exp: 'exponential', lin: 'linear' },
  'seq.dir': { fwd: 'forward', back: 'backward' },
  'quant.scale': { 'pent maj': 'pentatonic major', 'pent min': 'pentatonic minor', whole: 'whole tone' },
};

/** a port's or parameter's label on a module of `type` */
export const longName = (type: string, name: string): string => BY_TYPE[type]?.[name] ?? GENERIC[name] ?? name;

/** a module's title */
export const moduleName = (type: string, label: string): string => MODULES[type] ?? label;

/** a choice's label (an enum parameter's value) */
export const choiceName = (type: string, param: string, choice: string): string => CHOICES[`${type}.${param}`]?.[choice] ?? choice;

/** the families a card's tag is coloured by (CSS `--tag-<family>`): sound sources, shapers in the signal path, modulation, effects, utilities */
export type TagFamily = 'src' | 'shp' | 'mod' | 'fx' | 'util';

const TAGS: Record<string, [string, TagFamily]> = {
  osc: ['VCO', 'src'], noise: ['NOISE', 'src'], wavetable: ['WAVE', 'src'], string: ['STRING', 'src'], grain: ['GRAIN', 'src'],
  filter: ['VCF', 'shp'], ladder: ['VCF', 'shp'], vca: ['VCA', 'shp'], shape: ['SHAPE', 'shp'], crush: ['CRUSH', 'shp'],
  vowel: ['VOWEL', 'shp'], dyn: ['DYN', 'shp'], pan: ['PAN', 'shp'], xfade: ['XFADE', 'shp'],
  adsr: ['ENV', 'mod'], env: ['ENV', 'mod'], lfo: ['LFO', 'mod'], random: ['RAND', 'mod'], seq: ['SEQ', 'mod'], glide: ['GLIDE', 'mod'],
  sh: ['S&H', 'mod'], quant: ['QUANT', 'mod'], clkdiv: ['CLOCK', 'mod'], pulse: ['PULSE', 'mod'],
  delay: ['DELAY', 'fx'], reverb: ['VERB', 'fx'], chorus: ['CHORUS', 'fx'], phaser: ['PHASER', 'fx'], shift: ['SHIFT', 'fx'],
  comb: ['COMB', 'fx'], modal: ['MODAL', 'fx'],
  mixer: ['MIX', 'util'], math: ['MATH', 'util'], logic: ['LOGIC', 'util'], const: ['DC', 'util'], scale: ['SCALE', 'util'],
  output: ['OUT', 'util'], fm1: ['MAIN', 'util'], part: ['PART', 'util'], alloc: ['VOICES', 'util'],
};

/** the short tag before a card's title and the family that colours it */
export const moduleTag = (type: string): { tag: string; family: TagFamily } => {
  const [tag, family] = TAGS[type] ?? [type.slice(0, 5).toUpperCase(), 'util'];
  return { tag, family };
};

/** three significant figures, trailing zeros dropped */
const sig = (v: number): string => String(Number(v.toPrecision(3)));

/**
 * A parameter value for a card: the number and its unit apart (the unit is drawn smaller). Three significant figures;
 * kHz from 1000 Hz, ms below one second; a + on positive values of a parameter that can go negative.
 */
export function formatValue(v: number, unit: string | undefined, signed: boolean): { num: string; unit: string } {
  if (!Number.isFinite(v)) return { num: String(v), unit: unit ?? '' };
  let u = unit ?? '';
  let x = v;
  if (u === 'Hz' && Math.abs(x) >= 1000) { x /= 1000; u = 'kHz'; }
  else if (u === 's' && Math.abs(x) < 1 && x !== 0) { x *= 1000; u = 'ms'; }
  const num = Math.abs(x) < 1e-9 ? '0' : sig(x);
  return { num: signed && x > 0 ? `+${num}` : num, unit: u };
}
