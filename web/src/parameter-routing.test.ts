// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DEFS } from './modules';
import { addModule, connect, emptyPatch, validatePatch } from './patch';
import { connectParameter, parameterInputs } from './parameter-routing';

function setup() {
  const p = emptyPatch();
  const source = addModule(p, DEFS.lfo, 0, 0);
  const second = addModule(p, DEFS.const, 0, 0);
  const target = addModule(p, DEFS.filter, 0, 0);
  const from = { module: source.id, port: 'out' };
  return { p, source, second, target, from };
}

describe('slider jack routing', () => {
  it('aliases dedicated CV jacks and makes duplicate drops a no-op', () => {
    const { p, target, from } = setup();
    const original = structuredClone(target);
    connectParameter(p, DEFS, from, target.id, 'cutoff');
    connectParameter(p, DEFS, from, target.id, 'cutoff');
    expect(p.cables).toEqual([{ from, to: { module: target.id, port: 'cv' } }]);
    expect(target).toEqual(original);
  });

  it('uses the existing parameter assignment, preserved in compatible saved patches', () => {
    const { p, target, from } = setup();
    connectParameter(p, DEFS, from, target.id, 'res');
    expect(p.cables[0].to.port).toBe('p2');
    expect(validatePatch(JSON.parse(JSON.stringify(p)), DEFS)).toEqual(p);
  });

  it('assigns an unused pin to a new destination without changing base values', () => {
    const { p, target, from } = setup();
    const params = { ...target.params };
    connectParameter(p, DEFS, from, target.id, 'cvamt');
    expect(target.map!.p1).toEqual(['cvamt']);
    expect(p.cables[0].to.port).toBe('p1');
    expect(target.params).toEqual(params);
  });

  it('shares an existing identical source without duplicating or redirecting its cable', () => {
    const { p, target, from } = setup();
    connectParameter(p, DEFS, from, target.id, 'res');
    connectParameter(p, DEFS, from, target.id, 'cvamt');
    expect(p.cables).toHaveLength(1);
    expect(target.map!.p2).toEqual(['res', 'cvamt']);
  });

  it('does not add a new signal to another parameter through a shared pin', () => {
    const { p, target, from, second } = setup();
    target.map!.p2 = ['res', 'cvamt'];
    connect(p, DEFS, { module: second.id, port: 'out' }, { module: target.id, port: 'p2' });
    connectParameter(p, DEFS, from, target.id, 'res');
    expect(p.cables[1].to.port).toBe('p1');
    expect(target.map!.p1).toEqual(['res']);
    expect(target.map!.p2).toEqual(['res', 'cvamt']);
  });

  it('rejects an unavailable third independent input without mutating the patch', () => {
    const { p, target, from, second } = setup();
    const other = addModule(p, DEFS.noise, 0, 0);
    connect(p, DEFS, { module: second.id, port: 'out' }, { module: target.id, port: 'p1' });
    connect(p, DEFS, { module: other.id, port: 'out' }, { module: target.id, port: 'p2' });
    const before = JSON.stringify(p);
    expect(() => connectParameter(p, DEFS, from, target.id, 'cvamt')).toThrow('Both parameter inputs');
    expect(JSON.stringify(p)).toBe(before);
  });

  it('preserves macro ranges and knob assignments while patching an existing destination', () => {
    const { p, target, from } = setup();
    target.range = { p2: { res: [.8, .2] } };
    const map = structuredClone(target.map);
    connectParameter(p, DEFS, from, target.id, 'res');
    expect(target.map).toEqual(map);
    expect(target.range).toEqual({ p2: { res: [.8, .2] } });
  });

  it('exposes every existing route at a thumb and validates dedicated input metadata', () => {
    const { target } = setup();
    target.map!.p2.push('cutoff');
    expect(parameterInputs(target, DEFS.filter.params[0])).toEqual(['cv', 'p1', 'p2']);
    for (const def of Object.values(DEFS)) for (const pd of def.params)
      if (pd.input) expect(def.inputs.some((p) => p.name === pd.input && p.kind === 'control')).toBe(true);
  });
});
