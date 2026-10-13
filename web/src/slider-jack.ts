// SPDX-License-Identifier: GPL-3.0-only
/** A native, keyboard-accessible range control with a moving jack over its thumb. */
export function sliderJack(input: HTMLInputElement, onPatch: (e: PointerEvent, jack: HTMLElement) => void): {
  element: HTMLElement; jack: HTMLElement; update(): void;
} {
  const element = document.createElement('span');
  element.className = 'slider-jack';
  const jack = document.createElement('span');
  jack.className = 'dot control slider-port';
  jack.setAttribute('aria-hidden', 'true');
  input.classList.add('jack-range');
  const update = (): void => {
    const unit = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min));
    element.style.setProperty('--position', String(Math.max(0, Math.min(1, unit))));
  };
  input.addEventListener('input', update);
  input.addEventListener('pointerdown', (e) => {
    if (!e.altKey) return;
    onPatch(e, jack);
  });
  // While a cable is being patched, the overlay becomes the drop/click target.
  jack.addEventListener('pointerdown', (e) => onPatch(e, jack));
  element.append(input, jack);
  update();
  return { element, jack, update };
}
