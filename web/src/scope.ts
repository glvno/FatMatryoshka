// SPDX-License-Identifier: GPL-3.0-only
import { resizeHandle } from './resize-handle';

// Draggable, resizable scope window, anchored to the patch viewport independently of patch zoom.
export const OUTPUT_PROBES = ['output:left', 'output:right'] as const;
type ProbeKind = 'audio' | 'control' | 'gate';
interface Probe {
  key: string;
  kind: ProbeKind;
  data: Float32Array | null;
  sr: number;
}
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
  private cv: HTMLCanvasElement;
  private position: { x: number; y: number } | null = null;

  constructor(private root: HTMLElement) {
    this.cv = root.querySelector('canvas')!;
    for (const key of OUTPUT_PROBES) this.add(key, 'audio');
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-scope-mode]')) {
      button.onclick = () => this.setMode(button.dataset.scopeMode === 'time' ? 'time' : 'spectrum');
    }
    root.querySelector<HTMLButtonElement>('.scope-close')!.onclick = () => this.setVisible(false);
    this.setupDragging();
    root.append(resizeHandle('Resize oscilloscope', () => 1, {
      start: () => { this.position = this.currentPosition(); },
      size: () => ({ width: root.offsetWidth, height: root.offsetHeight }),
      resize: (width, height) => {
        const parent = root.parentElement!;
        root.style.width = `${Math.min(parent.clientWidth - 24, Math.max(280, width))}px`;
        root.style.height = `${Math.min(parent.clientHeight - 24, Math.max(120, height))}px`;
        this.clampPosition();
      },
      end: () => {},
    }));
    new ResizeObserver(() => { this.clampPosition(); this.schedule(); }).observe(root.parentElement!);
    new ResizeObserver(() => this.schedule()).observe(this.cv);
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => this.schedule());
    document.addEventListener('visibilitychange', () => this.schedule());
  }

  get visible(): boolean { return !this.root.hidden; }

  setVisible(visible: boolean): void {
    this.root.hidden = !visible;
    if (visible) this.clampPosition();
    this.schedule();
  }

  setMode(mode: 'time' | 'spectrum'): void {
    this.mode = mode;
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-scope-mode]')) {
      button.setAttribute('aria-pressed', String(button.dataset.scopeMode === mode));
    }
    this.setVisible(true);
  }

  private clampPosition(): void {
    if (!this.position || !this.root.checkVisibility()) return;
    const parent = this.root.parentElement!;
    const maxX = Math.max(0, parent.clientWidth - this.root.offsetWidth);
    const maxY = Math.max(0, parent.clientHeight - this.root.offsetHeight);
    this.position.x = Math.max(0, Math.min(maxX, this.position.x));
    this.position.y = Math.max(0, Math.min(maxY, this.position.y));
    this.root.style.left = `${this.position.x}px`;
    this.root.style.top = `${this.position.y}px`;
    this.root.style.right = 'auto';
    this.root.style.bottom = 'auto';
  }

  private currentPosition(): { x: number; y: number } {
    const rect = this.root.getBoundingClientRect();
    const parent = this.root.parentElement!.getBoundingClientRect();
    return { x: rect.left - parent.left, y: rect.top - parent.top };
  }

  private setupDragging(): void {
    const handle = this.root.querySelector<HTMLButtonElement>('.scope-handle')!;
    let drag: { pointer: number; x: number; y: number; origin: { x: number; y: number } } | null = null;
    handle.onpointerdown = (event) => {
      if (event.button !== 0 || drag) return;
      event.preventDefault();
      handle.focus();
      drag = { pointer: event.pointerId, x: event.clientX, y: event.clientY, origin: this.currentPosition() };
      handle.setPointerCapture(event.pointerId);
      handle.classList.add('dragging');
    };
    handle.onpointermove = (event) => {
      if (!drag || event.pointerId !== drag.pointer) return;
      this.position = { x: drag.origin.x + event.clientX - drag.x, y: drag.origin.y + event.clientY - drag.y };
      this.clampPosition();
    };
    const end = (event: PointerEvent): void => {
      if (!drag || event.pointerId !== drag.pointer) return;
      drag = null;
      handle.classList.remove('dragging');
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    };
    handle.onpointerup = end;
    handle.onpointercancel = end;
    handle.onlostpointercapture = end;
    handle.onkeydown = (event) => {
      if (event.key === 'Home') {
        this.position = null;
        for (const property of ['left', 'top', 'right', 'bottom']) this.root.style.removeProperty(property);
      } else {
        const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!delta) return;
        const origin = this.currentPosition(), step = event.shiftKey ? 40 : 10;
        this.position = { x: origin.x + delta[0] * step, y: origin.y + delta[1] * step };
        this.clampPosition();
      }
      event.preventDefault();
      event.stopPropagation();
    };
  }

  add(key: string, kind: ProbeKind): void {
    if (this.probes.some((p) => p.key === key)) return;
    this.probes.push({ key, kind, data: null, sr: 48000 });
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
    g.lineCap = 'butt';
    g.lineJoin = 'miter';
    g.globalAlpha = .25;
    const traceHeight = Math.max(1, H - 16), traceBottom = H / 2 + traceHeight / 2;
    for (const p of this.probes) {
      const d = p.data;
      if (!d?.length) continue;
      g.strokeStyle = style.getPropertyValue(`--${p.kind}`).trim();
      g.beginPath();
      if (this.mode === 'spectrum') {
        const s = spectrum(d);
        const n = s.length;
        const fmin = 20, fmax = p.sr / 2;
        for (let x = 0; x < W; x++) {
          const f = fmin * Math.pow(fmax / fmin, x / W);
          const bin = Math.min(n - 1, Math.round((f / (p.sr / 2)) * (n - 1)));
          const db = Math.max(-96, Math.min(0, s[bin]));
          const y = traceBottom - ((db + 96) / 96) * traceHeight;
          if (x === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
      } else {
        let amp = 1e-3;
        for (const sample of d) amp = Math.max(amp, Math.abs(sample));
        let start = 0, len = d.length;
        if (p.kind === 'audio') {
          // A 16 ms window gives individual samples more horizontal space.
          len = Math.min(Math.round(p.sr * .016), d.length);
          start = Math.max(0, d.length - len);
          // Use the most recent rising crossing that leaves a complete window.
          for (let i = start; i >= 1; i--) {
            if (d[i - 1] < 0 && d[i] >= 0) { start = i; break; }
          }
        }
        const scale = p.kind === 'audio' ? amp : Math.max(1, amp);
        // Original display: pick the nearest preceding sample for each pixel.
        for (let x = 0; x < W; x++) {
          const i = start + Math.floor((x / W) * len);
          const y = H / 2 - (d[i] / scale) * traceHeight / 2;
          if (x === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
      }
      g.stroke();
    }
  }
}
