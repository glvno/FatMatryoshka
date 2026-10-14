// SPDX-License-Identifier: GPL-3.0-only
import { addModule, connect, emptyPatch, type Patch } from './patch';
import { DEFS } from './modules';

/** Four visible pieces: a keyboard, a sound source, a gate and a destination. */
export function starterPatch(): Patch {
  const p = emptyPatch('My first voice');
  const main = addModule(p, DEFS.fm1, 20, 20);
  const osc = addModule(p, DEFS.osc, 300, 20);
  const vca = addModule(p, DEFS.vca, 580, 20);
  const out = addModule(p, DEFS.output, 860, 20);
  osc.params.level = 0.45; out.params.level = 0.15;
  for (const [a, ap, b, bp] of [[main, 'pitch', osc, 'pitch'], [main, 'gate', vca, 'cv'], [osc, 'out', vca, 'in'], [vca, 'out', out, 'l']] as const)
    connect(p, DEFS, { module: a.id, port: ap }, { module: b.id, port: bp });
  return p;
}
