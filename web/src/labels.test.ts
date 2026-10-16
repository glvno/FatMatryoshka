// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { formatValue, moduleTag } from './labels';
import { DEFS } from './modules';

describe('card labels', () => {
  it('formats values to three figures with readable units', () => {
    const f = (v: number, u?: string, s = false) => { const r = formatValue(v, u, s); return `${r.num}${r.unit ? ' ' + r.unit : ''}`; };
    expect(f(3160.991, 'Hz')).toBe('3.16 kHz');
    expect(f(440, 'Hz')).toBe('440 Hz');
    expect(f(0.012, 's')).toBe('12 ms');
    expect(f(1.8, 's')).toBe('1.8 s');
    expect(f(8, 'ct', true)).toBe('+8 ct');
    expect(f(-8, 'ct', true)).toBe('-8 ct');
    expect(f(0, 'ct', true)).toBe('0 ct');
    expect(f(0.2)).toBe('0.2');
    expect(f(16000, 'Hz')).toBe('16 kHz');
  });

  it('gives every module type a tag', () => {
    for (const t of Object.keys(DEFS)) expect(moduleTag(t).tag.length).toBeGreaterThan(0);
  });
});
