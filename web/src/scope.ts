// SPDX-License-Identifier: GPL-3.0-only
// The scope: a floating panel that draws the probed outputs (worklet probes, 4096 samples each, about 30 times a
// second) as a time view (auto-scaled; audio signals triggered on a rising zero crossing so the wave stands still) or as
// a spectrum (a radix-2 FFT in TypeScript, Hann window, log magnitude over a log frequency axis). Control signals get a
// min / max / mean readout. Several probes at once, each in its own colour.

export interface Probe {
  key: string;
  label: string;
  kind: 'audio' | 'control' | 'gate';
  color: string;
  data: Float32Array | null;
  sr: number;
}

const COLORS = ['#c2410c', '#2563eb', '#059669', '#9333ea', '#b45309', '#0891b2'];
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
  private el: HTMLElement;
  private cv: HTMLCanvasElement;
  private list: HTMLElement;
  private mode: 'time' | 'spectrum' = 'time';
  private raf = 0;
  onRemove: (key: string) => void = () => {};

  constructor(root: HTMLElement) {
    this.el = root;
    root.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'scope-head';
    const title = document.createElement('span');
    title.textContent = 'Scope';
    const time = document.createElement('button');
    time.textContent = 'time';
    const spec = document.createElement('button');
    spec.textContent = 'spectrum';
    const pick = (m: 'time' | 'spectrum'): void => {
      this.mode = m;
      time.classList.toggle('on', m === 'time');
      spec.classList.toggle('on', m === 'spectrum');
    };
    time.onclick = () => pick('time');
    spec.onclick = () => pick('spectrum');
    pick('time');
    const close = document.createElement('button');
    close.textContent = '×';
    close.title = 'remove every probe';
    close.onclick = () => {
      for (const p of [...this.probes]) this.onRemove(p.key);
    };
    head.append(title, time, spec, close);
    this.cv = document.createElement('canvas');
    this.cv.width = 480;
    this.cv.height = 160;
    this.list = document.createElement('div');
    this.list.className = 'scope-list';
    root.append(head, this.cv, this.list);
    root.hidden = true;
  }

  get keys(): string[] {
    return this.probes.map((p) => p.key);
  }

  add(key: string, label: string, kind: Probe['kind']): void {
    if (this.probes.some((p) => p.key === key)) return;
    const used = new Set(this.probes.map((p) => p.color));
    this.probes.push({ key, label, kind, color: COLORS.find((c) => !used.has(c)) ?? COLORS[this.probes.length % COLORS.length], data: null, sr: 48000 });
    this.renderList();
    this.el.hidden = false;
    if (!this.raf) this.raf = requestAnimationFrame(() => this.draw());
  }

  remove(key: string): void {
    this.probes = this.probes.filter((p) => p.key !== key);
    this.renderList();
    if (!this.probes.length) {
      this.el.hidden = true;
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
  }

  feed(key: string, data: Float32Array, sr: number): void {
    const p = this.probes.find((x) => x.key === key);
    if (p) {
      p.data = data;
      p.sr = sr;
    }
  }

  colorOf(key: string): string | undefined {
    return this.probes.find((p) => p.key === key)?.color;
  }

  private renderList(): void {
    this.list.replaceChildren(
      ...this.probes.map((p) => {
        const row = document.createElement('span');
        row.className = 'scope-probe';
        row.style.color = p.color;
        const name = document.createElement('b');
        name.textContent = p.label;
        const stat = document.createElement('output');
        stat.dataset.key = p.key;
        const x = document.createElement('button');
        x.textContent = '×';
        x.title = `remove the probe on ${p.label}`;
        x.onclick = () => this.onRemove(p.key);
        row.append(name, stat, x);
        return row;
      }),
    );
  }

  private draw(): void {
    this.raf = this.probes.length ? requestAnimationFrame(() => this.draw()) : 0;
    const g = this.cv.getContext('2d');
    if (!g) return;
    const W = this.cv.width, H = this.cv.height;
    g.fillStyle = getComputedStyle(this.cv).getPropertyValue('--panel') || '#fff';
    g.fillRect(0, 0, W, H);
    g.strokeStyle = '#8884';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(0, H / 2);
    g.lineTo(W, H / 2);
    g.stroke();
    for (const p of this.probes) {
      const stat = this.list.querySelector<HTMLOutputElement>(`output[data-key="${CSS.escape(p.key)}"]`);
      if (!p.data) continue;
      const d = p.data;
      if (this.mode === 'spectrum') {
        const s = spectrum(d);
        const n = s.length;
        const fmin = 20, fmax = p.sr / 2;
        g.strokeStyle = p.color;
        g.beginPath();
        for (let x = 0; x < W; x++) {
          const f = fmin * Math.pow(fmax / fmin, x / W);
          const bin = Math.min(n - 1, Math.round((f / (p.sr / 2)) * (n - 1)));
          const y = H - ((Math.max(-96, s[bin]) + 96) / 96) * H;
          if (x === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();
        if (stat) {
          let best = 1;
          for (let i = 2; i < n; i++) if (s[i] > s[best]) best = i;
          stat.textContent = `peak ${Math.round((best / (n - 1)) * (p.sr / 2))} Hz, ${s[best].toFixed(0)} dB`;
        }
        continue;
      }
      let lo = Infinity, hi = -Infinity, sum = 0;
      for (let i = 0; i < d.length; i++) {
        if (d[i] < lo) lo = d[i];
        if (d[i] > hi) hi = d[i];
        sum += d[i];
      }
      const mean = sum / d.length;
      // audio: a window of 1024 samples from a rising zero crossing; control / gate: the whole buffer
      let start = 0, len = d.length;
      if (p.kind === 'audio') {
        len = 1024;
        for (let i = Math.floor(d.length / 2); i < d.length - len; i++) if (d[i - 1] < 0 && d[i] >= 0) {
          start = i;
          break;
        }
      }
      const amp = Math.max(1e-3, Math.abs(lo), Math.abs(hi));
      const scale = p.kind === 'audio' ? amp : Math.max(1, amp);
      g.strokeStyle = p.color;
      g.lineWidth = 1.5;
      g.beginPath();
      for (let x = 0; x < W; x++) {
        const i = start + Math.floor((x / W) * len);
        const y = H / 2 - (d[Math.min(d.length - 1, i)] / scale) * (H / 2 - 4);
        if (x === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
      if (stat) stat.textContent = p.kind === 'audio' ? `peak ${amp.toFixed(3)}` : `${lo.toFixed(3)} … ${hi.toFixed(3)}, mean ${mean.toFixed(3)}`;
    }
  }
}
