// SPDX-License-Identifier: GPL-3.0-only
import { connect, sameEnd, type Endpoint, type ModuleDef, type ModuleInst, type ParamDef, type Patch } from './patch';

const PINS = ['p1', 'p2'] as const;

/** Physical inputs whose signals affect this parameter. The thumb is an alias, never a new patch port. */
export function parameterInputs(m: ModuleInst, pd: ParamDef): string[] {
  return [...(pd.input ? [pd.input] : []), ...PINS.filter((pin) => m.map?.[pin].includes(pd.name))];
}

/** Connect to a slider without changing the signal heard by other parameters sharing a pin. */
export function connectParameter(p: Patch, defs: Record<string, ModuleDef>, from: Endpoint, module: number, param: string): Endpoint {
  const m = p.modules.find((m) => m.id === module);
  const def = m && defs[m.type];
  const pd = def?.params.find((pd) => pd.name === param);
  if (!m || !def || !pd) throw new Error('This parameter is no longer available.');
  if (from.module === module || !p.modules.some((m) => m.id === from.module && defs[m.type].outputs.some((o) => o.name === from.port)))
    throw new Error('Connect an output from another module.');
  const incoming = (pin: string) => p.cables.filter((c) => c.to.module === module && c.to.port === pin);
  let port = pd.input;
  if (!port && m.map) {
    // Reuse the same signal first, then a pin exclusive to this parameter. Otherwise take an unused pin.
    port = PINS.find((pin) => incoming(pin).length === 1 && sameEnd(incoming(pin)[0].from, from))
      ?? PINS.find((pin) => m.map![pin].length === 1 && m.map![pin][0] === param)
      ?? PINS.find((pin) => !incoming(pin).length && !Object.keys(m.range?.[pin] ?? {}).length);
    if (!port) throw new Error('Both parameter inputs are shared or in use. Open this parameter’s routing menu to free or share p1 / p2.');
    const pin = port as 'p1' | 'p2';
    if (!m.map[pin].includes(param)) {
      if (!incoming(pin).length) m.map[pin] = [param];
      else m.map[pin].push(param);
    }
  }
  if (!port) throw new Error('This control has no modulation input.');
  const to = { module, port };
  if (!p.cables.some((c) => sameEnd(c.from, from) && sameEnd(c.to, to)) && !connect(p, defs, from, to))
    throw new Error('Cannot connect these ports.');
  return to;
}
