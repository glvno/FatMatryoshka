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
  // While a cable is being patched, the overlay becomes the drop/click target.
  jack.addEventListener('pointerdown', (e) => onPatch(e, jack));
  element.append(base, input, jack);
  update();
  return { element, jack, update, setBase, setKnobTicks };
}
