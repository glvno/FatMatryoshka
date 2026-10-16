// SPDX-License-Identifier: GPL-3.0-only
// A selector for a list of choices: a notched groove. A thin line with a notch per choice; the jack rides on the live
// choice's notch and hops from notch to notch as modulation moves it (a modulated slider's thumb glides). When every
// name fits under its notch they are all written there, else only the live one, riding under the jack. While modulated
// the base notch is marked; the FM-1 knobs' resting choices are marked over their notches in the knobs' colours.
// Click or drag along the groove to pick (the nearest notch), arrow keys step; the jack drags too, as a slider's thumb
// does, and patches with Alt or while a cable is being patched.

export interface Selector {
  element: HTMLElement;
  /** the marker on the live choice: a jack (cables land on it) or, with nothing to patch, a plain thumb */
  jack: HTMLElement;
  /** show the live choice (modulated) and the base (the setting) */
  update(live: number, base: number): void;
  /** the choices the FM-1 knobs leave it at; `unit` is the position in the range 0..1, as for a slider */
  setKnobTicks(ticks: { knob: string; unit: number }[]): void;
  /** replace the names (B side: the candidates change) */
  setNames(names: string[]): void;
}

/** whether the names fit under their notches is measured, and rechecked when the row's width changes */
const fit = new ResizeObserver((entries) => {
  for (const e of entries) checks.get(e.target)?.();
});
const checks = new WeakMap<Element, () => void>();

export function selector(o: {
  label: string;
  names: string[];
  /** the base index */
  get: () => number;
  set: (i: number) => void;
  /** the jack: Alt (or a cable being patched) starts a cable from it; without, a plain thumb that takes no cables */
  onPatch?: (e: PointerEvent, jack: HTMLElement) => void;
}): Selector {
  let names = o.names;
  let live = o.get(), base = o.get();
  const el = document.createElement('div');
  el.className = 'sel-track';
  el.tabIndex = 0;
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-label', o.label);
  const groove = document.createElement('span');
  groove.className = 'sel-groove';
  const notches = document.createElement('span');
  notches.className = 'sel-notches';
  const labels = document.createElement('span');
  labels.className = 'sel-labels';
  const rider = document.createElement('span');
  rider.className = 'sel-rider';
  const baseMark = document.createElement('span');
  baseMark.className = 'sel-base';
  baseMark.setAttribute('aria-hidden', 'true');
  const jack = document.createElement('span');
  jack.className = o.onPatch ? 'dot control slider-port sel-jack' : 'dot slider-thumb sel-jack';
  jack.setAttribute('aria-hidden', 'true');
  el.append(groove, notches, baseMark, labels, rider, jack);

  const n = (): number => names.length;
  const clamp = (i: number): number => Math.max(0, Math.min(n() - 1, Math.round(i)));
  /** where a notch is along the groove, 0..1: the first and last at its ends (inset by half the jack, so the jack stays on it) */
  const frac = (i: number): number => (n() > 1 ? i / (n() - 1) : 0.5);
  const pos = (i: number): string => `calc(7px + ${frac(i)} * (100% - 14px))`;
  const pick = (i: number): void => {
    i = clamp(i);
    if (i === o.get()) return;
    o.set(i);
    // show it now (the live value follows from the engine; unmodulated it is the new base)
    if (live === base) live = i;
    base = i;
    draw();
  };

  let items: HTMLElement[] = [];
  const build = (): void => {
    notches.replaceChildren(...names.map((_, i) => {
      const d = document.createElement('span');
      d.className = 'sel-notch';
      d.style.left = pos(i);
      return d;
    }));
    items = names.map((name, i) => {
      const b = document.createElement('span');
      // the end names line up with the groove's ends, the others are centred under their notches
      b.className = 'sel-opt' + (n() > 1 && i === 0 ? ' first' : n() > 1 && i === n() - 1 ? ' last' : '');
      b.textContent = name;
      b.style.left = pos(i);
      return b;
    });
    labels.replaceChildren(...items);
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', String(Math.max(0, n() - 1)));
    check();
    draw();
  };

  const draw = (): void => {
    const l = clamp(live), b = clamp(base);
    items.forEach((it, i) => {
      it.classList.toggle('live', i === l);
      it.classList.toggle('base', i === b && l !== b);
    });
    jack.style.left = `calc(${pos(l)} - 7px)`;
    rider.textContent = names[l] ?? '';
    // the riding name stays over its notch, but inside the groove's ends
    const w = el.clientWidth, rw = rider.offsetWidth;
    rider.style.left = w && rw ? `${Math.max(0, Math.min(w - rw, 7 + frac(l) * (w - 14) - rw / 2))}px` : '0px';
    baseMark.hidden = l === b;
    baseMark.style.left = pos(b);
    el.setAttribute('aria-valuenow', String(b));
    el.setAttribute('aria-valuetext', names[b] ?? '');
    el.title = l !== b ? `${o.label}: ${names[l] ?? ''} (set to ${names[b] ?? ''})` : `${o.label}: ${names[b] ?? ''}`;
  };

  // every name under its notch when each fits in its share of the groove, else only the live one under the jack
  const check = (): void => {
    if (!el.isConnected || !el.clientWidth) return;
    // the space between two notches; a name at an end may take most of it, as its neighbour is centred
    const gap = n() > 1 ? (el.clientWidth - 14) / (n() - 1) : el.clientWidth;
    el.classList.toggle('many', items.some((it, i) => {
      const end = n() > 1 && (i === 0 || i === n() - 1);
      const next = items[i === 0 ? 1 : i - 1];
      return end ? it.offsetWidth - 7 + (next?.offsetWidth ?? 0) / 2 > gap - 4 : it.offsetWidth > gap - 4;
    }));
    draw();
  };
  checks.set(el, check);
  fit.observe(el);

  // the knobs' resting choices, over their notches (several on one notch sit side by side)
  const ticks: HTMLElement[] = [];
  const setKnobTicks = (list: { knob: string; unit: number }[]): void => {
    const shown = list
      .map((t) => ({ knob: t.knob, i: clamp(t.unit * (n() - 1)) }))
      .filter((t) => t.i !== clamp(base));
    while (ticks.length > shown.length) ticks.pop()!.remove();
    shown.forEach((t, k) => {
      let tk = ticks[k];
      if (!tk) {
        tk = document.createElement('span');
        tk.className = 'sel-knob';
        tk.setAttribute('aria-hidden', 'true');
        el.insertBefore(tk, jack);
        ticks.push(tk);
      }
      const same = shown.slice(0, k).filter((x) => x.i === t.i).length;
      const count = shown.filter((x) => x.i === t.i).length;
      tk.style.left = `calc(${pos(t.i)} - 3px + ${(same - (count - 1) / 2) * 7}px)`;
      tk.style.color = `var(--${t.knob})`;
      tk.title = `${t.knob.toUpperCase()} rests it at ${names[t.i] ?? ''}`;
    });
  };

  /** the notch nearest a pointer's x */
  const nearest = (x: number): number => {
    const r = el.getBoundingClientRect();
    const k = r.width / (el.offsetWidth || 1); // the canvas zoom
    return n() > 1 ? clamp(((x - r.left - 7 * k) / (r.width - 14 * k)) * (n() - 1)) : 0;
  };
  /** press and drag: the value follows the pointer, notch by notch */
  const scrub = (e: PointerEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    el.focus({ preventScroll: true });
    pick(nearest(e.clientX));
    const move = (m: PointerEvent): void => {
      if (m.pointerId === e.pointerId) pick(nearest(m.clientX));
    };
    const up = (u: PointerEvent): void => {
      if (u.pointerId !== e.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target === jack) return;
    scrub(e);
  });
  if (o.onPatch)
    jack.addEventListener('pointerdown', (e) => {
      if (e.altKey || jack.closest('.patching')) return o.onPatch!(e, jack);
      if (e.button === 0) scrub(e);
    });
  el.addEventListener('keydown', (e) => {
    const d = e.key === 'ArrowLeft' || e.key === 'ArrowDown' ? -1 : e.key === 'ArrowRight' || e.key === 'ArrowUp' ? 1 : 0;
    if (d) pick(o.get() + d);
    else if (e.key === 'Home') pick(0);
    else if (e.key === 'End') pick(n() - 1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  });

  build();
  return {
    element: el,
    jack,
    update(l: number, b: number) {
      if (l === live && b === base) return;
      live = l;
      base = b;
      draw();
    },
    setKnobTicks,
    setNames(next: string[]) {
      if (next.length === names.length && next.every((x, i) => x === names[i])) return;
      names = next;
      build();
    },
  };
}
