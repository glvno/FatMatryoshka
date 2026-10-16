// SPDX-License-Identifier: GPL-3.0-only
/** A native, keyboard-accessible range control with a moving jack over its thumb. */
export function sliderJack(input: HTMLInputElement, onPatch: (e: PointerEvent, jack: HTMLElement) => void): {
  element: HTMLElement; jack: HTMLElement; update(): void;
  /** marks the base value on the track while the thumb shows the modulated value; null hides the tick */
  setBase(unit: number | null): void;
  /** ticks under the track where the FM-1 knobs put the parameter at rest, each in its knob's colour (CSS `--k1`..) */
  setKnobTicks(ticks: { knob: string; unit: number }[]): void;
} {
  const element = document.createElement('span');
  element.className = 'slider-jack';
  const jack = document.createElement('span');
  jack.className = 'dot control slider-port';
  jack.setAttribute('aria-hidden', 'true');
  const base = document.createElement('span');
  base.className = 'slider-base';
  base.setAttribute('aria-hidden', 'true');
  input.classList.add('jack-range');
  const update = (): void => {
    const unit = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min));
    element.style.setProperty('--position', String(Math.max(0, Math.min(1, unit))));
  };
  const setBase = (unit: number | null): void => {
    base.hidden = unit === null;
    if (unit !== null) element.style.setProperty('--base', String(Math.max(0, Math.min(1, unit))));
  };
  setBase(null);
  const knobTicks: HTMLElement[] = [];
  const setKnobTicks = (ticks: { knob: string; unit: number }[]): void => {
    while (knobTicks.length > ticks.length) knobTicks.pop()!.remove();
    ticks.forEach((t, i) => {
      let el = knobTicks[i];
      if (!el) {
        el = document.createElement('span');
        el.className = 'slider-knob';
        el.setAttribute('aria-hidden', 'true');
        element.insertBefore(el, input);
        knobTicks.push(el);
      }
      el.style.setProperty('--at', String(Math.max(0, Math.min(1, t.unit))));
      el.style.color = `var(--${t.knob})`;
      el.title = `${t.knob.toUpperCase()} rests it here`;
    });
  };
  input.addEventListener('input', update);
  input.addEventListener('pointerdown', (e) => {
    if (!e.altKey) return;
    onPatch(e, jack);
  });
  // The jack sits over the thumb and above the card's interior cables, so the thumb wins over a cable crossing it (and a
  // cable wins over the bare track). While a cable is being patched, or with Alt, it patches; otherwise it drags the
  // value as the native thumb would: the input gets the pointerdown (its handlers start the edit and capture the
  // pointer), and the moves set its value from the travel.
  jack.addEventListener('pointerdown', (e) => {
    if (e.altKey || jack.closest('.patching')) { onPatch(e, jack); return; }
    if (e.button !== 0 || input.disabled) return;
    e.preventDefault();
    e.stopPropagation();
    const min = Number(input.min), max = Number(input.max);
    const travel = Math.max(1, input.getBoundingClientRect().width - jack.getBoundingClientRect().width);
    const x0 = e.clientX, v0 = Number(input.value);
    input.dispatchEvent(new PointerEvent('pointerdown', e));
    const move = (m: PointerEvent): void => {
      if (m.pointerId !== e.pointerId) return;
      const before = input.value;
      input.value = String(Math.min(max, Math.max(min, v0 + ((m.clientX - x0) / travel) * (max - min))));
      if (input.value !== before) { input.dispatchEvent(new Event('input', { bubbles: true })); update(); }
    };
    const end = (u: PointerEvent): void => {
      if (u.pointerId !== e.pointerId) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      input.dispatchEvent(new Event('change', { bubbles: true }));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  });
  element.append(base, input, jack);
  update();
  return { element, jack, update, setBase, setKnobTicks };
}
