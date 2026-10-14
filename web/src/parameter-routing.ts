// SPDX-License-Identifier: GPL-3.0-only
import { connect, sameEnd, type Endpoint, type ModuleDef, type ModuleInst, type ParamDef, type Patch } from './patch';

const PINS = ['p1', 'p2'] as const;

/** Physical inputs whose signals affect this parameter. The thumb is an alias, never a new patch port. */
export function parameterInputs(m: ModuleInst, pd: ParamDef): string[] {
  return [...(pd.input ? [pd.input] : []), ...PINS.filter((pin) => m.map?.[pin].includes(pd.name)), ...Object.keys(m.inputMap ?? {}).filter((port) => m.inputMap![port].includes(pd.name))];
}

/** The editable p1/p2 branch; removing it also removes that destination's macro range. */
export function setParameterInput(m: ModuleInst, pin: 'p1' | 'p2', param: string, on: boolean): void {
  if (!m.map) throw new Error('This module has no parameter inputs.');
  if (on && m.map[pin].includes(param)) return;
  const names = m.map[pin].filter((name) => name !== param);
  if (on) names.push(param);
  else delete m.range?.[pin]?.[param];
  m.map[pin] = names;
}

/** Add or remove one branch without replacing any other destinations or the physical cable. */
export function setInputRoute(m: ModuleInst, def: ModuleDef, port: string, param: string, on: boolean): void {
  const pd = def.params.find((pd) => pd.name === param);
  if (!pd || !def.inputs.some((p) => p.name === port)) throw new Error('This input or parameter is no longer available.');
  if (port === 'p1' || port === 'p2') return setParameterInput(m, port, param, on);
  if (port === pd.input) {
    if (on) return; // built in: a dedicated input always feeds its parameter
    throw new Error(`${port} → ${param} is built into this module and cannot be disconnected.`);
  }
  const names = (m.inputMap?.[port] ?? []).filter((name) => name !== param);
  if (on) names.push(param);
  if (names.length) (m.inputMap ??= {})[port] = names;
  else if (m.inputMap) {
    delete m.inputMap[port];
    if (!Object.keys(m.inputMap).length) delete m.inputMap;
  }
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
  let port = parameterInputs(m, pd).find((port) => incoming(port).length === 1 && sameEnd(incoming(port)[0].from, from)) ?? pd.input;
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
