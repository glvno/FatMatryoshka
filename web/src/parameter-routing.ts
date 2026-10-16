// SPDX-License-Identifier: GPL-3.0-only
import { longName, moduleName } from './labels';
import { connect, sameEnd, type Cable, type Endpoint, type ModuleDef, type ModuleInst, type ParamDef, type Patch } from './patch';

// The pins p1 / p2 are a module's two modulation inputs. The editor shows no jacks for them: a cable to a parameter's
// thumb (or a knob's / picker's jack) is routed through a pin here, one source per pin, so a module takes at most two
// different sources across its parameters. One source can feed several parameters of a module through one pin; they
// share that pin's depth (the attenuverter) unless `separateDepth` moves one onto the other pin.

export const PINS = ['p1', 'p2'] as const;
export const isPin = (port: string): port is 'p1' | 'p2' => port === 'p1' || port === 'p2';

const into = (p: Patch, module: number, port: string): Cable[] => p.cables.filter((c) => c.to.module === module && c.to.port === port);

/** both pins hold other sources: `cables` are the ones holding them */
export class PinsInUse extends Error {
  constructor(message: string, readonly cables: Cable[]) {
    super(message);
  }
}

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
  const fromHere = (port: string): boolean => into(p, module, port).some((c) => sameEnd(c.from, from));
  // the same source already reaches this parameter (its dedicated input, a pin, a route): nothing new. Else a pin, so the
  // route has its own depth and range; the dedicated input is its jack (only a module without pins falls back to it).
  let port = parameterInputs(m, pd).find(fromHere) ?? (m.map ? undefined : pd.input);
  if (!port && m.map) {
    const shared = PINS.find(fromHere);
    if (shared) {
      // the source is on a pin already: this parameter shares it (and its depth)
      if (!m.map[shared].includes(param)) m.map[shared].push(param);
      port = shared;
    } else {
      // a free pin: first one already assigned to just this parameter (the saved matrix, its range and depth stay), then any
      const unused = PINS.filter((pin) => !into(p, module, pin).length);
      const own = unused.find((pin) => m.map![pin].length === 1 && m.map![pin][0] === param);
      const free = own ?? unused[0];
      if (!free) {
        const held = PINS.flatMap((pin) => into(p, module, pin));
        const names = [...new Set(held.map((c) => sourceName(p, defs, c.from)))];
        throw new PinsInUse(`${def.label} takes two modulation sources, and ${names.join(' and ')} use them. Remove one of those cables first.`, held);
      }
      if (!own) {
        // a fresh pin: this parameter only, full depth, no range left from an earlier source
        m.map[free] = [param];
        delete m.range?.[free];
        m.att![PINS.indexOf(free)] = 1;
      }
      port = free;
    }
  }
  if (!port) throw new Error('This control has no modulation input.');
  const to = { module, port };
  if (!p.cables.some((c) => sameEnd(c.from, from) && sameEnd(c.to, to)) && !connect(p, defs, from, to))
    throw new Error('Cannot connect these ports.');
  return to;
}

/** "LFO out", for messages */
function sourceName(p: Patch, defs: Record<string, ModuleDef>, from: Endpoint): string {
  const m = p.modules.find((x) => x.id === from.module);
  return m ? `${moduleName(m.type, defs[m.type].label)} ${longName(m.type, from.port)}` : from.port;
}

/** the pin routes into a parameter: each source cable with its pin and the other parameters sharing that pin */
export function pinRoutes(p: Patch, m: ModuleInst, param: string): { cable: Cable; pin: 'p1' | 'p2'; index: number; shared: string[] }[] {
  return PINS.flatMap((pin, index) => (m.map?.[pin].includes(param)
    ? into(p, m.id, pin).map((cable) => ({ cable, pin, index, shared: m.map![pin].filter((n) => n !== param) }))
    : []));
}

/**
 * Remove one drawn route: the cable `c` (into a pin) no longer feeds `param`. The cable goes when it feeds nothing else
 * (the pin keeps its assignment, as the FM-1's matrix does; only that parameter's range goes). A cable that shares its pin
 * with another source and other parameters cannot leave just one of them: it goes as a whole.
 */
export function removeRoute(p: Patch, c: Cable, param: string): void {
  const m = p.modules.find((x) => x.id === c.to.module);
  const pin = c.to.port;
  const drop = (): void => {
    p.cables = p.cables.filter((x) => x !== c && !(sameEnd(x.from, c.from) && sameEnd(x.to, c.to)));
    if (m && isPin(pin) && !into(p, m.id, pin).length) delete m.range?.[pin]?.[param];
  };
  if (!m?.map || !isPin(pin)) return drop();
  const others = m.map[pin].filter((n) => n !== param);
  if (!others.length || into(p, m.id, pin).length > 1) return drop();
  m.map[pin] = others;
  delete m.range?.[pin]?.[param];
}

/** whether `separateDepth` can give `param` its own depth: it shares a pin with one source, and the other pin is free */
export function canSeparate(p: Patch, m: ModuleInst, param: string): boolean {
  const s = PINS.find((pin) => m.map?.[pin].includes(param));
  if (!s || !m.map) return false;
  const other = s === 'p1' ? 'p2' : 'p1';
  return m.map[s].length > 1 && into(p, m.id, s).length === 1 && !into(p, m.id, other).length;
}

/** move `param` from the pin it shares onto the free pin, with the same source, depth and range: then its depth is its own */
export function separateDepth(p: Patch, defs: Record<string, ModuleDef>, m: ModuleInst, param: string): void {
  if (!canSeparate(p, m, param)) throw new Error('This parameter does not share its depth, or the other modulation input is in use.');
  const s = PINS.find((pin) => m.map![pin].includes(param))!;
  const o = s === 'p1' ? 'p2' : 'p1';
  const source = into(p, m.id, s)[0].from;
  m.map![s] = m.map![s].filter((n) => n !== param);
  m.map![o] = [param];
  m.att![PINS.indexOf(o)] = m.att![PINS.indexOf(s)];
  delete m.range?.[o];
  const r = m.range?.[s]?.[param];
  if (r) {
    delete m.range![s]![param];
    ((m.range ??= {})[o] ??= {})[param] = r;
  }
  connect(p, defs, source, { module: m.id, port: o });
}
