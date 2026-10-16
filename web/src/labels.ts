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
