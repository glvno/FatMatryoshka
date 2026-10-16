// SPDX-License-Identifier: GPL-3.0-only
// The deck's wheels beside the keyboard: pitch bend, which springs back to the centre, and the mod wheel (CC 1), which
// stays put. They follow MIDI pitch bend and CC 1 from other sources. `dragControl` is also the dial of Main's knobs
// K1..K4 on the dock (editor.ts).

export interface DeckHost {
  /** bend, -1..1 */
  bend(v: number): void;
  /** mod wheel, 0..1 */
  mod(v: number): void;
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** a vertical-drag control with keyboard and wheel input; `value` is in lo..hi */
export interface Control {
  el: HTMLElement;
  set(v: number): void;
  /** true while the user holds it: outside updates wait */
  held(): boolean;
}

export function dragControl(el: HTMLElement, label: string, lo: number, hi: number, value: number, onInput: (v: number) => void, o: {
  /** the value on release (the bend wheel); absent = it stays */
  spring?: number;
  /** double click puts this back */
  reset?: number;
  text: (v: number) => string;
  draw: (v: number) => void;
}): Control {
  let v = value;
  let holding = false;
  el.tabIndex = 0;
  el.setAttribute('role', 'slider');
  el.setAttribute('aria-label', label);
  el.setAttribute('aria-orientation', 'vertical');
  el.setAttribute('aria-valuemin', String(lo));
  el.setAttribute('aria-valuemax', String(hi));
  const show = (): void => {
    el.setAttribute('aria-valuenow', String(Number(v.toFixed(3))));
    el.setAttribute('aria-valuetext', o.text(v));
    el.title = `${label}: ${o.text(v)}`;
    o.draw(v);
  };
  const move = (x: number): void => {
    x = clamp(x, lo, hi);
    if (x === v) return;
    v = x;
    show();
    onInput(v);
  };
  let y0 = 0, v0 = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    holding = true;
    y0 = e.clientY;
    v0 = v;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* the pointer is already gone */
    }
  });
  // 120 px of travel cover the range; Shift is four times finer
  el.addEventListener('pointermove', (e) => {
    if (holding) move(v0 + ((y0 - e.clientY) / (e.shiftKey ? 480 : 120)) * (hi - lo));
  });
  const release = (): void => {
    if (!holding) return;
    holding = false;
    if (o.spring !== undefined) move(o.spring);
  };
  for (const t of ['pointerup', 'pointercancel', 'lostpointercapture'] as const) el.addEventListener(t, release);
  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    move(v - Math.sign(e.deltaY) * 0.02 * (hi - lo));
  }, { passive: false });
  el.addEventListener('keydown', (e) => {
    const step = (hi - lo) * (e.key.startsWith('Page') ? 0.1 : 0.01);
    const to = { ArrowUp: v + step, ArrowRight: v + step, PageUp: v + step, ArrowDown: v - step, ArrowLeft: v - step, PageDown: v - step, Home: lo, End: hi }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    move(to);
  });
  el.addEventListener('keyup', () => { if (o.spring !== undefined) move(o.spring); });
  el.addEventListener('blur', () => { if (o.spring !== undefined) move(o.spring); });
  if (o.reset !== undefined) el.addEventListener('dblclick', () => move(o.reset!));
  show();
  return {
    el,
    set(x) {
      if (holding || x === v) return;
      v = clamp(x, lo, hi);
      show();
    },
    held: () => holding,
  };
}

export class DeckControls {
  private bendWheel: Control;
  private modWheel: Control;
  /** each wheel with its name: the editor puts them in the dock under Main's bend and modulation jacks */
  readonly wheels: { bend: HTMLElement; mod: HTMLElement };

  constructor(root: HTMLElement, host: DeckHost) {
    root.innerHTML = '';
    const wheels = document.createElement('div');
    wheels.className = 'deck-wheels';
    const boxes: HTMLElement[] = [];
    const wheel = (label: string, short: string, lo: number, rest: number, onInput: (v: number) => void, spring: boolean): Control => {
      const box = document.createElement('div');
      boxes.push(box);
      box.className = 'deck-wheel';
      const track = document.createElement('div');
      track.className = 'wheel';
      const name = document.createElement('span');
      name.textContent = short;
      box.append(track, name);
      wheels.append(box);
      return dragControl(track, label, lo, 1, rest, onInput, {
        spring: spring ? rest : undefined,
        reset: rest,
        text: (v) => (lo < 0 ? `${v > 0 ? '+' : ''}${(v * 2).toFixed(2)} semitones` : `${Math.round(v * 100)} %`),
        // the position as 0..1 from the bottom
        draw: (v) => track.style.setProperty('--v', String((v - lo) / (1 - lo))),
      });
    };
    this.bendWheel = wheel('Pitch bend', 'BEND', -1, 0, (v) => host.bend(v), true);
    this.modWheel = wheel('Modulation wheel', 'MOD', 0, 0, (v) => host.mod(v), false);
    root.append(wheels);
    this.wheels = { bend: boxes[0], mod: boxes[1] };
  }

  /** follow MIDI wheel messages from other sources */
  track(msg: { t: string; n?: number; v?: number }): void {
    if (msg.t === 'bend' && msg.v !== undefined && !this.bendWheel.held()) this.bendWheel.set(msg.v);
    else if (msg.t === 'cc' && msg.n === 1 && msg.v !== undefined && !this.modWheel.held()) this.modWheel.set(msg.v / 127);
  }
}
