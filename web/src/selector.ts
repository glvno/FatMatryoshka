// SPDX-License-Identifier: GPL-3.0-only
// A selector for a list of choices, in one of two shapes:
// - a detent rail: every choice's name across the row, the jack standing over the live one (it hops between them as a
//   modulated slider's thumb glides), the base underlined;
// - a drum, when the names do not fit: a window of three, the jack fixed in the middle, the names rolling past it.
// Clicking a name picks it, a drag along the row scrubs, the arrow keys step; the drum also takes the scroll wheel.
// The FM-1 knobs' resting choices are marked under the names in the knobs' colours.

export interface Selector {
  element: HTMLElement;
  /** the marker over the live choice: a jack (cables land on it) or, with nothing to patch, a plain thumb */
  jack: HTMLElement;
  /** show the live choice (modulated) and the base (the setting) */
  update(live: number, base: number): void;
  /** the choices the FM-1 knobs leave it at; `unit` is the position in the range 0..1, as for a slider */
  setKnobTicks(ticks: { knob: string; unit: number }[]): void;
  /** replace the names (B side: the candidates change) */
  setNames(names: string[]): void;
}

/** the names do not fit in their columns: a drum, rechecked when the row's width changes */
const fit = new ResizeObserver((entries) => {
  for (const e of entries) checks.get(e.target)?.();
});
const checks = new WeakMap<Element, () => void>();

/** drag and wheel travel per step */
const STEP_PX = 28;
const WHEEL_STEP = 40;

export function selector(o: {
  label: string;
  names: string[];
  /** the base index */
  get: () => number;
  set: (i: number) => void;
  /** the jack: a cable starts from it; without, a plain thumb that takes no cables */
  onPatch?: (e: PointerEvent, jack: HTMLElement) => void;
}): Selector {
  let names = o.names;
  let live = o.get(), base = o.get();
  let drum = false;
  const el = document.createElement('div');
  el.className = 'sel-track';
  el.tabIndex = 0;
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-label', o.label);
  const opts = document.createElement('div');
  opts.className = 'sel-opts';
  const jack = document.createElement('span');
  jack.className = o.onPatch ? 'dot control slider-port sel-jack' : 'dot slider-thumb sel-jack';
  jack.setAttribute('aria-hidden', 'true');
  if (o.onPatch) jack.addEventListener('pointerdown', (e) => o.onPatch!(e, jack));
  el.append(opts, jack);

  const n = (): number => names.length;
  const clamp = (i: number): number => Math.max(0, Math.min(n() - 1, Math.round(i)));
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
    items = names.map((name, i) => {
      const b = document.createElement('span');
      b.className = 'sel-opt';
      b.textContent = name;
      b.dataset.i = String(i);
      return b;
    });
    opts.replaceChildren(...items, ...ticks);
    el.setAttribute('aria-valuemin', '0');
    el.setAttribute('aria-valuemax', String(Math.max(0, n() - 1)));
    check();
    draw();
  };

  // the names sit at their natural widths: the rail spreads them across the row and the jack stands over the live one;
  // the drum slides them so the live one is in the middle, under the fixed jack. Knob marks sit under their names.
  const centre = (i: number): number => {
    const it = items[i];
    return it ? it.offsetLeft + it.offsetWidth / 2 : 0;
  };
  const place = (): void => {
    if (!el.isConnected || !el.clientWidth) return;
    const l = clamp(live);
    if (drum) {
      opts.style.transform = `translateX(${el.clientWidth / 2 - centre(l)}px)`;
      jack.style.left = '';
    } else {
      opts.style.transform = '';
      jack.style.left = `${centre(l) - 7}px`;
    }
    for (const tk of ticks) tk.style.left = `${centre(Number(tk.dataset.i)) - 3 + Number(tk.dataset.k) * 7}px`;
  };

  const draw = (): void => {
    const l = clamp(live), b = clamp(base);
    items.forEach((it, i) => {
      it.classList.toggle('live', i === l);
      it.classList.toggle('base', i === b && l !== b);
    });
    place();
    el.setAttribute('aria-valuenow', String(b));
    el.setAttribute('aria-valuetext', names[b] ?? '');
    el.title = l !== b ? `${o.label}: ${names[l] ?? ''} (set to ${names[b] ?? ''})` : `${o.label}: ${names[b] ?? ''}`;
  };

  // rail or drum: the drum when the names at their natural widths do not fit across the row
  const check = (): void => {
    if (!el.isConnected || !el.clientWidth) return;
    el.classList.add('measure');
    drum = n() > 1 && opts.scrollWidth > el.clientWidth + 0.5;
    el.classList.remove('measure');
    el.classList.toggle('drum', drum);
    place();
  };
  checks.set(el, check);
  fit.observe(el);

  // the knobs' resting choices, under the names (they ride with the drum)
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
        opts.append(tk);
        ticks.push(tk);
      }
      // knobs on the same choice sit side by side
      const same = shown.slice(0, k).filter((x) => x.i === t.i).length;
      tk.dataset.i = String(t.i);
      tk.dataset.k = String(same);
      tk.style.color = `var(--${t.knob})`;
      tk.title = `${t.knob.toUpperCase()} rests it at ${names[t.i] ?? ''}`;
    });
    place();
  };

  // pointer: a press picks the name under it (the drum: a neighbour); a drag scrubs (the rail: the name under the
  // pointer; the drum: one step per name's width, the names following the pointer)
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || e.target === jack) return;
    e.preventDefault();
    e.stopPropagation();
    el.focus({ preventScroll: true });
    const x0 = e.clientX, i0 = o.get();
    let moved = false;
    // the rail: the name nearest the pointer (by the names' centres)
    const at = (x: number): number => {
      const r = opts.getBoundingClientRect();
      const scale = r.width / (opts.offsetWidth || 1); // the canvas zoom
      let best = 0, d = Infinity;
      items.forEach((_, i) => {
        const di = Math.abs(r.left + centre(i) * scale - x);
        if (di < d) (d = di), (best = i);
      });
      return best;
    };
    const move = (m: PointerEvent): void => {
      if (m.pointerId !== e.pointerId) return;
      if (Math.abs(m.clientX - x0) > 3) moved = true;
      if (!moved) return;
      pick(drum ? i0 - Math.round((m.clientX - x0) / STEP_PX) : at(m.clientX));
    };
    const up = (u: PointerEvent): void => {
      if (u.pointerId !== e.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', up);
      if (moved) return;
      const hit = (document.elementFromPoint(u.clientX, u.clientY) as HTMLElement | null)?.closest<HTMLElement>('.sel-opt');
      if (hit && el.contains(hit)) pick(Number(hit.dataset.i));
      else if (!drum) pick(at(u.clientX));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
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
  let wheel = 0;
  el.addEventListener('wheel', (e) => {
    if (!drum) return;
    e.preventDefault();
    wheel += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    const steps = Math.trunc(wheel / WHEEL_STEP);
    if (!steps) return;
    wheel -= steps * WHEEL_STEP;
    pick(o.get() + steps);
  }, { passive: false });

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
