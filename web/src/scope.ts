// SPDX-License-Identifier: GPL-3.0-only
// Transparent viewport-sized scope behind the patch. Drawing follows samples, not patch zoom.
export const OUTPUT_PROBES = ['output:left', 'output:right'] as const;
type ProbeKind = 'audio' | 'control' | 'gate';
interface Probe {
  key: string;
  kind: ProbeKind;
  color: string;
  data: Float32Array | null;
  sr: number;
}
const COLORS = ['--scope-1', '--scope-2', '--scope-3', '--scope-4', '--scope-5', '--scope-6'];
const FFT_N = 2048;

/** in-place radix-2 FFT of re / im (length a power of two) */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
}

/** the magnitude spectrum (dB, 0 = full scale sine) of the last FFT_N samples, Hann windowed; bins 0..N/2 */
export function spectrum(data: Float32Array): Float32Array {
  const re = new Float64Array(FFT_N), im = new Float64Array(FFT_N);
  const off = Math.max(0, data.length - FFT_N);
  for (let i = 0; i < FFT_N; i++) re[i] = (data[off + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_N));
  fft(re, im);
  const out = new Float32Array(FFT_N / 2 + 1);
  for (let i = 0; i <= FFT_N / 2; i++) out[i] = 20 * Math.log10(Math.hypot(re[i], im[i]) / (FFT_N / 4) + 1e-9); // a full-scale sine reads 0 dB
  return out;
}

export class Scope {
  private probes: Probe[] = [];
  private mode: 'time' | 'spectrum' = 'time';
  private raf = 0;

  constructor(private cv: HTMLCanvasElement) {
    for (const key of OUTPUT_PROBES) this.add(key, 'audio');
    new ResizeObserver(() => this.schedule()).observe(cv);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.schedule());
    document.addEventListener('visibilitychange', () => this.schedule());
  }

  get visible(): boolean { return !this.cv.hidden; }

  setVisible(visible: boolean): void {
    this.cv.hidden = !visible;
    this.schedule();
  }

  setMode(mode: 'time' | 'spectrum'): void {
    this.mode = mode;
    this.setVisible(true);
  }

  add(key: string, kind: ProbeKind): void {
    if (this.probes.some((p) => p.key === key)) return;
    const color = COLORS[this.probes.length % COLORS.length];
    this.probes.push({ key, kind, color, data: null, sr: 48000 });
    this.schedule();
  }

  remove(key: string): void {
    this.probes = this.probes.filter((p) => p.key !== key);
    this.schedule();
  }

  clearSamples(): void {
    for (const p of this.probes) p.data = null;
    this.schedule();
  }

  feed(key: string, data: Float32Array, sr: number): void {
    const p = this.probes.find((x) => x.key === key);
    if (p) {
      p.data = data;
      p.sr = sr;
      this.schedule();
    }
  }

  private schedule(): void {
    if (!this.raf) this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      if (!document.hidden && this.cv.checkVisibility()) this.draw();
    });
  }

  private draw(): void {
    const g = this.cv.getContext('2d');
    if (!g) return;
    const W = this.cv.clientWidth, H = this.cv.clientHeight;
    if (!W || !H) return;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.round(W * dpr), height = Math.round(H * dpr);
    if (this.cv.width !== width || this.cv.height !== height) {
      this.cv.width = width;
      this.cv.height = height;
    }
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const style = getComputedStyle(this.cv);
    g.lineWidth = 1.5;
    g.globalAlpha = .55;
    for (const p of this.probes) {
      const d = p.data;
      if (!d?.length) continue;
      g.strokeStyle = style.getPropertyValue(p.color).trim();
      g.beginPath();
      if (this.mode === 'spectrum') {
        const s = spectrum(d);
        const n = s.length;
        const fmin = 20, fmax = p.sr / 2;
        for (let x = 0; x < W; x++) {
          const f = fmin * Math.pow(fmax / fmin, x / W);
          const bin = Math.min(n - 1, Math.round((f / (p.sr / 2)) * (n - 1)));
          const y = H - ((Math.max(-96, s[bin]) + 96) / 96) * H;
          if (x === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
      } else {
        let amp = 1e-3;
        for (const sample of d) amp = Math.max(amp, Math.abs(sample));
        let start = 0, len = d.length;
        if (p.kind === 'audio') {
          len = Math.min(1024, d.length);
          start = Math.max(0, d.length - len);
          for (let i = Math.max(1, Math.floor(d.length / 2)); i < d.length - len; i++) {
            if (d[i - 1] < 0 && d[i] >= 0) { start = i; break; }
          }
        }
        const scale = p.kind === 'audio' ? amp : Math.max(1, amp);
        for (let x = 0; x < W; x++) {
          const i = start + Math.floor((x / W) * len);
          const y = H / 2 - (d[Math.min(d.length - 1, i)] / scale) * H * .4;
          if (x === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
      }
      g.stroke();
    }
  }
}
