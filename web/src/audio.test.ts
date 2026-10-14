// SPDX-License-Identifier: GPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioHost } from './audio';
import { emptyPatch } from './patch';
import type { ParameterValues } from './engine';

vi.mock('./worklet.ts?worker&url', () => ({ default: 'worklet.js' }));

let nextFrame = 0;
let frames: Map<number, FrameRequestCallback>;
let context: FakeContext;
let node: FakeNode;
class FakeContext {
  state = 'suspended';
  destination = {};
  audioWorklet = { addModule: async () => {} };
  onstatechange: (() => void) | null = null;
  constructor() { context = this; }
  async resume() { this.state = 'running'; }
}
class FakeNode {
  port = { postMessage: vi.fn(), onmessage: (_event: { data: { values?: ParameterValues; revision: number; probe?: string; data?: Float32Array; sr?: number } }) => {} };
  constructor() { node = this; }
  connect() {}
}
function frame() {
  const callbacks = [...frames.values()];
  frames.clear();
  for (const callback of callbacks) callback(0);
}
function reply(revision: number, value = 0.75) {
  node.port.onmessage({ data: { values: [{ id: 1, params: { gain: value } }], revision } });
}

beforeEach(() => {
  frames = new Map();
  vi.stubGlobal('AudioContext', FakeContext);
  vi.stubGlobal('AudioWorkletNode', FakeNode);
  vi.stubGlobal('document', { hidden: false });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
});
afterEach(() => vi.unstubAllGlobals());

describe('parameter display transport', () => {
  it('keeps one request in flight and paints only at animation frames', async () => {
    const host = new AudioHost();
    const paint = vi.fn();
    host.onValues = paint;
    host.setPatch(emptyPatch());
    await host.start();
    paint.mockClear();
    node.port.postMessage.mockClear();
    frame(); frame(); frame();
    expect(node.port.postMessage.mock.calls).toEqual([[{ t: 'values' }]]);
    reply(1);
    expect(paint).not.toHaveBeenCalled();
    frame();
    expect(paint).toHaveBeenCalledWith([{ id: 1, params: { gain: 0.75 } }]);
    expect(node.port.postMessage).toHaveBeenCalledTimes(2);
  });

  it('rejects an old patch reply even when module IDs are reused', async () => {
    const host = new AudioHost();
    const paint = vi.fn();
    host.onValues = paint;
    host.setPatch(emptyPatch());
    await host.start();
    frame();
    host.setPatch(emptyPatch());
    paint.mockClear();
    reply(1);
    frame();
    expect(paint).not.toHaveBeenCalled();
    reply(2, 0.1);
    frame();
    expect(paint).toHaveBeenCalledWith([{ id: 1, params: { gain: 0.1 } }]);
  });

  it('pauses polling in hidden tabs and restores base displays when audio suspends', async () => {
    const host = new AudioHost();
    const paint = vi.fn();
    host.onValues = paint;
    await host.start();
    node.port.postMessage.mockClear();
    vi.stubGlobal('document', { hidden: true });
    frame(); frame();
    expect(node.port.postMessage).not.toHaveBeenCalled();
    vi.stubGlobal('document', { hidden: false });
    frame();
    expect(node.port.postMessage).toHaveBeenCalledWith({ t: 'values' });
    context.state = 'suspended';
    context.onstatechange?.();
    expect(paint).toHaveBeenLastCalledWith(null);
    expect(frames.size).toBe(0);
  });
});

it('resumes within the gesture, shares initialization and replays the patch before early notes', async () => {
  let ready!: () => void;
  const moduleReady = new Promise<void>(resolve => { ready = resolve; });
  const resume = vi.fn(() => Promise.resolve());
  let contexts = 0;
  class Context {
    state = 'running'; destination = {}; audioWorklet = { addModule: () => moduleReady };
    resume = resume; constructor() { contexts++; }
  }
  const messages: unknown[] = [];
  class Node { port = { postMessage: (m: unknown) => messages.push(m), onmessage: null }; connect() {} }
  vi.stubGlobal('AudioContext', Context); vi.stubGlobal('AudioWorkletNode', Node);
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', () => {});
  const host = new AudioHost(); const patch = emptyPatch(); host.setPatch(patch);
  const first = host.start(), second = host.start();
  expect(contexts).toBe(1); expect(resume).toHaveBeenCalledTimes(2);
  host.send({ t: 'on', note: 60, vel: .8 }); host.send({ t: 'off', note: 60 });
  expect(messages).toEqual([]); ready(); await Promise.all([first, second]);
  expect(messages).toEqual([
    { t: 'patch', patch, revision: 1 }, expect.objectContaining({ t: 'arp' }),
    { t: 'on', note: 60, vel: .8 }, { t: 'off', note: 60 },
  ]);
});

it('discards stale scope messages after a preset switch', async () => {
  const host = new AudioHost();
  host.setPatch(emptyPatch());
  await host.start();
  const paint = vi.fn(); host.onProbe = paint;
  host.setPatch(emptyPatch());
  const data = new Float32Array([.1, -.1]);
  node.port.onmessage({ data: { probe: 'output:left', data, sr: 48000, revision: 1 } });
  expect(paint).not.toHaveBeenCalled();
  node.port.onmessage({ data: { probe: 'output:left', data, sr: 48000, revision: 2 } });
  expect(paint).toHaveBeenCalledWith('output:left', data, 48000);
});
