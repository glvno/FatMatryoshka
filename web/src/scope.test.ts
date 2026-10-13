// SPDX-License-Identifier: GPL-3.0-only
import { describe, expect, it } from 'vitest';
import { fft, spectrum } from './scope';

describe('scope', () => {
  it('the FFT of a sine has one bin, the spectrum reads 0 dB for a full-scale sine and finds its frequency', () => {
    const n = 2048;
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.cos((2 * Math.PI * 64 * i) / n);
    fft(re, im);
    expect(Math.hypot(re[64], im[64])).toBeCloseTo(n / 2, 6);
    expect(Math.hypot(re[65], im[65])).toBeLessThan(1e-6);
    const sr = 48000;
    const data = new Float32Array(4096);
    for (let i = 0; i < data.length; i++) data[i] = Math.sin((2 * Math.PI * 1000 * i) / sr);
    const s = spectrum(data);
    let best = 0;
    for (let i = 1; i < s.length; i++) if (s[i] > s[best]) best = i;
    expect((best / (s.length - 1)) * (sr / 2)).toBeCloseTo(1000, -2); // within the bin width (23 Hz)
    expect(s[best]).toBeGreaterThan(-1.5);
    expect(s[best]).toBeLessThan(0.5);
    expect(s[Math.round(best / 2)]).toBeLessThan(-60); // nothing at 500 Hz
  });
});
