// SPDX-License-Identifier: GPL-3.0-only
/**
 * Where each FM-1 knob alone puts the parameters it reaches, at rest (no note, every other source ignored): the
 * knob ticks under the editor's sliders. A knob reaches a parameter over a cable from the Main module's k1..k4 to
 * a p1 / p2 pin (through the attenuverter and the matrix, or a macro range), to an input route (inputMap), or to a
 * parameter's dedicated input (ParamDef.rest). Only knobs that move the parameter off its base are listed.
 */
import { DEFS, PIN_NAMES } from './modules';
import { modulate, paramValue, toUnit, type ModuleInst, type Patch } from './patch';

export const KNOBS = ['k1', 'k2', 'k3', 'k4'] as const;
export type Knob = (typeof KNOBS)[number];

export interface KnobRest {
  knob: Knob;
  value: number;
}

export const isKnob = (name: string): name is Knob => (KNOBS as readonly string[]).includes(name);

/** `moduleId:param` -> the knobs that move that parameter, with the resting value each one gives it */
export function knobRests(patch: Patch): Map<string, KnobRest[]> {
  const out = new Map<string, KnobRest[]>();
  const panel = patch.modules.find((m) => m.type === 'fm1');
  if (!panel) return out;
  const byId = new Map(patch.modules.map((m) => [m.id, m]));
  const put = (m: ModuleInst, name: string, knob: Knob, value: number): void => {
    const pd = DEFS[m.type].params.find((q) => q.name === name);
    if (!pd || pd.toggle) return;
    const base = m.params[name] ?? pd.default;
    const v = Math.min(pd.max, Math.max(pd.min, value));
    if (!Number.isFinite(v) || Math.abs(toUnit(pd, v) - toUnit(pd, base)) < 1e-4) return;
    const key = `${m.id}:${name}`;
    const list = out.get(key) ?? [];
    if (!list.some((r) => r.knob === knob)) list.push({ knob, value: v });
    out.set(key, list);
  };
  for (const c of patch.cables) {
    if (c.from.module !== panel.id || !isKnob(c.from.port)) continue;
    const knob = c.from.port;
    const k = panel.params[knob] ?? 0.5;
    const m = byId.get(c.to.module);
    if (!m || m.bypass) continue;
    const def = DEFS[m.type];
    const port = c.to.port;
    const pin = (PIN_NAMES as readonly string[]).indexOf(port);
    if (pin >= 0) {
      const v = k * (m.att?.[pin] ?? 1);
      for (const name of m.map?.[port as 'p1' | 'p2'] ?? []) {
        const pd = def.params.find((q) => q.name === name);
        if (!pd) continue;
        const r = m.range?.[port as 'p1' | 'p2']?.[name];
        put(m, name, knob, r ? paramValue(pd, r[0] + Math.min(1, Math.max(0, v)) * (r[1] - r[0])) : modulate(pd, m.params[name] ?? pd.default, v));
      }
      continue;
    }
    for (const name of m.inputMap?.[port] ?? []) {
      const pd = def.params.find((q) => q.name === name);
      if (pd) put(m, name, knob, modulate(pd, m.params[name] ?? pd.default, k));
    }
    for (const pd of def.params)
      if (pd.input === port && pd.rest && !m.disabledInputs?.includes(port)) put(m, pd.name, knob, pd.rest(m.params, k));
  }
  return out;
}
