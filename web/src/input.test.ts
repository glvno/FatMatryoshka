// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachKeyboard } from './input';

// Exercise the installed event handlers without an audio device or a DOM dependency.
class Control extends EventTarget {
  isContentEditable = false;
  open = false;
  constructor(public tagName: string, public type = '') { super(); }
  matches(selector: string): boolean { return selector === ':open' && this.open; }
}

describe('computer keyboard focus', () => {
  let events: EventTarget;
  let active: boolean;
  const send = vi.fn();
  beforeEach(() => {
    events = new EventTarget();
    active = true;
    send.mockClear();
    vi.stubGlobal('window', events);
    vi.stubGlobal('HTMLElement', Control);
    attachKeyboard({ send }, () => active);
  });
  afterEach(() => vi.unstubAllGlobals());

  const key = (type: string, target: Control, value: string, extra = {}): Event => {
    const event = new Event(type, { cancelable: true });
    for (const [name, v] of Object.entries({ target, key: value, ...extra })) Object.defineProperty(event, name, { value: v });
    events.dispatchEvent(event);
    return event;
  };

  it.each([
    ['SELECT', ''], ['INPUT', 'checkbox'], ['INPUT', 'radio'],
    ['INPUT', 'range'], ['BUTTON', ''], ['SUMMARY', ''],
  ])('plays notes while %s %s retains focus', (tag, type) => {
    const target = new Control(tag, type);
    expect(key('keydown', target, 'f').defaultPrevented).toBe(true);
    key('keyup', target, 'f');
    expect(send.mock.calls).toEqual([[{ t: 'on', note: 65, vel: 0.8 }], [{ t: 'off', note: 65 }]]);
  });

  it('cancels repeated note keys without retriggering or changing the dropdown', () => {
    const select = new Control('SELECT');
    key('keydown', select, 'f');
    expect(key('keydown', select, 'f', { repeat: true }).defaultPrevented).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    key('keyup', select, 'f');
  });

  it.each([['INPUT', 'text'], ['INPUT', 'number'], ['TEXTAREA', '']])('protects text editing in %s %s', (tag, type) => {
    expect(key('keydown', new Control(tag, type), 'f').defaultPrevented).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('protects contenteditable text, open dropdowns and inactive workspaces', () => {
    const text = new Control('DIV'); text.isContentEditable = true;
    const select = new Control('SELECT'); select.open = true;
    expect(key('keydown', text, 'f').defaultPrevented).toBe(false);
    expect(key('keydown', select, 'f').defaultPrevented).toBe(false);
    active = false;
    expect(key('keydown', new Control('BUTTON'), 'f').defaultPrevented).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('preserves navigation keys and modifier shortcuts', () => {
    const select = new Control('SELECT');
    for (const k of ['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Tab', 'Escape']) expect(key('keydown', select, k).defaultPrevented).toBe(false);
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) expect(key('keydown', select, 'f', { [modifier]: true }).defaultPrevented).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('changes octave once per press and releases notes even after focus changes', () => {
    const select = new Control('SELECT');
    expect(key('keydown', select, 'x').defaultPrevented).toBe(true);
    key('keydown', select, 'x', { repeat: true });
    key('keydown', select, 'f');
    active = false;
    key('keyup', new Control('INPUT', 'text'), 'f');
    expect(send.mock.calls).toEqual([[{ t: 'on', note: 77, vel: 0.8 }], [{ t: 'off', note: 77 }]]);
  });

  it('shares the octave with the on-screen keyboard: buttons and Z / X move the same notes, clamped', () => {
    vi.unstubAllGlobals();
    vi.stubGlobal('window', (events = new EventTarget()));
    vi.stubGlobal('HTMLElement', Control);
    const seen: number[] = [];
    const keys = attachKeyboard({ send }, () => true, (o) => seen.push(o));
    keys.shift(-1);
    key('keydown', new Control('BUTTON'), 'z');
    for (let i = 0; i < 5; i++) keys.shift(-1);
    expect(keys.octave()).toBe(-3);
    expect(seen).toEqual([-1, -2, -3]);
    key('keydown', new Control('BUTTON'), 'a');
    expect(send).toHaveBeenLastCalledWith({ t: 'on', note: 24, vel: 0.8 });
  });
});
