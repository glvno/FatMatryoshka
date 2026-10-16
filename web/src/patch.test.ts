// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { DEFS } from './modules';
import { addModule, ensureMain, newPatch, type Patch } from './patch';

describe('the Main module', () => {
  it('is added to a patch that has none, once, without touching the rest', () => {
    const p: Patch = { version: 2, name: 'no main', modules: [], cables: [] };
    const out = addModule(p, DEFS.output, 0, 0);
    expect(ensureMain(p, DEFS)).toBe(true);
    expect(ensureMain(p, DEFS)).toBe(false);
    expect(p.modules.map((m) => m.type)).toEqual(['output', 'fm1']);
    expect(p.modules[1].id).not.toBe(out.id);
  });

  it('a new patch already has one', () => {
    expect(ensureMain(newPatch(DEFS), DEFS)).toBe(false);
  });
});
