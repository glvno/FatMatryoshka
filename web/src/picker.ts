// SPDX-License-Identifier: GPL-3.0-only
// A lateral picker for a list of choices: ◀ [ saw ] ▶. The arrows step through the list and wrap around; the middle
// shows the current choice (the caller owns that element, so it can show a live value there).

export function picker(o: {
  label: string;
  /** the element in the middle; the caller writes the choice's name into it */
  value: HTMLElement;
  count: () => number;
  /** the index the arrows step from */
  get: () => number;
  set: (i: number) => void;
}): HTMLElement {
  const el = document.createElement('div');
  el.className = 'picker';
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', o.label);
  const step = (d: number): void => {
    const n = o.count();
    if (n > 1) o.set((((o.get() + d) % n) + n) % n);
  };
  const arrow = (d: number): HTMLButtonElement => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pick';
    b.textContent = d < 0 ? '◀' : '▶';
    b.title = `${d < 0 ? 'Previous' : 'Next'} ${o.label}`;
    b.setAttribute('aria-label', b.title);
    b.onclick = (e) => {
      e.preventDefault(); // inside a <label> a click would also activate the label's control
      step(d);
    };
    return b;
  };
  o.value.classList.add('pick-value');
  el.append(arrow(-1), o.value, arrow(1));
  return el;
}
